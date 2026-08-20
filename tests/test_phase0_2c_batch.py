from __future__ import annotations

import cv2
import numpy as np

from yuanstar.vision.batch_reconciliation import reconcile_batch
from yuanstar.vision.models import CardCandidate, PageClassification, RecognizedStar, SingleImageAnalysis, ViewportResult
from yuanstar.vision.quality_recognizer import classify_quality_pixels


def test_quality_classifier_accepts_only_confirmed_visual_backgrounds() -> None:
    colours = {
        "橙": (0, 110, 255), "紫": (180, 40, 140), "蓝": (255, 120, 20), "绿": (50, 220, 40), "白": (230, 230, 230),
    }
    for expected, colour in colours.items():
        pixels = np.full((800, 3), colour, dtype=np.uint8)
        quality, confidence, _, warnings = classify_quality_pixels(pixels)
        assert quality == expected and confidence >= .7 and not warnings
    quality, _, _, warnings = classify_quality_pixels(np.full((800, 3), (110, 110, 110), dtype=np.uint8))
    assert quality is None and "quality_unknown" in warnings


def _analysis(image_id: str, values: list[int], *, page: str = "main") -> tuple[SingleImageAnalysis, np.ndarray]:
    image = np.zeros((240, 400, 3), dtype=np.uint8)
    cards: list[CardCandidate] = []
    stars: list[RecognizedStar] = []
    for index, value in enumerate(values):
        row, column = divmod(index, 4)
        x, y = 15 + column * 95, 30 + row * 95
        cv2.circle(image, (x + 35, y + 35), 28, (value, 255 - value, value // 2), -1)
        cv2.putText(image, str(value), (x + 17, y + 42), cv2.FONT_HERSHEY_SIMPLEX, .35, (255, 255, 255), 1, cv2.LINE_AA)
        card = CardCandidate(f"card_{index:03d}", row, column, (x, y, 70, 70), (0, 0, 0, 0), True, 1.0)
        cards.append(card)
        stars.append(RecognizedStar(card.card_id, page, "天府", "天府", .95, "60级", 60, .95, .95, False, [], quality="橙", quality_confidence=.9, quality_source="visual_background"))
    analysis = SingleImageAnalysis(image_id, ViewportResult((400, 240), (0, 0, 400, 240), None, 1.0), PageClassification(page, .9), cards, stars)
    return analysis, image


def test_overlap_requires_visual_evidence_and_does_not_use_equal_fields_as_key() -> None:
    # Same OCR fields but visibly distinct cards are retained as different records.
    first, image_a = _analysis("a", [20, 40, 60, 80])
    second, image_b = _analysis("b", [120, 140, 160, 180])
    result = reconcile_batch([(first, image_a, "sha-a", "phone"), (second, image_b, "sha-b", "phone")])
    assert not any(item.auto_confirmed for item in result.overlaps)
    assert len(result.unique_records) == 8


def test_one_row_three_visual_cards_confirms_overlap_and_retains_sources() -> None:
    first, image_a = _analysis("a", [20, 40, 60, 80])
    second, image_b = _analysis("b", [20, 40, 60, 190])
    result = reconcile_batch([(first, image_a, "sha-a", "phone"), (second, image_b, "sha-b", "phone")])
    evidence = next(item for item in result.overlaps if item.image_a == "a")
    assert evidence.auto_confirmed and evidence.match_count >= 3
    assert len(result.unique_records) == 5


def test_exact_duplicate_input_is_explicit_not_silently_dropped() -> None:
    analysis, image = _analysis("a", [20, 40, 60, 80])
    copy = SingleImageAnalysis("b", analysis.viewport, analysis.page, analysis.cards, analysis.stars)
    result = reconcile_batch([(analysis, image, "same", "phone"), (copy, image.copy(), "same", "phone")])
    assert any(item.relation == "exact_duplicate_input" for item in result.overlaps)
    assert len(result.unique_records) == 4
