from __future__ import annotations

import asyncio
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from nicegui import ui

from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem, GameVersion, Quality
from yuanstar.persistence import WorkspaceStore
from yuanstar.session import SessionState
from yuanstar.ui_contract import (
    can_confirm_all_pools,
    inventory_display_rows,
    plan_display_rows,
)
from yuanstar.vision.contracts import ImageInput
from yuanstar.vision.models import CardCandidate
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


ROOT = Path(__file__).resolve().parents[1]


def card(
    card_id: str,
    row: int,
    column: int,
    *,
    name_box: tuple[int, int, int, int],
    level_box: tuple[int, int, int, int],
    circle: tuple[int, int, int] | None = None,
) -> CardCandidate:
    return CardCandidate(
        card_id,
        row,
        column,
        (20 + column * 50, max(0, level_box[1] + 10), 40, 70),
        (0.0, 0.0, 0.0, 0.0),
        False,
        0.45,
        name_box,
        level_box,
        circle,
    )


def test_compact_bag_layout_and_filtered_rows_have_no_virtual_name_heading() -> None:
    source = (ROOT / "src" / "yuanstar" / "app.py").read_text(encoding="utf-8")
    assert ".bag-info-panel { min-width: 0; min-height: 0;" in source
    assert "align-self: stretch" in source
    assert ".bag-form-grid" in source and "gap: .1rem .65rem" in source
    assert "height: 12.5rem" not in source
    assert "margin: -.15rem" not in source
    assert "name-group-heading" not in source
    assert "props.row.name_group_header" not in source

    state = SessionState(load_catalog())
    state.detected_items = [
        DetectedStarItem(
            card_id=f"card-{index}",
            source_image="image",
            source_position=f"r1c{index}",
            page_type="main",
            final_name=name,
            final_level=level,
            final_quality=Quality.ORANGE,
            is_complete_card=True,
        )
        for index, (name, level) in enumerate(
            [("天府", 60), ("天府", 40), ("武曲", 50)],
            1,
        )
    ]
    state.recalculate_postprocess()
    state.set_filters("全部", "全部", "天府 武曲")
    filtered = state.filtered_rows()
    current = inventory_display_rows(filtered, aggregate_by_name=True)
    planned = plan_display_rows(filtered, state.plan_rows, aggregate_by_name=True)

    assert len(current) == len(filtered) == len(planned)
    assert all("name_group_header" not in row for row in current + planned)
    assert current[0]["name"] == "天府"
    assert current[0]["level"] == 60
    assert current[0]["quality"] == "橙"
    assert [row["group_quantity"] for row in current] == [
        "本组共 2 颗",
        "",
        "本组共 1 颗",
    ]
    assert [row["group_quantity"] for row in planned] == [
        row["group_quantity"] for row in current
    ]


def test_review_crop_covers_name_band_with_padding_without_next_row_body() -> None:
    cards = [
        SimpleNamespace(
            row_index=0,
            column_index=0,
            box_original=(20, 40, 80, 100),
            level_box_original=(20, 30, 80, 24),
            name_box_original=(20, 138, 80, 24),
            circle_original=(60, 90, 40),
        ),
        SimpleNamespace(
            row_index=0,
            column_index=1,
            box_original=(120, 40, 80, 100),
            level_box_original=(120, 30, 80, 24),
            name_box_original=(120, 138, 80, 24),
            circle_original=(160, 90, 40),
        ),
        SimpleNamespace(
            row_index=1,
            column_index=0,
            box_original=(20, 210, 80, 100),
            level_box_original=(20, 200, 80, 24),
            name_box_original=(20, 308, 80, 24),
            circle_original=(60, 260, 40),
        ),
    ]

    boxes = LocalOfflineVisionPipeline._row_crop_boxes(cards, 240, 360)
    first_bottom = boxes[0][1] + boxes[0][3]

    assert boxes[0][1] == 28
    assert first_bottom == 164
    assert boxes[1][1] + boxes[1][3] <= 360


def test_edge_fragments_are_excluded_individually_by_disc_geometry() -> None:
    image_height = 200
    cards = [
        card("top", 0, 0, name_box=(0, 30, 40, 20), level_box=(0, -2, 40, 20), circle=(20, 5, 6)),
        card("full-a", 0, 1, name_box=(50, 80, 40, 20), level_box=(50, 30, 40, 20), circle=(70, 60, 30)),
        card("bottom", 0, 2, name_box=(100, 195, 40, 20), level_box=(100, 150, 40, 20), circle=(120, 195, 6)),
        card("full-b", 0, 3, name_box=(150, 150, 40, 20), level_box=(150, 100, 40, 20), circle=(170, 130, 30)),
    ]

    excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        cards,
        image_height,
    )

    assert excluded == {"top": "top", "bottom": "bottom"}


