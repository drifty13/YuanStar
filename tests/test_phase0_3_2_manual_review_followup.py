from __future__ import annotations

import json
from pathlib import Path
from time import sleep

import cv2
import numpy as np
import pytest
from nicegui import ui

from test_phase0_3_2_persistence_recalc import overlap_state
from yuanstar.catalog import load_catalog
from yuanstar.domain import Quality
from yuanstar.persistence import WorkspaceStore
from yuanstar.session import SessionState
from yuanstar.vision.card_detector import detect_cards
from yuanstar.vision.contracts import ImageInput
from yuanstar.vision.hierarchical_order import apply_hierarchical_name_sandwich
from yuanstar.vision.layout_profiles import select_layout_profile
from yuanstar.vision.models import CardCandidate, RecognizedStar
from yuanstar.vision.offline_pipeline import OfflineSingleImagePipeline
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline
from yuanstar.vision.viewport import detect_viewport


ROOT = Path(__file__).resolve().parents[1]
TABLET_ROOT = ROOT / "samples_private" / "phase0_2" / "raw" / "own_tablet"
EIGHT_CARD_SAMPLE = TABLET_ROOT / "support" / "own_tablet_support_002.png"
PHONE_CROP_SAMPLE = (
    ROOT
    / "samples_private"
    / "phase0_2"
    / "raw"
    / "own_phone"
    / "main"
    / "own_phone_main_001.jpg"
)


def _card(card_id: str, column: int) -> CardCandidate:
    return CardCandidate(
        card_id,
        0,
        column,
        (column * 30, 10, 24, 24),
        (0.0, 0.0, 0.0, 0.0),
        True,
        0.99,
    )


def _star(
    card_id: str,
    *,
    name: str | None,
    equipped: str,
) -> RecognizedStar:
    return RecognizedStar(
        card_id=card_id,
        page_type="main",
        raw_name_text=name,
        canonical_name=name,
        name_confidence=0.95 if name else 0.0,
        raw_level_text="40级",
        level=40,
        level_confidence=0.95,
        overall_confidence=0.90,
        review_required=name is None,
        name_source="direct_ocr",
        direct_level=40,
        quality="橙",
        quality_confidence=0.95,
        quality_source="visual_background",
        equipped_state=equipped,
        equipped_confidence=0.90,
        equipped_source="test",
    )


def _decode(path: Path) -> np.ndarray:
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    assert image is not None
    return image


def test_legal_name_sandwich_is_inferred_with_auditable_reason() -> None:
    cards = [_card("left", 0), _card("middle", 1), _card("right", 2)]
    stars = [
        _star("left", name="天府", equipped="unequipped"),
        _star("middle", name=None, equipped="unequipped"),
        _star("right", name="天府", equipped="unequipped"),
    ]

    result = {item.card_id: item for item in apply_hierarchical_name_sandwich(cards, stars)}

    assert result["middle"].canonical_name == "天府"
    assert result["middle"].name_source == "hierarchical_sort_sandwich_inference"
    assert "name_inferred_by_hierarchical_sandwich" in result["middle"].warnings


def test_name_sandwich_never_crosses_equipped_boundary() -> None:
    cards = [_card("left", 0), _card("middle", 1), _card("right", 2)]
    stars = [
        _star("left", name="天府", equipped="equipped"),
        _star("middle", name=None, equipped="unequipped"),
        _star("right", name="天府", equipped="equipped"),
    ]

    result = {item.card_id: item for item in apply_hierarchical_name_sandwich(cards, stars)}

    assert result["middle"].canonical_name is None
    assert "name_inferred_by_hierarchical_sandwich" not in result["middle"].warnings


@pytest.mark.skipif(not EIGHT_CARD_SAMPLE.exists(), reason="private regression sample unavailable")
def test_real_tablet_two_missing_rows_are_all_preserved() -> None:
    analysis, _ = OfflineSingleImagePipeline().analyze_path(EIGHT_CARD_SAMPLE)
    complete = [card for card in analysis.cards if card.is_complete]

    assert analysis.page.page_type == "support"
    assert len(complete) == 16
    assert {
        (card.row_index, card.column_index)
        for card in complete
    } == {
        (row, column)
        for row in range(4)
        for column in range(4)
    }


