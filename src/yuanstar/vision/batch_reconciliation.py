from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha256
from itertools import combinations
from statistics import median

import cv2
import numpy as np

from .models import BagCountResult, SingleImageAnalysis
from .preprocess import crop


@dataclass(frozen=True)
class ImageNode:
    image_id: str
    page_type: str
    source_sha256: str
    device_type: str = "unknown"
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CardOccurrence:
    occurrence_id: str
    image_id: str
    card_id: str
    row_index: int
    column_index: int
    complete: bool
    canonical_name: str | None
    level: int | None
    quality: str | None
    confidence: float


@dataclass(frozen=True)
class OverlapEvidence:
    image_a: str
    image_b: str
    page_type: str
    relation: str
    vertical_offset: float | None
    matched_pairs: list[tuple[str, str]]
    match_count: int
    similarity: float
    auto_confirmed: bool
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class DedupDecision:
    decision_id: str
    occurrence_ids: list[str]
    reason: str
    confidence: float
    review_required: bool


@dataclass(frozen=True)
class UniqueStarRecord:
    unique_id: str
    canonical_name: str | None
    level: int | None
    quality: str | None
    primary_occurrence_id: str
    occurrence_ids: list[str]
    source_images: list[str]
    merge_reason: str
    merge_confidence: float
    review_required: bool
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class BatchReconciliation:
    nodes: list[ImageNode]
    overlaps: list[OverlapEvidence]
    decisions: list[DedupDecision]
    unique_records: list[UniqueStarRecord]
    sequences: dict[str, list[str]]
    bag_consensus: BagCountResult
    warnings: list[str] = field(default_factory=list)


def image_sha256(image: np.ndarray) -> str:
    return sha256(image.tobytes()).hexdigest()


def _fingerprint(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    card = crop(image, box)
    if card.size == 0:
        return np.empty((0,), dtype=np.float32)
    gray = cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)
    resized = cv2.resize(gray, (40, 40), interpolation=cv2.INTER_AREA).astype(np.float32)
    texture = ((resized - resized.mean()) / max(resized.std(), 1.0)).ravel()
    hsv = cv2.cvtColor(card, cv2.COLOR_BGR2HSV)
    colourful = hsv[:, :, 1] >= 45
    histogram = cv2.calcHist([hsv], [0], colourful.astype(np.uint8), [12], [0, 180]).ravel()
    histogram /= max(histogram.sum(), 1.0)
    # Colour belongs to the visual fingerprint (not to structured OCR fields).
    # Upweight it enough that a different quality backing cannot look identical
    # merely because its grayscale icon silhouette is the same.
    luminance = (resized.ravel() / 255.0) * 10.0
    return np.concatenate((texture, luminance, histogram * 36.0)).astype(np.float32)


def _similarity(left: np.ndarray, right: np.ndarray) -> float:
    if left.size == 0 or right.size == 0 or left.shape != right.shape:
        return 0.0
    denominator = float(np.linalg.norm(left) * np.linalg.norm(right))
    if not denominator:
        return 0.0
    correlation = float(np.dot(left, right) / denominator)
    return max(0.0, min(1.0, (correlation + 1.0) / 2.0))


def _complete_occurrences(analysis: SingleImageAnalysis) -> list[CardOccurrence]:
    stars = {star.card_id: star for star in analysis.stars}
    occurrences: list[CardOccurrence] = []
    for card in analysis.cards:
        star = stars.get(card.card_id)
        if not card.is_complete or star is None:
            continue
        occurrences.append(CardOccurrence(
            f"{analysis.image_id}:{card.card_id}", analysis.image_id, card.card_id,
            card.row_index, card.column_index, True, star.canonical_name, star.level,
            star.quality, star.overall_confidence,
        ))
    return occurrences


