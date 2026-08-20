from __future__ import annotations

from dataclasses import replace

import cv2
import numpy as np
import pytest

from tools.inspect_ocr_roi import PRODUCTION_ROI
from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem, GameVersion, ImportBatch, Quality
from yuanstar.session import SessionState
from yuanstar.ui_contract import item_needs_review
from yuanstar.vision.bottom_toolbar import locate_bottom_toolbar
from yuanstar.vision.card_detector import CircleProposal, _boxes, _toolbar_top, detect_cards
from yuanstar.vision.hierarchical_order import (
    apply_hierarchical_name_sandwich,
    apply_hierarchical_order,
)
from yuanstar.vision.layout_profiles import PHONE_PORTRAIT_V1
from yuanstar.vision.contracts import ImageInput
from yuanstar.vision.models import CardCandidate, ExperienceStoneResult, PageClassification, RecognizedStar, SingleImageAnalysis, ViewportResult
from yuanstar.vision.ocr_engine import PositionedOcrText
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline


def _proposal_image(
    height: int,
    proposals: list[CircleProposal],
) -> np.ndarray:
    image = np.full((height, 500, 3), 24, dtype=np.uint8)
    for proposal in proposals:
        cv2.circle(
            image,
            (proposal.center_x, proposal.center_y),
            proposal.radius,
            (210, 190, 120),
            3,
        )
        cv2.line(
            image,
            (proposal.center_x - proposal.radius // 2, proposal.center_y),
            (proposal.center_x + proposal.radius // 2, proposal.center_y),
            (240, 240, 240),
            2,
        )
    return image


def _grid(rows: tuple[int, ...], *, columns: tuple[int, ...] = (80, 190, 300, 410)) -> list[CircleProposal]:
    return [
        CircleProposal(x, y, 35)
        for y in rows
        for x in columns
    ]


def _cards_above_toolbar(
    monkeypatch,
    *,
    tail_y: int,
    tail_columns: tuple[int, ...] = (80, 190, 300, 410),
) -> tuple[list[CardCandidate], dict[str, object]]:
    proposals = [*_grid((650,)), *_grid((tail_y,), columns=tail_columns)]
    image = _proposal_image(1000, proposals)
    monkeypatch.setattr(
        "yuanstar.vision.card_detector._hough_proposals",
        lambda *_args, **_kwargs: proposals,
    )
    audit: dict[str, object] = {}
    cards = detect_cards(
        image,
        (0, 0, 500, 1000),
        PHONE_PORTRAIT_V1,
        bottom_toolbar_anchor_boxes=((30, 904, 80, 22), (200, 904, 80, 22)),
        detection_audit=audit,
    )
    return cards, audit


def test_card_completeness_requires_disc_and_both_text_boxes(monkeypatch) -> None:
    cards, audit = _cards_above_toolbar(monkeypatch, tail_y=800)
    tail = [card for card in cards if card.row_index == 1]

    assert audit["card_content_bottom"] == 900
    assert len(tail) == 4
    assert all(card.is_complete for card in tail)


def test_toolbar_content_bottom_rejects_dark_background_far_above_anchors() -> None:
    anchors = ((350, 2517, 142, 87), (1002, 2521, 132, 79))
    assert _toolbar_top(anchors, 119, 2166) == 2505

    phone_anchors = ((69, 1274, 60, 40), (198, 1277, 55, 34))
    assert _toolbar_top(phone_anchors, 48, 1157) == 1157


def test_circle_complete_but_name_box_below_content_bottom_is_fragment(monkeypatch) -> None:
    cards, audit = _cards_above_toolbar(monkeypatch, tail_y=850)
    tail = [card for card in cards if card.row_index == 1]

    assert len(tail) == 4
    assert all(card.circle_original[1] + card.circle_original[2] < audit["card_content_bottom"] for card in tail)
    assert all(card.level_box_original[1] + card.level_box_original[3] <= audit["card_content_bottom"] for card in tail)
    assert all(card.name_box_original[1] + card.name_box_original[3] > audit["card_content_bottom"] for card in tail)
    assert all(not card.is_complete for card in tail)
    assert LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        tail,
        1000,
        content_bottom=audit["card_content_bottom"],
    ) == {card.card_id: "bottom" for card in tail}


def test_name_box_on_content_bottom_boundary_remains_complete(monkeypatch) -> None:
    cards, audit = _cards_above_toolbar(monkeypatch, tail_y=842)
    tail = [card for card in cards if card.row_index == 1]

    assert len(tail) == 4
    assert all(card.name_box_original[1] + card.name_box_original[3] == audit["card_content_bottom"] for card in tail)
    assert all(card.is_complete for card in tail)


def test_batch_marks_name_box_content_cut_as_bottom_fragment(monkeypatch) -> None:
    proposal = CircleProposal(80, 850, 35)
    box, name_box, level_box = _boxes(proposal)
    card = CardCandidate(
        "cut-name",
        0,
        0,
        box,
        (0.0, 0.0, 0.0, 0.0),
        False,
        0.45,
        name_box,
        level_box,
        (proposal.center_x, proposal.center_y, proposal.radius),
    )
    analysis = SingleImageAnalysis(
        "content-cut",
        ViewportResult((500, 1000), (0, 0, 500, 1000), "phone_portrait_v1", 1.0),
        PageClassification("main", 0.9, ["selected_tab_visual:main"]),
        [card],
        [],
        content_bounds=(0, 900),
    )
    monkeypatch.setattr(
        LocalOfflineVisionPipeline,
        "analyze_decoded_image",
        lambda _self, image, _image_id: (analysis, image),
    )
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    result = LocalOfflineVisionPipeline().analyze(
        [ImageInput("content-cut.jpg", content=encoded.tobytes(), id="content-cut")],
        ImportBatch(image_count=1, game_version=GameVersion.RU_YUAN),
    )

    item = result.items[0]
    assert not item.is_complete_card
    assert item.inventory_action == "auto_excluded_edge_fragment"
    assert item.row_crop_box is None
    assert "auto_excluded_edge_fragment_bottom" in item.field_warnings


def test_experience_analysis_without_content_bounds_does_not_rederive_profile(monkeypatch) -> None:
    experience = ExperienceStoneResult(
        3,
        2,
        1,
        0.9,
        0.9,
        0.9,
        True,
        evidence={
            kind: {"icon_detected": True}
            for kind in ("orange", "purple", "white")
        },
    )
    analysis = SingleImageAnalysis(
        "experience",
        ViewportResult((500, 1000), (0, 0, 500, 1000), "phone_portrait_v1", 1.0),
        PageClassification("experience", 0.9, ["selected_tab_visual:experience"]),
        [],
        [],
        experience=experience,
        content_bounds=None,
    )
    monkeypatch.setattr(
        LocalOfflineVisionPipeline,
        "analyze_decoded_image",
        lambda _self, image, _image_id: (analysis, image),
    )
    image = np.zeros((100, 100, 3), dtype=np.uint8)
    ok, encoded = cv2.imencode(".jpg", image)
    assert ok
    result = LocalOfflineVisionPipeline().analyze(
        [ImageInput("experience.jpg", content=encoded.tobytes(), id="experience")],
        ImportBatch(image_count=1, game_version=GameVersion.RU_YUAN),
    )

    assert result.executed
    assert [result.experience_resolution[label]["value"] for label in ("橙星曜", "紫星曜", "白星曜")] == [3, 2, 1]


def test_text_box_cut_does_not_propagate_to_aligned_four_card_row() -> None:
    cards = [_card(f"card-{column}", 0, column, (80 + column * 110, 800, 35)) for column in range(4)]
    first = cards[0]
    x, _, width, _ = first.name_box_original
    cards[0] = replace(first, name_box_original=(x, 890, width, 11))

    excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        cards,
        1000,
        content_bottom=900,
    )

    assert excluded == {"card-0": "bottom"}


