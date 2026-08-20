from __future__ import annotations

from pathlib import Path
import re

import pytest
from nicegui import ui

from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem, Quality
from yuanstar.persistence import WorkspaceStore
from yuanstar.session import SessionState
from yuanstar.ui_contract import inventory_display_rows, plan_display_rows
from yuanstar.vision.contracts import ImageInput
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


def detected(
    image_id: str,
    row: int,
    column: int,
    *,
    name: str | None,
    level: int = 60,
    confidence: float = .8,
) -> DetectedStarItem:
    return DetectedStarItem(
        card_id=f"{image_id}:r{row}c{column}",
        source_image=image_id,
        source_position=f"r{row}c{column}",
        page_type="main",
        final_name=name,
        final_level=level,
        final_quality=Quality.ORANGE,
        confidence=confidence,
        is_complete_card=True,
    )


def overlap_state() -> SessionState:
    state = SessionState(load_catalog())
    state.uploaded_images = [
        ImageInput(id="before", filename="before.png", content=b"before", content_type="image/png"),
        ImageInput(id="after", filename="after.png", content=b"after", content_type="image/png"),
    ]
    state.image_pools = {"before": "main", "after": "main"}
    state.confirmed_image_pools = {"before", "after"}
    state.overlap_pairs = {"main": [("before", "after")], "support": []}
    names = ["天府", "武曲", "破军", "太阳"]
    state.detected_items = [
        *[
            detected("before", 4, column, name=name, confidence=.95)
            for column, name in enumerate(names, 1)
        ],
        *[
            detected("after", 1, column, name=name if column < 4 else None)
            for column, name in enumerate(names, 1)
        ],
    ]
    state.recalculate_postprocess()
    return state


def test_manual_completion_recalculates_overlap_and_preserves_stable_ids() -> None:
    state = overlap_state()
    before_ids = {
        row.occurrence_id: row.star_instance_id
        for row in state.rows
        if row.source_image == "before"
    }
    assert len(state.rows) == 7

    state.update_detected_card(
        "after:r1c4",
        name="太阳",
        level=60,
        quality=Quality.ORANGE,
    )

    assert len(state.rows) == 4
    assert sum(item.overlap_duplicate_of is not None for item in state.detected_items) == 4
    surviving_before = {
        row.occurrence_id: row.star_instance_id
        for row in state.rows
        if row.source_image == "before"
    }
    assert surviving_before == {
        occurrence_id: instance_id
        for occurrence_id, instance_id in before_ids.items()
        if occurrence_id != "before:r4c4"
    }
    assert any(
        row.occurrence_id == "after:r1c4" and row.manual_status == "人工核对"
        for row in state.rows
    )
    updated = next(item for item in state.detected_items if item.card_id == "after:r1c4")
    assert updated.manual_override
    assert updated.final_name == "太阳"

    assert state.undo()
    assert len(state.rows) == 7
    assert next(item for item in state.detected_items if item.card_id == "after:r1c4").final_name is None
    assert state.redo()
    assert len(state.rows) == 4


def test_workspace_round_trip_restores_business_data_but_not_transient_ui(tmp_path: Path) -> None:
    store = WorkspaceStore(tmp_path / "workspace")
    state = overlap_state()
    state.update_detected_card("after:r1c4", name="太阳", level=60, quality=Quality.ORANGE)
    state.set_filters("主星", "橙", "天府")
    state.selected_row_id = state.rows[0].id
    state.selected_import_image_id = "before"

    sizes = store.save(state)
    loaded = store.load(load_catalog())

    assert sizes.structured_bytes > 0
    assert sizes.image_bytes == len(b"before") + len(b"after")
    assert loaded.state is not None
    assert not loaded.missing_images
    restored = loaded.state
    assert len(restored.rows) == 4
    assert restored.overlap_pairs == state.overlap_pairs
    assert [image.content for image in restored.uploaded_images] == [b"before", b"after"]
    assert restored.filter_kind == "全部"
    assert restored.filter_quality == "全部"
    assert restored.filter_name == ""
    assert restored.selected_row_id is None
    assert restored.selected_import_image_id is None
    assert not restored.history.can_undo


def test_missing_image_is_marked_without_losing_other_data(tmp_path: Path) -> None:
    store = WorkspaceStore(tmp_path / "workspace")
    state = overlap_state()
    store.save(state)
    (store.image_dir / "after.png").unlink()

    loaded = store.load(load_catalog())

    assert loaded.state is not None
    assert loaded.missing_images == ("after.png",)
    assert next(image for image in loaded.state.uploaded_images if image.id == "after").missing
    assert len(loaded.state.detected_items) == 8


def test_corrupt_workspace_is_backed_up_and_does_not_block_startup(tmp_path: Path) -> None:
    store = WorkspaceStore(tmp_path / "workspace")
    store.root.mkdir(parents=True)
    store.state_path.write_text("{not-json", encoding="utf-8")

    loaded = store.load(load_catalog())

    assert loaded.state is None
    assert "无法完整恢复" in (loaded.warning or "")
    assert loaded.corrupt_backup is not None
    assert loaded.corrupt_backup.read_text(encoding="utf-8") == "{not-json"