def _match_pair(
    image_a: np.ndarray, analysis_a: SingleImageAnalysis, image_b: np.ndarray, analysis_b: SingleImageAnalysis,
) -> OverlapEvidence:
    complete_a = _complete_occurrences(analysis_a)
    complete_b = _complete_occurrences(analysis_b)
    cards_a = {card.card_id: card for card in analysis_a.cards}
    cards_b = {card.card_id: card for card in analysis_b.cards}
    fingerprints_a = {occ.occurrence_id: _fingerprint(image_a, cards_a[occ.card_id].box_original) for occ in complete_a}
    fingerprints_b = {occ.occurrence_id: _fingerprint(image_b, cards_b[occ.card_id].box_original) for occ in complete_b}
    # Each source card can have at most one visual counterpart.  Structured OCR
    # values intentionally do not participate in this decision.
    candidates: list[tuple[float, CardOccurrence, CardOccurrence]] = []
    for left in complete_a:
        for right in complete_b:
            if left.column_index != right.column_index:
                continue
            score = _similarity(fingerprints_a[left.occurrence_id], fingerprints_b[right.occurrence_id])
            if score >= .985:
                candidates.append((score, left, right))
    selected: list[tuple[float, CardOccurrence, CardOccurrence]] = []
    used_a: set[str] = set(); used_b: set[str] = set()
    for candidate in sorted(candidates, key=lambda item: item[0], reverse=True):
        _, left, right = candidate
        if left.occurrence_id not in used_a and right.occurrence_id not in used_b:
            selected.append(candidate); used_a.add(left.occurrence_id); used_b.add(right.occurrence_id)
    if not selected:
        return OverlapEvidence(analysis_a.image_id, analysis_b.image_id, analysis_a.page.page_type, "none", None, [], 0, 0.0, False)
    offsets = [
        (cards_b[right.card_id].box_original[1] + cards_b[right.card_id].box_original[3] / 2)
        - (cards_a[left.card_id].box_original[1] + cards_a[left.card_id].box_original[3] / 2)
        for _, left, right in selected
    ]
    offset = float(median(offsets))
    geometric = [item for item, value in zip(selected, offsets) if abs(value - offset) <= 14]
    if not geometric:
        return OverlapEvidence(
            analysis_a.image_id, analysis_b.image_id, analysis_a.page.page_type, "review_required", offset,
            [], 0, 0.0, False, ["overlap_geometric_offset_conflict"],
        )
    rows = {left.row_index for _, left, _ in geometric}
    per_row: dict[int, list[int]] = {}
    for _, left, _ in geometric:
        per_row.setdefault(left.row_index, []).append(left.column_index)
    has_two_rows = len(rows) >= 2 and len(geometric) >= 6
    has_one_full_row = any(len(columns) >= 3 and max(columns) - min(columns) >= 2 for columns in per_row.values())
    confirmed = has_two_rows or has_one_full_row
    relation = "confirmed" if confirmed else "review_required"
    warnings = [] if confirmed else ["overlap_visual_evidence_insufficient"]
    return OverlapEvidence(
        analysis_a.image_id, analysis_b.image_id, analysis_a.page.page_type, relation, offset,
        [(left.occurrence_id, right.occurrence_id) for _, left, right in geometric], len(geometric),
        float(sum(score for score, _, _ in geometric) / len(geometric)), confirmed, warnings,
    )


def _sequence_groups(nodes: list[ImageNode], overlaps: list[OverlapEvidence]) -> tuple[dict[str, list[str]], list[str]]:
    groups: dict[str, list[str]] = {}
    warnings: list[str] = []
    by_page: dict[str, list[ImageNode]] = {}
    for node in nodes:
        if node.page_type in {"main", "support"}:
            by_page.setdefault(node.page_type, []).append(node)
    for page, page_nodes in by_page.items():
        edges: dict[str, set[str]] = {node.image_id: set() for node in page_nodes}
        for evidence in overlaps:
            if not evidence.auto_confirmed or evidence.page_type != page or evidence.vertical_offset is None:
                continue
            # A shared card moving upwards means B was captured after A was scrolled down.
            before, after = (evidence.image_a, evidence.image_b) if evidence.vertical_offset < 0 else (evidence.image_b, evidence.image_a)
            edges[before].add(after)
        incoming = {node: 0 for node in edges}
        for targets in edges.values():
            for target in targets:
                incoming[target] += 1
        order: list[str] = []
        available = sorted(node for node, count in incoming.items() if count == 0)
        while available:
            node = available.pop(0); order.append(node)
            for target in sorted(edges[node]):
                incoming[target] -= 1
                if incoming[target] == 0:
                    available.append(target)
            available.sort()
        if len(order) != len(edges):
            warnings.append(f"overlap_graph_conflict:{page}")
            order = sorted(edges)
        groups[page] = order
    return groups, warnings


