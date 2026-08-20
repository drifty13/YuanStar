from __future__ import annotations

import asyncio
import base64
import logging
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from time import perf_counter
from uuid import uuid4

import cv2
import numpy as np

from nicegui import events, run as nicegui_run, ui

from .catalog import load_catalog
from .accounts import AccountRegistryError, AccountWorkspaceManager, LocalAccount
from .domain import GameVersion, InventorySummaryRow, Quality, StarKind, parse_integer, reconcile
from .experience_calculator import (
    InstanceExperiencePlan,
    feedable_experience_required,
    requirement_as_purple_white,
    summarize_experience_plan,
)
from .experience_rules import ExperienceRuleLoadError, ExperienceRules, cached_experience_rules
from .export_excel import export_workbook
from .persistence import PreparedWorkspace, RestorePointInfo, WorkspaceLoadResult, WorkspaceStore
from .session import SessionState
from .ui_contract import (
    POOL_LABELS,
    POOL_ORDER,
    can_confirm_all_pools,
    inventory_display_rows,
    item_needs_review,
    localized_status,
    localized_position,
    localized_warning,
    pending_review_count,
    plan_display_rows,
    review_counts,
    review_image_summaries,
)
from .vision.contracts import ImageInput, ImportFailure, ImportProgressCallback, ImportProgressEvent
from .vision.image_metadata import image_input_from_upload
from .vision.pipeline import LocalOfflineVisionPipeline

logger = logging.getLogger(__name__)


def inventory_viewport_alignment_script(source_table_class: str, target_table_class: str) -> str:
    """Return the one-shot, value-agnostic inventory viewport alignment script."""
    return f"""
    (() => {{
      const sourceClass = {source_table_class!r};
      const targetClass = {target_table_class!r};
      window.__yuanstarInventoryAlignToken =
        (window.__yuanstarInventoryAlignToken || 0) + 1;
      const token = window.__yuanstarInventoryAlignToken;
      const align = () => {{
        if (token !== window.__yuanstarInventoryAlignToken) return;
        const sourceMiddle = document.querySelector(sourceClass)?.querySelector('.q-table__middle');
        const targetMiddle = document.querySelector(targetClass)?.querySelector('.q-table__middle');
        if (!sourceMiddle || !targetMiddle) return;
        const maxScroll = Math.max(0, targetMiddle.scrollHeight - targetMiddle.clientHeight);
        targetMiddle.scrollTop = Math.max(0, Math.min(sourceMiddle.scrollTop, maxScroll));
      }};
      requestAnimationFrame(() => requestAnimationFrame(align));
    }})();
    """


@dataclass
class ImportTaskState:
    task_id: str | None = None
    status: str = "idle"
    started_at: float | None = None
    stage: str = "等待开始"
    completed_images: int = 0
    total_images: int = 0
    current_image_index: int | None = None
    current_filename: str | None = None
    error_count: int = 0
    error_summary: str | None = None
    engine_initializations: int = 0
    client_id: str | None = None

    @property
    def running(self) -> bool:
        return self.status == "running"


@dataclass(frozen=True)
class InstanceDisplayPosition:
    """Separate filter visibility from a unique table position."""

    exists: bool
    visible_after_filter: bool
    uniquely_addressable: bool
    display_index: int | None


def current_instance_display_position(state: SessionState, instance_id: str) -> InstanceDisplayPosition:
    """Describe an instance without conflating filtering and name aggregation."""
    exists = any(row.star_instance_id == instance_id for row in state.rows)
    filtered_instances = state.filtered_rows()
    visible_after_filter = any(row.star_instance_id == instance_id for row in filtered_instances)
    uniquely_addressable = visible_after_filter and not bool(state.filter_name.strip())
    display_index = (
        next(
            (index for index, row in enumerate(filtered_instances) if row.star_instance_id == instance_id),
            None,
        )
        if uniquely_addressable
        else None
    )
    return InstanceDisplayPosition(
        exists=exists,
        visible_after_filter=visible_after_filter,
        uniquely_addressable=uniquely_addressable,
        display_index=display_index,
    )

async def run_import_transaction(
    state: SessionState,
    pipeline: LocalOfflineVisionPipeline,
    batch,
    overlap_pairs: dict[str, list[tuple[str, str]]],
    *,
    io_bound=nicegui_run.io_bound,
    progress: ImportProgressCallback | None = None,
) -> tuple[object, int] | ImportFailure:
    """Run pure local analysis first, then atomically apply only a success result."""
    try:
        result = await io_bound(pipeline.analyze, state.uploaded_images, batch, overlap_pairs, progress)
        if not result.executed:
            raise RuntimeError(result.message)
        if progress:
            progress(ImportProgressEvent(stage="写入会话", total_images=batch.image_count, completed_images=batch.image_count))
        accepted = state.apply_local_analysis(result, rebuild_inventory=True)
        if progress:
            progress(ImportProgressEvent(stage="完成", total_images=batch.image_count, completed_images=batch.image_count))
        return result, accepted
    except Exception as error:
        return ImportFailure.from_exception("导入任务", error)


async def read_uploaded_file(event: events.UploadEventArguments) -> ImageInput:
    """Read and validate a NiceGUI upload without changing session state."""
    content = await event.file.read()
    return image_input_from_upload(event.file.name, content, event.file.content_type)


async def accept_uploaded_file(
    event: events.UploadEventArguments, state: SessionState
) -> ImageInput:
    """Compatibility helper for tests and non-classifying upload paths."""
    image = await read_uploaded_file(event)
    state.add_uploaded_image(image)
    return image


async def classify_and_add_uploaded_file(
    event: events.UploadEventArguments,
    state: SessionState,
    pipeline: LocalOfflineVisionPipeline,
    *,
    io_bound=nicegui_run.io_bound,
) -> tuple[ImageInput, str]:
    """Classify first; only successful local classifications enter the session."""
    image = await read_uploaded_file(event)
    suggested_pool = await io_bound(pipeline.classify_pool, image)
    state.add_uploaded_image(image)
    state.suggest_image_pool(image.id, suggested_pool)
    return image, suggested_pool


def format_file_size(size_bytes: int) -> str:
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.1f} MB"


def accumulated_engine_initializations(current: int, incoming: int | None) -> int:
    """Keep task-local OCR initialization count monotonic across sparse events."""
    return max(int(current or 0), int(incoming or 0))


def is_import_mutation_locked(*, ocr_busy: bool, task_status: str) -> bool:
    return ocr_busy or task_status == "running"


def is_workspace_mutation_locked(
    *,
    ocr_busy: bool,
    restore_busy: bool,
    task_status: str,
    processing_uploads: bool,
) -> bool:
    """One small shared guard for every persistent-workspace mutation."""
    return ocr_busy or restore_busy or task_status == "running" or processing_uploads


def reset_import_task_transients(task: ImportTaskState, *, total_images: int) -> None:
    """Clear every field that must not bleed into a new OCR task."""
    task.total_images = total_images
    task.completed_images = 0
    task.current_image_index = None
    task.current_filename = None
    task.error_count = 0
    task.error_summary = None
    task.engine_initializations = 0


def thumbnail_data_url(image: ImageInput, *, width: int = 100) -> str | None:
    """Create a small local-only list thumbnail; full image stays lazy in the dialog."""
    decoded = cv2.imdecode(np.frombuffer(image.content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        return None
    height, original_width = decoded.shape[:2]
    target_height = max(1, round(height * width / max(original_width, 1)))
    preview = cv2.resize(decoded, (width, target_height), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 70])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def full_image_data_url(image: ImageInput) -> str:
    content_type = image.content_type or "image/jpeg"
    return f"data:{content_type};base64," + base64.b64encode(image.content).decode("ascii")


def row_crop_data_url(
    image: ImageInput,
    box: tuple[int, int, int, int] | None,
) -> str | None:
    """Render a real source-row crop, or report that no reliable box exists."""
    if box is None:
        return None
    decoded = cv2.imdecode(np.frombuffer(image.content, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        return None
    x, y, width, height = box
    image_height, image_width = decoded.shape[:2]
    left = max(0, min(int(x), image_width))
    top = max(0, min(int(y), image_height))
    right = max(left, min(int(x + width), image_width))
    bottom = max(top, min(int(y + height), image_height))
    if right <= left or bottom <= top:
        return None
    crop = decoded[top:bottom, left:right]
    ok, encoded = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 82])
    if not ok:
        return None
    return "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")


