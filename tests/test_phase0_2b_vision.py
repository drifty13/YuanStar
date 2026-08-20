from __future__ import annotations

from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from yuanstar.catalog import load_catalog
import yuanstar.vision.card_detector as card_detector
from yuanstar.vision.card_detector import CircleProposal, _circle_complete, _main_radius_cluster, _nms_2d, _row_lattice, detect_cards
from yuanstar.vision.layout_profiles import PHONE_PORTRAIT_V1, TABLET_PORTRAIT_V1, select_layout_profile
from yuanstar.vision.level_recognizer import parse_level, recognize_level
from yuanstar.vision.models import CardCandidate, PageClassification, RecognizedStar, SingleImageAnalysis
from yuanstar.vision.name_recognizer import clean_name, recognize_name
from yuanstar.vision.ocr_engine import OcrText
import yuanstar.vision.experience_recognizer as experience_recognizer
from yuanstar.vision.experience_recognizer import locate_experience_rois, recognize_experience_stones
from yuanstar.vision.offline_pipeline import apply_sort_order_level_inference, apply_sort_sandwich_inference, finalize_stars
from yuanstar.vision.page_classifier import classify_page
from yuanstar.vision.viewport import detect_viewport


class FakeEngine:
    def __init__(self, values: list[tuple[str, float]]) -> None:
        self.values = values

    def recognize(self, _image, **_kwargs):
        return [OcrText(text, score) for text, score in self.values]


