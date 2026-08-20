from __future__ import annotations

from pathlib import Path

import pytest
from nicegui import ui

from test_phase0_3_ui_contract_rebuild import fixture_state
from yuanstar.app import row_crop_data_url
from yuanstar.ui_contract import (
    REVIEW_SECTION_DEFAULTS,
    inventory_display_rows,
    localized_position,
    localized_warning,
    pending_review_count,
    restored_review_section_states,
)
from yuanstar.vision.models import CardCandidate
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


APP_SOURCE = Path("src/yuanstar/app.py").read_text(encoding="utf-8")


def only_element(interaction):
    assert len(interaction.elements) == 1
    return next(iter(interaction.elements))


def test_localized_review_text_never_leaks_internal_codes() -> None:
    assert localized_position("r7c4") == "第7行第4列"
    assert localized_warning("name_unknown") == "名称未知"
    assert localized_warning("level_unknown") == "等级未知"
    assert localized_warning("rarity_unknown") == "品质未知"
    assert localized_warning("quality_unknown") == "品质未知"
    assert localized_warning("incomplete_card") == "卡片残缺"
    assert localized_warning("no_recognized_star_for_candidate") == "未识别到有效星石"
    assert localized_warning("bag_count_unknown") == "背包数量未知"
    assert localized_warning("new_internal_snake_case") == "需要人工复核"


def test_review_section_storage_uses_safe_defaults_and_rejects_damage() -> None:
    assert restored_review_section_states(None) == REVIEW_SECTION_DEFAULTS
    assert restored_review_section_states("{broken") == REVIEW_SECTION_DEFAULTS
    assert restored_review_section_states('{"inventory":false,"ocr":true}') == {
        "inventory": False,
        "editor": True,
        "ocr": True,
        "experience": True,
    }
    assert restored_review_section_states('{"inventory":"false","ocr":1}') == REVIEW_SECTION_DEFAULTS


def test_real_row_crop_uses_existing_boxes_without_changing_ocr() -> None:
    state = fixture_state()
    image = state.uploaded_images[0]
    data_url = row_crop_data_url(image, (0, 0, image.width or 0, 42))
    assert data_url and data_url.startswith("data:image/jpeg;base64,")
    assert row_crop_data_url(image, None) is None
    assert row_crop_data_url(image, (200, 200, 10, 10)) is None

    cards = [
        CardCandidate("a", 0, 0, (10, 20, 30, 40), (0, 0, 0, 0), True, .9),
        CardCandidate("b", 0, 1, (45, 22, 30, 38), (0, 0, 0, 0), True, .9),
        CardCandidate("partial", 1, 0, (12, 70, 28, 20), (0, 0, 0, 0), False, .4),
    ]
    boxes = LocalOfflineVisionPipeline._row_crop_boxes(cards, 100, 120)
    assert boxes[0][0] <= 10
    assert boxes[0][0] + boxes[0][2] >= 75
    assert boxes[1][1] <= 70


def test_group_and_kind_boundaries_preserve_individual_instances() -> None:
    rows = inventory_display_rows(fixture_state().rows)
    assert [row["group_quantity"] for row in rows] == [
        "本组共 2 颗",
        "",
        "本组共 1 颗",
    ]
    assert rows[0]["group_start"] is True
    assert rows[1]["group_start"] is False
    assert rows[2]["kind_start"] is True
    assert len({row["star_instance_id"] for row in rows}) == len(rows)


def test_css_contract_declares_7_3_5_5_3_and_2_plus_1_without_page_overflow() -> None:
    assert "grid-template-columns: minmax(0, 7fr) minmax(20rem, 3fr)" in APP_SOURCE
    assert (
        "grid-template-columns: minmax(0, 5fr) minmax(0, 5fr) minmax(0, 3fr)"
        in APP_SOURCE
    )
    assert "@media (max-width: 1050px)" in APP_SOURCE
    assert ".image-pools-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }" in APP_SOURCE
    assert "grid-column: 1 / -1" in APP_SOURCE
    assert "overflow-x: auto" in APP_SOURCE