def test_all_four_text_box_cuts_remain_individual_bottom_fragments() -> None:
    cards = [_card(f"card-{column}", 0, column, (80 + column * 110, 800, 35)) for column in range(4)]
    cards = [
        replace(card, name_box_original=(card.name_box_original[0], 890, card.name_box_original[2], 11))
        for card in cards
    ]

    excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        cards,
        1000,
        content_bottom=900,
    )

    assert excluded == {card.card_id: "bottom" for card in cards}


def test_aligned_four_card_circle_edge_keeps_circle_only_row_compensation() -> None:
    cards = [
        _card("card-0", 0, 0, (80, 870, 35)),
        *[_card(f"card-{column}", 0, column, (80 + column * 110, 864, 35)) for column in range(1, 4)],
    ]
    cards = [
        replace(card, name_box_original=(card.name_box_original[0], 800, card.name_box_original[2], 12), level_box_original=(card.level_box_original[0], 760, card.level_box_original[2], 12))
        for card in cards
    ]

    excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        cards,
        1000,
        content_bottom=900,
    )

    assert excluded == {card.card_id: "bottom" for card in cards}


@pytest.mark.parametrize("tail_count", [1, 2, 3])
def test_complete_one_to_three_card_tail_is_retained(monkeypatch, tail_count: int) -> None:
    columns = (80, 190, 300, 410)[:tail_count]
    cards, _ = _cards_above_toolbar(monkeypatch, tail_y=800, tail_columns=columns)
    tail = [card for card in cards if card.row_index == 1]

    assert len(tail) == tail_count
    assert all(card.is_complete for card in tail)