def create_app(
    state: SessionState | None = None,
    pipeline: LocalOfflineVisionPipeline | None = None,
    workspace_store: WorkspaceStore | None = None,
    account_workspace_manager: AccountWorkspaceManager | None = None,
) -> None:
    manages_default_workspace = state is None
    catalog = load_catalog()
    experience_rules: ExperienceRules | None = None
    experience_rules_error: str | None = None
    try:
        experience_rules = cached_experience_rules()
    except ExperienceRuleLoadError as error:
        experience_rules_error = str(error)
        logger.warning("Experience rules are unavailable: %s", error, exc_info=True)
    except Exception:
        experience_rules_error = "经验星曜规则加载失败，暂无法计算计划需求。"
        logger.exception("Experience rules are unavailable")
    load_result = WorkspaceLoadResult(state=None)
    account_manager: AccountWorkspaceManager | None = None
    active_account: LocalAccount | None = None
    account_warning: str | None = None
    if state is None:
        if workspace_store is None:
            account_manager = account_workspace_manager or AccountWorkspaceManager.default()
            account_load = account_manager.load_current(catalog)
            active_account = account_load.account
            workspace_store = account_load.workspace_store
            load_result = account_load.load_result
            account_warning = account_load.warning
        else:
            load_result = workspace_store.load(catalog)
        state = load_result.state or SessionState(catalog)
    pipeline = pipeline or LocalOfflineVisionPipeline()
    processing_uploads: set[str] = set()
    import_task = ImportTaskState()
    review_view_state: dict[str, object] = {
        "expanded_image_id": None,
        "show_all_cards": False,
        "pending_count": None,
        "selected_plan_row_id": None,
        "selected_experience_instance_id": None,
        "plan_save_status": "已自动保存",
        "plan_input_blocked": False,
        "current_editor_notice": None,
    }
    account_ui_state = {"creating": False}
    ui.add_css(
        """
        .inventory-table .q-table__middle { max-height: 25rem; overflow-y: auto; }
        .inventory-table thead tr th { position: sticky; top: 0; z-index: 1; background: white; }
        .pending-image-uploader { width: 100%; min-height: 4.7rem; }
        .pending-image-uploader .q-uploader__list { display: none; }
        .yuanstar-title { width: 100%; text-align: center; }
        .compact-card { padding: .75rem; gap: .35rem; }
        .import-workbar {
          display: grid; grid-template-columns: minmax(0, 7fr) minmax(20rem, 3fr);
          gap: .75rem; align-items: stretch;
        }
        .import-workbar > .q-card { min-width: 0; height: 100%; }
        .progress-lines { line-height: 1.2rem; overflow-wrap: anywhere; }
        .image-pools-grid {
          display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 5fr) minmax(0, 3fr);
          gap: .75rem; align-items: stretch;
        }
        .pool-zone { min-width: 0; height: 18rem; max-height: 18rem; overflow: hidden; }
        .pool-zone { cursor: pointer; transition: box-shadow .16s ease, background .16s ease; }
        .pool-zone.active { box-shadow: inset 0 0 0 2px #90caf9; background: #f8fbff; }
        .pool-track { min-height: 12.2rem; max-height: 12.2rem; overflow-x: auto; overflow-y: hidden; flex-wrap: nowrap; scroll-behavior: smooth; }
        .pool-image-card { width: 9.5rem; min-width: 9.5rem; height: 11.2rem; padding: .45rem; cursor: pointer; user-select: none; }
        .pool-image-card.selected { outline: 3px solid #1976d2; outline-offset: -3px; }
        .pool-thumbnail { width: 8.6rem; height: 6.1rem; object-fit: contain; background: #f2f4f7; }
        .pool-filename { width: 8.6rem; white-space: normal; overflow-wrap: anywhere; line-height: 1.05rem; }
        .overlap-workspace {
            padding: .5rem 1rem .75rem 1.25rem !important;
            gap: .35rem !important;
        }
        .full-viewer-dialog {
          width: min(38rem, calc(100vw - 2rem)); max-width: calc(100vw - 2rem);
          height: min(92vh, 58rem); max-height: 92vh; padding: .75rem;
        }
        .full-image-stage {
          min-height: 0; flex: 1 1 auto; overflow: hidden; background: #16191d;
          display: flex; align-items: center; justify-content: center; position: relative;
          touch-action: none;
        }
        .full-image-stage.viewer-can-pan { cursor: grab; }
        .full-image-stage.viewer-dragging { cursor: grabbing; }
        .full-viewer-image {
          display: block; width: 100%; height: 100%; max-width: 100%;
          max-height: calc(92vh - 8.5rem); transform-origin: center center;
          will-change: transform; user-select: none;
        }
        .full-viewer-image .q-img__image { object-fit: contain !important; }
        .review-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; align-items: stretch; }
        .review-column { min-width: 0; height: 28.5rem; overflow: hidden; display: flex; flex-direction: column; }
        .review-column .inventory-table { min-height: 0; flex: 1 1 auto; display: flex; flex-direction: column; }
        .review-column .inventory-table .q-table__container,
        .review-column .inventory-table .q-table__middle {
          min-height: 0; max-height: none; flex: 1 1 auto;
        }
        .review-summary-scroll { max-height: 8.6rem; overflow-y: auto; padding-right: .2rem; }
        .review-expansion-body { max-height: 34rem; overflow-y: auto; }
        .review-section {
          margin-bottom: .8rem; border-radius: 1rem; overflow: hidden;
          background: #f7f8fa; border: 1px solid #e7e9ee; padding: .2rem .55rem .65rem;
        }
        .review-section .q-item { min-height: 2.7rem; }
        .review-section > .q-item { font-weight: 600; }
        .ocr-summary-line { line-height: 1.15rem; }
        .ocr-row-preview { width: min(100%, 52rem); max-height: 9rem; object-fit: contain; background: #f2f4f7; }
        .ocr-candidate-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
        .bag-info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; align-items: stretch; }
        .bag-info-panel { min-width: 0; min-height: 0; overflow: hidden; align-self: stretch; gap: .2rem; }
        .bag-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .1rem .65rem; }
        .bag-form-grid .q-field { min-width: 0; width: 100%; }
        .bag-candidate-scroll { max-height: 5.6rem; overflow-y: auto; }
        .bag-ocr-candidate-panel .q-expansion-item__content { max-height: 6rem; overflow-y: auto; }
        .business-five-columns table { table-layout: fixed; width: 100%; }
        .business-five-columns th:not(.q-table--col-auto-width),
        .business-five-columns td:not(.q-table--col-auto-width) { width: 20%; }
        .business-five-columns .q-table--col-auto-width {
          width: 2.75rem; min-width: 2.75rem; max-width: 2.75rem;
        }
        .current-inventory-table th:not(.q-table--col-auto-width),
        .current-inventory-table td:not(.q-table--col-auto-width),
        .planned-inventory-table th:not(.q-table--col-auto-width),
        .planned-inventory-table td:not(.q-table--col-auto-width) {
          width: calc((100% - 2.75rem) / 5);
        }
        .main-action-row { display: flex; align-items: center; width: 100%; gap: .5rem; flex-wrap: wrap; }
        .main-action-row .import-primary-actions { margin-left: auto; display: flex; gap: .5rem; flex-wrap: nowrap; }
        .account-management-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.25fr) repeat(4, minmax(0, 1fr));
          gap: .75rem;
          align-items: end;
          width: 100%;
        }
        .account-management-grid > * { min-width: 0; width: 100%; }
        .experience-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: .75rem;
          align-items: start;
        }
        .experience-column { min-width: 0; padding: .6rem; overflow: visible; }
        .manual-editor-section { 
          padding-bottom: .1rem; 
        }
        .manual-editor-content {
          display: flex; flex-direction: column; gap: .5rem;
          padding-top: 0;
          margin-top: -16px;
        }
        .experience-fields-row {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: .75rem; align-items: start; width: 100%;
        }
        .experience-field-stack { min-width: 0; }
        .experience-field-stack .core-field { min-width: 0; }
        .experience-unknown-hint { line-height: 1rem; }
        .experience-action-row {
          display: flex; align-items: center; justify-content: space-between;
          width: 100%; margin-top: .25rem;
        }
        .experience-plan-rows {
          display: flex;
          flex-direction: column;
          width: 100%;
          min-width: 0;
        }
        .experience-plan-row {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          gap: .5rem;
          align-items: center;
          padding: .22rem 0;
          border-bottom: 1px solid #e4e7ec;
          line-height: 1.1rem;
        }

        .experience-plan-row > * {
          width: 100%;
          min-width: 0;
        }
        .experience-plan-row:last-child { border-bottom: 0; }
        .experience-plan-label { color: #1d2939; text-align: left; }
        .experience-plan-value { color: #1d2939; text-align: center; overflow-wrap: anywhere; }
        .experience-plan-result {
          color: #1d2939;
          width: 100%;
          min-width: 0;
          justify-self: stretch;
          display: flex;
          align-items: center;
          justify-content: flex-end;
          text-align: right;
          white-space: nowrap;
          overflow-wrap: normal;
        }
        .experience-plan-footnote { line-height: .9rem; color: #667085; margin-top: .25rem; text-align: left; }
        .experience-plan-footnote-warning { color: #b54708; }
        .experience-plan-warning { line-height: 1rem; color: #b54708; overflow-wrap: anywhere; }
        .group-divider-cell { border-top: 2px solid #b8bec8 !important; }
        .kind-divider-cell { border-top: 4px solid #667085 !important; }
        .current-inventory-table tbody tr:has(> .group-divider-cell) > td,
        .planned-inventory-table tbody tr:has(> .group-divider-cell) > td {
          border-top: 2px solid #b8bec8 !important;
        }
        .current-inventory-table tbody tr:has(> .kind-divider-cell) > td,
        .planned-inventory-table tbody tr:has(> .kind-divider-cell) > td {
          border-top: 4px solid #667085 !important;
        }
        .current-inventory-table tbody tr:has(> td[data-yuanstar-row-highlight="actual"]) > td,
        .planned-inventory-table tbody tr:has(> td[data-yuanstar-row-highlight="actual"]) > td {
          background-color: #c6cbd2 !important;
        }
        .current-inventory-table tbody tr:has(> td[data-yuanstar-row-highlight="counterpart"]) > td,
        .planned-inventory-table tbody tr:has(> td[data-yuanstar-row-highlight="counterpart"]) > td {
          background-color: #e9edf1 !important;
        }
        .star-description-trigger {
          display: inline-flex; align-items: center; box-sizing: border-box;
          max-width: 100%; min-height: 1.3em; padding-inline: 1em; cursor: help;
        }
        .star-description-tooltip { max-width: 22rem; white-space: pre-line; line-height: 1.45; }
        .floating-actions {
          position: fixed; right: 1.25rem; bottom: 1.25rem; z-index: 1900;
          display: flex; flex-direction: column; gap: .6rem;
        }
        .core-field { min-width: 8.5rem; }
        .name-field { min-width: 13rem; }
        .quality-badge { min-width: 2rem; text-align: center; }
        @media (max-width: 1050px) {
          .import-workbar { grid-template-columns: minmax(0, 1fr); }
          .image-pools-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
          .image-pools-grid .pool-experience {
            grid-column: 1 / -1; width: min(38rem, 62%); min-width: 18rem; justify-self: center;
          }
        }
        @media (max-width: 900px) {
          .review-grid, .experience-grid, .bag-info-grid, .ocr-candidate-grid, .account-management-grid { grid-template-columns: minmax(0, 1fr); }
          .floating-actions { right: .75rem; bottom: .75rem; }
          .main-action-row .import-primary-actions { margin-left: 0; }
        }
        """
    )
    import_view_state = {
        "active_pool": "main",
        "unclassified_focus_claimed": bool(state.unclassified_images()),
    }
    review_expansions: dict[str, object] = {}
    pending_save_task: asyncio.Task | None = None
    persist_revision = 0
    current_editor_save_pending = False
    ocr_busy = False
    restore_busy = False
    account_control_elements: list[object] = []
    import_mutation_elements: list[object] = []
    restore_entry_elements: dict[str, object | None] = {"import": None, "review": None}
    account_selector_elements: list[object] = []
    inventory_table_controller: dict[str, object] = {}
    plan_save_status_element: object | None = None
    current_save_status_element: object | None = None
    restore_points_cache_key: tuple[object, ...] | None = None
    restore_points_cache: tuple[RestorePointInfo, ...] = ()
    current_editor_controller: dict[str, object] = {}

    def selected_experience_instance_id() -> str | None:
        selected_id = review_view_state.get("selected_experience_instance_id")
        return str(selected_id) if selected_id is not None else None

    def set_selected_experience_instance(instance_id: str | None) -> None:
        """Keep the experience panel bound to one stable star instance identity."""
        review_view_state["selected_experience_instance_id"] = instance_id

    def clear_experience_selection_if_filtered_out() -> None:
        selected_id = selected_experience_instance_id()
        if selected_id is None:
            return
        if any(row.star_instance_id == selected_id for row in state.filtered_rows()):
            return
        state.selected_row_id = None
        review_view_state["selected_plan_row_id"] = None
        set_selected_experience_instance(None)

    def commit_current_editor_if_dirty() -> bool:
        """Commit the active current-inventory session before it is replaced."""
        callback = current_editor_controller.get("commit_if_dirty")
        if not callable(callback):
            return True
        return bool(callback())

    def set_plan_save_status(status: str) -> None:
        """Update only the small status label; never replace an active input."""
        nonlocal plan_save_status_element
        review_view_state["plan_save_status"] = status
        element = plan_save_status_element
        if element is None:
            return
        element.set_text(status)
        if status == "保存失败，请重试":
            element.classes(add="text-negative text-weight-bold", remove="text-grey")
        else:
            element.classes(add="text-grey", remove="text-negative text-weight-bold")

    def set_current_save_status(status: str) -> None:
        """Update only the current-inventory editor status label in place."""
        nonlocal current_save_status_element
        element = current_save_status_element
        if element is None:
            return
        element.set_text(status)
        if status == "保存失败，请重试":
            element.classes(add="text-negative text-weight-bold", remove="text-grey")
        else:
            element.classes(add="text-grey", remove="text-negative text-weight-bold")

    def set_ocr_busy(value: bool) -> None:
        """Keep account controls visually and behaviorally tied to OCR lifecycle."""
        nonlocal ocr_busy
        ocr_busy = value
        for element in tuple(account_control_elements):
            element.set_enabled(not workspace_mutation_locked())
        for element in tuple(import_mutation_elements):
            element.set_enabled(not workspace_mutation_locked())
        for element in tuple(restore_entry_elements.values()):
            if element is not None:
                element.set_enabled(bool(restore_points()) and not workspace_mutation_locked())
        # Pool controls are rendered dynamically; rebuild only that local
        # section so their disabled props match the same backend lock.
        try:
            pending_image_section.refresh()
        except NameError:
            pass
        try:
            bag_info_section.refresh()
        except NameError:
            pass

    def import_mutation_locked() -> bool:
        return workspace_mutation_locked()

    def workspace_mutation_locked() -> bool:
        return is_workspace_mutation_locked(
            ocr_busy=ocr_busy,
            restore_busy=restore_busy,
            task_status=import_task.status,
            processing_uploads=bool(processing_uploads),
        )

    def restore_points() -> tuple[RestorePointInfo, ...]:
        nonlocal restore_points_cache_key, restore_points_cache
        if workspace_store is None:
            return ()
        try:
            paths = workspace_store.restore_point_paths()
            fingerprint: tuple[object, ...] = (
                str(workspace_store.root.resolve()),
                *(
                    (
                        path.name,
                        path.stat().st_mtime_ns,
                        (path / "workspace.json").stat().st_mtime_ns if (path / "workspace.json").exists() else None,
                        (path / "restore-point.json").stat().st_mtime_ns if (path / "restore-point.json").exists() else None,
                        (path / "images").stat().st_mtime_ns if (path / "images").exists() else None,
                    )
                    for path in paths
                ),
            )
            if fingerprint != restore_points_cache_key:
                restore_points_cache = workspace_store.list_restore_points(catalog)
                restore_points_cache_key = fingerprint
            return restore_points_cache
        except Exception:
            logger.exception("Failed to list restore points")
            restore_points_cache_key = None
            restore_points_cache = ()
            return ()

    def can_open_restore_dialog() -> bool:
        return bool(restore_points()) and not workspace_mutation_locked()

    def restore_active_account_selector() -> None:
        if active_account is None:
            return
        for element in tuple(account_selector_elements):
            element.value = active_account.account_id
            element.update()

    def request_persist(*, current_editor_save: bool = False) -> asyncio.Task | None:
        """Coalesce saves into one writer and always finish with the newest state."""
        nonlocal pending_save_task, persist_revision, current_editor_save_pending
        if workspace_store is None:
            return None
        current_editor_save_pending = current_editor_save_pending or current_editor_save
        persist_revision += 1
        if pending_save_task and not pending_save_task.done():
            return pending_save_task

        async def persist_worker() -> bool:
            nonlocal current_editor_save_pending
            try:
                await asyncio.sleep(.2)
                while True:
                    target_revision = persist_revision
                    prepared = workspace_store.prepare(
                        state,
                        revision=target_revision,
                    )
                    await nicegui_run.io_bound(workspace_store.save, prepared)
                    if target_revision == persist_revision:
                        if review_view_state.get("plan_save_status") == "正在保存…":
                            set_plan_save_status("已自动保存")
                        if current_editor_save_pending:
                            set_current_save_status("已自动保存")
                            current_editor_save_pending = False
                        return True
            except Exception as error:
                logger.warning("Failed to persist local workspace", exc_info=True)
                if review_view_state.get("plan_save_status") == "正在保存…":
                    set_plan_save_status("保存失败，请重试")
                if current_editor_save_pending:
                    set_current_save_status("保存失败，请重试")
                    current_editor_save_pending = False
                ui.notify(f"自动保存失败：{error}；当前内存数据仍保留。", type="negative")
                return False

        pending_save_task = asyncio.create_task(persist_worker())
        return pending_save_task

    async def save_current_account_before_switch() -> None:
        """Finish every queued save, then prove the current snapshot is durable."""
        if workspace_store is None:
            return
        if pending_save_task is not None and not pending_save_task.done():
            await pending_save_task
        prepared = workspace_store.prepare(state)
        await nicegui_run.io_bound(workspace_store.save, prepared)

    async def switch_account(account_id: str) -> None:
        nonlocal state, workspace_store, active_account, account_warning
        if account_manager is None or active_account is None or account_id == active_account.account_id:
            return
        if workspace_mutation_locked():
            restore_active_account_selector()
            ui.notify("当前工作区正在处理，完成后才能切换账号。", type="warning")
            return
        try:
            await save_current_account_before_switch()
        except Exception as error:
            ui.notify(f"当前账号保存失败，未切换账号：{error}", type="negative")
            return
        try:
            target = account_manager.load_account(account_id, catalog)
            # Only record the new last-active account after it is readable.
            account_manager.activate(account_id, catalog)
        except Exception as error:
            ui.notify(f"目标账号无法加载，仍停留在当前账号：{error}", type="negative")
            return
        state = target.load_result.state or SessionState(catalog)
        workspace_store = target.workspace_store
        active_account = target.account
        account_warning = target.warning
        processing_uploads.clear()
        inventory_table_controller.clear()
        import_view_state.clear()
        import_view_state.update({"active_pool": "main", "unclassified_focus_claimed": bool(state.unclassified_images())})
        review_view_state.clear()
        review_view_state.update({"expanded_image_id": None, "show_all_cards": False, "pending_count": None, "selected_plan_row_id": None, "selected_experience_instance_id": None, "plan_save_status": "已自动保存", "plan_input_blocked": False, "current_editor_notice": None})
        import_page.refresh()
        refresh_review_sections()
        ui.notify(f"已切换到 {active_account.display_name}（{active_account.game_version.value}）。", type="positive")

    async def create_account_and_switch(display_name: str, game_version: str) -> bool:
        if account_manager is None:
            return False
        if workspace_mutation_locked():
            ui.notify("当前仍有本机图片处理任务，完成后才能新增并切换账号。", type="warning")
            return False
        try:
            await save_current_account_before_switch()
        except Exception as error:
            ui.notify(f"当前账号保存失败，未创建新账号：{error}", type="negative")
            return False
        try:
            account = account_manager.create_account(display_name, game_version, catalog)
        except (ValueError, AccountRegistryError) as error:
            ui.notify(str(error), type="negative")
            # The registry remains unchanged on validation errors. Rebuild both
            # editors so an invalid or duplicate value is visibly restored to
            # the current effective account metadata.
            if refresh_ui:
                import_page.refresh()
                refresh_review_sections()
            return False
        await switch_account(account.account_id)
        return active_account is not None and active_account.account_id == account.account_id

    async def update_current_account_metadata(
        display_name: str,
        game_version: str,
        *,
        refresh_ui: bool = True,
    ) -> bool:
        nonlocal active_account
        if account_manager is None or active_account is None:
            return False
        if workspace_mutation_locked():
            ui.notify("当前工作区正在处理，完成后才能修改账号信息。", type="warning")
            return False
        previous_account = active_account
        try:
            active_account = account_manager.update_account_metadata(
                active_account.account_id,
                display_name,
                game_version,
                catalog,
            )
            state.save_game_version(active_account.game_version)
            state.save_account_name(active_account.display_name)
            await save_current_account_before_switch()
        except (ValueError, AccountRegistryError) as error:
            ui.notify(str(error), type="negative")
            return False
        except Exception as error:
            # Workspace writes are atomic. Restore the registry and in-memory
            # identity so a failed metadata save never creates a split account.
            active_account = previous_account
            state.game_version = previous_account.game_version
            state.account_name = previous_account.display_name
            try:
                account_manager.update_account_metadata(
                    previous_account.account_id,
                    previous_account.display_name,
                    previous_account.game_version,
                    catalog,
                )
            except Exception:
                logger.exception("Failed to roll back account metadata after workspace save failure")
            ui.notify(f"账号信息保存失败，已恢复原值：{error}", type="negative")
            return False
        if refresh_ui:
            import_page.refresh()
            refresh_review_sections()
        ui.notify("账号信息已保存。", type="positive")
        return True

    def open_full_preview(image_id: str, pool_name: str | None = None) -> None:
        """Open the shared, height-first full-page viewer."""
        source = next((image for image in state.uploaded_images if image.id == image_id), None)
        if source is None:
            ui.notify("原图已不在当前会话。", type="warning")
            return
        if source.missing or not source.content:
            ui.notify("该工作区图片副本缺失，无法打开原图。", type="warning")
            return
        resolved_pool = pool_name or state.image_pools.get(source.id, "unknown")
        pool_images = [
            image for image in state.uploaded_images
            if state.image_pools.get(image.id, "unknown") == resolved_pool
        ]
        if not pool_images:
            pool_images = [source]
        current_index = next(
            (index for index, image in enumerate(pool_images) if image.id == source.id),
            0,
        )
        cursor = {"index": current_index}
        token = uuid4().hex
        previous_id = f"viewer-previous-{token}"
        next_id = f"viewer-next-{token}"
        stage_id = f"viewer-stage-{token}"
        image_id_element = f"viewer-image-{token}"
        zoom_out_id = f"viewer-zoom-out-{token}"
        zoom_in_id = f"viewer-zoom-in-{token}"
        zoom_label_id = f"viewer-zoom-label-{token}"

        with ui.dialog() as dialog, ui.card().classes("full-viewer-dialog column no-wrap"):
            with ui.row().classes("w-full items-center justify-between no-wrap"):
                with ui.column().classes("gap-0 min-w-0"):
                    filename_label = ui.label().classes("text-subtitle1 text-weight-medium")
                    metadata_label = ui.label().classes("text-caption")
                with ui.row().classes("items-center no-wrap gap-1"):
                    ui.button("缩小", icon="remove").props(
                        f"flat dense id={zoom_out_id}"
                    ).mark("full-viewer-zoom-out")
                    ui.label("100%").props(f"id={zoom_label_id}").classes(
                        "text-caption text-center"
                    ).mark("full-viewer-zoom-label")
                    ui.button("放大", icon="add").props(
                        f"flat dense id={zoom_in_id}"
                    ).mark("full-viewer-zoom-in")
                    ui.button(
                        "关闭",
                        on_click=dialog.close,
                        icon="close",
                    ).props("flat").mark("full-viewer-close")
            with ui.element("div").props(f"id={stage_id}").classes("full-image-stage w-full"):
                viewer_image = ui.image().props(
                    f"draggable=false id={image_id_element}"
                ).classes("full-viewer-image")
            with ui.row().classes("w-full items-center justify-center no-wrap"):
                previous_button = ui.button(
                    "上一张",
                    icon="chevron_left",
                ).props(f"flat id={previous_id}").mark("full-viewer-previous")
                next_button = ui.button(
                    "下一张",
                    icon="chevron_right",
                ).props(f"flat id={next_id}").mark("full-viewer-next")

            def update_viewer(offset: int = 0) -> None:
                cursor["index"] = max(0, min(cursor["index"] + offset, len(pool_images) - 1))
                current = pool_images[cursor["index"]]
                state.selected_import_image_id = current.id
                filename_label.set_text(current.filename)
                metadata_label.set_text(
                    f"{current.width or '未识别'} × {current.height or '未识别'} · "
                    f"{POOL_LABELS.get(resolved_pool, '待确认池')} · "
                    f"第 {cursor['index'] + 1} / {len(pool_images)} 张"
                )
                viewer_image.set_source(full_image_data_url(current))
                previous_button.set_enabled(cursor["index"] > 0)
                next_button.set_enabled(cursor["index"] + 1 < len(pool_images))
                ui.run_javascript(
                    f"""
                    const viewerImage = document.getElementById('{image_id_element}');
                    if (viewerImage) {{
                      viewerImage.dataset.naturalWidth = '{current.width or 0}';
                      viewerImage.dataset.naturalHeight = '{current.height or 0}';
                    }}
                    window.__yuanstarViewers?.['{token}']?.reset();
                    """
                )

            previous_button.on("click", lambda: update_viewer(-1))
            next_button.on("click", lambda: update_viewer(1))

            def install_viewer_keys() -> None:
                ui.run_javascript(
                    f"""
                    if (window.__yuanstarViewerKey) {{
                      window.removeEventListener('keydown', window.__yuanstarViewerKey);
                    }}
                    window.__yuanstarViewerKey = event => {{
                      if (event.key === 'ArrowLeft') document.getElementById('{previous_id}')?.click();
                      if (event.key === 'ArrowRight') document.getElementById('{next_id}')?.click();
                    }};
                    window.addEventListener('keydown', window.__yuanstarViewerKey);

                    window.__yuanstarViewers = window.__yuanstarViewers || {{}};
                    window.__yuanstarViewers['{token}']?.cleanup?.();
                    const stage = document.getElementById('{stage_id}');
                    const image = document.getElementById('{image_id_element}');
                    const zoomLabel = document.getElementById('{zoom_label_id}');
                    const zoomOut = document.getElementById('{zoom_out_id}');
                    const zoomIn = document.getElementById('{zoom_in_id}');
                    if (stage && image && zoomLabel && zoomOut && zoomIn) {{
                      let scale = 1.0;
                      let offsetX = 0;
                      let offsetY = 0;
                      let dragging = false;
                      let dragStartX = 0;
                      let dragStartY = 0;
                      let originX = 0;
                      let originY = 0;

                      const baseImageSize = () => {{
                        const naturalWidth = Number(image.dataset.naturalWidth) || stage.clientWidth;
                        const naturalHeight = Number(image.dataset.naturalHeight) || stage.clientHeight;
                        const ratio = Math.min(
                          stage.clientWidth / naturalWidth,
                          stage.clientHeight / naturalHeight,
                        );
                        return {{width: naturalWidth * ratio, height: naturalHeight * ratio}};
                      }};
                      const limits = () => {{
                        const base = baseImageSize();
                        return {{
                          x: Math.max(0, (base.width * scale - stage.clientWidth) / 2),
                          y: Math.max(0, (base.height * scale - stage.clientHeight) / 2),
                        }};
                      }};
                      const clamp = () => {{
                        const limit = limits();
                        offsetX = Math.max(-limit.x, Math.min(limit.x, offsetX));
                        offsetY = Math.max(-limit.y, Math.min(limit.y, offsetY));
                        return limit;
                      }};
                      const render = () => {{
                        const limit = clamp();
                        image.style.transform = `translate3d(${{offsetX}}px, ${{offsetY}}px, 0) scale(${{scale}})`;
                        zoomLabel.textContent = `${{Math.round(scale * 100)}}%`;
                        stage.classList.toggle('viewer-can-pan', scale > 1 && (limit.x > 0 || limit.y > 0));
                      }};
                      const reset = () => {{
                        scale = 1.0;
                        offsetX = 0;
                        offsetY = 0;
                        dragging = false;
                        stage.classList.remove('viewer-dragging');
                        render();
                      }};
                      const zoomBy = delta => {{
                        const next = Math.max(0.5, Math.min(4.0, scale + delta));
                        scale = Math.round(next * 4) / 4;
                        if (scale <= 1.0) {{
                          offsetX = 0;
                          offsetY = 0;
                        }}
                        render();
                      }};
                      const onWheel = event => {{
                        if (!event.ctrlKey) return;
                        event.preventDefault();
                        zoomBy(event.deltaY < 0 ? 0.25 : -0.25);
                      }};
                      const onPointerDown = event => {{
                        const limit = limits();
                        if (scale <= 1 || (limit.x <= 0 && limit.y <= 0)) return;
                        dragging = true;
                        dragStartX = event.clientX;
                        dragStartY = event.clientY;
                        originX = offsetX;
                        originY = offsetY;
                        stage.setPointerCapture(event.pointerId);
                        stage.classList.add('viewer-dragging');
                        event.preventDefault();
                      }};
                      const onPointerMove = event => {{
                        if (!dragging) return;
                        offsetX = originX + event.clientX - dragStartX;
                        offsetY = originY + event.clientY - dragStartY;
                        render();
                      }};
                      const onPointerUp = event => {{
                        if (!dragging) return;
                        dragging = false;
                        stage.classList.remove('viewer-dragging');
                        if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
                      }};
                      const onZoomOut = () => zoomBy(-0.25);
                      const onZoomIn = () => zoomBy(0.25);
                      stage.addEventListener('wheel', onWheel, {{passive: false}});
                      stage.addEventListener('pointerdown', onPointerDown);
                      stage.addEventListener('pointermove', onPointerMove);
                      stage.addEventListener('pointerup', onPointerUp);
                      stage.addEventListener('pointercancel', onPointerUp);
                      zoomOut.addEventListener('click', onZoomOut);
                      zoomIn.addEventListener('click', onZoomIn);
                      const cleanup = () => {{
                        stage.removeEventListener('wheel', onWheel);
                        stage.removeEventListener('pointerdown', onPointerDown);
                        stage.removeEventListener('pointermove', onPointerMove);
                        stage.removeEventListener('pointerup', onPointerUp);
                        stage.removeEventListener('pointercancel', onPointerUp);
                        zoomOut.removeEventListener('click', onZoomOut);
                        zoomIn.removeEventListener('click', onZoomIn);
                        image.style.transform = '';
                      }};
                      window.__yuanstarViewers['{token}'] = {{reset, zoomBy, cleanup}};
                      reset();
                    }}
                    """
                )

            def cleanup_viewer_keys() -> None:
                ui.run_javascript(
                    """
                    if (window.__yuanstarViewerKey) {
                      window.removeEventListener('keydown', window.__yuanstarViewerKey);
                      delete window.__yuanstarViewerKey;
                    }
                    window.__yuanstarViewers?.['%s']?.cleanup?.();
                    if (window.__yuanstarViewers) delete window.__yuanstarViewers['%s'];
                    """
                    % (token, token)
                )
                pending_image_section.refresh()

            dialog.on("show", install_viewer_keys)
            dialog.on("hide", cleanup_viewer_keys)
            update_viewer()
        dialog.open()

    def restore_reason_text(reason: str) -> str:
        return "手动恢复前安全点" if reason == "pre_manual_restore" else "重新识别前自动恢复点"

    def restore_status_text(info: RestorePointInfo) -> str:
        if not info.readable:
            return "不可读取"
        if info.missing_images:
            return f"可恢复，但有 {len(info.missing_images)} 张原图缺失"
        return "可恢复"

    def restore_timestamp(info: RestorePointInfo) -> str:
        return info.created_at.astimezone().strftime("%Y-%m-%d %H:%M:%S")

    async def restore_snapshot(info: RestorePointInfo) -> None:
        nonlocal state, restore_busy, pending_save_task
        if restore_busy:
            return
        if ocr_busy or import_task.status == "running":
            ui.notify("OCR 正在运行，完成或失败后才能恢复快照。", type="warning")
            return
        if processing_uploads:
            ui.notify("图片正在本机分流，完成后才能恢复快照。", type="warning")
            return
        if workspace_store is None or active_account is None or not info.readable:
            ui.notify("该恢复快照无法读取，不能恢复。", type="negative")
            return
        restore_busy = True
        restore_dialog.close()
        import_page.refresh()
        refresh_review_sections()
        current_store = workspace_store
        current_account = active_account
        try:
            # Do not allow a delayed autosave to overwrite the restored state.
            if pending_save_task is not None and not pending_save_task.done():
                saved = await pending_save_task
                if saved is False:
                    raise RuntimeError("当前自动保存失败")
            await nicegui_run.io_bound(current_store.save, current_store.prepare(state))

            # The target must be fixed before creating this safety point, since
            # creating it can prune the oldest (third) restore point.
            prepared_target = await nicegui_run.io_bound(
                current_store.prepare_restore_point, info.path, catalog,
            )
            target_snapshot = deepcopy(prepared_target.snapshot)
            target_snapshot["game_version"] = current_account.game_version.value
            target_snapshot["account_name"] = current_account.display_name
            prepared_target = PreparedWorkspace(
                snapshot=target_snapshot,
                images=prepared_target.images,
            )
            safety_point = current_store.prepare(state)
            try:
                await nicegui_run.io_bound(
                    lambda: current_store.create_restore_point(
                        safety_point, reason="pre_manual_restore",
                    )
                )
            except Exception as error:
                logger.exception("Failed to create manual-restore safety point")
                ui.notify("无法创建恢复前安全点，本次恢复未执行", type="negative")
                return
            loaded = await nicegui_run.io_bound(
                current_store.restore_prepared_workspace, prepared_target, catalog,
            )
            if loaded.state is None:
                raise RuntimeError(loaded.warning or "恢复后的工作区无法读取")
            state = loaded.state
            # Registry identity is authoritative even if a legacy point carries
            # a different display name or game version.
            state.game_version = current_account.game_version
            state.account_name = current_account.display_name
            state.reset_transient_ui_state()
            inventory_table_controller.clear()
            processing_uploads.clear()
            import_view_state.clear()
            import_view_state.update({"active_pool": "main", "unclassified_focus_claimed": bool(state.unclassified_images())})
            review_view_state.clear()
            review_view_state.update({"expanded_image_id": None, "show_all_cards": False, "pending_count": None, "selected_plan_row_id": None, "selected_experience_instance_id": None, "plan_save_status": "已自动保存", "plan_input_blocked": False, "current_editor_notice": None})
            ui.notify(
                f"已恢复到 {restore_timestamp(info)} 的快照；\n恢复前状态已保存为新的安全恢复点。",
                type="positive",
                multi_line=True,
            )
        except Exception as error:
            logger.exception("Snapshot restore failed")
            ui.notify(f"恢复失败：{error}", type="negative")
        finally:
            restore_busy = False
            import_page.refresh()
            refresh_review_sections()
            restore_dialog_content.refresh()

    with ui.dialog().mark("restore-snapshots-dialog") as restore_dialog, ui.card().classes("w-full max-w-2xl"):
        @ui.refreshable
        def restore_dialog_content() -> None:
            ui.label("恢复快照").classes("text-h6")
            if active_account is not None:
                ui.label(f"当前账号：{active_account.game_version.value} · {active_account.display_name}")
            ui.label("仅显示当前账号最近 3 个恢复点").classes("text-caption text-grey")
            for info in restore_points():
                with ui.expansion(
                    f"{restore_timestamp(info)} · {restore_reason_text(info.reason)} · {restore_status_text(info)}",
                    value=False,
                ).classes("w-full").mark("restore-point-card"):
                    ui.label(f"当前背包：{info.inventory_count} 颗")
                    ui.label(f"已设置计划：{info.explicit_plan_count} 颗")
                    ui.label(f"保存图片：{info.image_count} 张")
                    ui.label(f"OCR 结果：{'已包含' if info.has_ocr_result else '未包含'}")
                    if info.missing_images:
                        ui.label(
                            f"此快照有 {len(info.missing_images)} 张原图缺失。背包、计划和 OCR 记录仍可恢复，但缺失图片无法打开原图预览。"
                        ).classes("text-warning")
                    if info.warning:
                        ui.label(info.warning).classes("text-negative" if not info.readable else "text-warning")
                    ui.label("恢复后，当前账号的背包、计划、图片、OCR 结果和人工修改会替换为此恢复点的内容。\n账号名称、游戏版本和账号 ID 不会回退。恢复前的当前状态会先保存为新的安全恢复点。").classes("whitespace-pre-line text-caption")
                    if info.readable:
                        ui.button(
                            "恢复此快照",
                            on_click=lambda item=info: restore_snapshot(item),
                            icon="restore",
                        ).props("color=primary").set_enabled(not workspace_mutation_locked()).mark("restore-this-snapshot")
            with ui.row().classes("w-full justify-end"):
                ui.button("关闭", on_click=restore_dialog.close).props("flat").mark("restore-dialog-close")

        restore_dialog_content()

    def open_restore_dialog() -> None:
        if workspace_mutation_locked():
            ui.notify("当前正在处理工作区，暂不能恢复快照。", type="warning")
            return
        if not restore_points():
            ui.notify("当前账号暂无可恢复快照", type="warning")
            return
        restore_dialog_content.refresh()
        restore_dialog.open()

    @ui.refreshable
    def import_page() -> None:
        account_control_elements.clear()
        account_selector_elements.clear()
        import_mutation_elements.clear()
        ui.label("图片仅在本机离线进行识别，并保存到本机最近工作区，不会上传到外部服务。确认分类后若有图片重叠，请标记重叠关系。").classes("text-grey")
        with ui.card().classes("w-full").mark("screenshot-requirements"):
            ui.label("截图要求").classes("text-subtitle1")
            ui.markdown(
                "- 请上传同一账号、同一设备、同一次背包查看过程中的截图；截图过程中不要分解、升级、获得或消耗星石。\n"
                "- 优先上传清晰、完整的原始截图；主星和辅星尽量减少前后截图重叠。\n"
                "- 每张截图优先保证顶部第一行完整；页面底部半隐没行可以保留，后续可作为残片忽略。\n"
                "- 若两张截图存在重复行，请明确标记前图和后图；主星、辅星通常各 1–2 组。\n"
                "- 经验星石建议上传一张完整清晰页面；若未标记重叠不会阻断识别，但可能导致识别的星石数量偏高。"
            )
        with ui.element("div").classes(
                "account-management-grid w-full"
        ).mark("top-account-placeholder"):
            if account_manager is not None and active_account is not None:
                account_options = {
                    account.account_id: f"{account.game_version.value} · {account.display_name}"
                    for account in account_manager.accounts(catalog)
                }

                async def choose_account(event) -> None:
                    if not event.value:
                        return
                    if workspace_mutation_locked():
                        restore_active_account_selector()
                        ui.notify("当前工作区正在处理，完成后才能切换账号。", type="warning")
                        return
                    was_creating = bool(account_ui_state["creating"])
                    account_ui_state["creating"] = False
                    if str(event.value) == active_account.account_id and was_creating:
                        import_page.refresh()
                        return
                    await switch_account(str(event.value))

                account_selector = ui.select(
                    account_options,
                    value=None if account_ui_state["creating"] else active_account.account_id,
                    label="当前账号",
                    on_change=choose_account,
                ).mark("account-selector")
                account_selector_elements.append(account_selector)
                account_control_elements.append(account_selector)
                account_selector.set_enabled(not workspace_mutation_locked())
                if account_ui_state["creating"]:
                    game_version = ui.select(
                        [version.value for version in GameVersion],
                        label="游戏版本",
                    ).mark("import-game-version")
                else:
                    game_version = ui.select(
                        [version.value for version in GameVersion],
                        value=active_account.game_version.value,
                        label="游戏版本",
                    ).mark("import-game-version")
                account_name = ui.input(
                    "账号名称",
                    value="" if account_ui_state["creating"] else active_account.display_name,
                ).mark("workspace-account-name")
                account_control_elements.extend((game_version, account_name))
                game_version.set_enabled(not workspace_mutation_locked())
                account_name.set_enabled(not workspace_mutation_locked())

                async def save_account_metadata(_=None) -> None:
                    if account_ui_state["creating"]:
                        return
                    await update_current_account_metadata(
                        str(account_name.value or ""),
                        str(game_version.value or ""),
                    )

                account_name.on("blur", save_account_metadata)
                account_name.on("keydown.enter", save_account_metadata)
                if not account_ui_state["creating"]:
                    game_version.on_value_change(save_account_metadata)

                async def create_or_enter_account() -> None:
                    if workspace_mutation_locked():
                        ui.notify("当前工作区正在处理，完成后才能新增账号。", type="warning")
                        return
                    if not account_ui_state["creating"]:
                        account_ui_state["creating"] = True
                        import_page.refresh()
                        return
                    if await create_account_and_switch(
                        str(account_name.value or ""),
                        str(game_version.value or ""),
                    ):
                        account_ui_state["creating"] = False
                        import_page.refresh()

                create_account_button = ui.button(
                    "创建并进入" if account_ui_state["creating"] else "新增账号",
                    on_click=create_or_enter_account,
                ).props("color=primary").mark("create-account")
                account_control_elements.append(create_account_button)
                create_account_button.set_enabled(not workspace_mutation_locked())
                ui.button("删除当前账号").props("disable").tooltip("暂未开放").mark("delete-account-placeholder")
            else:
                # Injected test/demo states retain the former single-workspace controls.
                game_version = ui.select(
                    [version.value for version in GameVersion],
                    value=state.game_version.value,
                    label="游戏",
                ).classes("core-field").mark("import-game-version")
                account_name = ui.input(
                    "账号",
                    value=state.account_name,
                    placeholder="当前工作区账号名称",
                ).classes("name-field").mark("workspace-account-name")

                def save_import_account() -> None:
                    state.save_account_name(account_name.value)
                    request_persist()

                account_name.on("blur", save_import_account)

                def save_import_game(_=None) -> None:
                    state.save_game_version(game_version.value)
                    request_persist()
                    bag_info_section.refresh()

                game_version.on_value_change(save_import_game)

        with ui.element("div").classes("import-workbar w-full").mark("import-workbar-7-3"):
            with ui.card().classes("compact-card w-full").mark("upload-workzone"):
                ui.label("选择多张星石背包截图").classes("text-subtitle1")
                upload_mount = ui.column().classes("w-full gap-1")
                upload_count_label = ui.label().classes("text-caption")
                upload_size_label = ui.label().classes("text-caption text-grey")
            with ui.card().props("id=yuanstar-task-progress").classes("compact-card w-full").mark("task-progress-zone"):
                ui.label("导入任务进度").classes("text-subtitle1")
                progress_status = ui.label().classes("progress-lines")
                progress_detail = ui.label().classes("text-grey progress-lines")
                progress_elapsed = ui.label().classes("text-caption")
                progress_bar = ui.linear_progress(value=0, show_value=False).classes("w-full")

            def update_upload_summary() -> None:
                total_size = sum(
                    image.size_bytes or len(image.content)
                    for image in state.uploaded_images
                )
                upload_count_label.set_text(f"已选文件：{len(state.uploaded_images)} 张")
                status = (
                    f"正在本机分流：{len(processing_uploads)} 张"
                    if processing_uploads
                    else "等待选择图片" if not state.uploaded_images else "图片已进入分类池"
                )
                upload_size_label.set_text(f"总大小：{format_file_size(total_size)} · {status}")

            def update_progress(event: ImportProgressEvent | None = None) -> None:
                if event:
                    import_task.stage = event.stage
                    import_task.completed_images = event.completed_images
                    import_task.total_images = event.total_images
                    import_task.current_image_index = event.current_image_index
                    import_task.current_filename = event.current_filename
                    import_task.error_count = event.error_count
                    import_task.engine_initializations = accumulated_engine_initializations(
                        import_task.engine_initializations,
                        event.engine_initializations,
                    )
                    detail = event.detail or ""
                else:
                    detail = import_task.error_summary or ""
                elapsed = perf_counter() - import_task.started_at if import_task.started_at else 0.0
                activity = "处理中" if import_task.running else "等待" if import_task.status == "idle" else "已停止"
                progress_status.set_text(
                    f"任务状态：{localized_status(import_task.status)} · 当前阶段：{import_task.stage} · 活动状态：{activity}"
                )
                image_number = import_task.current_image_index or import_task.completed_images
                current = f"当前图片：{image_number} / {import_task.total_images}"
                if import_task.current_filename:
                    current += f" · {import_task.current_filename}"
                waiting = max(import_task.total_images - import_task.completed_images, 0)
                progress_detail.set_text(
                    f"{current} · 已完成：{import_task.completed_images} · 待处理：{waiting} · "
                    f"错误数：{import_task.error_count} · OCR 初始化次数：{import_task.engine_initializations}。{detail}"
                )
                progress_elapsed.set_text(f"已用时间：{elapsed:.1f} 秒")
                progress_bar.value = (import_task.completed_images / import_task.total_images) if import_task.total_images else 0
                progress_bar.update()

            update_progress()
            update_upload_summary()

        def clear_pending() -> None:
            if import_mutation_locked():
                ui.notify("识别进行中，不能修改本次任务的图片。", type="warning")
                return
            state.clear_uploaded_images()
            import_view_state["unclassified_focus_claimed"] = False
            uploader.reset()
            request_persist()
            ui.notify("已清空待识别图片。")
            update_upload_summary()
            pending_image_section.refresh()
            confirm_all_action.refresh()
            refresh_review_sections()

        def confirm_all_pools() -> None:
            if import_mutation_locked():
                ui.notify("识别进行中，不能修改本次任务的图片分类。", type="warning")
                return
            confirmed, failures = state.confirm_all_image_pools()
            request_persist()
            if failures:
                ui.notify(
                    f"已确认 {confirmed} 张；失败 {len(failures)} 张：" + "；".join(failures),
                    type="negative",
                    multi_line=True,
                )
            else:
                ui.notify(f"已确认全部分类：{confirmed} 张。", type="positive")
            pending_image_section.refresh()
            confirm_all_action.refresh()

        @ui.refreshable
        def pending_image_section() -> None:
            """Render the state-owned three-pool contract, never the uploader itself."""
            def remove_pending(image_id: str) -> None:
                if import_mutation_locked():
                    ui.notify("识别进行中，不能修改本次任务的图片。", type="warning")
                    return
                if state.remove_uploaded_image(image_id):
                    request_persist()
                    ui.notify("已移除待识别图片。")
                    update_upload_summary()
                    pending_image_section.refresh()

            ui.label(f"待识别图片：{len(state.uploaded_images)} 张").classes("text-subtitle2")
            if processing_uploads:
                ui.label(f"正在本机自动分流图片池：{len(processing_uploads)} 张").classes("text-grey")
            unknown_images = state.unclassified_images()
            if unknown_images:
                current_unknown = unknown_images[0]
                with ui.card().props("id=unclassified-manual-routing").classes(
                    "compact-card w-full bg-orange-1"
                ).mark("unclassified-manual-routing"):
                    with ui.row().classes("w-full items-center justify-between no-wrap"):
                        ui.label("无法自动分流图片").classes("text-subtitle1")
                        ui.label(f"第 1 / {len(unknown_images)} 张").classes("text-caption")
                    ui.label(f"图片 ID：{current_unknown.filename or current_unknown.id}").classes(
                        "text-caption"
                    ).mark("unclassified-image-id")
                    ui.label("请先将当前图片归入一个目标池，处理完全部图片后才可开始识别。").classes(
                        "text-caption text-negative"
                    )
                    with ui.row().classes("w-full items-end"):
                        ui.button(
                            "查看图片",
                            on_click=lambda image_id=current_unknown.id: open_full_preview(
                                image_id,
                                "unknown",
                            ),
                        ).props("flat dense").mark("unclassified-view-image")
                        target_pool = ui.select(
                            {
                                "main": "主星池",
                                "support": "辅星池",
                                "experience": "经验星曜池",
                            },
                            value=None,
                            label="分流到：请选择目标池",
                        ).props("dense").classes("core-field").mark(
                            "unclassified-routing-target"
                        )
                        target_pool.set_enabled(not import_mutation_locked())

                        def route_current_unknown(
                            event,
                            image_id: str = current_unknown.id,
                            control=target_pool,
                        ) -> None:
                            selected_pool = event.value
                            if not selected_pool:
                                return
                            if import_mutation_locked():
                                control.set_value(None)
                                ui.notify("识别进行中，不能修改图片分类。", type="warning")
                                return
                            try:
                                routed = state.route_unclassified_image(
                                    image_id,
                                    selected_pool,
                                )
                            except (TypeError, ValueError) as error:
                                control.set_value(None)
                                ui.notify(str(error), type="negative")
                                return
                            except Exception as error:
                                logger.exception("Failed to route unclassified image")
                                control.set_value(None)
                                ui.notify(f"图片归池失败：{error}", type="negative")
                                return
                            import_view_state["active_pool"] = selected_pool
                            state.selected_import_image_id = routed.id
                            if not state.unclassified_images() and not processing_uploads:
                                import_view_state["unclassified_focus_claimed"] = False
                            request_persist()
                            routed_pool_label = {
                                "main": "主星池",
                                "support": "辅星池",
                                "experience": "经验星曜池",
                            }[selected_pool]
                            ui.notify(
                                f"{routed.filename} 已归入{routed_pool_label}并标记为已确认。",
                                type="positive",
                            )
                            pending_image_section.refresh()
                            confirm_all_action.refresh()

                        target_pool.on_value_change(route_current_unknown)
            selected_pool = state.image_pools.get(
                state.selected_import_image_id or "",
                import_view_state["active_pool"],
            )
            if selected_pool in POOL_ORDER:
                import_view_state["active_pool"] = selected_pool

            def activate_pool(target_pool: str) -> None:
                import_view_state["active_pool"] = target_pool
                first = next(
                    (
                        image for image in state.uploaded_images
                        if state.image_pools.get(image.id, "unknown") == target_pool
                    ),
                    None,
                )
                if first and state.image_pools.get(state.selected_import_image_id or "") != target_pool:
                    state.selected_import_image_id = first.id
                pending_image_section.refresh()

            with ui.element("div").classes("image-pools-grid w-full").mark("image-pools-5-5-3"):
                for pool_name in POOL_ORDER:
                    pool_images = [
                        image for image in state.uploaded_images
                        if state.image_pools.get(image.id, "unknown") == pool_name
                    ]
                    active_class = " active" if import_view_state["active_pool"] == pool_name else ""
                    pool_classes = f"w-full pool-zone pool-{pool_name}{active_class}"
                    pool_card = ui.card().classes(pool_classes).mark(f"pool-{pool_name}")
                    pool_card.on(
                        "click",
                        lambda target=pool_name: activate_pool(target),
                        js_handler=(
                            "event => {"
                            " if (event.target.closest('button, input, [role=\"button\"], .q-scrollarea__thumb')) return;"
                            " emit();"
                            "}"
                        ),
                    )
                    with pool_card:
                        with ui.row().classes("w-full items-center justify-between no-wrap"):
                            ui.button(
                                f"{POOL_LABELS[pool_name]}（{len(pool_images)} 张）",
                                on_click=lambda target=pool_name: activate_pool(target),
                            ).props("flat dense").classes("text-subtitle1").mark(f"activate-pool-{pool_name}")

                            def confirm_current_pool(target_pool: str = pool_name) -> None:
                                if import_mutation_locked():
                                    ui.notify("识别进行中，不能确认图片池。", type="warning")
                                    return
                                confirmed, failures = state.confirm_image_pool(target_pool)
                                if failures:
                                    ui.notify("；".join(failures), type="negative")
                                else:
                                    ui.notify(f"{POOL_LABELS[target_pool]}已确认 {confirmed} 张。", type="positive")
                                request_persist()
                                pending_image_section.refresh()
                                confirm_all_action.refresh()

                            confirm_pool_button = ui.button(
                                "确认本池",
                                on_click=confirm_current_pool,
                            ).props("flat dense color=primary").set_enabled(
                                bool(pool_images) and not import_mutation_locked()
                            ).mark(f"confirm-pool-{pool_name}")

                        track_id = f"pool-track-{pool_name}"
                        with ui.row().classes("w-full items-center no-wrap"):
                            ui.button(
                                icon="chevron_left",
                                on_click=lambda target=track_id: ui.run_javascript(
                                    f"document.getElementById('{target}')?.scrollBy({{left:-360,behavior:'smooth'}});"
                                ),
                            ).props("round flat dense").mark(f"pool-scroll-left-{pool_name}")
                            with ui.row().props(f"id={track_id}").classes("pool-track grow no-wrap"):
                                if not pool_images:
                                    ui.label("当前图片池为空。").classes("text-grey self-center")
                                for image_index, image in enumerate(pool_images, 1):
                                    selected = state.selected_import_image_id == image.id
                                    image_card = ui.card().classes(
                                         "pool-image-card selected" if selected else "pool-image-card"
                                    ).mark(f"pool-image-{pool_name}")
                                    click_generation = {"value": 0}

                                    async def select_card(
                                        selected_pool: str = pool_name,
                                        selected_image: ImageInput = image,
                                        generation=click_generation,
                                    ) -> None:
                                        generation["value"] += 1
                                        current = generation["value"]
                                        await asyncio.sleep(.18)
                                        if current != generation["value"]:
                                            return
                                        import_view_state["active_pool"] = selected_pool
                                        state.selected_import_image_id = selected_image.id
                                        pending_image_section.refresh()

                                    def preview_card(
                                        selected_pool: str = pool_name,
                                        selected_image: ImageInput = image,
                                        generation=click_generation,
                                    ) -> None:
                                        generation["value"] += 1
                                        import_view_state["active_pool"] = selected_pool
                                        state.selected_import_image_id = selected_image.id
                                        open_full_preview(selected_image.id, selected_pool)

                                    image_card.on(
                                        "click",
                                        select_card,
                                        js_handler=(
                                            "event => {"
                                            " event.stopPropagation();"
                                            " if (event.target.closest('button, input, [role=\"button\"]')) return;"
                                            " emit();"
                                            "}"
                                        ),
                                    )
                                    image_card.on(
                                        "dblclick",
                                        preview_card,
                                        js_handler=(
                                            "event => {"
                                            " event.preventDefault(); event.stopPropagation();"
                                            " if (event.target.closest('button, input, [role=\"button\"]')) return;"
                                            " emit();"
                                            "}"
                                        ),
                                    )
                                    with image_card:
                                        preview = thumbnail_data_url(image, width=180)

                                        if preview:
                                            ui.image(preview).classes("pool-thumbnail").mark(f"pool-thumbnail-{pool_name}")
                                        else:
                                            unavailable = "工作区图片副本缺失" if image.missing else "缩略图不可用"
                                            ui.label(unavailable).classes("pool-thumbnail text-grey")
                                        ui.label(f"{image_index}. {image.filename}").classes("pool-filename text-caption")
                                        status = "已确认" if image.id in state.confirmed_image_pools else "待确认"
                                        ui.label(status).classes(
                                            "text-positive text-caption" if status == "已确认" else "text-orange text-caption"
                                        )
                            ui.button(
                                icon="chevron_right",
                                on_click=lambda target=track_id: ui.run_javascript(
                                    f"document.getElementById('{target}')?.scrollBy({{left:360,behavior:'smooth'}});"
                                ),
                            ).props("round flat dense").mark(f"pool-scroll-right-{pool_name}")

            active_pool = str(import_view_state["active_pool"])
            selected_image = next(
                (
                    image for image in state.uploaded_images
                    if image.id == state.selected_import_image_id
                    and state.image_pools.get(image.id, "unknown") == active_pool
                ),
                None,
            )
            if selected_image:
                with ui.card().classes("compact-card w-full bg-blue-1").mark("selected-image-actions"):
                    with ui.row().classes("items-end w-full"):
                        ui.label(f"当前选中：{selected_image.filename}").classes("grow")
                        target_pool = ui.select(
                            {"main": "主星", "support": "辅星", "experience": "经验星曜"},
                            value=active_pool,
                            label="修改图片池归属",
                        ).props("dense").classes("core-field")
                        target_pool.set_enabled(not import_mutation_locked())

                        def confirm_selected(
                            image_id: str = selected_image.id,
                            control=target_pool,
                        ) -> None:
                            if import_mutation_locked():
                                ui.notify("识别进行中，不能修改图片分类。", type="warning")
                                return
                            try:
                                state.set_image_pool(image_id, control.value)
                            except ValueError as error:
                                ui.notify(str(error), type="negative")
                                return
                            import_view_state["active_pool"] = control.value
                            request_persist()
                            ui.notify("图片分类已确认；只清理了与该图相关的旧重叠关系。", type="positive")
                            pending_image_section.refresh()
                            confirm_all_action.refresh()

                        ui.button(
                            "查看完整原图",
                            on_click=lambda image_id=selected_image.id, pool=active_pool: open_full_preview(image_id, pool),
                        ).props("flat")
                        ui.button("确认分类", on_click=confirm_selected).props("color=primary").set_enabled(
                            not import_mutation_locked()
                        ).mark("confirm-selected-image")
                        ui.button(
                            "删除",
                            on_click=lambda image_id=selected_image.id: remove_pending(image_id),
                        ).props("flat color=negative").set_enabled(not import_mutation_locked()).mark("delete-selected-image")

            if active_pool in {"main", "support"}:
                pool_images = [
                    image for image in state.uploaded_images
                    if state.image_pools.get(image.id, "unknown") == active_pool
                ]
                relation_label = "主星池重叠校验" if active_pool == "main" else "辅星池重叠校验"
                with ui.card().classes("overlap-workspace w-full").mark("overlap-workspace"):
                    ui.label(relation_label).classes("text-subtitle2").mark(
                        f"overlap-{active_pool}"
                    )
                    ui.label(
                        f"当前 {len(state.overlap_pairs[active_pool])} 组；0 组不阻断识别。"
                    ).classes("text-caption text-grey")
                    choices = {
                        image.id: f"{index}. {image.filename}"
                        for index, image in enumerate(pool_images, 1)
                    }
                    if len(choices) >= 2:
                        with ui.row().classes("items-end w-full"):
                            before = ui.select(choices, label="前一张图片").props("dense").classes("name-field")
                            ui.icon("arrow_forward")
                            after = ui.select(choices, label="后一张图片").props("dense").classes("name-field")
                            before.set_enabled(not import_mutation_locked())
                            after.set_enabled(not import_mutation_locked())

                            def add_pair(
                                target_pool: str = active_pool,
                                left=before,
                                right=after,
                            ) -> None:
                                if import_mutation_locked():
                                    ui.notify("识别进行中，不能修改重叠关系。", type="warning")
                                    return
                                try:
                                    state.add_overlap_pair(target_pool, left.value, right.value)
                                except ValueError as error:
                                    ui.notify(str(error), type="negative")
                                    return
                                ui.notify("已保存有向重叠关系。", type="positive")
                                request_persist()
                                pending_image_section.refresh()

                            ui.button(
                                "查看前图",
                                on_click=lambda pool=active_pool, control=before: open_full_preview(control.value, pool) if control.value else None,
                            ).props("flat")
                            ui.button(
                                "查看后图",
                                on_click=lambda pool=active_pool, control=after: open_full_preview(control.value, pool) if control.value else None,
                            ).props("flat")
                            ui.button("添加关系", on_click=add_pair).props("color=primary").set_enabled(
                                not import_mutation_locked()
                            ).mark(f"add-overlap-{active_pool}")
                    else:
                        ui.label("至少需要两张同池图片才能添加关系。").classes("text-grey")

                    for before_id, after_id in state.overlap_pairs[active_pool]:
                        with ui.row().classes("items-center"):
                            ui.label(f"{choices.get(before_id, before_id)} → {choices.get(after_id, after_id)}")

                            def remove_pair(
                                left: str = before_id,
                                right: str = after_id,
                                target_pool: str = active_pool,
                            ) -> None:
                                if import_mutation_locked():
                                    ui.notify("识别进行中，不能修改重叠关系。", type="warning")
                                    return
                                state.remove_overlap_pair(target_pool, left, right)
                                request_persist()
                                pending_image_section.refresh()

                            ui.button("移除", on_click=remove_pair).props("flat dense color=negative").set_enabled(
                                not import_mutation_locked()
                            )

            if not state.uploaded_images:
                ui.label("尚未上传图片。")

        async def on_upload(event: events.UploadEventArguments) -> None:
            if import_mutation_locked():
                ui.notify("识别进行中，暂不能上传新图片。", type="warning")
                return
            processing_uploads.add(event.file.name)
            should_focus_unclassified = False
            try:
                ui.notify("正在本机自动分流图片池。")
                _, suggested_pool = await classify_and_add_uploaded_file(event, state, pipeline)
                if (
                    suggested_pool == "unknown"
                    and not import_view_state["unclassified_focus_claimed"]
                ):
                    import_view_state["unclassified_focus_claimed"] = True
                    should_focus_unclassified = True
                request_persist()
                pool_label = {"main": "主星", "support": "辅星", "experience": "经验星石"}.get(suggested_pool, "待确认")
                ui.notify(f"已完成本机分流建议：{pool_label}，请确认图片池。", type="positive")
            except Exception:
                logger.exception("Failed to classify uploaded image")
                ui.notify("图片分类失败，请查看运行窗口中的错误信息。", type="negative")
            finally:
                processing_uploads.discard(event.file.name)
                if not processing_uploads and not state.unclassified_images():
                    import_view_state["unclassified_focus_claimed"] = False
                update_upload_summary()
                pending_image_section.refresh()
                confirm_all_action.refresh()
                if should_focus_unclassified:
                    ui.run_javascript(
                        "requestAnimationFrame(() => "
                        "document.getElementById('unclassified-manual-routing')"
                        "?.scrollIntoView({block:'nearest', behavior:'smooth'}));"
                    )

        with upload_mount:
            uploader = ui.upload(
                label="选择图片",
                multiple=True,
                auto_upload=True,
                on_upload=on_upload,
            ).props("accept=.png,.jpg,.jpeg flat bordered").classes("pending-image-uploader")
        uploader.set_enabled(not import_mutation_locked())
        import_mutation_elements.append(uploader)
        pending_image_section()

        async def start_import(*, confirmed: bool = False) -> None:
            def abort_before_run() -> None:
                if confirmed:
                    set_ocr_busy(False)

            if restore_busy:
                ui.notify("恢复快照正在进行，暂不能开始识别。", type="warning")
                return
            if import_task.running or (ocr_busy and not confirmed):
                ui.notify("当前识别正在进行。", type="warning")
                return
            if processing_uploads:
                abort_before_run()
                ui.notify("请等待全部图片完成本机分流后再开始识别。", type="warning")
                return
            if state.unclassified_images():
                abort_before_run()
                ui.notify("请先处理“无法自动分流图片”区的全部图片。", type="negative")
                return
            unconfirmed = [image.filename for image in state.uploaded_images if image.id not in state.confirmed_image_pools]
            if unconfirmed:
                abort_before_run()
                ui.notify("请先确认全部图片池，再开始识别。", type="negative")
                return
            if not state.overlap_pairs["main"] and not state.overlap_pairs["support"]:
                ui.notify("未标记重叠关系：本次不会比较图片，也不会自动跨图去重。", type="warning")
            try:
                batch = state.start_import(
                    state.game_version.value,
                    state.bag_current_count,
                    state.bag_capacity,
                )
            except ValueError as error:
                abort_before_run()
                ui.notify(str(error), type="negative")
                return
            set_ocr_busy(True)
            ocr_state = state
            ocr_account = active_account
            ocr_workspace_store = workspace_store
            ocr_overlap_pairs = deepcopy(ocr_state.overlap_pairs)
            # Existing inventory must have a durable, account-scoped rollback
            # point before any OCR worker starts.  The OCR result itself is
            # still applied only after the worker succeeds.
            if ocr_state.rows or ocr_state.detected_items:
                if ocr_workspace_store is None:
                    # Injected test/demo workspaces deliberately have no disk
                    # store. Real application sessions always have one.
                    logger.warning("Skipping pre-OCR restore point for an injected in-memory workspace")
                else:
                    start_button.disable()
                    start_button.set_text("正在创建恢复点……")
                    try:
                        prepared_restore_point = ocr_workspace_store.prepare(ocr_state)
                        await nicegui_run.io_bound(
                            ocr_workspace_store.create_restore_point,
                            prepared_restore_point,
                        )
                    except Exception:
                        logger.exception("Failed to create pre-OCR restore point")
                        start_button.set_text("开始识别")
                        start_button.enable()
                        set_ocr_busy(False)
                        ui.notify("无法创建识别前恢复点，本次识别尚未开始。", type="negative")
                        return
            client = ui.context.client
            import_task.task_id = uuid4().hex
            active_task_id = import_task.task_id
            import_task.client_id = str(getattr(client, "id", "local"))
            import_task.status = "running"
            import_task.started_at = perf_counter()
            import_task.stage = "准备任务"
            reset_import_task_transients(import_task, total_images=len(ocr_state.uploaded_images))
            start_button.disable()
            update_progress()
            await ui.run_javascript(
                "document.getElementById('yuanstar-task-progress')?.scrollIntoView({behavior:'smooth',block:'center'});"
            )
            loop = asyncio.get_running_loop()
            progress_events: asyncio.Queue[ImportProgressEvent] = asyncio.Queue()

            def background_progress(event: ImportProgressEvent) -> None:
                loop.call_soon_threadsafe(progress_events.put_nowait, event)

            worker = asyncio.create_task(
                run_import_transaction(ocr_state, pipeline, batch, ocr_overlap_pairs, progress=background_progress)
            )
            try:
                while not worker.done():
                    try:
                        update_progress(await asyncio.wait_for(progress_events.get(), timeout=.15))
                    except asyncio.TimeoutError:
                        update_progress()
                while not progress_events.empty():
                    update_progress(progress_events.get_nowait())
                outcome = await worker
                if active_task_id != import_task.task_id:
                    return
                if isinstance(outcome, ImportFailure):
                    raise RuntimeError(f"{outcome.error_type}: {outcome.message}\n{outcome.traceback}")
                result, accepted = outcome
                import_task.status = "succeeded"
                import_task.stage = "完成"
                start_button.set_text("开始识别")
                update_progress()
                if workspace_store is not None:
                    save_task = request_persist()
                    if save_task is not None:
                        saved = await save_task
                        if saved is False:
                            import_task.status = "failed"
                            import_task.stage = "自动保存失败"
                            import_task.error_summary = "结果仍在当前内存，但自动保存失败。"
                            update_progress()
                            refresh_review_sections()
                            ui.notify("结果仍在当前内存，但自动保存失败。", type="negative")
                            tabs.value = review_tab
                            tabs.update()
                            return
                refresh_review_sections()
                ui.notify(
                    f"{result.message}\n识别完成，养成计划已按新背包重新建立。可使用撤销功能恢复到本次识别前状态。",
                    type="positive",
                    multi_line=True,
                )
                tabs.value = review_tab
                tabs.update()
            except Exception as error:
                logger.exception("Local import task failed at stage %s", import_task.stage)
                if active_task_id == import_task.task_id:
                    import_task.status = "failed"
                    import_task.error_count += 1
                    import_task.error_summary = f"失败阶段：{import_task.stage}；{error}"
                    start_button.set_text("重试识别")
                    update_progress()
                    ui.notify("识别失败；当前数据、上传图片、分类和重叠标记已保留，可直接重试。", type="negative")
            finally:
                if active_task_id == import_task.task_id:
                    start_button.enable()
                    set_ocr_busy(False)

        with ui.dialog() as import_confirmation, ui.card():
            ui.label("重新识别将重建养成计划")
            ui.label("本次识别成功后，将使用新的识别结果替换当前背包，并将所有计划等级重置为新的当前等级。\n\n系统会在识别前创建恢复点。识别成功后，可以撤回到本次识别前的背包与计划状态。\n识别失败时，当前背包和计划不会发生变化。").classes("whitespace-pre-line")

            async def confirm_start_import() -> None:
                import_confirmation.close()
                set_ocr_busy(True)
                await start_import(confirmed=True)

            with ui.row():
                ui.button("取消", on_click=import_confirmation.close).props("flat")
                ui.button("开始识别", on_click=confirm_start_import).props("color=primary").mark("confirm-start-import")

        async def open_import_confirmation() -> None:
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能开始识别。", type="warning")
                return
            if state.rows or state.detected_items:
                import_confirmation.open()
            else:
                await start_import()

        @ui.refreshable
        def confirm_all_action() -> None:
            ui.button(
                "一键确认全部分类",
                on_click=confirm_all_pools,
            ).props("color=primary").set_enabled(
                not import_mutation_locked() and can_confirm_all_pools(
                    state.uploaded_images,
                    state.image_pools,
                    state.confirmed_image_pools,
                    processing=bool(processing_uploads),
                )
            ).mark("confirm-all-pools")

        with ui.element("div").classes("main-action-row").mark("main-import-actions"):
            confirm_all_action()
            clear_pending_button = ui.button(
                "清空待识别图片",
                on_click=clear_pending,
            ).props("flat").set_enabled(bool(state.uploaded_images)).mark("clear-pending-images")
            clear_pending_button.set_enabled(bool(state.uploaded_images) and not import_mutation_locked())
            import_mutation_elements.append(clear_pending_button)
            with ui.element("div").classes("import-primary-actions").mark("import-primary-actions"):
                restore_button = ui.button(
                    "恢复快照",
                    on_click=open_restore_dialog,
                    icon="restore",
                ).mark("import-restore-snapshots")
                restore_button.set_enabled(can_open_restore_dialog())
                restore_entry_elements["import"] = restore_button
                if not restore_points():
                    restore_button.tooltip("当前账号暂无可恢复快照")
                start_button = ui.button(
                    "开始识别",
                    on_click=open_import_confirmation,
                    icon="visibility",
                ).props("color=primary").mark("start-import")
                import_mutation_elements.append(start_button)
        ui.label(
            "识别成功后会替换当前已识别数据，并保留一个可撤回的恢复点。"
            "识别失败时，当前数据、上传图片、分类和重叠标记均会保留。"
        ).classes("text-orange w-full").mark("import-replacement-note")

    @ui.refreshable
    def reconciliation_summary() -> None:
        result = reconcile(state.rows, state.bag_current_count)
        ui.label(result.message.splitlines()[0]).classes("text-subtitle1")
        if result.difference not in (None, 0):
            ui.label("背包可能不完整，建议人工前往OCR模块复查。").classes("text-caption text-orange")

    @ui.refreshable
    def bag_info_section() -> None:
        with ui.element("div").classes("bag-info-grid w-full").mark("bag-info-ocr-grid"):
            with ui.card().classes("bag-info-panel compact-card w-full").mark("bag-info-panel"):
                ui.label("背包信息").classes("text-subtitle1")
                with ui.element("div").classes("bag-form-grid w-full").mark("bag-info-four-fields"):
                    if account_manager is not None:
                        metadata_version = ui.select(
                            [version.value for version in GameVersion],
                            value=state.game_version.value,
                            label="游戏版本",
                        ).props("dense").mark("bag-game-version")
                    else:
                        metadata_version = ui.select(
                            [version.value for version in GameVersion],
                            value=state.game_version.value,
                            label="游戏版本",
                        ).props("dense").mark("bag-game-version")
                    metadata_account = ui.input(
                        "账号名称",
                        value=state.account_name,
                        placeholder="当前账号名称",
                    ).props("dense").mark("bag-account-name")
                    metadata_count = ui.input(
                        "背包当前数量",
                        value="" if state.bag_current_count is None else str(state.bag_current_count),
                    ).props("dense")
                    metadata_capacity = ui.input(
                        "背包容量",
                        value="" if state.bag_capacity is None else str(state.bag_capacity),
                    ).props("dense")
                for metadata_control in (metadata_version, metadata_account, metadata_count, metadata_capacity):
                    metadata_control.set_enabled(not import_mutation_locked())

                async def save_metadata_from_bag(_=None) -> None:
                    if import_mutation_locked():
                        bag_info_section.refresh()
                        ui.notify("OCR 正在运行，完成或失败后才能修改账号信息。", type="warning")
                        return
                    if account_manager is not None:
                        await update_current_account_metadata(
                            str(metadata_account.value or ""),
                            str(metadata_version.value or ""),
                        )
                        return
                    state.save_game_version(metadata_version.value)
                    state.save_account_name(metadata_account.value)
                    request_persist()
                    import_page.refresh()

                metadata_version.on_value_change(save_metadata_from_bag)
                metadata_account.on("blur", save_metadata_from_bag)
                metadata_account.on("keydown.enter", save_metadata_from_bag)

                async def save_bag_info() -> None:
                    if import_mutation_locked():
                        bag_info_section.refresh()
                        ui.notify("OCR 正在运行，完成或失败后才能保存背包信息。", type="warning")
                        return
                    if account_manager is not None and not await update_current_account_metadata(
                        str(metadata_account.value or ""),
                        str(metadata_version.value or ""),
                        refresh_ui=False,
                    ):
                        bag_info_section.refresh()
                        return
                    try:
                        state.save_bag_info(
                            state.game_version.value,
                            metadata_count.value,
                            metadata_capacity.value,
                            account_name=state.account_name,
                        )
                    except ValueError as error:
                        ui.notify(str(error), type="negative")
                        return
                    request_persist()
                    ui.notify("背包信息已保存。", type="positive")
                    reconciliation_summary.refresh()
                    bag_info_section.refresh()
                    action_section.refresh()
                    import_page.refresh()

                ui.button("保存背包信息", on_click=save_bag_info).set_enabled(
                    not import_mutation_locked()
                ).mark("save-bag-info")

            with ui.card().classes("bag-info-panel bag-ocr-candidate-panel compact-card w-full").mark("bag-ocr-candidate-panel"):
                resolution = state.bag_resolution
                status = localized_status(resolution.get("status") or "未识别") if resolution else "未识别"
                confidence = resolution.get("confidence") if resolution else None
                confidence_text = f"{float(confidence):.1%}" if isinstance(confidence, (int, float)) else "未识别"
                raw_status = str(resolution.get("status") or "") if resolution else ""
                consistency = "不一致" if raw_status in {"候选冲突", "conflict"} else "一致" if resolution else "未评估"
                with ui.row().classes("w-full items-center justify-between no-wrap"):
                    ui.label("查看背包 OCR 候选").classes("text-subtitle1")
                    ui.label(
                        f"OCR 状态：{status} · {consistency} · 置信度 {confidence_text}"
                    ).classes("text-caption")
                warning = resolution.get("warning") if resolution else None
                if warning:
                    ui.label(f"提示：{localized_warning(warning)}").classes("text-orange text-caption")
                candidates = resolution.get("candidates") if resolution else []
                with ui.expansion("展开候选", value=False).classes("w-full").mark("bag-ocr-candidates"):
                    with ui.column().classes("bag-candidate-scroll w-full"):
                        if not isinstance(candidates, list) or not candidates:
                            ui.label("暂无背包 OCR 候选。").classes("text-grey")
                        else:
                            for candidate in candidates:
                                if not isinstance(candidate, dict):
                                    continue
                                candidate_confidence = candidate.get("confidence")
                                ui.label(
                                    f"数量 {candidate.get('bag_current_count', '未识别')} / "
                                    f"容量 {candidate.get('bag_capacity', '未识别')} · "
                                    f"置信度 {float(candidate_confidence):.1%}"
                                    if isinstance(candidate_confidence, (int, float))
                                    else f"数量 {candidate.get('bag_current_count', '未识别')} / "
                                    f"容量 {candidate.get('bag_capacity', '未识别')} · 置信度 未识别"
                                )

    @ui.refreshable
    def filter_and_table_section() -> None:
        with ui.row().classes("items-end w-full"):
            kind_filter = ui.select(
                ["全部", StarKind.MAIN.value, StarKind.SUPPORT.value],
                value=state.filter_kind,
                label="大类",
            ).classes("core-field").mark("kind-filter")
            quality_filter = ui.select(
                ["全部", *[quality.value for quality in Quality]],
                value=state.filter_quality,
                label="品质",
            ).classes("core-field").mark("quality-filter")
            name_filter = ui.input(
                "标准名称搜索（可用空格或逗号分隔）",
                value=state.filter_name,
            ).classes("name-field")

            def apply_filters() -> None:
                state.set_filters(kind_filter.value, quality_filter.value, name_filter.value or "")
                clear_experience_selection_if_filtered_out()
                inventory_table_controller.clear()
                filter_and_table_section.refresh()
                editor_section.refresh()
                experience_section.refresh()

            def apply_filters_from_enter(event: events.GenericEventArguments) -> None:
                details = event.args if isinstance(event.args, dict) else {}
                if details.get("key") == "Enter" and not details.get("isComposing"):
                    apply_filters()

            name_filter.mark("name-filter").on(
                "keydown",
                apply_filters_from_enter,
                args=["key", "isComposing"],
                js_handler=(
                    "event => { if (event.key === 'Enter' && !event.isComposing) "
                    "emit({key: event.key, isComposing: false}); }"
                ),
            )
            ui.button("应用筛选", on_click=apply_filters, icon="filter_alt").mark("apply-filters")

            def clear_filters() -> None:
                state.set_filters("全部", "全部", "")
                clear_experience_selection_if_filtered_out()
                review_view_state["current_editor_notice"] = None
                inventory_table_controller.clear()
                filter_and_table_section.refresh()
                editor_section.refresh()
                experience_section.refresh()

            ui.button("清除筛选", on_click=clear_filters).props("flat").mark("clear-filters")

        def display_rows() -> tuple[list[dict], list[dict]]:
            filtered_instances = state.filtered_rows()
            aggregate_by_name = bool(state.filter_name.strip())
            return (
                inventory_display_rows(filtered_instances, aggregate_by_name=aggregate_by_name),
                plan_display_rows(
                    filtered_instances,
                    state.plan_targets,
                    aggregate_by_name=aggregate_by_name,
                ),
            )

        table_rows, planned_rows = display_rows()
        if state.selected_row_id is not None and not any(row["id"] == state.selected_row_id for row in table_rows):
            state.selected_row_id = None
        selected_plan_id = review_view_state["selected_plan_row_id"]
        if selected_plan_id is not None and not any(
            row["star_instance_id"] == selected_plan_id for row in planned_rows
        ):
            review_view_state["selected_plan_row_id"] = None
        if (
            selected_experience_instance_id() is not None
            and not any(
                row["star_instance_id"] == selected_experience_instance_id()
                for row in table_rows
            )
        ):
            set_selected_experience_instance(None)

        def derive_row_visual_state(
            current_row_id: str | None = None,
            plan_row_id: str | None = None,
        ) -> tuple[list[dict], list[dict]]:
            nonlocal table_rows, planned_rows
            table_rows, planned_rows = display_rows()
            current_row_id = current_row_id or state.selected_row_id
            plan_row_id = plan_row_id or review_view_state["selected_plan_row_id"]
            selected_current_instance_id = next(
                (str(row["star_instance_id"]) for row in table_rows if row["id"] == current_row_id),
                None,
            )
            selected_plan_instance_id = next(
                (str(row["star_instance_id"]) for row in planned_rows if row["star_instance_id"] == plan_row_id),
                None,
            )
            current_rows_for_ui = []
            for source_row in table_rows:
                row = dict(source_row)
                row["star_description"] = catalog.description(str(row["name"]))
                row["row_highlight"] = (
                    "actual" if row["id"] == current_row_id
                    else "counterpart" if row["star_instance_id"] == selected_plan_instance_id
                    else ""
                )
                current_rows_for_ui.append(row)
            planned_rows_for_ui = []
            for source_row in planned_rows:
                row = dict(source_row)
                row["star_description"] = catalog.description(str(row["name"]))
                row["row_highlight"] = (
                    "actual" if row["star_instance_id"] == plan_row_id
                    else "counterpart" if row["star_instance_id"] == selected_current_instance_id
                    else ""
                )
                planned_rows_for_ui.append(row)
            return current_rows_for_ui, planned_rows_for_ui

        current_rows_for_ui, planned_rows_for_ui = derive_row_visual_state()
        selected_current_row = next((row for row in current_rows_for_ui if row["id"] == state.selected_row_id), None)
        selected_plan_row = next((row for row in planned_rows_for_ui if row["star_instance_id"] == review_view_state["selected_plan_row_id"]), None)

        def reload_rows_in_place() -> None:
            """Recompute both table models without replacing either Quasar table."""
            nonlocal current_rows_for_ui, planned_rows_for_ui, selected_current_row, selected_plan_row
            current_row_id = state.selected_row_id
            plan_row_id = review_view_state["selected_plan_row_id"]
            current_rows_for_ui, planned_rows_for_ui = derive_row_visual_state(current_row_id, plan_row_id)
            selected_current_row = next(
                (row for row in current_rows_for_ui if row["id"] == current_row_id),
                None,
            )
            selected_plan_row = next(
                (row for row in planned_rows_for_ui if row["star_instance_id"] == plan_row_id),
                None,
            )
            if current_row_id is not None and selected_current_row is None:
                state.selected_row_id = None
            if plan_row_id is not None and selected_plan_row is None:
                review_view_state["selected_plan_row_id"] = None
            table.rows = current_rows_for_ui
            plan_table.rows = planned_rows_for_ui
            table.selected = [selected_current_row] if selected_current_row is not None else []
            plan_table.selected = [selected_plan_row] if selected_plan_row is not None else []
            current_inventory_title.set_text(f"当前背包（{len(table_rows)} 颗）")
            planned_inventory_title.set_text(f"计划背包（对应 {len(planned_rows)} 颗）")
            table.update()
            plan_table.update()

        def refresh_row_visual_state() -> None:
            reload_rows_in_place()

        def follow_instance_after_sort(instance_id: str, target_index: int) -> None:
            """Follow once after rows have reached the mounted QTables."""
            if not any(row["star_instance_id"] == instance_id for row in current_rows_for_ui):
                return
            state.selected_row_id = instance_id
            review_view_state["selected_plan_row_id"] = None
            set_selected_experience_instance(instance_id)
            reload_rows_in_place()

            def scroll_after_table_update() -> None:
                # Quasar QVirtualScroll accepts the edge argument. Running on
                # the one-shot next tick puts this behind the rows/selection
                # updates in the client outbox without introducing a delay or
                # a persistent cross-table sync listener.
                # Preserve the genuine target index for state and highlights,
                # but scroll one row earlier so the sticky header cannot cover it.
                scroll_index = max(0, target_index - 1)
                table.run_method("scrollTo", scroll_index, "start")
                plan_table.run_method("scrollTo", scroll_index, "start")

            ui.timer(0, scroll_after_table_update, once=True, immediate=False)

        def clear_current_selection() -> None:
            state.selected_row_id = None
            table.selected = []
            table.update()

        def clear_plan_selection() -> None:
            review_view_state["selected_plan_row_id"] = None
            plan_table.selected = []
            plan_table.update()

        def align_counterpart_view_once(source_table_class: str, target_table_class: str) -> None:
            """Copy one table viewport once; never synchronize inventory business values."""
            ui.run_javascript(inventory_viewport_alignment_script(source_table_class, target_table_class))

        def select_row(event: events.TableSelectionEventArguments) -> None:
            if review_view_state.get("plan_input_blocked"):
                ui.notify("请先处理计划等级确认。", type="warning")
                refresh_row_visual_state()
                return
            if not commit_current_editor_if_dirty():
                refresh_row_visual_state()
                return
            if event.selection:
                state.selected_row_id = event.selection[0]["id"]
                clear_plan_selection()
                set_selected_experience_instance(event.selection[0]["star_instance_id"])
                review_view_state["current_editor_notice"] = None
                align_counterpart_view_once(".current-inventory-table", ".planned-inventory-table")
            else:
                state.selected_row_id = None
                set_selected_experience_instance(None)
            refresh_row_visual_state()
            editor_section.refresh()
            experience_section.refresh()

        def select_clicked_row(event: events.GenericEventArguments) -> None:
            if review_view_state.get("plan_input_blocked"):
                ui.notify("请先处理计划等级确认。", type="warning")
                refresh_row_visual_state()
                return
            row = event.args
            if isinstance(row, dict) and "id" in row:
                if not commit_current_editor_if_dirty():
                    refresh_row_visual_state()
                    return
                state.selected_row_id = row["id"]
                table.selected = [row]
                table.update()
                clear_plan_selection()
                set_selected_experience_instance(row["star_instance_id"])
                review_view_state["current_editor_notice"] = None
                refresh_row_visual_state()
                align_counterpart_view_once(".current-inventory-table", ".planned-inventory-table")
                editor_section.refresh()
                experience_section.refresh()

        def select_plan_row(event: events.TableSelectionEventArguments) -> None:
            if review_view_state.get("plan_input_blocked"):
                ui.notify("请先处理计划等级确认。", type="warning")
                refresh_row_visual_state()
                return
            if not commit_current_editor_if_dirty():
                refresh_row_visual_state()
                return
            if event.selection:
                review_view_state["selected_plan_row_id"] = event.selection[0]["star_instance_id"]
                clear_current_selection()
                set_selected_experience_instance(event.selection[0]["star_instance_id"])
                align_counterpart_view_once(".planned-inventory-table", ".current-inventory-table")
                editor_section.refresh()
            else:
                review_view_state["selected_plan_row_id"] = None
                set_selected_experience_instance(None)
            refresh_row_visual_state()
            experience_section.refresh()

        def select_clicked_plan_row(event: events.GenericEventArguments) -> None:
            if review_view_state.get("plan_input_blocked"):
                ui.notify("请先处理计划等级确认。", type="warning")
                refresh_row_visual_state()
                return
            row = event.args
            if isinstance(row, dict) and "star_instance_id" in row:
                if not commit_current_editor_if_dirty():
                    refresh_row_visual_state()
                    return
                review_view_state["selected_plan_row_id"] = row["star_instance_id"]
                plan_table.selected = [row]
                plan_table.update()
                clear_current_selection()
                set_selected_experience_instance(row["star_instance_id"])
                refresh_row_visual_state()
                align_counterpart_view_once(".planned-inventory-table", ".current-inventory-table")
                editor_section.refresh()
                experience_section.refresh()

        with ui.element("div").classes("review-grid w-full").mark("inventory-plan-grid"):
            with ui.card().classes("review-column w-full").mark("current-inventory-column"):
                current_inventory_title = ui.label(f"当前背包（{len(table_rows)} 颗）").classes("text-h6")
                table = ui.table(
                    columns=[
                        {"name": "kind", "label": "大类", "field": "kind", "align": "left", "style": "width:20%"},
                        {"name": "name", "label": "标准名称", "field": "name", "align": "left", "style": "width:20%"},
                        {"name": "level", "label": "等级", "field": "level", "align": "right", "style": "width:20%"},
                        {"name": "quality", "label": "品质", "field": "quality", "align": "center", "style": "width:20%"},
                        {"name": "group_quantity", "label": "数量", "field": "group_quantity", "align": "right", "style": "width:20%"},
                    ],
                    rows=current_rows_for_ui,
                    row_key="id",
                    selection="single",
                    on_select=select_row,
                ).props(
                    "dense flat bordered hide-bottom virtual-scroll wrap-cells"
                ).classes("inventory-table business-five-columns current-inventory-table w-full").mark("current-inventory-table")
                divider_class = (
                    "props.rowIndex > 0 && props.row.kind_start ? 'kind-divider-cell' : "
                    "(props.rowIndex > 0 && props.row.group_start ? 'group-divider-cell' : '')"
                )
                for column_name in ("kind", "level", "group_quantity"):
                    table.add_slot(
                        f"body-cell-{column_name}",
                        f"""
                        <q-td :props="props" :class="{divider_class}">
                          {{{{ props.value }}}}
                        </q-td>
                        """,
                    )
                table.add_slot(
                    "body-cell-name",
                    f"""
                    <q-td :props="props" :class="{divider_class}" :data-yuanstar-row-highlight="props.row.row_highlight">
                      <span v-if="props.row.star_description" class="star-description-trigger">
                        {{{{ props.value }}}}
                        <q-tooltip class="star-description-tooltip">{{{{ props.row.star_description }}}}</q-tooltip>
                      </span>
                      <span v-else>{{{{ props.value }}}}</span>
                    </q-td>
                    """,
                )
                table.add_slot(
                    "body-cell-quality",
                    f"""
                    <q-td :props="props" :class="{divider_class}">
                      <q-badge :color="({{橙:'orange-8',紫:'purple-7',蓝:'blue-7',绿:'green-7',白:'grey-6'}})[props.value] || 'grey-6'">
                        {{{{ props.value }}}}
                      </q-badge>
                    </q-td>
                    """,
                )
                selected_table_row = selected_current_row
                if selected_table_row:
                    table.selected = [selected_table_row]
                table.on("rowClick", select_clicked_row, js_handler="(_, row) => emit(row)")
                table.on("rowDblclick", select_clicked_row, js_handler="(_, row) => emit(row)")
                if not table_rows:
                    ui.label("未找到符合条件的星石。")

            with ui.card().classes("review-column w-full").mark("planned-inventory-column"):
                planned_inventory_title = ui.label(f"计划背包（对应 {len(planned_rows)} 颗）").classes("text-h6")
                plan_table = ui.table(
                    columns=[
                        {"name": "kind", "label": "大类", "field": "kind", "align": "left", "style": "width:20%"},
                        {"name": "name", "label": "标准名称", "field": "name", "align": "left", "style": "width:20%"},
                        {"name": "level", "label": "计划等级", "field": "level", "align": "right", "style": "width:20%"},
                        {"name": "quality", "label": "品质", "field": "quality", "align": "center", "style": "width:20%"},
                        {"name": "group_quantity", "label": "数量", "field": "group_quantity", "align": "right", "style": "width:20%"},
                    ],
                    rows=planned_rows_for_ui,
                    row_key="star_instance_id",
                    selection="single",
                    on_select=select_plan_row,
                ).props(
                    "dense flat bordered hide-bottom virtual-scroll wrap-cells"
                ).classes("inventory-table business-five-columns planned-inventory-table w-full").mark("planned-inventory-table")
                plan_divider_class = (
                    "props.rowIndex > 0 && props.row.kind_start ? 'kind-divider-cell' : "
                    "(props.rowIndex > 0 && props.row.group_start ? 'group-divider-cell' : '')"
                )
                for column_name in ("kind", "level", "group_quantity"):
                    plan_table.add_slot(
                        f"body-cell-{column_name}",
                        f"""
                        <q-td :props="props" :class="{plan_divider_class}">
                          {{{{ props.value }}}}
                        </q-td>
                        """,
                    )
                plan_table.add_slot(
                    "body-cell-name",
                    f"""
                    <q-td :props="props" :class="{plan_divider_class}" :data-yuanstar-row-highlight="props.row.row_highlight">
                      <span v-if="props.row.star_description" class="star-description-trigger">
                        {{{{ props.value }}}}
                        <q-tooltip class="star-description-tooltip">{{{{ props.row.star_description }}}}</q-tooltip>
                      </span>
                      <span v-else>{{{{ props.value }}}}</span>
                    </q-td>
                    """,
                )
                if selected_plan_row:
                    plan_table.selected = [selected_plan_row]
                plan_table.on(
                    "rowClick",
                    select_clicked_plan_row,
                    js_handler="(_, row) => emit(row)",
                )
                plan_table.add_slot(
                    "body-cell-quality",
                    f"""
                    <q-td :props="props" :class="{plan_divider_class}">
                      <q-badge :color="({{橙:'orange-8',紫:'purple-7',蓝:'blue-7',绿:'green-7',白:'grey-6'}})[props.value] || 'grey-6'">
                        {{{{ props.value }}}}
                      </q-badge>
                    </q-td>
                    """,
                )

        # The controller is replaced whenever a filter/account rebuild creates
        # new table elements. Ordinary edits only replace these table models.
        inventory_table_controller["reload_rows"] = reload_rows_in_place
        inventory_table_controller["follow_instance"] = follow_instance_after_sort

    def ocr_summary_text() -> tuple[str, str | None, int]:
        counts = review_counts(state.detected_items, len(state.rows))
        pending = pending_review_count(state.detected_items)
        title = (
            f"OCR图片人工复核 | 待审查 {pending} | 检测实例 {counts['detected_occurrence_count']} | "
            f"字段完整实例 {counts['fully_resolved_count']} | 已排除 {counts['excluded_count']} | "
            f"重叠合并 {counts['overlap_duplicate_count']}"
        )
        return title, None, pending

    def update_ocr_expansion_header() -> None:
        title, caption, pending = ocr_summary_text()
        expansion = review_expansions.get("ocr")
        if expansion is not None:
            expansion.set_text(title)
            expansion._props.pop("caption", None)
            previous = review_view_state.get("pending_count")
            if isinstance(previous, int) and previous > 0 and pending == 0:
                expansion.close()
            expansion.update()
        review_view_state["pending_count"] = pending

    def reload_inventory_tables_in_place() -> None:
        """Update the live table models, with one logged rebuild fallback."""
        reload_rows = inventory_table_controller.get("reload_rows")
        if callable(reload_rows):
            reload_rows()
            return
        logger.warning("inventory table controller missing; rebuilding inventory tables once")
        inventory_table_controller.clear()
        filter_and_table_section.refresh()

    def refresh_review_sections() -> None:
        reconciliation_summary.refresh()
        bag_info_section.refresh()
        reload_inventory_tables_in_place()
        editor_section.refresh()
        experience_section.refresh()
        action_section.refresh()
        ocr_review_section.refresh()
        update_ocr_expansion_header()

    @ui.refreshable
    def ocr_review_section() -> None:
        if not state.detected_items and not state.image_audit:
            ui.label("尚无本机 OCR 结果。完整、待审查与已排除卡片会在此按来源显示。")
            return

        counts = review_counts(state.detected_items, len(state.rows))
        marked_pair_count = sum(len(pairs) for pairs in state.overlap_pairs.values())
        if marked_pair_count and counts["overlap_duplicate_count"] == 0:
            reasons = [
                str(item.get("reason"))
                for item in state.overlap_audit
                if item.get("reason")
            ]
            reason_text = (
                "；".join(dict.fromkeys(localized_warning(item) for item in reasons))
                if reasons
                else "OCR 结果尚未应用这些关系"
            )
            ui.label(
                f"已标记 {marked_pair_count} 组重叠但当前合并为 0：{reason_text}。"
            ).classes("text-orange")

        def refresh_after_card_change() -> None:
            request_persist()
            ui.notify("人工结果已保存并完成自动重算。", type="positive")
            refresh_review_sections()

        def set_action(card_id: str, action: str) -> None:
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能修改 OCR 核对结果。", type="warning")
                return
            try:
                state.set_card_inventory_action(card_id, action)
            except ValueError as error:
                ui.notify(str(error), type="negative")
                return
            refresh_after_card_change()

        def edit_dialog_for(candidate) -> object:
            with ui.dialog() as dialog, ui.card():
                ui.label(f"人工修改 {localized_position(candidate.source_position)}")
                name = ui.select(
                    [*state.catalog.names_for_kind(StarKind.MAIN), *state.catalog.names_for_kind(StarKind.SUPPORT)],
                    value=candidate.final_name, label="标准名称",
                )
                level = ui.input("等级", value="" if candidate.final_level is None else str(candidate.final_level))
                quality = ui.select([value.value for value in Quality], value=candidate.final_quality.value if candidate.final_quality else None, label="品质")

                def save_card() -> None:
                    if workspace_mutation_locked():
                        ui.notify("当前工作区正在处理，暂不能保存人工核对。", type="warning")
                        return
                    try:
                        state.update_detected_card(candidate.card_id or "", name=name.value, level=level.value, quality=quality.value)
                    except (TypeError, ValueError) as error:
                        ui.notify(str(error), type="negative")
                        return
                    dialog.close()
                    refresh_after_card_change()

                with ui.row():
                    ui.button("取消", on_click=dialog.close).props("flat")
                    ui.button("保存人工值", on_click=save_card).props("color=primary")
            return dialog

        summaries = review_image_summaries(state)
        with ui.column().classes("review-summary-scroll w-full gap-1").mark("ocr-review-two-row-scroll"):
            for summary in summaries:
                with ui.card().classes("w-full py-2 px-3"):
                    with ui.row().classes("w-full items-center justify-between no-wrap"):
                        with ui.column().classes("gap-0 min-w-0"):
                            ui.label(str(summary["filename"])).classes("text-weight-medium")
                            ui.label(
                                f"页面类型：{summary['page_type_label']} · 候选总数：{summary['detected_occurrence_count']}"
                            ).classes("text-caption")
                        with ui.row().classes("items-center no-wrap"):
                            ui.label(f"待审查 {summary['pending_count']}")
                            ui.label(f"已排除 {summary['excluded_count']}")
                            ui.label(f"重叠重复 {summary['overlap_duplicate_count']}")

                            def toggle_expanded(image_id: str = str(summary["image_id"])) -> None:
                                review_view_state["expanded_image_id"] = (
                                    None
                                    if review_view_state["expanded_image_id"] == image_id
                                    else image_id
                                )
                                review_view_state["show_all_cards"] = False
                                ocr_review_section.refresh()

                            ui.button(
                                "收起" if review_view_state["expanded_image_id"] == summary["image_id"] else "展开",
                                on_click=toggle_expanded,
                            ).props("flat dense").mark("ocr-review-expand")

        expanded = next(
            (
                summary for summary in summaries
                if summary["image_id"] == review_view_state["expanded_image_id"]
            ),
            None,
        )
        if expanded:
            image_items = [
                item for item in state.detected_items
                if item.source_image == expanded["image_id"]
            ]
            source_image = next(
                (
                    image for image in state.uploaded_images
                    if image.id == expanded["image_id"]
                ),
                None,
            )
            with ui.card().classes("review-expansion-body w-full").mark("ocr-review-expanded"):
                with ui.row().classes("w-full items-center justify-between"):
                    ui.label(f"展开复核：{expanded['filename']}").classes("text-subtitle2")
                    if source_image is not None:
                        ui.button(
                            "查看整页",
                            on_click=lambda image_id=source_image.id, pool=str(expanded["page_type"]): open_full_preview(image_id, pool),
                            icon="open_in_full",
                        ).props("flat").mark("ocr-view-full-page")
                if expanded["warnings"]:
                    ui.label(
                        "图片提示：" + "；".join(localized_warning(item) for item in expanded["warnings"])
                    ).classes("text-orange")
                bag_current = expanded.get("bag_current_count")
                bag_capacity = expanded.get("bag_capacity")
                bag_confidence = expanded.get("bag_confidence")
                ui.label(
                    f"背包数量/容量：{bag_current if bag_current is not None else '未识别'} / "
                    f"{bag_capacity if bag_capacity is not None else '未识别'} · "
                    f"置信度：{float(bag_confidence):.1%}" if isinstance(bag_confidence, (int, float))
                    else f"背包数量/容量：{bag_current if bag_current is not None else '未识别'} / "
                    f"{bag_capacity if bag_capacity is not None else '未识别'} · 置信度：未识别"
                )

                experience = expanded.get("experience")
                if expanded["page_type"] == "experience" and isinstance(experience, dict):
                    ui.label("经验星石识别结果").classes("text-subtitle2")
                    for label, value_key, confidence_key in (
                        ("橙星曜", "orange_count", "orange_confidence"),
                        ("紫星曜", "purple_count", "purple_confidence"),
                        ("白星曜", "white_count", "white_confidence"),
                    ):
                        value = experience.get(value_key)
                        confidence = experience.get(confidence_key)
                        ui.label(
                            f"{label}：{value if value is not None else '未识别'} · "
                            f"来源：{experience.get('source_filename') or expanded['filename']} · "
                            f"置信度：{float(confidence):.1%}" if isinstance(confidence, (int, float))
                            else f"{label}：{value if value is not None else '未识别'} · "
                            f"来源：{experience.get('source_filename') or expanded['filename']} · 置信度：未识别"
                        )
                else:
                    pending_items = [
                        item for item in image_items
                        if item_needs_review(item)
                    ]
                    visible_items = image_items if review_view_state["show_all_cards"] else pending_items
                    if not review_view_state["show_all_cards"]:
                        ui.label("优先显示待审查卡片；完整卡片默认收起。").classes("text-caption text-grey")

                        def show_all_cards() -> None:
                            review_view_state["show_all_cards"] = True
                            ocr_review_section.refresh()

                        ui.button("查看全部卡片", on_click=show_all_cards).props("flat").mark("ocr-review-show-all")
                    if not visible_items:
                        ui.label("当前没有待审查卡片。")
                    with ui.element("div").classes("ocr-candidate-grid w-full").mark("ocr-review-candidate-grid"):
                        for item in visible_items:
                            if item.inventory_action != "keep":
                                status = "已排除"
                            elif item.overlap_duplicate_of:
                                status = "重叠重复"
                            elif item.is_complete_card and item.final_name and item.final_level and item.final_quality:
                                status = "完整"
                            else:
                                status = "待审查"
                            with ui.card().classes("w-full compact-card").mark("ocr-review-candidate"):
                                ui.label(
                                    f"{localized_position(item.source_position)} · {status} · "
                                    f"{item.final_name or '未识别'} · "
                                    f"{str(item.final_level) + '级' if item.final_level is not None else '未识别'} · "
                                    f"{item.final_quality.value if item.final_quality else '未识别'}"
                                ).classes("text-weight-medium")
                                if item.field_warnings:
                                    ui.label(
                                        "；".join(localized_warning(warning) for warning in item.field_warnings)
                                    ).classes("text-orange text-caption")
                                crop_preview = (
                                    row_crop_data_url(source_image, item.row_crop_box)
                                    if source_image is not None
                                    else None
                                )
                                if crop_preview:
                                    ui.image(crop_preview).classes("ocr-row-preview").mark("ocr-row-preview")
                                else:
                                    ui.label(
                                        "行级裁切范围不足，请查看整页。"
                                    ).classes("text-orange text-caption").mark("ocr-row-preview-unavailable")
                                with ui.row().classes("items-center w-full"):
                                    if source_image is not None:
                                        ui.button(
                                            "查看整页",
                                            on_click=lambda image_id=source_image.id, pool=str(expanded["page_type"]): open_full_preview(image_id, pool),
                                        ).props("flat dense").mark("ocr-candidate-full-page")
                                    ui.button(
                                        "保留",
                                        on_click=lambda card_id=item.card_id or "": set_action(card_id, "keep"),
                                    ).props("flat dense")
                                    ui.button(
                                        "忽略残片",
                                        on_click=lambda card_id=item.card_id or "": set_action(card_id, "exclude_fragment"),
                                    ).props("flat dense color=warning").mark("exclude-fragment")
                                    ui.button(
                                        "删除错误框",
                                        on_click=lambda card_id=item.card_id or "": set_action(card_id, "exclude_false_box"),
                                    ).props("flat dense color=negative").mark("exclude-false-box")
                                    edit_dialog = edit_dialog_for(item)
                                    ui.button(
                                        "人工修改",
                                        on_click=edit_dialog.open,
                                    ).props("flat dense").mark("manual-card-edit")

    @ui.refreshable
    def editor_section() -> None:
        nonlocal current_save_status_element
        selected_plan_id = review_view_state.get("selected_plan_row_id")
        plan_editing = (
            next((row for row in state.rows if row.star_instance_id == selected_plan_id), None)
            if selected_plan_id else None
        )
        if plan_editing is not None:
            nonlocal plan_save_status_element
            current_save_status_element = None
            if current_editor_controller.get("token"):
                ui.run_javascript("window.__yuanstarCurrentEditorOutsideCleanup?.();")
            current_editor_controller.clear()
            ui.label(f"正在编辑：计划背包实例 {plan_editing.star_instance_id}").classes("text-subtitle1").mark("plan-editor-status")
            with ui.row().classes("items-end w-full").mark("plan-editor-fields"):
                ui.input("大类", value=plan_editing.kind.value).classes("core-field").set_enabled(False)
                name_input = ui.input("标准名称", value=plan_editing.name).classes("name-field").set_enabled(False)
                name_input.tooltip(catalog.description(plan_editing.name) or plan_editing.name)
                current_level_input = ui.input("当前等级", value=str(plan_editing.level)).classes("core-field").set_enabled(False)
                target_input = ui.input(
                    "计划等级", value=str(state.plan_level(plan_editing.star_instance_id)),
                ).classes("core-field").set_enabled(
                    not workspace_mutation_locked()
                ).mark("plan-level-input")
                ui.input("品质", value=plan_editing.quality.value).classes("core-field").set_enabled(False)

            pending_low_level: dict[str, int] = {}

            def refresh_after_plan_change() -> None:
                set_plan_save_status("正在保存…")
                task = request_persist()
                reload_inventory_tables_in_place()
                experience_section.refresh()
                action_section.refresh()
                _ = task

            def apply_plan_level() -> bool:
                if workspace_mutation_locked():
                    ui.notify("当前工作区正在处理，暂不能修改计划等级。", type="warning")
                    return False
                try:
                    proposed = parse_integer(target_input.value, label="计划等级", minimum=1, maximum=60)
                except (TypeError, ValueError) as error:
                    ui.notify(str(error), type="negative")
                    target_input.value = str(state.plan_level(plan_editing.star_instance_id))
                    target_input.update()
                    return False
                if proposed < plan_editing.level:
                    pending_low_level["value"] = proposed
                    review_view_state["plan_input_blocked"] = True
                    low_level_confirmation.open()
                    return False
                try:
                    changed = state.set_plan_level(plan_editing.star_instance_id, proposed)
                except ValueError as error:
                    ui.notify(str(error), type="negative")
                    return False
                if changed:
                    refresh_after_plan_change()
                return True

            def confirm_lower_current_level() -> None:
                if workspace_mutation_locked():
                    ui.notify("当前工作区正在处理，暂不能修改计划等级。", type="warning")
                    return
                proposed = pending_low_level.get("value")
                if proposed is None:
                    low_level_confirmation.close()
                    return
                state.correct_current_and_plan_level(plan_editing.star_instance_id, proposed)
                current_level_input.value = str(proposed)
                current_level_input.update()
                review_view_state["plan_input_blocked"] = False
                low_level_confirmation.close()
                refresh_after_plan_change()

            def restore_input_to_effective(*, close: bool = True) -> None:
                review_view_state["plan_input_blocked"] = False
                target_input.value = str(state.plan_level(plan_editing.star_instance_id))
                target_input.update()
                if close:
                    low_level_confirmation.close()

            with ui.dialog() as low_level_confirmation, ui.card():
                ui.label(f"计划等级不能低于当前等级 {plan_editing.level}。")
                ui.label("你输入的计划等级将同时修正当前背包等级。是否继续？")
                with ui.row():
                    ui.button("修正当前等级", on_click=confirm_lower_current_level).props("color=primary")
                    ui.button("恢复原有效计划等级", on_click=restore_input_to_effective).props("flat")
            low_level_confirmation.on("hide", lambda _: restore_input_to_effective(close=False))

            target_input.on("blur", lambda _: apply_plan_level())
            target_input.on("keydown.enter", lambda _: apply_plan_level())

            def restore_current() -> None:
                if workspace_mutation_locked():
                    ui.notify("当前工作区正在处理，暂不能修改计划等级。", type="warning")
                    return
                if state.restore_plan_to_current(plan_editing.star_instance_id):
                    refresh_after_plan_change()

            def quick_60() -> None:
                if workspace_mutation_locked():
                    ui.notify("当前工作区正在处理，暂不能修改计划等级。", type="warning")
                    return
                if state.plan_level_60(plan_editing.star_instance_id):
                    refresh_after_plan_change()

            def reset_all() -> None:
                if workspace_mutation_locked():
                    ui.notify("当前工作区正在处理，暂不能修改计划等级。", type="warning")
                    return
                if state.reset_all_plan_targets():
                    reset_confirmation.close()
                    refresh_after_plan_change()

            with ui.dialog() as reset_confirmation, ui.card():
                ui.label("确定将当前账号的全部计划等级恢复为当前背包等级吗？")
                ui.label("此操作会清除当前账号已有的全部养成计划，但可以通过撤销恢复。")
                with ui.row():
                    ui.button("确认重置", on_click=reset_all).props("color=primary")
                    ui.button("取消", on_click=reset_confirmation.close).props("flat")

            with ui.row().classes("items-center w-full").mark("plan-editor-actions"):
                ui.button("恢复为当前等级", on_click=restore_current).set_enabled(
                    state.plan_level(plan_editing.star_instance_id) != plan_editing.level and not workspace_mutation_locked()
                ).mark("plan-restore-current")
                ui.button("快捷计划60级", on_click=quick_60).set_enabled(
                    plan_editing.level < 60 and state.plan_level(plan_editing.star_instance_id) < 60 and not workspace_mutation_locked()
                ).mark("plan-level-60")
                ui.button("重置全部计划", on_click=reset_confirmation.open).set_enabled(
                    any(state.plan_level(row.star_instance_id) > row.level for row in state.rows) and not workspace_mutation_locked()
                ).mark("plan-reset-all")
                plan_save_status_element = ui.label(str(review_view_state["plan_save_status"])).classes(
                    "text-caption q-ml-auto " + (
                        "text-negative text-weight-bold"
                        if review_view_state["plan_save_status"] == "保存失败，请重试"
                        else "text-grey"
                    )
                ).mark("plan-save-status")
            return

        editing = state.selected_row()
        if editing is None:
            if current_editor_controller.get("token"):
                ui.run_javascript("window.__yuanstarCurrentEditorOutsideCleanup?.();")
            current_editor_controller.clear()
        ui.label(
            f"正在编辑：当前背包实例 {editing.star_instance_id}" if editing else "正在新增：当前背包"
        ).classes("text-subtitle1").mark("manual-editor-status")
        notice = review_view_state.get("current_editor_notice")
        if isinstance(notice, str) and notice:
            ui.label(notice).classes("text-warning text-weight-medium").mark("current-editor-notice")
        default_kind = editing.kind if editing else StarKind.MAIN
        default_names = state.catalog.names_for_kind(default_kind)
        editor_session_token = uuid4().hex if editing else None
        with ui.row().props("id=yuanstar-current-editor-fields").classes("items-end w-full").mark("manual-editor-fields") as current_editor_fields:
            kind = ui.select(
                [StarKind.MAIN.value, StarKind.SUPPORT.value],
                value=default_kind.value,
                label="大类",
            ).classes("core-field").mark("manual-kind-select")
            name = ui.select(
                default_names,
                label="标准名称",
                value=editing.name if editing else default_names[0],
            ).classes("name-field").mark("manual-name-select")
            level = ui.input(
                "等级",
                value=str(editing.level if editing else 1),
            ).classes("core-field").mark("manual-level-input")
            quality = ui.select(
                [item.value for item in Quality],
                value=(editing.quality if editing else Quality.ORANGE).value,
                label="品质",
            ).classes("core-field").mark("manual-quality-select")
            quantity = ui.input(
                "新增颗数",
                value="1",
            ).classes("core-field").set_enabled(editing is None)

        if editor_session_token is not None:
            kind.props(f"id=yuanstar-current-editor-kind data-yuanstar-editor-token={editor_session_token}")
            name.props(f"id=yuanstar-current-editor-name data-yuanstar-editor-token={editor_session_token}")
            quality.props(f"id=yuanstar-current-editor-quality data-yuanstar-editor-token={editor_session_token}")

        def update_name_options(_=None) -> None:
            names = state.catalog.names_for_kind(StarKind(kind.value))
            name.options = names
            name.value = names[0]
            name.update()
            if current_editor_controller.get("token") == editor_session_token:
                current_editor_controller["dirty"] = True

        kind.on("update:model-value", update_name_options)

        def build_row() -> InventorySummaryRow:
            return InventorySummaryRow(
                kind=StarKind(kind.value),
                name=name.value,
                level=parse_integer(level.value, label="等级", minimum=1, maximum=60),
                quality=Quality(quality.value),
                quantity=1 if editing else parse_integer(quantity.value, label="新增颗数", minimum=1),
                source_image=editing.source_image if editing else None,
                source_position=editing.source_position if editing else None,
                occurrence_id=editing.occurrence_id if editing else None,
                manual_status="人工修改" if editing else "人工新增",
                upload_batch_index=editing.upload_batch_index if editing else 0,
                source_image_index=editing.source_image_index if editing else 0,
                row_index=editing.row_index if editing else 0,
                column_index=editing.column_index if editing else 0,
            )

        editor_target_id = editing.star_instance_id if editing else None

        def current_editor_signature(row: InventorySummaryRow) -> tuple[str, str, str, int, str]:
            return (row.star_instance_id, row.kind.value, row.name, row.level, row.quality.value)

        def restore_current_editor_values() -> None:
            target = next((row for row in state.rows if row.star_instance_id == editor_target_id), None)
            if target is None:
                editor_section.refresh()
                return
            kind.value = target.kind.value
            names = state.catalog.names_for_kind(target.kind)
            name.options = names
            name.value = target.name
            level.value = str(target.level)
            quality.value = target.quality.value
            for control in (kind, name, level, quality):
                control.update()

        def commit_current_editor() -> bool:
            if editor_target_id is None or editor_session_token is None:
                return True
            if current_editor_controller.get("token") != editor_session_token:
                # A delayed browser event belongs to a replaced editor.
                return True
            if not bool(current_editor_controller.get("dirty")):
                return True
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能修改背包。", type="warning")
                return False
            target = next((row for row in state.rows if row.star_instance_id == editor_target_id), None)
            if target is None:
                current_editor_controller.clear()
                editor_section.refresh()
                return True
            try:
                proposed_kind = StarKind(str(kind.value))
                proposed_name = str(name.value or "")
                if proposed_name not in state.catalog.names_for_kind(proposed_kind):
                    raise ValueError("标准名称不属于当前大类。")
                proposed_level = parse_integer(level.value, label="等级", minimum=1, maximum=60)
                proposed_quality = Quality(str(quality.value))
            except (TypeError, ValueError) as error:
                ui.notify(f"当前背包编辑未保存：{error}", type="negative")
                restore_current_editor_values()
                current_editor_controller["dirty"] = False
                return False
            proposed = target.model_copy(update={
                "kind": proposed_kind,
                "name": proposed_name,
                "level": proposed_level,
                "quality": proposed_quality,
            })
            signature = current_editor_signature(proposed)
            if signature == current_editor_signature(target):
                current_editor_controller["dirty"] = False
                current_editor_controller["last_committed_signature"] = signature
                return True
            before = current_instance_display_position(state, editor_target_id)
            try:
                state.update_row(editor_target_id, proposed)
            except (TypeError, ValueError) as error:
                ui.notify(f"当前背包编辑未保存：{error}", type="negative")
                restore_current_editor_values()
                return False
            current_editor_controller["dirty"] = False
            current_editor_controller["last_committed_signature"] = signature
            after = current_instance_display_position(state, editor_target_id)
            was_filtered_out = before.visible_after_filter and not after.visible_after_filter
            if was_filtered_out:
                state.selected_row_id = None
                review_view_state["selected_plan_row_id"] = None
                set_selected_experience_instance(None)
                review_view_state["current_editor_notice"] = "该实例已更新，但不再符合当前筛选条件。"
                ui.run_javascript("window.__yuanstarCurrentEditorOutsideCleanup?.();")
                current_editor_controller.clear()
            else:
                state.selected_row_id = editor_target_id
                set_selected_experience_instance(editor_target_id)
            set_current_save_status("正在保存…")
            save_task = request_persist(current_editor_save=True)
            if save_task is None:
                set_current_save_status("已自动保存")
            reconciliation_summary.refresh()
            bag_info_section.refresh()
            reload_inventory_tables_in_place()
            experience_section.refresh()
            action_section.refresh()
            update_ocr_expansion_header()
            if was_filtered_out:
                editor_section.refresh()
                ui.notify("该实例已更新，但不再符合当前筛选条件。", type="warning", timeout=8000)
            elif (
                before.uniquely_addressable
                and after.uniquely_addressable
                and before.display_index is not None
                and after.display_index is not None
                and before.display_index != after.display_index
            ):
                follow = inventory_table_controller.get("follow_instance")
                if callable(follow):
                    follow(editor_target_id, after.display_index)
            return True

        if editing is not None:
            assert editor_session_token is not None
            initial_signature = current_editor_signature(editing)
            current_editor_controller.clear()
            current_editor_controller.update({
                "target_id": editor_target_id,
                "token": editor_session_token,
                "dirty": False,
                "draft_signature": initial_signature,
                "last_committed_signature": initial_signature,
                "popup_active": False,
                "commit_if_dirty": commit_current_editor,
                "discard_or_reload": restore_current_editor_values,
            })

            def mark_current_editor_dirty(_=None) -> None:
                if current_editor_controller.get("token") == editor_session_token:
                    current_editor_controller["dirty"] = True

            for control in (name, quality):
                control.on("update:model-value", mark_current_editor_dirty)
            level.on("update:value", mark_current_editor_dirty)

            def set_editor_popup_active(value: bool) -> None:
                if current_editor_controller.get("token") == editor_session_token:
                    current_editor_controller["popup_active"] = value

            for control in (kind, name, quality):
                control.on(
                    "popup-show",
                    lambda _, value=True: set_editor_popup_active(value),
                    js_handler=(
                        f"event => {{ window.__yuanstarCurrentEditorPopupToken = {editor_session_token!r}; emit(); }}"
                    ),
                )
                control.on(
                    "popup-hide",
                    lambda _, value=False: set_editor_popup_active(value),
                    js_handler=(
                        f"event => {{ if (window.__yuanstarCurrentEditorPopupToken === {editor_session_token!r}) "
                        "window.__yuanstarCurrentEditorPopupToken = null; emit(); }"
                    ),
                )

            def commit_current_editor_outside(event: events.GenericEventArguments) -> None:
                details = event.args if isinstance(event.args, dict) else {}
                if details.get("token") == editor_session_token:
                    commit_current_editor()

            current_editor_fields.on(
                "yuanstar-current-editor-outside",
                commit_current_editor_outside,
                js_handler="event => emit(event.detail)",
            )
            ui.run_javascript(
                f"""
                (() => {{
                  window.__yuanstarCurrentEditorOutsideCleanup?.();
                  const token = {editor_session_token!r};
                  const root = document.getElementById('yuanstar-current-editor-fields');
                  if (!root) return;
                  const isOwnPopup = target => Boolean(
                    target?.closest?.('.q-menu, .q-dialog') &&
                    window.__yuanstarCurrentEditorPopupToken === token
                  );
                  const emitOutside = () => root.dispatchEvent(new CustomEvent(
                    'yuanstar-current-editor-outside', {{detail: {{token}}, bubbles: true}}
                  ));
                  const onPointerDown = event => {{
                    if (root.contains(event.target) || isOwnPopup(event.target)) return;
                    emitOutside();
                  }};
                  const onFocusOut = event => {{
                    const next = event.relatedTarget;
                    if (root.contains(next) || isOwnPopup(next)) return;
                    // A Quasar popup can receive focus before popup-show is
                    // delivered. Let its own pointer interaction decide.
                    if (next?.closest?.('.q-menu, .q-dialog')) return;
                    emitOutside();
                  }};
                  document.addEventListener('pointerdown', onPointerDown, true);
                  root.addEventListener('focusout', onFocusOut);
                  window.__yuanstarCurrentEditorOutsideCleanup = () => {{
                    document.removeEventListener('pointerdown', onPointerDown, true);
                    root.removeEventListener('focusout', onFocusOut);
                  }};
                }})()
                """
            )

            def commit_current_editor_on_enter(event: events.GenericEventArguments) -> None:
                details = event.args if isinstance(event.args, dict) else {}
                if details.get("key") == "Enter" and not details.get("isComposing"):
                    commit_current_editor()

            for control in (kind, name, level, quality):
                control.on(
                    "keydown",
                    commit_current_editor_on_enter,
                    args=["key", "isComposing"],
                    js_handler=(
                        "event => { if (event.key === 'Enter' && !event.isComposing) "
                        "emit({key: event.key, isComposing: false}); }"
                    ),
                )

        def apply_row_change(operation) -> None:
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能修改背包。", type="warning")
                return
            try:
                operation()
            except (ValueError, TypeError) as error:
                ui.notify(str(error), type="negative")
                return
            request_persist()
            ui.notify("修改已保存并完成自动重算。", type="positive")
            reconciliation_summary.refresh()
            bag_info_section.refresh()
            reload_inventory_tables_in_place()
            editor_section.refresh()
            experience_section.refresh()
            action_section.refresh()
            update_ocr_expansion_header()

        with ui.row().mark("manual-editor-actions"):
            ui.button("新增", on_click=lambda: apply_row_change(lambda: state.add_row(build_row())), icon="add").props("color=primary")
            ui.button(
                "删除选中行",
                on_click=lambda: apply_row_change(lambda: state.delete_row(state.selected_row_id or "")),
                icon="delete",
            ).props("color=negative flat")
            ui.button("清空当前表格", on_click=lambda: apply_row_change(state.clear_rows)).props("flat")
            if editing is not None:
                current_save_status_element = ui.label("已自动保存").classes("text-caption q-ml-auto text-grey").mark(
                    "current-save-status"
                )
            else:
                current_save_status_element = None

    @ui.refreshable
    def experience_section() -> None:
        def plan_for(row: InventorySummaryRow) -> InstanceExperiencePlan:
            return InstanceExperiencePlan(
                star_instance_id=row.star_instance_id,
                current_level=row.level,
                target_level=state.plan_level(row.star_instance_id),
            )

        selected_id = selected_experience_instance_id()
        selected_row = next((row for row in state.rows if row.star_instance_id == selected_id), None)
        selected_instance = plan_for(selected_row) if selected_row is not None else None
        plans = [plan_for(row) for row in state.filtered_rows()]
        has_active_filter = (
            state.filter_kind != "全部"
            or state.filter_quality != "全部"
            or bool(state.filter_name.strip())
        )
        summary = (
            summarize_experience_plan(plans, experience_rules, state.experience_quantities)
            if experience_rules is not None
            else None
        )
        with ui.element("div").classes("experience-grid w-full").mark("experience-plan-grid"):
            with ui.card().classes("experience-column compact-card w-full").mark("current-experience-column"):
                ui.label("当前经验星曜").classes("text-subtitle1")
                orange_value = state.experience_quantities["橙星曜"]
                purple_value = state.experience_quantities["紫星曜"]
                white_value = state.experience_quantities["白星曜"]
                with ui.element("div").classes("experience-fields-row").mark("experience-quantity-fields"):
                    with ui.column().classes("experience-field-stack gap-0"):
                        orange = ui.input(
                            "橙星曜数量",
                            value="" if orange_value is None else str(orange_value),
                        ).classes("core-field w-full")
                        ui.label(
                            "橙星曜数量未知，请点击原图查看"
                            if state.experience_quantity_needs_review("橙星曜") else ""
                        ).classes("experience-unknown-hint text-caption text-grey").mark(
                            "experience-orange-unknown-hint"
                        )
                    with ui.column().classes("experience-field-stack gap-0"):
                        purple = ui.input(
                            "紫星曜数量",
                            value="" if purple_value is None else str(purple_value),
                        ).classes("core-field w-full")
                        ui.label(
                            "紫星曜数量未知，请点击原图查看"
                            if state.experience_quantity_needs_review("紫星曜") else ""
                        ).classes("experience-unknown-hint text-caption text-grey").mark(
                            "experience-purple-unknown-hint"
                        )
                    with ui.column().classes("experience-field-stack gap-0"):
                        white = ui.input(
                            "白星曜数量",
                            value="" if white_value is None else str(white_value),
                        ).classes("core-field w-full")
                        ui.label(
                            "白星曜数量未知，请点击原图查看"
                            if state.experience_quantity_needs_review("白星曜") else ""
                        ).classes("experience-unknown-hint text-caption text-grey").mark(
                            "experience-white-unknown-hint"
                        )

                def save_experience() -> None:
                    if workspace_mutation_locked():
                        ui.notify("当前工作区正在处理，暂不能保存经验星曜。", type="warning")
                        return
                    try:
                        state.save_experience(
                            purple=purple.value,
                            white=white.value,
                            orange=orange.value,
                        )
                    except ValueError as error:
                        ui.notify(str(error), type="negative")
                        return
                    request_persist()
                    experience_section.refresh()
                    action_section.refresh()
                experience_images = [
                    image
                    for image in state.uploaded_images
                    if state.image_pools.get(image.id) == "experience"
                    and not image.missing
                    and bool(image.content)
                ]
                with ui.element("div").classes("experience-action-row").mark("experience-action-row"):
                    preview_button = ui.button(
                        "查看经验星曜原图",
                        icon="image",
                        on_click=(
                            (lambda: open_full_preview(experience_images[0].id, "experience"))
                            if experience_images
                            else (lambda: ui.notify("当前批次没有经验星曜原图。", type="warning"))
                        ),
                    ).props("flat").mark("experience-original-preview")
                    ui.button("保存", on_click=save_experience).props("color=primary").mark("save-experience")
                preview_button.set_enabled(bool(experience_images))
            with ui.card().classes("experience-column compact-card w-full").mark("planned-experience-column"):
                ui.label("计划经验星曜需求").classes("text-subtitle1")
                if experience_rules_error is not None:
                    ui.label("经验星曜规则加载失败，暂无法计算计划需求。").classes("experience-plan-warning")
                    ui.label(experience_rules_error).classes("experience-plan-warning")
                else:
                    assert experience_rules is not None and summary is not None
                    with ui.element("div").classes("experience-plan-rows w-full").mark("experience-plan-results"):
                        with ui.element("div").classes("experience-plan-row").mark("experience-selected-plan"):
                            ui.label("当前选中行").classes("experience-plan-label")
                            if selected_row is None or selected_instance is None:
                                ui.label("请选择星石").classes("experience-plan-value")
                                ui.label("—").classes("experience-plan-result")
                            else:
                                requirement = requirement_as_purple_white(
                                    feedable_experience_required(
                                        selected_instance.current_level,
                                        selected_instance.target_level,
                                        experience_rules,
                                    ),
                                    experience_rules,
                                )
                                ui.label(
                                    f"{selected_row.name} {selected_row.level}级 → {selected_instance.target_level}级"
                                ).classes("experience-plan-value")
                                ui.label(
                                    f"紫星曜 {requirement.purple} 颗    白星曜 {requirement.white} 颗"
                                ).classes("experience-plan-result")
                        with ui.element("div").classes("experience-plan-row").mark("experience-filter-plan"):
                            ui.label(
                                "完成当前筛选所需" if has_active_filter else "完成全部计划所需"
                            ).classes("experience-plan-label")
                            ui.label(f"共包含 {summary.planned_instance_count} 颗星石").classes("experience-plan-value")
                            ui.label(
                                f"紫星曜 {summary.required.purple} 颗    白星曜 {summary.required.white} 颗"
                            ).classes("experience-plan-result")
                        with ui.element("div").classes("experience-plan-row").mark("experience-remaining-gap"):
                            ui.label("扣除当前背包后仍缺").classes("experience-plan-label")
                            ui.label(
                                "暂无法计算缺口"
                                if summary.stage_6_24 is None
                                else f"需6-24 {summary.stage_6_24.runs}次"
                            ).classes("experience-plan-value")
                            ui.label(
                                "数量未完整确认" if summary.remaining is None
                                else f"紫星曜 {summary.remaining.purple} 颗    白星曜 {summary.remaining.white} 颗"
                            ).classes("experience-plan-result")
                    if summary.calculation_warnings:
                        ui.label(
                            "；".join(summary.calculation_warnings)
                        ).classes("experience-plan-warning")

                    footnote_text = (
                        "当前经验星曜数量未完整确认，暂无法计算缺口"
                        if summary.remaining is None
                        else "按当前等级经验条0进度估算，实际需求可能更少。"
                    )

                    footnote_classes = (
                        "experience-plan-footnote experience-plan-footnote-warning"
                        if summary.remaining is None
                        else "experience-plan-footnote"
                    )

                    ui.label(footnote_text).classes(footnote_classes)

    @ui.refreshable
    def action_section() -> None:
        def undo() -> None:
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能撤销。", type="warning")
                return
            changed = state.undo()
            if changed:
                request_persist()
            ui.notify("已撤回并重新计算。" if changed else "没有可撤回的操作。")
            import_page.refresh()
            refresh_review_sections()

        def redo() -> None:
            if workspace_mutation_locked():
                ui.notify("当前工作区正在处理，暂不能重做。", type="warning")
                return
            changed = state.redo()
            if changed:
                request_persist()
            ui.notify("已重做并重新计算。" if changed else "没有可重做的操作。")
            import_page.refresh()
            refresh_review_sections()

        def export() -> None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            path = export_workbook(
                Path("exports") / f"yuanstar_inventory_{timestamp}.xlsx",
                state.game_version,
                state.account_name,
                state.rows,
                state.experience_resources(),
                state.import_batch,
                state.catalog.order_index,
                state.plan_targets,
            )
            ui.download(str(path))
            ui.notify(f"已导出：{path}", type="positive")

        with ui.element("div").classes("floating-actions").mark("floating-global-actions"):
            restore_action = ui.button(
                icon="restore",
                on_click=open_restore_dialog,
            ).props("round id=yuanstar-restore-action title=恢复快照").set_enabled(
                can_open_restore_dialog()
            ).mark("review-restore-snapshots")
            restore_entry_elements["review"] = restore_action
            if not restore_points():
                restore_action.tooltip("当前账号暂无可恢复快照")
            ui.button(
                icon="undo",
                on_click=undo,
            ).props("round id=yuanstar-undo-action title=撤回").set_enabled(
                state.history.can_undo and not workspace_mutation_locked()
            ).mark("undo-action")
            ui.button(
                icon="redo",
                on_click=redo,
            ).props("round id=yuanstar-redo-action title=重做").set_enabled(
                state.history.can_redo and not workspace_mutation_locked()
            ).mark("redo-action")
            ui.button(
                icon="download",
                on_click=export,
            ).props(
                'round color=positive id=yuanstar-export-action title="导出 Excel"'
            ).mark("export-action")

    def review_page() -> None:
        with ui.element("div").props("id=yuanstar-review-page").classes("w-full").mark("review-page"):
            def section(
                section_name: str,
                title: str,
                *,
                default: bool,
                caption: str | None = None,
            ):
                expansion = ui.expansion(
                    title,
                    caption=caption,
                    value=default,
                ).classes("review-section w-full").mark(f"review-section-{section_name}")
                review_expansions[section_name] = expansion
                return expansion

            with section("inventory", "当前背包 / 计划背包", default=True):
                reconciliation_summary()
                bag_info_section()
                filter_and_table_section()
            with section("editor", "人工新增与编辑", default=True).classes("manual-editor-section"):
                with ui.element("div").classes("manual-editor-content").mark("manual-editor-content"):
                    editor_section()
            ocr_title, ocr_caption, initial_pending = ocr_summary_text()
            review_view_state["pending_count"] = initial_pending
            with section("experience", "经验星曜", default=True):
                experience_section()
            with section("ocr", ocr_title, default=False, caption=ocr_caption):
                ocr_review_section()
            action_section()

            def install_global_shortcuts() -> None:
                ui.run_javascript(
                    """
                    (() => {
                      if (window.__yuanstarGlobalKeyHandler) {
                        window.removeEventListener('keydown', window.__yuanstarGlobalKeyHandler);
                      }
                      window.__yuanstarGlobalKeyHandler = event => {
                        const reviewPage = document.getElementById('yuanstar-review-page');
                        if (!reviewPage || reviewPage.offsetParent === null) return;
                        const target = event.target;
                        const editable = target instanceof Element && (
                          target.matches('input, textarea, [contenteditable="true"]') ||
                          Boolean(target.closest('input, textarea, [contenteditable="true"]'))
                        );
                        if (editable || event.isComposing || !event.ctrlKey || event.altKey) return;
                        const key = event.key.toLowerCase();
                        const buttonId = key === 'z'
                          ? 'yuanstar-undo-action'
                          : key === 'y' ? 'yuanstar-redo-action' : null;
                        if (!buttonId) return;
                        const button = document.getElementById(buttonId);
                        if (!button || button.disabled) return;
                        event.preventDefault();
                        button.click();
                      };
                      window.addEventListener('keydown', window.__yuanstarGlobalKeyHandler);
                      if (window.__yuanstarPageHideCleanup) {
                        window.removeEventListener('pagehide', window.__yuanstarPageHideCleanup);
                      }
                      window.__yuanstarPageHideCleanup = () => {
                        window.removeEventListener('keydown', window.__yuanstarGlobalKeyHandler);
                        delete window.__yuanstarGlobalKeyHandler;
                      };
                      window.addEventListener('pagehide', window.__yuanstarPageHideCleanup, {once: true});
                    })();
                    """
                )

            ui.context.client.on_connect(install_global_shortcuts)

    ui.page_title("YuanStar 星石整理")
    ui.label("YuanStar 星石整理").classes("text-h4 yuanstar-title")
    with ui.tabs().classes("w-full") as tabs:
        import_tab = ui.tab("导入识别")
        review_tab = ui.tab("人工核对")
    with ui.tab_panels(tabs, value=import_tab).classes("w-full"):
        with ui.tab_panel(import_tab):
            import_page()
        with ui.tab_panel(review_tab):
            review_page()

    def report_workspace_restore() -> None:
        if load_result.state is not None:
            message = "已恢复上次本机工作区。"
            if active_account is not None:
                message = f"已恢复账号：{active_account.display_name}（{active_account.game_version.value}）。"
            ui.notify(message, type="positive")
        if account_warning:
            ui.notify(account_warning, type="warning", multi_line=True)
        if load_result.warning:
            ui.notify(load_result.warning, type="warning", multi_line=True)

    if load_result.state is not None or load_result.warning:
        ui.context.client.on_connect(report_workspace_restore)

    if manages_default_workspace and workspace_store is not None:
        async def flush_workspace_on_disconnect() -> None:
            try:
                save_task = request_persist()
                if save_task is not None:
                    await save_task
            except Exception:
                logger.warning("Failed to flush local workspace on disconnect", exc_info=True)

        ui.context.client.on_disconnect(flush_workspace_on_disconnect)


def start_app() -> None:
    create_app()
    ui.run(title="YuanStar 星石整理", reload=False)