def test_shortcut_guard_and_single_registration_contract_is_explicit() -> None:
    assert "window.__yuanstarGlobalKeyHandler" in APP_SOURCE
    assert "removeEventListener('keydown', window.__yuanstarGlobalKeyHandler)" in APP_SOURCE
    assert "target.matches('input, textarea, [contenteditable=\"true\"]')" in APP_SOURCE
    assert "event.isComposing" in APP_SOURCE
    assert "event.ctrlKey" in APP_SOURCE
    assert "window.addEventListener('pagehide'" in APP_SOURCE


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/ui_contract_refine_test_app.py")
async def test_refined_ui_contract_and_interactions(user) -> None:
    await user.open("/")

    for marker in (
        "top-account-placeholder",
        "workspace-account-name",
        "import-workbar-7-3",
        "upload-workzone",
        "task-progress-zone",
        "image-pools-5-5-3",
        "pool-main",
        "pool-support",
        "pool-experience",
    ):
        await user.should_see(marker=marker)
    for text in (
        "任务状态",
        "当前阶段",
        "活动状态",
        "当前图片",
        "已完成",
        "待处理",
        "错误数",
        "OCR 初始化次数",
        "已用时间",
        "已选文件",
        "总大小",
    ):
        await user.should_see(text)

    await user.should_see(marker="overlap-main")
    await user.should_not_see(marker="overlap-support")
    user.find(marker="activate-pool-support").click()
    await user.should_see(marker="overlap-support")
    await user.should_not_see(marker="overlap-main")
    user.find(marker="activate-pool-experience").click()
    await user.should_not_see(marker="overlap-workspace")
    user.find(marker="activate-pool-main").click()

    user.find(marker="pool-image-main").trigger("dblclick")
    await user.should_see(marker="full-viewer-previous")
    await user.should_see(marker="full-viewer-next")
    await user.should_see(marker="full-viewer-close")
    await user.should_see(marker="full-viewer-zoom-in")
    await user.should_see(marker="full-viewer-zoom-out")
    for removed in ("full-viewer-original", "full-viewer-fit"):
        await user.should_not_see(marker=removed)
    user.find(marker="full-viewer-next").click()
    await user.should_see("main-b.png")
    user.find(marker="full-viewer-close").click()

    user.find("人工核对").click()
    inventory = only_element(user.find(marker="review-section-inventory"))
    editor = only_element(user.find(marker="review-section-editor"))
    ocr = only_element(user.find(marker="review-section-ocr"))
    experience = only_element(user.find(marker="review-section-experience"))
    assert [inventory.value, editor.value, ocr.value, experience.value] == [
        True,
        True,
        False,
        True,
    ]
    assert inventory.id < editor.id < ocr.id < experience.id
    assert "检测实例" in ocr.props["label"]
    assert "字段完整实例" in ocr.props["label"]
    assert "已排除" in ocr.props["label"]
    assert "重叠合并" in ocr.props["label"]
    assert "最终唯一实例" in ocr.props["label"]
    assert "统计口径" in ocr.props["caption"]

    for marker in (
        "inventory-plan-grid",
        "current-inventory-column",
        "planned-inventory-column",
        "experience-plan-grid",
        "current-experience-column",
        "planned-experience-column",
        "floating-global-actions",
        "undo-action",
        "redo-action",
        "export-action",
    ):
        await user.should_see(marker=marker)
    assert len(user.find(marker="undo-action").elements) == 1
    assert len(user.find(marker="redo-action").elements) == 1
    assert len(user.find(marker="export-action").elements) == 1

    user.find(marker="ocr-review-expand").click()
    await user.should_see(marker="ocr-review-expanded")
    await user.should_see(marker="ocr-row-preview")
    await user.should_see(marker="ocr-candidate-full-page")
    await user.should_see("第7行第1列")
    await user.should_see("卡片残缺")
    await user.should_not_see("r7c1")
    await user.should_not_see("incomplete_card")

    ocr.value = True
    user.find(marker="exclude-fragment").click()
    ocr_after = only_element(user.find(marker="review-section-ocr"))
    assert pending_review_count(fixture_state().detected_items) == 1
    assert ocr_after.value is False
    assert "复核已完成" in ocr_after.props["label"]


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/ui_contract_refine_test_app.py")
async def test_name_enter_and_ime_composition_guard(user) -> None:
    await user.open("/")
    user.find("人工核对").click()
    name_input = user.find(marker="name-filter")
    name_input.type("天府")
    name_input.trigger("keydown", {"key": "Enter", "isComposing": True})
    await user.should_see("当前背包（3 颗）")
    name_input.trigger("keydown", {"key": "Enter", "isComposing": False})
    await user.should_see("当前背包（2 颗）")
