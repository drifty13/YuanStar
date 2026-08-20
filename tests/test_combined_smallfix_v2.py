from __future__ import annotations

from pathlib import Path

import numpy as np

from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion, ImportBatch, InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState
from yuanstar.vision.contracts import AnalysisResult, ImageInput
from yuanstar.vision.experience_recognizer import (
    EXPERIENCE_COUNT_HEIGHT,
    EXPERIENCE_COUNT_WIDTH,
    EXPERIENCE_COUNT_X_OFFSET,
    EXPERIENCE_COUNT_Y_OFFSET,
    _count,
    experience_count_box,
)
from yuanstar.vision.hierarchical_order import (
    EQUIPPED_ROI_HEIGHT,
    EQUIPPED_ROI_WIDTH,
    EQUIPPED_ROI_X_OFFSET,
    EQUIPPED_ROI_Y_OFFSET,
    apply_hierarchical_order,
    equipped_roi_box,
    infer_equipped_sandwiches,
    recognize_equipped_on_demand,
)
from yuanstar.vision.models import CardCandidate, RecognizedStar
from yuanstar.vision.ocr_engine import OcrText
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


def _card(index: int) -> CardCandidate:
    return CardCandidate(
        card_id=f"c{index}",
        row_index=index // 4,
        column_index=index % 4,
        box_original=(10 + index * 100, 20, 100, 200),
        box_normalized=(0.0, 0.0, 0.1, 0.2),
        is_complete=True,
        completeness_confidence=.95,
    )


def _star(index: int, level: int, *, name: str = "天府") -> RecognizedStar:
    return RecognizedStar(
        card_id=f"c{index}",
        page_type="main",
        raw_name_text=name,
        canonical_name=name,
        name_confidence=.95,
        raw_level_text=str(level),
        level=level,
        level_confidence=.95,
        overall_confidence=.95,
        review_required=False,
        direct_level=level,
        quality="橙",
        quality_confidence=.95,
    )


def test_clear_batch_resets_derived_state_but_keeps_workspace_identity_and_history() -> None:
    state = SessionState(load_catalog())
    state.game_version = GameVersion.DAI_HAO_YUAN
    state.account_name = "长期账号"
    state.uploaded_images = [ImageInput(filename="a.png", content=b"a")]
    state.rows = [InventorySummaryRow(
        kind=StarKind.MAIN,
        name="天府",
        level=60,
        quality=Quality.ORANGE,
        quantity=1,
    )]
    state.plan_rows = {}
    state.bag_current_count = 203
    state.bag_capacity = 250
    state.bag_resolution = {"status": "一致", "candidates": [{"bag_current_count": 203}]}
    state.experience_quantities = {"橙星曜": 1, "紫星曜": 77, "白星曜": 14}
    state.experience_evidence = {"紫星曜": {"raw_texts": ["77"]}}

    state.clear_uploaded_images()

    assert state.uploaded_images == []
    assert state.rows == [] and state.plan_rows == {}
    assert state.bag_current_count is None and state.bag_capacity is None
    assert state.bag_resolution == {}
    assert state.experience_quantities == {"橙星曜": None, "紫星曜": None, "白星曜": None}
    assert state.experience_evidence == {}
    assert state.game_version == GameVersion.DAI_HAO_YUAN
    assert state.account_name == "长期账号"

    state.add_row(InventorySummaryRow(
        kind=StarKind.MAIN,
        name="武曲",
        level=1,
        quality=Quality.WHITE,
        quantity=1,
    ))
    assert state.undo()
    assert state.rows == []
    assert state.redo()
    assert [row.name for row in state.rows] == ["武曲"]


def test_new_batch_missing_bag_count_cannot_reuse_previous_batch() -> None:
    state = SessionState(load_catalog())
    state.bag_current_count = 203
    state.bag_capacity = 250
    state.clear_uploaded_images()
    state.uploaded_images = [ImageInput(id="b", filename="b.png", content=b"b")]

    state.apply_local_analysis(AnalysisResult(
        True,
        "batch B",
        import_batch=ImportBatch(
            image_count=1,
            game_version=GameVersion.RU_YUAN,
            bag_current_count=None,
            bag_capacity=None,
            ocr_executed=True,
        ),
        image_pools={"b": "main"},
        bag_resolution={"status": "未识别", "bag_current_count": None, "bag_capacity": None},
    ))

    assert state.bag_current_count is None and state.bag_capacity is None
    assert state.bag_resolution["status"] == "未识别"


def test_final_roi_parameters_and_image_clipping() -> None:
    assert (EQUIPPED_ROI_X_OFFSET, EQUIPPED_ROI_Y_OFFSET, EQUIPPED_ROI_WIDTH, EQUIPPED_ROI_HEIGHT) == (
        -0.065,
        0.00,
        0.37,
        0.36,
    )
    assert (EXPERIENCE_COUNT_X_OFFSET, EXPERIENCE_COUNT_Y_OFFSET, EXPERIENCE_COUNT_WIDTH, EXPERIENCE_COUNT_HEIGHT) == (
        0.40,
        0.78,
        0.60,
        0.24,
    )
    edge_card = CardCandidate("edge", 0, 0, (2, 5, 100, 200), (0, 0, 1, 1), True, .9)
    assert equipped_roi_box(edge_card, (60, 30, 3)) == (0, 5, 30, 55)
    assert experience_count_box((10, 20, 100, 200)) == (50, 176, 60, 48)