@pytest.mark.parametrize("height,toolbar_y", [(1000, 880), (1200, 1080)])
def test_toolbar_circle_is_filtered_at_different_image_heights(
    monkeypatch,
    height: int,
    toolbar_y: int,
) -> None:
    real_rows = (220, 420, 620)
    fake = CircleProposal(300, toolbar_y, 35)
    proposals = [*_grid(real_rows), fake]
    image = _proposal_image(height, proposals)
    monkeypatch.setattr(
        "yuanstar.vision.card_detector._hough_proposals",
        lambda *_args, **_kwargs: proposals,
    )
    audit: dict[str, object] = {}

    cards = detect_cards(
        image,
        (0, 0, 500, height),
        PHONE_PORTRAIT_V1,
        bottom_toolbar_anchor_boxes=(
            (40, toolbar_y - 12, 60, 20),
            (200, toolbar_y - 10, 60, 20),
        ),
        detection_audit=audit,
    )

    assert len(cards) == 12
    assert all(card.circle_original != (fake.center_x, fake.center_y, fake.radius) for card in cards)
    assert audit["auto_excluded_bottom_ui"] == 1


def test_toolbar_keeps_complete_one_to_three_card_tail(monkeypatch) -> None:
    proposals = [
        *_grid((200, 400, 600)),
        *_grid((800,), columns=(80, 190, 300)),
        CircleProposal(300, 960, 35),
    ]
    image = _proposal_image(1050, proposals)
    monkeypatch.setattr(
        "yuanstar.vision.card_detector._hough_proposals",
        lambda *_args, **_kwargs: proposals,
    )

    cards = detect_cards(
        image,
        (0, 0, 500, 1050),
        PHONE_PORTRAIT_V1,
        bottom_toolbar_anchor_boxes=((30, 950, 80, 22), (200, 950, 80, 22)),
    )

    assert {(card.row_index, card.column_index) for card in cards if card.row_index == 3} == {
        (3, 0),
        (3, 1),
        (3, 2),
    }
    assert all(card.is_complete for card in cards if card.row_index == 3)


def test_partial_without_toolbar_has_no_fixed_bottom_mask(monkeypatch) -> None:
    proposals = [*_grid((200, 400, 600)), *_grid((800,), columns=(80, 190))]
    image = _proposal_image(1000, proposals)
    monkeypatch.setattr(
        "yuanstar.vision.card_detector._hough_proposals",
        lambda *_args, **_kwargs: proposals,
    )
    audit: dict[str, object] = {}

    cards = detect_cards(
        image,
        (0, 0, 500, 1000),
        PHONE_PORTRAIT_V1,
        anchors_present=False,
        detection_audit=audit,
    )

    assert {(card.row_index, card.column_index) for card in cards if card.row_index == 3} == {
        (3, 0),
        (3, 1),
    }
    assert audit["bottom_toolbar_present"] is False
    assert audit["auto_excluded_bottom_ui"] == 0


class _PositionedEngine:
    def __init__(self, values: list[PositionedOcrText]) -> None:
        self.values = values

    def recognize_positioned(self, _image):
        return self.values