class CropAwareFakeEngine:
    """Returns text only for the icon crop identified by its local marker pixel."""

    def __init__(self, values_by_marker: dict[int, tuple[str, float]]) -> None:
        self.values_by_marker = values_by_marker

    def recognize(self, image, **_kwargs):
        marker = int(image[-5, image.shape[1] // 2, 0]) if image.size else -1
        value = self.values_by_marker.get(marker)
        return [OcrText(*value)] if value else []


def _tabbed_experience_image(kinds: tuple[str, ...]) -> tuple[np.ndarray, np.ndarray]:
    """Create tab circles above the real icon row without relying on filenames."""
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    for x in (110, 250, 390):
        cv2.circle(image, (x, 180), 48, (180, 180, 180), 3)
    colours = {
        "orange": (0, 120, 255),
        "purple": (220, 80, 130),
        "white": (255, 190, 60),
    }
    circles: list[tuple[float, float, float]] = []
    for x, kind in zip((110, 250, 390), kinds):
        cv2.circle(image, (x, 480), 48, colours[kind], -1)
        circles.append((float(x), 240.0, 48.0))
    return image, np.array([circles], dtype=np.float32)


def test_viewport_detects_real_black_bars_without_cropping_dark_content() -> None:
    image = np.full((200, 140, 3), 40, dtype=np.uint8)
    image[:, :15] = 0
    image[:, -15:] = 0
    viewport = detect_viewport(image)
    assert viewport.viewport_box == (15, 0, 110, 200)


def test_layout_profile_selection() -> None:
    assert select_layout_profile((450, 1000)) == PHONE_PORTRAIT_V1
    assert select_layout_profile((600, 1000)) == TABLET_PORTRAIT_V1


def test_selected_tab_visual_page_evidence() -> None:
    image = np.full((1000, 500, 3), 20, dtype=np.uint8)
    image[90:150, 40:170] = (160, 190, 220)
    page = classify_page(image, (0, 0, 500, 1000))
    assert page.page_type == "main"
    assert page.confidence > 0.7


def test_card_detection_uses_relative_circle_grid_and_marks_bottom_partial(monkeypatch) -> None:
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    row_centers = (280, 400, 520, 640, 760, 880, 970)
    column_centers = (82, 190, 298, 406)
    for y in row_centers:
        for x in column_centers:
            cv2.circle(image, (x, y), 35, (220, 220, 220), 3)
    # The last row is genuinely clipped: y + radius = 1005 > image height.
    # Pin its known proposals because Hough is intentionally conservative for
    # heavily cropped arcs; this test exercises the grid and completeness rule.
    proposals = [
        CircleProposal(x, y, 35, "synthetic")
        for y in row_centers
        for x in column_centers
    ]
    monkeypatch.setattr(card_detector, "_hough_proposals", lambda *_args: proposals)
    cards = detect_cards(image, (0, 0, 500, 1000), PHONE_PORTRAIT_V1)
    assert len(cards) == 28
    assert any(card.is_complete for card in cards)
    bottom_cards = [
        card for card in cards
        if card.circle_original is not None and card.circle_original[1] == 970
    ]
    assert len(bottom_cards) == 4
    assert all(card.circle_original[1] + card.circle_original[2] > image.shape[0] for card in bottom_cards)
    assert all(not card.is_complete for card in bottom_cards)


def test_circle_completeness_respects_image_bottom_boundary() -> None:
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    viewport = (0, 0, 500, 1000)

    assert _circle_complete(CircleProposal(250, 500, 35), image, viewport)
    assert _circle_complete(CircleProposal(250, 965, 35), image, viewport)
    assert not _circle_complete(CircleProposal(250, 966, 35), image, viewport)


def test_cropped_top_grid_search_keeps_complete_first_row_and_rejects_lone_between_rows() -> None:
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    for y in (105, 330, 560, 790, 945):
        for x in (62, 185, 310, 435):
            cv2.circle(image, (x, y), 38, (220, 220, 220), 3)
    cv2.circle(image, (310, 440), 38, (220, 220, 220), 3)  # decorative lone ring
    cards = detect_cards(image, (0, 0, 500, 1000), PHONE_PORTRAIT_V1, anchors_present=False)
    assert {(card.row_index, card.column_index) for card in cards if card.row_index == 0} == {(0, 0), (0, 1), (0, 2), (0, 3)}
    assert len(cards) <= 20  # the lone decorative ring never adds a sixth-row candidate


def test_detector_nms_radius_mode_and_lattice_reject_decorative_row() -> None:
    proposals = [CircleProposal(100, 100, 30), CircleProposal(101, 101, 30), CircleProposal(200, 100, 30), CircleProposal(300, 100, 30), CircleProposal(400, 100, 30), CircleProposal(100, 220, 30), CircleProposal(200, 220, 30), CircleProposal(300, 220, 30), CircleProposal(400, 220, 30), CircleProposal(200, 160, 44)]
    deduped = _nms_2d(proposals)
    main = _main_radius_cluster(deduped)
    assert len(main) == 8
    rows = [[item for item in main if item.center_y == y] for y in (100, 220)]
    assert [len(row) for row in _row_lattice(rows, [100, 200, 300, 400], (0, 0, 500, 500))] == [4, 4]


def test_name_alias_and_conservative_fuzzy_matching() -> None:
    catalog = load_catalog()
    raw, canonical, confidence, warnings = recognize_name(np.zeros((20, 50, 3), dtype=np.uint8), FakeEngine([("紫薇", 0.95)]), catalog, "main")
    assert (raw, canonical, warnings) == ("紫薇", "紫微", [])
    assert confidence > 0.7
    assert clean_name(" 天 府 级 ") == "天府"
    _, uncertain, _, warnings = recognize_name(np.zeros((20, 50, 3), dtype=np.uint8), FakeEngine([("天", 0.99)]), catalog, "main")
    assert uncertain is None and "name_unknown" in warnings


def test_level_validation_and_consensus() -> None:
    assert parse_level("1级") == 1
    assert parse_level("60级") == 60
    assert parse_level("0级") is None
    assert parse_level("61级") is None
    assert parse_level("-1级") is None
    raw, level, confidence, warnings = recognize_level(np.zeros((20, 50, 3), dtype=np.uint8), FakeEngine([("30级", 0.90)]))
    assert (raw, level, warnings) == ("30级", 30, [])
    assert confidence > 0.7


def test_weighted_level_consensus_keeps_high_confidence_complete_value() -> None:
    raw, level, _, warnings = recognize_level(np.zeros((20, 50, 3), dtype=np.uint8), FakeEngine([("60级", 0.96), ("50", 0.20)]))
    assert (raw, level) == ("60级", 60)
    assert any(item.startswith("level_weighted_consensus") for item in warnings)


def test_page_fallback_recomputes_review_state() -> None:
    initial = RecognizedStar("card_001", "unknown", "天府", "天府", 0.95, "60级", 60, 0.94, 0.0, True, [], quality="橙", quality_confidence=.9, quality_source="visual_background")
    final = finalize_stars([initial], PageClassification("main", 0.45))[0]
    assert final.page_type == "main"
    assert final.review_required is False
    assert final.overall_confidence == 0.45


def test_sort_sandwich_inference_is_strict_and_non_chaining() -> None:
    cards = [CardCandidate(f"card_{i:03d}", 0, i - 1, (0, 0, 1, 1), (0, 0, 0, 0), True, 1.0) for i in range(1, 5)]
    stars = [
        RecognizedStar("card_001", "main", "武曲", "武曲", .95, "60级", 60, .95, .9, False),
        RecognizedStar("card_002", "main", None, None, 0, "60级", 60, .95, 0, True),
        RecognizedStar("card_003", "main", "武曲", "武曲", .94, "60级", 60, .94, .9, False),
        RecognizedStar("card_004", "main", None, None, 0, "60级", 60, .95, 0, True),
    ]
    updated = apply_sort_sandwich_inference(cards, stars)
    assert updated[1].canonical_name == "武曲" and updated[1].name_source == "sort_sandwich_inference"
    assert updated[1].name_confidence <= .82 and "name_inferred_by_sort_sandwich" in updated[1].warnings
    assert updated[3].canonical_name is None  # inferred card cannot become a neighbour


def test_sort_sandwich_rejects_mismatch_unknown_level_and_gap() -> None:
    cards = [CardCandidate(f"card_{i:03d}", 0, column, (0, 0, 1, 1), (0, 0, 0, 0), True, 1.0) for i, column in enumerate((0, 2, 3), 1)]
    stars = [RecognizedStar("card_001", "main", "武曲", "武曲", .95, "60级", 60, .95, .9, False), RecognizedStar("card_002", "main", None, None, 0, "60级", 60, .95, 0, True), RecognizedStar("card_003", "main", "七杀", "七杀", .95, "60级", 60, .95, .9, False)]
    assert apply_sort_sandwich_inference(cards, stars)[1].canonical_name is None


def _level_cards(values: list[int | None], *, columns: list[int] | None = None, complete: list[bool] | None = None) -> tuple[list[CardCandidate], list[RecognizedStar]]:
    columns = columns or list(range(len(values)))
    complete = complete or [True] * len(values)
    cards = [CardCandidate(f"card_{index:03d}", 0, column, (0, 0, 1, 1), (0, 0, 0, 0), is_complete, 1.0) for index, (column, is_complete) in enumerate(zip(columns, complete), 1)]
    stars = [RecognizedStar(card.card_id, "main", "天府", "天府", .95, f"{value}级" if value else None, value, .95 if value else 0, .9, value is None, [], direct_level=value) for card, value in zip(cards, values) if card.is_complete]
    return cards, stars


def test_level_sort_inference_only_fills_singleton_intervals() -> None:
    cards, stars = _level_cards([60, 60, 9, 60])
    result = apply_sort_order_level_inference(cards, stars)
    assert result[2].level == 60
    assert result[2].level_source == "sort_order_inference"
    assert result[2].raw_level_text == "9级" and result[2].direct_level == 9
    cards, stars = _level_cards([9, 60])
    assert apply_sort_order_level_inference(cards, stars)[0].level == 60
    cards, stars = _level_cards([60, None, 60])
    assert apply_sort_order_level_inference(cards, stars)[1].level == 60


def test_level_sort_conflicts_are_reviewed_and_never_chain() -> None:
    cards, stars = _level_cards([60, 9, 50])
    result = apply_sort_order_level_inference(cards, stars)
    assert result[1].level is None and "level_order_conflict" in result[1].warnings
    cards, stars = _level_cards([60, 50, 40])
    assert [item.level for item in apply_sort_order_level_inference(cards, stars)] == [60, 50, 40]
    cards, stars = _level_cards([40, 50])
    result = apply_sort_order_level_inference(cards, stars)
    assert all(item.level is None and "level_order_conflict" in item.warnings for item in result)
    cards, stars = _level_cards([60, None, None, 60])
    result = apply_sort_order_level_inference(cards, stars)
    assert result[1].level is None  # a missing neighbour cannot be supplied by a new inference
    cards, stars = _level_cards([60, None, 60], complete=[True, False, True])
    assert [item.level for item in apply_sort_order_level_inference(cards, stars)] == [60, 60]


def test_experience_recognizer_binds_colour_icon_to_local_count() -> None:
    image = np.zeros((700, 500, 3), dtype=np.uint8)
    for x, colour, marker in ((110, (0, 120, 255), 22), (250, (220, 80, 130), 29), (390, (255, 190, 60), 88)):
        cv2.circle(image, (x, 330), 48, colour, -1)
        image[365:382, x - 40:x + 40] = (marker, marker, marker)
    # The fake returns a different result for each local number crop; no global OCR text is reused.
    result = recognize_experience_stones(
        image, (0, 0, 500, 700), CropAwareFakeEngine({22: ("22", .95), 29: ("295", .95), 88: ("88", .95)}),
        page=PageClassification("experience", .9, ["selected_tab_visual:experience"]),
    )
    assert result.complete and (result.orange_count, result.purple_count, result.white_count) == (22, 295, 88)


@pytest.mark.parametrize(
    ("kinds", "expected"),
    [
        (("orange", "purple", "white"), ["orange", "purple", "white"]),
        (("purple",), ["purple"]),
        (("orange", "white"), ["orange", "white"]),
    ],
)
def test_reliable_experience_tab_excludes_upper_tab_circle_row(
    monkeypatch,
    kinds: tuple[str, ...],
    expected: list[str],
) -> None:
    image, lower_icon_circles = _tabbed_experience_image(kinds)
    region_heights: list[int] = []

    def fake_hough(gray, *_args, **_kwargs):
        region_heights.append(gray.shape[0])
        return lower_icon_circles

    monkeypatch.setattr(experience_recognizer.cv2, "HoughCircles", fake_hough)
    observations = locate_experience_rois(
        image,
        (0, 0, 500, 1000),
        FakeEngine([]),
        page=PageClassification("experience", .9, ["selected_tab_visual:experience"]),
    )

    assert region_heights == [380]  # 24%..62%; the tab row at y=180 is excluded.
    assert [observation.kind for observation in observations] == expected
    assert all(observation.icon_box[1] >= 432 for observation in observations)


def test_unverified_or_partial_experience_page_keeps_legacy_search_range(monkeypatch) -> None:
    image = np.zeros((1000, 500, 3), dtype=np.uint8)
    region_heights: list[int] = []

    def fake_hough(gray, *_args, **_kwargs):
        region_heights.append(gray.shape[0])
        return None

    monkeypatch.setattr(experience_recognizer.cv2, "HoughCircles", fake_hough)
    assert locate_experience_rois(
        image,
        (0, 0, 500, 1000),
        FakeEngine([]),
        page=PageClassification("experience", .9, []),
    ) == []
    assert region_heights == [440]  # legacy 18%..62% range for compatibility.


def test_reliable_phone_experience_tab_keeps_legacy_search_range(monkeypatch) -> None:
    image = np.zeros((1000, 480, 3), dtype=np.uint8)
    region_heights: list[int] = []

    def fake_hough(gray, *_args, **_kwargs):
        region_heights.append(gray.shape[0])
        return None

    monkeypatch.setattr(experience_recognizer.cv2, "HoughCircles", fake_hough)
    assert locate_experience_rois(
        image,
        (0, 0, 480, 1000),
        FakeEngine([]),
        page=PageClassification("experience", .9, ["selected_tab_visual:experience"]),
    ) == []
    assert region_heights == [440]  # existing phone portrait coverage is retained.


def test_experience_recognizer_passes_page_to_roi_locator(monkeypatch) -> None:
    page = PageClassification("experience", .9, ["selected_tab_visual:experience"])
    received: list[PageClassification | None] = []

    def fake_locator(_image, _viewport, _engine, *, page=None):
        received.append(page)
        return []

    monkeypatch.setattr(experience_recognizer, "locate_experience_rois", fake_locator)
    result = recognize_experience_stones(
        np.zeros((10, 10, 3), dtype=np.uint8),
        (0, 0, 10, 10),
        FakeEngine([]),
        page=page,
    )

    assert received == [page]
    assert result.warnings == ["experience_icons_not_found"]


def test_experience_diagnostic_passes_analysis_page_to_production_locator(monkeypatch, tmp_path) -> None:
    from tools import inspect_ocr_roi

    page = PageClassification("experience", .9, ["selected_tab_visual:experience"])
    analysis = SimpleNamespace(
        viewport=SimpleNamespace(viewport_box=(0, 0, 500, 1000)),
        page=page,
    )
    received: list[PageClassification | None] = []

    def fake_locator(_image, _viewport, _engine, *, page=None):
        received.append(page)
        return []

    pipeline = SimpleNamespace(
        canonical_pipeline=SimpleNamespace(
            engine=FakeEngine([]),
            analyze_path=lambda _path: (analysis, np.zeros((1000, 500, 3), dtype=np.uint8)),
        )
    )
    monkeypatch.setattr(inspect_ocr_roi, "locate_experience_rois", fake_locator)

    destination = inspect_ocr_roi.inspect_experience_image(
        tmp_path / "synthetic.png",
        tmp_path,
        pipeline=pipeline,
    )

    assert received == [page]
    report = (destination / "experience_roi_report.csv").read_text(encoding="utf-8-sig")
    assert "viewport_box,page_type,page_confidence,page_evidence" in report
    assert "selected_tab_visual:experience" in report


def test_analysis_serializes_original_and_normalized_values() -> None:
    card = CardCandidate("card_001", 0, 0, (10, 20, 30, 40), (0.1, 0.2, 0.3, 0.4), True, 0.9)
    star = RecognizedStar("card_001", "main", "紫薇", "紫微", 0.9, "30级", 30, 0.9, 0.9, False)
    analysis = SingleImageAnalysis("image", detect_viewport(np.full((50, 50, 3), 40, dtype=np.uint8)), PageClassification("main", 0.8), [card], [star])
    payload = analysis.as_dict()
    assert payload["stars"][0]["raw_name_text"] == "紫薇"
    assert payload["cards"][0]["box_normalized"] == (0.1, 0.2, 0.3, 0.4)