def test_equipped_classifier_is_zero_for_explained_order_and_local_for_one_boundary() -> None:
    image = np.zeros((500, 1000, 3), dtype=np.uint8)
    cards = [_card(index) for index in range(8)]
    ordered_stars = [_star(index, 60 - index * 5) for index in range(8)]
    called: list[str] = []

    def classifier(_, card):
        called.append(card.card_id)
        return "unknown", .4, "test", []

    evidence, count = recognize_equipped_on_demand(
        image, cards, ordered_stars, classifier=classifier,
    )
    assert evidence == {} and count == 0 and called == []

    boundary_stars = [_star(index, level) for index, level in enumerate((60, 50, 40, 30, 60, 50, 40, 30))]

    def boundary_classifier(_, card):
        called.append(card.card_id)
        state = "equipped" if card.card_id == "c3" else "unequipped"
        return state, .9, "test", []

    called.clear()
    evidence, count = recognize_equipped_on_demand(
        image, cards, boundary_stars, classifier=boundary_classifier,
    )
    assert count == 2
    assert called == ["c3", "c4"]
    assert set(evidence) == {"c3", "c4"}


def test_equipped_sandwich_and_reverse_order_warning_are_conservative() -> None:
    cards = [_card(index) for index in range(3)]
    stars = [_star(index, 60) for index in range(3)]
    inferred = infer_equipped_sandwiches(cards, stars, {
        "c0": ("equipped", .9, "test", []),
        "c1": ("unknown", .4, "test", []),
        "c2": ("equipped", .9, "test", []),
    })
    assert inferred["c1"][0] == "equipped"
    assert inferred["c1"][2] == "equipped_sandwich_inference"

    unchanged = infer_equipped_sandwiches(cards, stars, {
        "c0": ("equipped", .9, "test", []),
        "c1": ("unknown", .4, "test", []),
        "c2": ("unequipped", .9, "test", []),
    })
    assert unchanged["c1"][0] == "unknown"

    reversed_stars = apply_hierarchical_order(cards[:2], stars[:2], {
        "c0": ("unequipped", .9, "test", []),
        "c1": ("equipped", .9, "test", []),
    })
    assert "equipped_order_reversal" in reversed_stars[1].warnings
    assert reversed_stars[1].review_required


class _Engine:
    def __init__(self, text: str) -> None:
        self.text = text

    def recognize(self, _image, *, single_line: bool = False):
        assert single_line
        return [OcrText(self.text, .99)]


def test_non_numeric_experience_count_stays_unknown_and_keeps_evidence() -> None:
    image = np.zeros((300, 300, 3), dtype=np.uint8)
    assert _count(image, (10, 10, 100, 100), _Engine("T")) == (None, 0.0, ("T",))
    assert _count(image, (10, 10, 100, 100), _Engine("77")) == (77, .99, ("77",))
    assert _count(image, (10, 10, 100, 100), _Engine("T77")) == (None, 0.0, ("T77",))

    state = SessionState(load_catalog())
    state.experience_evidence = {
        "紫星曜": {
            "value": None,
            "icon_detected": True,
            "raw_texts": ["T"],
            "count_boxes": [(40, 78, 60, 24)],
            "source_images": ["source-id"],
        }
    }
    assert state.experience_quantity_needs_review("紫星曜")
    state.save_experience(77, None, None)
    assert not state.experience_quantity_needs_review("紫星曜")
    assert state.experience_evidence["紫星曜"]["raw_texts"] == ["T"]
    assert state.experience_evidence["紫星曜"]["count_boxes"] == [(40, 78, 60, 24)]


def test_experience_resolution_keeps_unparsed_source_text_and_roi() -> None:
    resolved = LocalOfflineVisionPipeline._resolve_experience_observations([{
        "source_image": "source-id",
        "purple_count": None,
        "purple_confidence": 0.0,
        "evidence": {
            "purple": {
                "icon_detected": True,
                "raw_texts": ["T"],
                "count_box": (40, 78, 60, 24),
                "icon_box": (0, 0, 100, 100),
            }
        },
    }])
    purple = resolved["紫星曜"]
    assert purple["value"] is None
    assert purple["icon_detected"] is True
    assert purple["raw_texts"] == ["T"]
    assert purple["count_boxes"] == [(40, 78, 60, 24)]
    assert purple["source_images"] == ["source-id"]


def test_viewer_contract_keeps_fit_and_adds_scoped_zoom_pan_controls() -> None:
    source = (Path(__file__).parents[1] / "src" / "yuanstar" / "app.py").read_text(encoding="utf-8")
    assert ".full-viewer-image .q-img__image { object-fit: contain !important; }" in source
    assert "Math.max(0.5, Math.min(4.0, scale + delta))" in source
    assert "event.ctrlKey" in source
    assert "{passive: false}" in source
    assert "pointerdown" in source and "setPointerCapture" in source
    assert "window.__yuanstarViewers?.['" in source
    assert "?.reset();" in source
    assert ".current-inventory-table tbody tr:has(> .group-divider-cell) > td" in source
    assert ".current-inventory-table tbody tr:has(> .kind-divider-cell) > td" in source