@pytest.mark.skipif(not EIGHT_CARD_SAMPLE.exists(), reason="private regression sample unavailable")
def test_web_entry_and_canonical_entry_match_on_existing_tablet_image() -> None:
    image = _decode(EIGHT_CARD_SAMPLE)
    web = LocalOfflineVisionPipeline()
    canonical = web.canonical_pipeline

    canonical_result, _ = canonical.analyze_image(image, "same-image")
    web_result, _ = web.analyze_decoded_image(image, "same-image")

    assert web_result.page == canonical_result.page
    assert [
        (card.row_index, card.column_index, card.box_normalized, card.is_complete)
        for card in web_result.cards
    ] == [
        (card.row_index, card.column_index, card.box_normalized, card.is_complete)
        for card in canonical_result.cards
    ]
    assert [
        (
            star.card_id,
            star.canonical_name,
            star.level,
            star.quality,
            star.name_source,
            tuple(star.warnings),
        )
        for star in web_result.stars
    ] == [
        (
            star.card_id,
            star.canonical_name,
            star.level,
            star.quality,
            star.name_source,
            tuple(star.warnings),
        )
        for star in canonical_result.stars
    ]


@pytest.mark.skipif(not TABLET_ROOT.exists(), reason="private regression samples unavailable")
def test_existing_tablet_detector_removes_bottom_controls_and_keeps_real_tails() -> None:
    expected = {
        "own_tablet_main_001.png": (16, 16),
        "own_tablet_main_002.png": (16, 16),
        "own_tablet_main_003.png": (16, 16),
        "own_tablet_main_004.png": (16, 16),
        "own_tablet_main_005.png": (22, 20),
        "own_tablet_main_006.png": (16, 16),
        "own_tablet_support_001.png": (16, 16),
        "own_tablet_support_002.png": (16, 16),
        "own_tablet_support_003.png": (16, 16),
        "own_tablet_support_004.png": (16, 16),
        "own_tablet_support_005.png": (16, 16),
        "own_tablet_support_006.png": (16, 16),
        "own_tablet_support_007.png": (16, 16),
        "own_tablet_support_008.png": (16, 16),
        "own_tablet_support_009.png": (14, 14),
    }
    actual: dict[str, tuple[int, int]] = {}
    for path in sorted((*((TABLET_ROOT / "main").glob("*.png")), *((TABLET_ROOT / "support").glob("*.png")))):
        image = _decode(path)
        viewport = detect_viewport(image).viewport_box
        profile = select_layout_profile((viewport[2], viewport[3]))
        cards = detect_cards(image, viewport, profile, anchors_present=True)
        actual[path.name] = (len(cards), sum(card.is_complete for card in cards))

    assert actual == expected
    assert sum(total for total, _ in actual.values()) == 244


def test_review_crop_follows_actual_level_and_name_rois() -> None:
    card = CardCandidate(
        "card",
        0,
        0,
        (20, 30, 100, 120),
        (0.0, 0.0, 0.0, 0.0),
        True,
        0.99,
        (20, 148, 100, 28),
        (20, 24, 100, 28),
        (70, 90, 50),
    )

    box = LocalOfflineVisionPipeline._row_crop_boxes([card], 300, 260)[0]

    assert box[1] == 22
    assert box[1] + box[3] == 178
    assert box[1] + box[3] <= 260


@pytest.mark.parametrize("path", [PHONE_CROP_SAMPLE, EIGHT_CARD_SAMPLE])
def test_existing_phone_and_tablet_review_crops_include_name_line(path: Path) -> None:
    if not path.exists():
        pytest.skip("private crop regression sample unavailable")
    image = _decode(path)
    viewport = detect_viewport(image).viewport_box
    profile = select_layout_profile((viewport[2], viewport[3]))
    cards = detect_cards(image, viewport, profile, anchors_present=True)
    first_row = [card for card in cards if card.row_index == 0 and card.is_complete]
    assert first_row

    row_box = LocalOfflineVisionPipeline._row_crop_boxes(
        cards,
        image.shape[1],
        image.shape[0],
    )[0]
    crop_bottom = row_box[1] + row_box[3]
    name_bottom = max(
        card.name_box_original[1] + card.name_box_original[3]
        for card in first_row
        if card.name_box_original is not None
    )

    assert crop_bottom >= name_bottom


def test_workspace_account_and_business_state_restore(tmp_path: Path) -> None:
    catalog = load_catalog()
    state = overlap_state()
    state.save_account_name("本地测试账号")
    state.save_experience(orange=6, purple=7, white=8)
    state.uploaded_images = [
        ImageInput(
            id="before",
            filename="before.png",
            width=8,
            height=8,
            content_type="image/png",
            content=b"image-before",
        ),
        ImageInput(
            id="after",
            filename="after.png",
            width=8,
            height=8,
            content_type="image/png",
            content=b"image-after",
        ),
    ]
    store = WorkspaceStore(tmp_path / "workspace")
    store.save(state)

    loaded = store.load(catalog).state

    assert loaded is not None
    assert loaded.account_name == "本地测试账号"
    assert loaded.image_pools == state.image_pools
    assert loaded.overlap_pairs == state.overlap_pairs
    assert loaded.experience_quantities == {"橙星曜": 6, "紫星曜": 7, "白星曜": 8}
    assert [item.manual_override for item in loaded.detected_items] == [
        item.manual_override for item in state.detected_items
    ]