def test_normal_and_decompose_toolbar_require_two_positioned_anchors() -> None:
    image = np.full((1000, 500, 3), 120, dtype=np.uint8)
    normal = locate_bottom_toolbar(
        image,
        (0, 0, 500, 1000),
        _PositionedEngine(
            [
                PositionedOcrText("自动", 0.9, (80, 330, 45, 20)),
                PositionedOcrText("筛选", 0.9, (190, 332, 45, 20)),
                PositionedOcrText("142/245", 0.9, (330, 331, 80, 20)),
            ]
        ),
    )
    assert normal.present
    assert set(normal.labels) == {"自动", "筛选", "capacity"}

    image[760:] = 35
    decompose = locate_bottom_toolbar(
        image,
        (0, 0, 500, 1000),
        _PositionedEngine(
            [
                PositionedOcrText("取消分解", 0.9, (20, 255, 85, 20)),
                PositionedOcrText("一键解锁", 0.9, (340, 256, 85, 20)),
                PositionedOcrText("一键选择", 0.9, (90, 390, 85, 20)),
                PositionedOcrText("分解", 0.9, (320, 392, 45, 20)),
            ]
        ),
    )
    assert decompose.present
    assert {"取消分解", "一键解锁", "一键选择", "分解"} == set(decompose.labels)
    assert decompose.dark_panel_top is not None

    missing = locate_bottom_toolbar(
        image,
        (0, 0, 500, 1000),
        _PositionedEngine([PositionedOcrText("筛选", 0.9, (190, 332, 45, 20))]),
    )
    assert not missing.present


def _card(
    card_id: str,
    row: int,
    column: int,
    circle: tuple[int, int, int],
) -> CardCandidate:
    box, name, level = _boxes(CircleProposal(*circle))
    return CardCandidate(
        card_id,
        row,
        column,
        box,
        (0.0, 0.0, 0.0, 0.0),
        circle[1] - circle[2] > 0 and circle[1] + circle[2] < 200,
        0.97,
        name,
        level,
        circle,
    )


def test_edge_fragments_are_per_card_and_any_vertical_cut_is_enough() -> None:
    cards = [
        _card("top-cut", 0, 0, (40, 5, 6)),
        _card("full-a", 0, 1, (90, 50, 20)),
        _card("bottom-cut", 0, 2, (140, 195, 6)),
        _card("full-b", 0, 3, (190, 150, 20)),
    ]

    excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(cards, 200)

    assert excluded == {"top-cut": "top", "bottom-cut": "bottom"}


@pytest.mark.parametrize(
    ("card_id", "center_y", "expected"),
    [
        ("top-edge", 70, {}),
        ("bottom-edge", 180, {}),
        ("top-outside", 69, {"top-outside": "top"}),
        ("bottom-outside", 181, {"bottom-outside": "bottom"}),
    ],
)
def test_batch_circle_edges_match_single_image_content_bounds(
    card_id: str,
    center_y: int,
    expected: dict[str, str],
) -> None:
    card = _card(card_id, 0, 0, (100, center_y, 20))
    card = replace(
        card,
        name_box_original=(70, 130, 60, 12),
        level_box_original=(100, 80, 30, 12),
    )

    assert LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
        [card],
        250,
        content_top=50,
        content_bottom=200,
    ) == expected


def test_unknown_ocr_does_not_make_a_complete_disc_a_fragment() -> None:
    card = _card("unknown-name", 0, 0, (60, 80, 25))
    assert LocalOfflineVisionPipeline._auto_excluded_edge_fragments([card], 200) == {}

    pending_item = DetectedStarItem(
        card_id="complete-but-unreadable",
        source_image="main",
        is_complete_card=True,
    )
    assert item_needs_review(pending_item)

    excluded_item = DetectedStarItem(
        card_id="edge",
        source_image="partial",
        is_complete_card=True,
        inventory_action="auto_excluded_edge_fragment",
    )
    assert not item_needs_review(excluded_item)


def _star(
    card_id: str,
    level: int | None,
    equipped: str,
    *,
    name: str | None = "天府",
) -> RecognizedStar:
    return RecognizedStar(
        card_id=card_id,
        page_type="main",
        raw_name_text=name,
        canonical_name=name,
        name_confidence=0.95 if name else 0.0,
        raw_level_text=f"{level}级" if level else None,
        level=level,
        level_confidence=0.95 if level else 0.0,
        overall_confidence=0.9,
        review_required=name is None or level is None,
        direct_level=level,
        quality="橙",
        quality_confidence=0.9,
        equipped_state=equipped,
    )


