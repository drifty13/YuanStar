from __future__ import annotations

import asyncio
import base64
from pathlib import Path

import cv2
import numpy as np
import pytest
from nicegui import ui

from yuanstar.app import create_app
from yuanstar.catalog import load_catalog
from yuanstar.domain import (
    DetectedStarItem,
    GameVersion,
    ImportBatch,
    InventorySummaryRow,
    PlannedInventoryRow,
    Quality,
    StarKind,
)
from yuanstar.session import SessionState
from yuanstar.ui_contract import (
    inventory_display_rows,
    plan_display_rows,
    review_counts,
    review_image_summaries,
)
from yuanstar.vision.contracts import AnalysisResult, ImageInput
from yuanstar.vision.hierarchical_order import apply_hierarchical_order, needs_equipped_evidence
from yuanstar.vision.models import CardCandidate, RecognizedStar
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


def synthetic_png(colour: tuple[int, int, int]) -> bytes:
    image = np.full((160, 96, 3), colour, dtype=np.uint8)
    cv2.putText(image, "TEST", (6, 80), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 255, 255), 1)
    success, encoded = cv2.imencode(".png", image)
    assert success
    return encoded.tobytes()


def preview_url(content: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(content).decode("ascii")


def fixture_state() -> SessionState:
    state = SessionState(load_catalog())
    images = [
        ImageInput("main-a.png", 96, 160, content=synthetic_png((30, 80, 150)), content_type="image/png"),
        ImageInput("main-b.png", 96, 160, content=synthetic_png((40, 90, 160)), content_type="image/png"),
        ImageInput("support-a.png", 96, 160, content=synthetic_png((80, 40, 150)), content_type="image/png"),
        ImageInput("support-b.png", 96, 160, content=synthetic_png((90, 50, 160)), content_type="image/png"),
        ImageInput("experience.png", 96, 160, content=synthetic_png((120, 70, 20)), content_type="image/png"),
    ]
    pools = ("main", "main", "support", "support", "experience")
    for image, pool in zip(images, pools, strict=True):
        state.add_uploaded_image(image)
        state.suggest_image_pool(image.id, pool)
    items = [
        DetectedStarItem(
            card_id=f"{images[0].id}:card_001",
            source_image=images[0].id,
            source_position="r1c1",
            row_crop_box=(0, 0, 96, 42),
            page_type="main",
            recognized_name="天府",
            recognized_level=60,
            recognized_quality=Quality.ORANGE,
            final_name="天府",
            final_level=60,
            final_quality=Quality.ORANGE,
            is_complete_card=True,
        ),
        DetectedStarItem(
            card_id=f"{images[1].id}:card_001",
            source_image=images[1].id,
            source_position="r1c1",
            row_crop_box=(0, 0, 96, 42),
            page_type="main",
            recognized_name="天府",
            recognized_level=60,
            recognized_quality=Quality.ORANGE,
            final_name="天府",
            final_level=60,
            final_quality=Quality.ORANGE,
            is_complete_card=True,
        ),
        DetectedStarItem(
            card_id=f"{images[2].id}:card_001",
            source_image=images[2].id,
            source_position="r1c1",
            row_crop_box=(0, 0, 96, 42),
            page_type="support",
            recognized_name="解神",
            recognized_level=40,
            recognized_quality=Quality.PURPLE,
            final_name="解神",
            final_level=40,
            final_quality=Quality.PURPLE,
            is_complete_card=True,
        ),
        DetectedStarItem(
            card_id=f"{images[3].id}:card_002",
            source_image=images[3].id,
            source_position="r7c1",
            row_crop_box=(0, 110, 96, 50),
            page_type="support",
            final_name=None,
            final_level=1,
            final_quality=Quality.WHITE,
            is_complete_card=False,
            field_warnings=["incomplete_card"],
        ),
    ]
    audits = {
        image.id: {
            "page_type": pool,
            "warnings": ["synthetic_fixture_warning"] if image is images[3] else [],
            "preview_data_url": preview_url(image.content),
            "bag_current_count": 164,
            "bag_capacity": 250,
            "bag_confidence": .94,
            "detected_occurrence_count": sum(item.source_image == image.id for item in items),
            "fully_resolved_count": sum(
                item.source_image == image.id and item.final_name is not None
                for item in items
            ),
            "experience": {
                "source_image": image.id,
                "source_filename": image.filename,
                "orange_count": 22,
                "purple_count": 295,
                "white_count": 88,
                "orange_confidence": .95,
                "purple_confidence": .91,
                "white_confidence": .90,
                "warning": None,
            } if pool == "experience" else None,
        }
        for image, pool in zip(images, pools, strict=True)
    }
    state.apply_local_analysis(AnalysisResult(
        executed=True,
        message="synthetic UI fixture",
        items=items,
        import_batch=ImportBatch(
            image_count=5,
            game_version=GameVersion.RU_YUAN,
            bag_current_count=164,
            bag_capacity=250,
            ocr_executed=True,
        ),
        image_pools={image.id: pool for image, pool in zip(images, pools, strict=True)},
        image_audit=audits,
        bag_resolution={
            "status": "一致",
            "bag_current_count": 164,
            "bag_capacity": 250,
            "source_images": ["synthetic-a.png"],
            "confidence": .94,
            "warning": None,
            "candidates": [],
        },
        experience_resolution={
            "橙星曜": {"value": 22, "confidence": .95, "source_images": ["experience.png"], "warning": None},
            "紫星曜": {"value": 295, "confidence": .91, "source_images": ["experience.png"], "warning": None},
            "白星曜": {"value": 88, "confidence": .90, "source_images": ["experience.png"], "warning": None},
        },
    ))
    return state


def test_physical_instances_keep_stable_ids_sorting_and_group_first_count() -> None:
    state = fixture_state()
    first_ids = [row.star_instance_id for row in state.rows]
    assert len(first_ids) == len(set(first_ids)) == 3
    assert [row.kind for row in state.rows] == [StarKind.MAIN, StarKind.MAIN, StarKind.SUPPORT]
    display = inventory_display_rows(state.filtered_rows())
    assert [row["group_quantity"] for row in display] == ["本组共 2 颗", "", "本组共 1 颗"]
    assert [row["star_instance_id"] for row in plan_display_rows(state.filtered_rows())] == first_ids
    assert set(state.plan_rows) == set(first_ids)

    state.set_filters("主星", "橙", "天府")
    filtered = state.filtered_rows()
    assert [row.star_instance_id for row in filtered] == first_ids[:2]
    assert [row["star_instance_id"] for row in plan_display_rows(filtered, state.plan_rows)] == first_ids[:2]
    assert set(state.plan_rows) == set(first_ids)

    card = state.detected_items[0]
    state.update_detected_card(card.card_id or "", name="武曲", level=60, quality="紫")
    assert next(row for row in state.rows if row.occurrence_id == card.card_id).star_instance_id == first_ids[0]


def test_plan_display_order_and_grouping_ignore_planned_mapping_insertion_order() -> None:
    state = fixture_state()
    current = inventory_display_rows(state.filtered_rows())
    reversed_plan_mapping = {
        row.star_instance_id: PlannedInventoryRow(
            star_instance_id=row.star_instance_id,
            placeholder=f"计划占位-{index}",
        )
        for index, row in enumerate(reversed(state.rows))
    }

    planned = plan_display_rows(state.filtered_rows(), reversed_plan_mapping)

    assert [row["star_instance_id"] for row in planned] == [row["star_instance_id"] for row in current]
    assert [
        (row["kind_start"], row["group_start"], row["name_group_start"])
        for row in planned
    ] == [
        (row["kind_start"], row["group_start"], row["name_group_start"])
        for row in current
    ]
    assert {row["star_instance_id"]: row["placeholder"] for row in planned} == {
        row.star_instance_id: f"计划占位-{index}"
        for index, row in enumerate(reversed(state.rows))
    }


def test_bag_and_experience_resolution_are_consistent_or_explicitly_unknown() -> None:
    consistent = LocalOfflineVisionPipeline._resolve_bag_observations([
        {"source_image": "a", "source_filename": "a.png", "bag_current_count": 164, "bag_capacity": 250, "confidence": .9},
        {"source_image": "b", "source_filename": "b.png", "bag_current_count": 164, "bag_capacity": 250, "confidence": .8},
    ])
    assert (consistent["bag_current_count"], consistent["bag_capacity"]) == (164, 250)
    assert consistent["warning"] is None
    conflict = LocalOfflineVisionPipeline._resolve_bag_observations([
        {"source_image": "a", "bag_current_count": 164, "bag_capacity": 250, "confidence": .9},
        {"source_image": "b", "bag_current_count": 165, "bag_capacity": 250, "confidence": .9},
    ])
    assert conflict["bag_current_count"] is None
    assert conflict["bag_capacity"] is None
    assert conflict["warning"]

    experience = LocalOfflineVisionPipeline._resolve_experience_observations([
        {
            "source_image": "exp",
            "source_filename": "exp.png",
            "orange_count": 22,
            "purple_count": 295,
            "white_count": 88,
            "orange_confidence": .95,
            "purple_confidence": .91,
            "white_confidence": .90,
        }
    ])
    assert [experience[name]["value"] for name in ("橙星曜", "紫星曜", "白星曜")] == [22, 295, 88]


def test_manual_bag_and_experience_values_are_absolute() -> None:
    state = SessionState(load_catalog())
    state.save_bag_info(GameVersion.RU_YUAN, 9, 300)
    state.save_experience(purple=7, white=8, orange=6)
    result = AnalysisResult(
        executed=True,
        message="ocr",
        import_batch=ImportBatch(
            image_count=1,
            game_version=GameVersion.RU_YUAN,
            bag_current_count=164,
            bag_capacity=250,
            ocr_executed=True,
        ),
        bag_resolution={"bag_current_count": 164, "bag_capacity": 250},
        experience_resolution={
            "橙星曜": {"value": 22},
            "紫星曜": {"value": 295},
            "白星曜": {"value": 88},
        },
    )
    state.apply_local_analysis(result)
    assert (state.bag_current_count, state.bag_capacity) == (9, 300)
    assert state.import_batch and (state.import_batch.bag_current_count, state.import_batch.bag_capacity) == (9, 300)
    assert state.experience_quantities == {"橙星曜": 6, "紫星曜": 7, "白星曜": 8}


def test_latest_hierarchical_rule_accepts_quality_and_equipped_segments() -> None:
    cards = [
        CardCandidate(f"card_{index}", 0, index, (index * 10, 0, 10, 10), (0, 0, 0, 0), True, .99)
        for index in range(3)
    ]
    stars = [
        RecognizedStar("card_0", "main", "紫微", "紫微", .99, "1", 1, .99, .99, False, quality="橙", direct_level=1),
        RecognizedStar("card_1", "main", "武曲", "武曲", .99, "40", 40, .99, .99, False, quality="紫", direct_level=40),
        RecognizedStar("card_2", "main", "天府", "天府", .99, "60", 60, .99, .99, False, quality="橙", direct_level=60),
    ]
    assert not needs_equipped_evidence(cards, stars)
    result = apply_hierarchical_order(cards, stars, {})
    assert [star.level for star in result] == [1, 40, 60]
    assert not any("level_order_conflict" in warning for star in result for warning in star.warnings)


def test_review_summary_sorting_and_quantity_contract() -> None:
    state = fixture_state()
    summaries = review_image_summaries(state)
    assert summaries[0]["filename"] == "support-b.png"
    counts = review_counts(state.detected_items, len(state.rows))
    assert counts == {
        "detected_occurrence_count": 4,
        "fully_resolved_count": 3,
        "excluded_count": 0,
        "overlap_duplicate_count": 0,
        "unique_instance_count": 3,
    }


def test_plan_table_selection_adds_no_row_size_css_override() -> None:
    source = Path("src/yuanstar/app.py").read_text(encoding="utf-8")
    plan_block = source.split("plan_table = ui.table(", 1)[1].split("def ocr_summary_text", 1)[0]
    assert 'selection="single"' in plan_block
    assert all(token not in plan_block for token in ("height", "line-height", "padding", "font-size"))
    assert ".planned-inventory-table th:not(.q-table--col-auto-width)" in source
    assert ".planned-inventory-table td:not(.q-table--col-auto-width)" in source
    assert "width: calc((100% - 2.75rem) / 5);" in source
    assert ".planned-inventory-table tbody tr:has(> .group-divider-cell) > td" in source
    assert ".planned-inventory-table tbody tr:has(> .kind-divider-cell) > td" in source
    assert "border-top: 2px solid #b8bec8 !important;" in source
    assert "border-top: 4px solid #667085 !important;" in source


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/ui_contract_test_app.py")
async def test_ui_controls_and_key_interactions_remain_available(user) -> None:
    await user.open("/")
    for marker in (
        "screenshot-requirements",
        "pool-main",
        "pool-support",
        "pool-experience",
        "confirm-all-pools",
        "confirm-pool-main",
        "confirm-pool-support",
        "confirm-pool-experience",
        "overlap-main",
    ):
        await user.should_see(marker=marker)
    await user.should_not_see(marker="overlap-support")
    user.find(marker="activate-pool-support").click()
    await user.should_see(marker="overlap-support")
    await user.should_not_see(marker="overlap-main")
    user.find(marker="activate-pool-experience").click()
    await user.should_not_see(marker="overlap-workspace")
    user.find(marker="activate-pool-main").click()

    user.find(marker="confirm-all-pools").click()
    await user.should_see("已确认")
    main_card = user.find(marker="pool-image-main")
    main_card.elements = {min(main_card.elements, key=lambda element: element.id)}
    main_card.trigger("dblclick")
    await user.should_see(marker="full-viewer-zoom-in")
    await user.should_see(marker="full-viewer-zoom-out")
    await user.should_not_see(marker="full-viewer-original")
    await user.should_not_see(marker="full-viewer-fit")
    await user.should_see(marker="full-viewer-next")
    user.find(marker="full-viewer-next").click()
    await user.should_see("main-b.png")
    user.find(marker="full-viewer-close").click()

    user.find("人工核对").click()
    for marker in (
        "inventory-plan-grid",
        "current-inventory-column",
        "planned-inventory-column",
        "ocr-review-two-row-scroll",
        "undo-action",
        "redo-action",
        "export-action",
    ):
        await user.should_see(marker=marker)
    user.find(marker="ocr-review-expand").click()
    await user.should_see(marker="ocr-review-expanded")
    await user.should_see(marker="ocr-review-show-all")


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/ui_contract_test_app.py")
async def test_plan_table_selection_is_exclusive_and_clears_when_filtered_out(user) -> None:
    await user.open("/")
    user.find("人工核对").click()

    current = user.find(marker="current-inventory-table")
    planned = user.find(marker="planned-inventory-table")
    current_table = next(iter(current.elements))
    planned_table = next(iter(planned.elements))
    current_row = current_table._props["rows"][0]
    planned_row = planned_table._props["rows"][0]
    assert planned_table._props["selection"] == current_table._props["selection"] == "single"
    assert planned_table._props["row-key"] == "star_instance_id"
    assert planned_row["kind"] == StarKind.MAIN.value

    current.trigger("selection", {"added": True, "rows": [current_row], "keys": []})
    assert [row["id"] for row in current_table._props["selected"]] == [current_row["id"]]
    assert planned_table._props["selected"] == []
    assert next(row for row in current_table._props["rows"] if row["id"] == current_row["id"])["row_highlight"] == "actual"
    assert next(row for row in planned_table._props["rows"] if row["star_instance_id"] == current_row["star_instance_id"])["row_highlight"] == "counterpart"
    await user.should_see("正在编辑：当前背包实例")

    planned.trigger("selection", {"added": True, "rows": [planned_row], "keys": []})
    assert current_table._props["selected"] == []
    assert [row["star_instance_id"] for row in planned_table._props["selected"]] == [planned_row["star_instance_id"]]
    assert next(row for row in planned_table._props["rows"] if row["star_instance_id"] == planned_row["star_instance_id"])["row_highlight"] == "actual"
    assert next(row for row in current_table._props["rows"] if row["star_instance_id"] == planned_row["star_instance_id"])["row_highlight"] == "counterpart"
    await user.should_see("正在编辑：计划背包实例")

    planned.trigger("rowClick", planned_row)
    assert [row["star_instance_id"] for row in planned_table._props["selected"]] == [planned_row["star_instance_id"]]
    assert current_table._props["selected"] == []
    await user.should_see("正在编辑：计划背包实例")

    current.trigger("rowClick", current_row)
    assert [row["id"] for row in current_table._props["selected"]] == [current_row["id"]]
    assert planned_table._props["selected"] == []
    await user.should_see("正在编辑：当前背包实例")

    current.trigger(
        "selection",
        {"added": False, "rows": [], "keys": [current_row["id"]]},
    )
    assert current_table._props["selected"] == []
    assert planned_table._props["selected"] == []
    assert all(not row["row_highlight"] for row in current_table._props["rows"])
    assert all(not row["row_highlight"] for row in planned_table._props["rows"])

    planned.trigger("selection", {"added": True, "rows": [planned_row], "keys": []})
    kind_filter = user.find(marker="kind-filter")
    kind_filter.trigger(
        "update:modelValue",
        {"value": 2, "label": StarKind.SUPPORT.value},
    )
    assert next(iter(kind_filter.elements)).value == StarKind.SUPPORT.value
    user.find(marker="apply-filters").click()
    await asyncio.sleep(.1)

    refreshed_plan_table = max(
        user.find(marker="planned-inventory-table").elements,
        key=lambda element: element.id,
    )
    assert {row["kind"] for row in refreshed_plan_table._props["rows"]} == {StarKind.SUPPORT.value}
    assert refreshed_plan_table._props["selected"] == []
    await user.should_see("正在新增：当前背包")
    user.find(marker="clear-filters").click()