def test_ordinary_save_does_not_rewrite_unchanged_image_copy(tmp_path: Path) -> None:
    state = SessionState(load_catalog())
    image = ImageInput(
        id="same-image",
        filename="same.png",
        width=8,
        height=8,
        content_type="image/png",
        content=b"immutable-image-content",
    )
    state.uploaded_images = [image]
    store = WorkspaceStore(tmp_path / "workspace")
    store.save(state)
    stored = next(store.image_dir.iterdir())
    original_mtime = stored.stat().st_mtime_ns
    original_content = stored.read_bytes()

    sleep(0.01)
    state.save_account_name("只改结构化字段")
    store.save(state)

    assert stored.read_bytes() == original_content
    assert stored.stat().st_mtime_ns == original_mtime


def test_older_prepared_save_cannot_overwrite_newer_revision(tmp_path: Path) -> None:
    state = SessionState(load_catalog())
    store = WorkspaceStore(tmp_path / "workspace")
    state.account_name = "旧状态"
    older = store.prepare(state, revision=1)
    state.account_name = "新状态"
    newer = store.prepare(state, revision=2)

    store.save(newer)
    store.save(older)

    payload = json.loads(store.state_path.read_text(encoding="utf-8"))
    assert payload["state"]["account_name"] == "新状态"


def test_overlap_primary_prefers_manual_value_and_id_is_stable_after_relation_restore() -> None:
    state = overlap_state()
    state.update_detected_card(
        "after:r1c4",
        name="太阳",
        level=60,
        quality=Quality.PURPLE,
    )
    manual_row = next(row for row in state.rows if row.occurrence_id == "after:r1c4")
    stable_id = manual_row.star_instance_id
    assert manual_row.quality == Quality.PURPLE
    assert state.detected_items[3].overlap_duplicate_of == "after:r1c4"

    state.remove_overlap_pair("main", "before", "after")
    assert len(state.rows) == 8
    state.add_overlap_pair("main", "before", "after")

    restored = next(row for row in state.rows if row.occurrence_id == "after:r1c4")
    assert restored.star_instance_id == stable_id
    assert restored.quality == Quality.PURPLE


def test_conflicting_manual_values_in_overlap_are_visible_and_not_silently_chosen() -> None:
    state = overlap_state()
    state.update_detected_card(
        "after:r1c4",
        name="太阳",
        level=60,
        quality=Quality.PURPLE,
    )
    state.update_detected_card(
        "before:r4c4",
        name="太阳",
        level=60,
        quality=Quality.ORANGE,
    )

    conflicting = [
        item
        for item in state.detected_items
        if item.card_id in {"before:r4c4", "after:r1c4"}
    ]
    assert all(item.overlap_duplicate_of is None for item in conflicting)
    assert all("manual_overlap_value_conflict" in item.field_warnings for item in conflicting)
    assert any(entry.get("status") == "冲突" for entry in state.overlap_audit)


@pytest.mark.anyio
@pytest.mark.nicegui_main_file("tests/phase0_3_2_test_app.py")
async def test_review_layout_and_target_pool_startup_regression(user) -> None:
    await user.open("/")
    await user.should_see(marker="workspace-account-name")
    user.find("人工核对").click()

    await user.should_not_see(kind=ui.label, content="人工核对")
    await user.should_see(marker="bag-info-four-fields")
    await user.should_see(marker="bag-account-name")
    await user.should_see(marker="review-section-experience")

    current_table = next(iter(user.find(marker="current-inventory-table").elements))
    planned_table = next(iter(user.find(marker="planned-inventory-table").elements))
    assert [column["name"] for column in current_table._props["columns"]] == [
        "kind",
        "name",
        "level",
        "quality",
        "group_quantity",
    ]
    assert [column["name"] for column in planned_table._props["columns"]] == [
        "kind",
        "name",
        "level",
        "quality",
        "group_quantity",
    ]
    assert all(column.get("style") == "width:20%" for column in current_table._props["columns"])
    assert all(column.get("style") == "width:20%" for column in planned_table._props["columns"])
