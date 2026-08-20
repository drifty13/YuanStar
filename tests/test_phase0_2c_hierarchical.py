from __future__ import annotations

import numpy as np

from yuanstar.catalog import load_catalog
from yuanstar.vision.hierarchical_order import apply_hierarchical_name_sandwich, apply_hierarchical_order, classify_equipped_roi, sort_web_records, web_sort_key
from yuanstar.vision.models import CardCandidate, PageClassification, RecognizedStar, SingleImageAnalysis, ViewportResult
from yuanstar.vision.targeted_overlap import CandidateAudit, unique_records


def test_equipped_anchor_classifier_never_identifies_people() -> None:
    avatar = np.zeros((20, 20, 3), dtype=np.uint8)
    for y in range(20):
        for x in range(20):
            avatar[y, x] = (20 + (x * 7) % 80, 100 + (y * 9) % 120, 140 + ((x + y) * 5) % 110)
    state, _, warnings = classify_equipped_roi(avatar)
    assert state == "equipped" and not warnings
    lock = np.full((20, 20, 3), 100, dtype=np.uint8)
    assert classify_equipped_roi(lock)[0] == "unequipped"
    gold_lock = np.full((40, 40, 3), (55, 150, 230), dtype=np.uint8)
    gold_lock[:10, 8:32] = (25, 75, 115)
    gold_lock[10:32, 8:32] = (65, 170, 245)
    assert classify_equipped_roi(gold_lock)[0] == "unequipped"
    assert classify_equipped_roi(np.empty((0, 0, 3), dtype=np.uint8))[0] == "unknown"


def test_manual_level_is_never_overwritten_by_hierarchical_sort() -> None:
    cards = [
        CardCandidate("manual", 0, 0, (0, 0, 10, 10), (0, 0, 0, 0), True, .99),
        CardCandidate("neighbour", 0, 1, (10, 0, 10, 10), (0, 0, 0, 0), True, .99),
    ]
    stars = [
        RecognizedStar("manual", "main", "天同", "天同", .99, "1", 1, .99, .99, False, level_source="manual_review", quality="橙"),
        RecognizedStar("neighbour", "main", "天同", "天同", .99, "60", 60, .99, .99, False, quality="橙"),
    ]
    result = {item.card_id: item for item in apply_hierarchical_order(cards, stars, {
        "manual": ("equipped", 1.0, "manual_review", []),
        "neighbour": ("equipped", 1.0, "manual_review", []),
    })}
    assert result["manual"].level == 1
    assert result["manual"].level_source == "manual_review"
    assert result["manual"].equipped_state == "equipped"
    assert result["neighbour"].equipped_state == "equipped"
    assert "manual_value_overrides_sort_rule" not in result["manual"].warnings


def test_excluded_fragment_never_enters_unique_inventory() -> None:
    star = RecognizedStar("keep", "main", "天府", "天府", .99, "1", 1, .99, .99, False, quality="橙")
    analysis = SingleImageAnalysis(
        "sample", ViewportResult((40, 20), (0, 0, 40, 20), None, .99), PageClassification("main", .99), [], [star],
    )
    audits = [
        CandidateAudit("sample", "keep", 0, 0, (0, 0, 10, 10), "candidate_structurally_valid", "ok", True, .99, star),
        CandidateAudit("sample", "fragment", 6, 0, (0, 0, 10, 10), "candidate_structurally_valid", "manual_fragment", True, .99, star, "exclude_fragment"),
    ]
    records = unique_records({"sample": analysis}, {"sample": audits}, [])
    assert len(records) == 1
    assert records[0]["all_sources"] == ["sample:r1c1"]


def test_default_equipped_state_stays_not_evaluated_without_conflict_review() -> None:
    cards = [CardCandidate("first", 0, 0, (0, 0, 10, 10), (0, 0, 0, 0), True, .99)]
    stars = [RecognizedStar("first", "main", "天府", "天府", .99, "60", 60, .99, .99, False, quality="橙")]
    result = apply_hierarchical_order(cards, stars, {})
    assert result[0].equipped_state == "not_evaluated"
    assert result[0].equipped_source == "not_evaluated"


def test_name_sandwich_needs_two_matching_sides_and_does_not_touch_single_tail_card() -> None:
    cards = [
        CardCandidate("left", 0, 0, (0, 0, 10, 10), (0, 0, 0, 0), True, .99),
        CardCandidate("middle", 0, 1, (10, 0, 10, 10), (0, 0, 0, 0), True, .99),
        CardCandidate("right", 0, 2, (20, 0, 10, 10), (0, 0, 0, 0), True, .99),
        CardCandidate("tail", 1, 0, (0, 10, 10, 10), (0, 0, 0, 0), True, .99),
    ]
    stars = [
        RecognizedStar("left", "support", "恩光", "恩光", .99, "1", 1, .99, .99, False, quality="紫"),
        RecognizedStar("middle", "support", None, None, 0, "1", 1, .99, .99, True, quality="紫"),
        RecognizedStar("right", "support", "恩光", "恩光", .99, "1", 1, .99, .99, False, quality="紫"),
        RecognizedStar("tail", "support", "恩光", "恩光", .99, "1", 1, .99, .99, False, quality="紫"),
    ]
    result = {item.card_id: item for item in apply_hierarchical_name_sandwich(cards, stars)}
    assert result["middle"].canonical_name == "恩光"
    assert result["middle"].name_source == "hierarchical_sort_sandwich_inference"
    assert result["tail"].name_source == "direct_ocr"


def test_web_sort_uses_equipped_quality_level_then_catalog_and_source() -> None:
    catalog_order = load_catalog().order_index
    rows = [
        {"unique_record_id": "late", "name": "武曲", "level": 60, "quality": "橙", "catalog_order": catalog_order["武曲"], "equipped_state": "equipped", "source_order": {"source_image_index": 2}},
        {"unique_record_id": "white", "name": "天府", "level": 60, "quality": "白", "catalog_order": catalog_order["天府"], "equipped_state": "unequipped", "source_order": {"source_image_index": 1}},
        {"unique_record_id": "orange", "name": "天府", "level": 60, "quality": "橙", "catalog_order": catalog_order["天府"], "equipped_state": "equipped", "source_order": {"source_image_index": 3}},
    ]
    assert [row["unique_record_id"] for row in sorted(rows, key=web_sort_key)] == ["orange", "late", "white"]


def test_web_sort_resolves_missing_catalog_order_after_equipped_priority() -> None:
    catalog_order = load_catalog().order_index
    rows = [
        {"unique_record_id": "late", "name": "武曲", "level": 60, "quality": "橙", "equipped_state": "unequipped", "source_order": {"source_image_index": 0}},
        {"unique_record_id": "same-name-later", "name": "天府", "level": 60, "quality": "橙", "equipped_state": "equipped", "source_order": {"source_image_index": 5}},
        {"unique_record_id": "same-name-first", "name": "天府", "level": 60, "quality": "橙", "equipped_state": "not_evaluated", "source_order": {"source_image_index": 1}},
    ]
    result = sort_web_records(rows, catalog_order)
    assert [row["unique_record_id"] for row in result] == ["same-name-later", "late", "same-name-first"]
    assert all(row["catalog_order"] == catalog_order[row["name"]] for row in result)