def _bag_consensus(analyses: list[SingleImageAnalysis]) -> BagCountResult:
    candidates = [analysis.bag for analysis in analyses if analysis.bag and analysis.bag.current is not None and analysis.bag.capacity is not None]
    if not candidates:
        return BagCountResult(None, None, warnings=["bag_count_unknown"])
    score: dict[tuple[int, int], float] = {}
    for item in candidates:
        score[(item.current, item.capacity)] = score.get((item.current, item.capacity), 0.0) + item.confidence
    (current, capacity), confidence = max(score.items(), key=lambda item: item[1])
    warnings = [] if len(score) == 1 else ["bag_count_conflict"]
    return BagCountResult(current, capacity, min(.99, confidence / len(candidates)), [f"{a}/{b}" for a, b in score], warnings)


def reconcile_batch(items: list[tuple[SingleImageAnalysis, np.ndarray, str, str]]) -> BatchReconciliation:
    """Recover sequence and merge only confirmed visual overlap occurrences."""
    nodes = [ImageNode(analysis.image_id, analysis.page.page_type, sha, device) for analysis, _, sha, device in items]
    representatives: dict[str, str] = {}
    duplicate_pairs: list[OverlapEvidence] = []
    retained: list[tuple[SingleImageAnalysis, np.ndarray, str, str]] = []
    for item in items:
        analysis, _, sha, _ = item
        if sha in representatives:
            duplicate_pairs.append(OverlapEvidence(representatives[sha], analysis.image_id, analysis.page.page_type, "exact_duplicate_input", None, [], 0, 1.0, True))
        else:
            representatives[sha] = analysis.image_id; retained.append(item)
    overlaps = duplicate_pairs[:]
    for left, right in combinations(retained, 2):
        analysis_a, image_a, _, _ = left; analysis_b, image_b, _, _ = right
        if analysis_a.page.page_type not in {"main", "support"} or analysis_a.page.page_type != analysis_b.page.page_type:
            continue
        overlaps.append(_match_pair(image_a, analysis_a, image_b, analysis_b))
    occurrences = [occ for analysis, _, _, _ in retained for occ in _complete_occurrences(analysis)]
    parent = {occ.occurrence_id: occ.occurrence_id for occ in occurrences}
    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]; key = parent[key]
        return key
    def union(left: str, right: str) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root
    decisions: list[DedupDecision] = []
    for evidence in overlaps:
        if evidence.relation != "confirmed":
            continue
        for left, right in evidence.matched_pairs:
            union(left, right)
            decisions.append(DedupDecision(f"dedup_{len(decisions) + 1:04d}", [left, right], "confirmed_visual_overlap", evidence.similarity, False))
    by_id = {occ.occurrence_id: occ for occ in occurrences}
    components: dict[str, list[CardOccurrence]] = {}
    for occurrence in occurrences:
        components.setdefault(find(occurrence.occurrence_id), []).append(occurrence)
    unique_records: list[UniqueStarRecord] = []
    for index, component in enumerate(components.values(), 1):
        primary = max(component, key=lambda item: item.confidence)
        warnings = [] if all(item.canonical_name and item.level is not None and item.quality for item in component) else ["field_unknown"]
        unique_records.append(UniqueStarRecord(
            f"unique_{index:04d}", primary.canonical_name, primary.level, primary.quality, primary.occurrence_id,
            [item.occurrence_id for item in component], sorted({item.image_id for item in component}),
            "confirmed_visual_overlap" if len(component) > 1 else "single_occurrence",
            max(item.confidence for item in component), bool(warnings), warnings,
        ))
    sequences, warnings = _sequence_groups(nodes, overlaps)
    return BatchReconciliation(nodes, overlaps, decisions, unique_records, sequences, _bag_consensus([item[0] for item in retained]), warnings)
