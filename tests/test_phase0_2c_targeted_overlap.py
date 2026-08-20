from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from tools.run_phase0_2c_targeted import PAIRS, RAW, _analysis_from_dict
from yuanstar.vision.models import CardCandidate, PageClassification, RecognizedStar, SingleImageAnalysis, ViewportResult
from yuanstar.vision.targeted_overlap import DirectedPair, align_directed_pair, complete_row_preview_box


def _analysis(image_id: str, rows: list[list[tuple[str | None, int | None, str | None]]]) -> SingleImageAnalysis:
    cards: list[CardCandidate] = []
    stars: list[RecognizedStar] = []
    for row_index, row in enumerate(rows):
        for column_index, (name, level, quality) in enumerate(row):
            card_id = f"card_{row_index}_{column_index}"
            x, y = column_index * 24, row_index * 24
            cards.append(CardCandidate(card_id, row_index, column_index, (x, y, 20, 16), (0, 0, 0, 0), True, .99, (x, y + 16, 20, 8), (x + 10, y, 10, 8)))
            stars.append(RecognizedStar(card_id, "main", name, name, .99, str(level) if level is not None else None, level, .99, .99, level is None or name is None, quality=quality, quality_confidence=.99, quality_source="visual_background"))
    return SingleImageAnalysis(image_id, ViewportResult((160, 160), (0, 0, 160, 160), None, .99), PageClassification("main", .99), cards, stars)


def _pair(before: SingleImageAnalysis, after: SingleImageAnalysis) -> list:
    image = np.full((180, 180, 3), 160, dtype=np.uint8)
    return align_directed_pair(DirectedPair("test", before.image_id, after.image_id, "test", "main"), before, image, after, image).rows


def test_semantic_name_level_and_quality_are_hard_gates() -> None:
    exact = [("天府", 1, "橙")] * 4
    assert _pair(_analysis("a", [exact]), _analysis("b", [exact]))[0].conclusion == "confirmed_overlap"
    assert _pair(_analysis("a", [exact]), _analysis("b", [[("天相", 1, "橙")] + exact[1:]])) == []
    assert _pair(_analysis("a", [exact]), _analysis("b", [[("天府", 2, "橙")] + exact[1:]])) == []
    assert _pair(_analysis("a", [exact]), _analysis("b", [[("天府", 1, "紫")] + exact[1:]])) == []


def test_unknown_is_pending_not_equal() -> None:
    exact = [("天府", 1, "橙"), ("天府", 1, "橙"), ("天相", 1, "橙"), ("天相", 1, "橙")]
    pending = [("天府", None, "橙"), ("天府", None, "橙"), ("天相", None, "橙"), ("天相", 1, "橙")]
    rows = _pair(_analysis("a", [pending, exact]), _analysis("b", [pending, exact]))
    assert [result.conclusion for result in rows] == ["pending_review", "confirmed_overlap"]
    assert rows[0].occurrence_mapping == []


def test_five_row_suffix_prefix_is_not_truncated_to_three() -> None:
    def row(name: str) -> list[tuple[str, int, str]]:
        return [(name, 1, "橙")] * 4
    before = _analysis("a", [row(f"r{index}") for index in range(1, 7)])
    after = _analysis("b", [row(f"r{index}") for index in range(2, 8)])
    rows = _pair(before, after)
    assert [(item.before_row, item.after_row) for item in rows] == [(1, 0), (2, 1), (3, 2), (4, 3), (5, 4)]
    assert all(item.conclusion == "confirmed_overlap" for item in rows)


def test_complete_row_preview_box_covers_icon_level_and_name() -> None:
    analysis = _analysis("preview", [[("天府", 1, "橙")] * 4])
    preview = complete_row_preview_box(analysis, 0)
    assert preview == (0, 0, 92, 24)
    x, y, width, height = preview
    for card in analysis.cards:
        for box in (card.box_original, card.name_box_original, card.level_box_original):
            assert box is not None
            assert x <= box[0] and y <= box[1]
            assert x + width >= box[0] + box[2] and y + height >= box[1] + box[3]


def test_real_fixed_pairs_document_dynamic_alignment_difference() -> None:
    root = Path("samples_private/phase0_2/output/phase0_2c_targeted/manual_isolated/per_image")
    analyses = {path.stem: _analysis_from_dict(json.loads(path.read_text(encoding="utf-8"))) for path in root.glob("*.json")}
    images = {sample_id: cv2.imread(str(RAW / next(target.source_path for target in __import__("tools.run_phase0_2c_targeted", fromlist=["TARGETS"]).TARGETS if target.sample_id == sample_id))) for sample_id in analyses}
    results = [row for pair in PAIRS for row in align_directed_pair(pair, analyses[pair.before_id], images[pair.before_id], analyses[pair.after_id], images[pair.after_id]).rows]
    confirmed = {(row.pair_id, row.before_row + 1, row.after_row + 1) for row in results if row.conclusion == "confirmed_overlap"}
    pending = {(row.pair_id, row.before_row + 1, row.after_row + 1) for row in results if row.conclusion == "pending_review"}
    required = {("pair_01", 6, 1), ("pair_02", 4, 3), ("pair_03", 5, 2), ("pair_03", 6, 3), ("pair_04", 5, 1), ("pair_04", 6, 2), ("pair_05", 6, 1), ("pair_06", 5, 1), ("pair_06", 6, 2)}
    assert required <= confirmed
    # B r1 has fewer than two confirmed names, so it is ignored as an identity
    # candidate. The dynamic suffix/prefix then selects A r3-r6 -> B r2-r5,
    # adding r3/r5/r6 instead of silently retaining the former 3x3 cap.
    assert len(confirmed) == 12
    assert pending == {("pair_03", 4, 1)}