def _reading_cards(count: int) -> list[CardCandidate]:
    return [
        _card(f"c{index}", 0, index, (30 + index * 40, 80, 15))
        for index in range(count)
    ]


def test_equipped_boundary_blocks_level_order_and_name_sandwich() -> None:
    cards = _reading_cards(4)
    stars = [
        _star("c0", 40, "equipped"),
        _star("c1", 40, "equipped"),
        _star("c2", 60, "unequipped"),
        _star("c3", 60, "unequipped"),
    ]
    equipped = {
        star.card_id: (star.equipped_state, 0.95, "test", [])
        for star in stars
    }
    ordered = apply_hierarchical_order(cards, stars, equipped)
    assert [star.level for star in ordered] == [40, 40, 60, 60]
    assert all("hierarchical_level_order_conflict" not in star.warnings for star in ordered)

    sandwich_stars = [
        _star("c0", 40, "equipped", name="天府"),
        _star("c1", 40, "unequipped", name=None),
        _star("c2", 40, "equipped", name="天府"),
        _star("c3", 40, "equipped", name="武曲"),
    ]
    result = apply_hierarchical_name_sandwich(cards, sandwich_stars)
    assert result[1].canonical_name is None
    assert result[1].warnings == sandwich_stars[1].warnings


def test_same_equipped_segment_keeps_inference_and_real_order_checks() -> None:
    cards = _reading_cards(3)
    stars = [
        _star("c0", 40, "unequipped", name="天府"),
        _star("c1", 40, "unequipped", name=None),
        _star("c2", 40, "unequipped", name="天府"),
    ]
    inferred = apply_hierarchical_name_sandwich(cards, stars)
    assert inferred[1].canonical_name == "天府"

    rising = [_star(f"c{index}", level, "unequipped") for index, level in enumerate((40, 50, 60))]
    equipped = {star.card_id: ("unequipped", 0.95, "test", []) for star in rising}
    checked = apply_hierarchical_order(cards, rising, equipped)
    assert any("hierarchical_level_order_conflict" in star.warnings for star in checked)


def test_review_crop_uses_level_top_name_bottom_and_actual_tail_width() -> None:
    cards = [
        _card("left", 0, 0, (60, 100, 40)),
        _card("right", 0, 1, (160, 100, 40)),
    ]
    boxes = LocalOfflineVisionPipeline._row_crop_boxes(cards, 240, 220)
    crop_box = boxes[0]
    padding = round(40 * 0.05)
    expected_left = cards[0].box_original[0] - padding
    expected_right = cards[1].box_original[0] + cards[1].box_original[2] + padding
    expected_top = min(card.level_box_original[1] for card in cards) - padding
    expected_bottom = max(
        card.name_box_original[1] + card.name_box_original[3]
        for card in cards
    ) + padding
    assert crop_box == (
        expected_left,
        expected_top,
        expected_right - expected_left,
        expected_bottom - expected_top,
    )


def test_review_crop_clips_to_image() -> None:
    edge_card = _card("edge", 0, 0, (30, 20, 25))
    crop_box = LocalOfflineVisionPipeline._row_crop_boxes([edge_card], 80, 80)[0]
    assert crop_box[0] >= 0 and crop_box[1] >= 0
    assert crop_box[0] + crop_box[2] <= 80
    assert crop_box[1] + crop_box[3] <= 80



def test_debug_defaults_match_new_production_roi() -> None:
    assert PRODUCTION_ROI.name_x_offset == -0.92
    assert PRODUCTION_ROI.name_y_offset == 1.08
    assert PRODUCTION_ROI.name_width == 1.84
    assert PRODUCTION_ROI.name_height == 0.62
    assert PRODUCTION_ROI.level_x_offset == 0.02
    assert PRODUCTION_ROI.level_y_offset == -1.06
    assert PRODUCTION_ROI.level_width == 1.08
    assert PRODUCTION_ROI.level_height == 0.58

    _, name_box, level_box = _boxes(CircleProposal(100, 100, 50))
    assert name_box == (54, 154, 92, 31)
    assert level_box == (101, 47, 54, 28)