def test_name_filter_uses_name_level_quality_groups_without_virtual_headers() -> None:
    state = overlap_state()
    state.detected_items = [
        detected("before", 1, 1, name="天府", level=40),
        detected("before", 1, 2, name="武曲", level=50),
        detected("before", 1, 3, name="天府", level=60),
        detected("before", 1, 4, name="破军", level=45),
    ]
    state.overlap_pairs = {"main": [], "support": []}
    state.recalculate_postprocess()
    state.set_filters("全部", "全部", "天府 武曲 破军")

    filtered = state.filtered_rows()
    assert [(row.name, row.level) for row in filtered] == [
        ("天府", 60),
        ("天府", 40),
        ("武曲", 50),
        ("破军", 45),
    ]
    current = inventory_display_rows(filtered, aggregate_by_name=True)
    planned = plan_display_rows(filtered, state.plan_rows, aggregate_by_name=True)
    assert all("name_group_header" not in row for row in current)
    assert all("name_group_header" not in row for row in planned)
    assert [row["group_quantity"] for row in current if row["name_group_start"]] == [
        "本组共 2 颗",
        "本组共 1 颗",
        "本组共 1 颗",
    ]
    assert [row["star_instance_id"] for row in planned] == [
        row["star_instance_id"] for row in current
    ]
    assert [row["group_quantity"] for row in planned] == [
        row["group_quantity"] for row in current
    ]
    assert current[1]["group_quantity"] == ""


def test_row_crop_follows_level_and_name_roi_boundaries() -> None:
    class Card:
        def __init__(self, row_index: int, column_index: int, box: tuple[int, int, int, int]) -> None:
            self.row_index = row_index
            self.column_index = column_index
            self.box_original = box
            self.level_box_original = (box[0], box[1] - 20, box[2], 40)
            self.name_box_original = (box[0], box[1] + box[3], box[2], 50)
            self.circle_original = (box[0] + box[2] // 2, box[1] + box[3] // 2, 90)

    boxes = LocalOfflineVisionPipeline._row_crop_boxes(
        [
            Card(0, 0, (100, 200, 180, 240)),
            Card(0, 1, (300, 200, 180, 240)),
            Card(1, 0, (100, 500, 180, 240)),
            Card(1, 1, (300, 500, 180, 240)),
        ],
        image_width=1080,
        image_height=1920,
    )

    first = boxes[0]
    second = boxes[1]
    assert first == (96, 176, 388, 318)
    assert second == (96, 476, 388, 318)


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_3_2_test_app.py")
async def test_phase0_3_2_ui_contract_and_success_navigation(user) -> None:
    user.javascript_rules[re.compile(".*scrollIntoView.*")] = lambda _: None
    await user.open("/")

    for marker in (
        "main-import-actions",
        "confirm-all-pools",
        "clear-pending-images",
        "start-import",
        "bag-info-ocr-grid",
        "bag-info-panel",
        "bag-ocr-candidate-panel",
        "ocr-review-two-row-scroll",
        "review-section-inventory",
        "review-section-editor",
        "review-section-ocr",
        "review-section-experience",
    ):
        await user.should_see(marker=marker)

    user.find(marker="pool-experience").trigger("click")
    await user.should_not_see(marker="overlap-workspace")
    user.find(marker="pool-main").trigger("click")
    await user.should_see(marker="overlap-main")

    user.find(marker="pool-image-main").click()
    await user.should_see("当前选中")
    await user.should_not_see(marker="full-viewer-next")
    card = user.find(marker="pool-image-main")
    card.elements = {min(card.elements, key=lambda element: element.id)}
    card.trigger("dblclick")
    await user.should_see(marker="full-viewer-next")
    assert len(user.find(marker="full-viewer-next").elements) == 1
    user.find(marker="full-viewer-close").click()

    user.find(marker="start-import").click()
    user.find(marker="confirm-start-import").click()
    await user.should_see("测试识别完成", retries=20)
    tabs = next(iter(user.find(kind=ui.tabs).elements))
    assert tabs.value.props["name"] == "人工核对"


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_3_2_failure_test_app.py")
async def test_import_failure_stays_on_import_page(user) -> None:
    user.javascript_rules[re.compile(".*scrollIntoView.*")] = lambda _: None
    await user.open("/")
    user.find(marker="start-import").click()
    user.find(marker="confirm-start-import").click()

    await user.should_see("识别失败", retries=20)
    await user.should_see(marker="task-progress-zone")
    tabs = next(iter(user.find(kind=ui.tabs).elements))
    assert tabs.value.props["name"] == "导入识别"


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_3_2_save_failure_test_app.py")
async def test_auto_save_failure_is_visible_and_keeps_ui_alive(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    user.find(marker="save-bag-info").click()

    await user.should_see("自动保存失败", retries=20)
    await user.should_see(marker="bag-info-panel")