def test_auto_excluded_edge_fragment_counts_as_excluded_and_undo_restores_it() -> None:
    state = SessionState(load_catalog())
    state.detected_items = [
        DetectedStarItem(
            card_id=f"edge-{column}",
            source_image="edge",
            source_position=f"r1c{column}",
            page_type="main",
            final_name="天府",
            final_level=60,
            final_quality=Quality.ORANGE,
            is_complete_card=True,
            inventory_action="auto_excluded_edge_fragment",
        )
        for column in range(1, 5)
    ]
    state.recalculate_postprocess()
    assert state.rows == []

    state.set_card_inventory_action("edge-1", "keep")
    assert next(
        item for item in state.detected_items if item.card_id == "edge-1"
    ).inventory_action == "keep"
    assert len(state.rows) == 1
    assert state.undo()
    assert all(
        item.inventory_action == "auto_excluded_edge_fragment"
        for item in state.detected_items
    )


def test_bulk_confirmation_availability_updates_for_classification_states() -> None:
    images = [
        SimpleNamespace(id="one"),
        SimpleNamespace(id="two"),
    ]
    assert not can_confirm_all_pools([], {}, set(), processing=False)
    assert not can_confirm_all_pools(
        images,
        {"one": "main", "two": "support"},
        set(),
        processing=True,
    )
    assert can_confirm_all_pools(
        images,
        {"one": "main", "two": "support"},
        set(),
        processing=False,
    )
    assert not can_confirm_all_pools(
        images,
        {"one": "main", "two": "unknown"},
        set(),
        processing=False,
    )
    assert can_confirm_all_pools(
        images,
        {"one": "main", "two": "support"},
        {"two"},
        processing=False,
    )
    assert can_confirm_all_pools(
        images,
        {"one": "main", "two": "support"},
        {"one", "two"},
        processing=False,
    )


def test_game_selection_round_trip_and_legacy_workspace_default(tmp_path: Path) -> None:
    store = WorkspaceStore(tmp_path / "workspace")
    state = SessionState(load_catalog())
    state.account_name = "保留账号"
    state.bag_current_count = 7
    state.bag_capacity = 500
    state.experience_quantities = {"橙星曜": 1, "紫星曜": 2, "白星曜": 3}
    state.uploaded_images = [
        ImageInput(
            id="image",
            filename="image.png",
            content=b"private-local-copy",
            content_type="image/png",
        )
    ]
    state.save_game_version(GameVersion.DAI_HAO_YUAN)
    store.save(state)

    restored = store.load(load_catalog()).state
    assert restored is not None
    assert restored.game_version == GameVersion.DAI_HAO_YUAN
    assert restored.account_name == "保留账号"
    assert restored.bag_current_count == 7
    assert restored.bag_capacity == 500
    assert restored.experience_quantities == {"橙星曜": 1, "紫星曜": 2, "白星曜": 3}
    assert [image.content for image in restored.uploaded_images] == [b"private-local-copy"]

    restored.save_game_version(GameVersion.RU_YUAN)
    store.save(restored)
    switched_back = store.load(load_catalog()).state
    assert switched_back is not None
    assert switched_back.game_version == GameVersion.RU_YUAN

    payload = json.loads(store.state_path.read_text(encoding="utf-8"))
    legacy_payload = deepcopy(payload)
    legacy_payload["state"].pop("game_version")
    store.state_path.write_text(
        json.dumps(legacy_payload, ensure_ascii=False),
        encoding="utf-8",
    )
    legacy = store.load(load_catalog()).state
    assert legacy is not None
    assert legacy.game_version == GameVersion.RU_YUAN
    store.save(legacy)
    rewritten = json.loads(store.state_path.read_text(encoding="utf-8"))
    assert rewritten["state"]["game_version"] == GameVersion.RU_YUAN.value


def test_game_controls_use_existing_workspace_save_flow() -> None:
    source = (ROOT / "src" / "yuanstar" / "app.py").read_text(encoding="utf-8")
    assert "game_version.on_value_change(save_import_game)" in source
    assert "metadata_version.on_value_change(save_metadata_game)" in source
    assert source.count("state.save_game_version(") == 2
    assert source.count("request_persist()") >= 2
    assert "confirm_all_action.refresh()" in source


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/task2_ui_test_app.py")
async def test_bulk_confirmation_button_refreshes_after_manual_pool_confirmation(
    user,
) -> None:
    await user.open("/")
    button = next(iter(user.find(marker="confirm-all-pools").elements))
    assert not button._props.get("disable", False)

    user.find(marker="confirm-selected-image").click()
    refreshed = next(iter(user.find(marker="confirm-all-pools").elements))
    assert not refreshed._props.get("disable", False)

    user.find(marker="confirm-pool-support").click()
    still_available = next(iter(user.find(marker="confirm-all-pools").elements))
    assert not still_available._props.get("disable", False)


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/task2_ui_test_app.py")
async def test_game_selection_event_updates_both_existing_controls(user) -> None:
    await user.open("/")
    import_game = next(iter(user.find(marker="import-game-version").elements))
    user.find(marker="import-game-version").trigger(
        "update:modelValue",
        {"value": 1, "label": "代号鸢"},
    )
    await asyncio.sleep(0.1)

    assert import_game.value == "代号鸢"
    user.find("人工核对").click()
    bag_game = next(iter(user.find(marker="bag-game-version").elements))
    assert bag_game.value == "代号鸢"
