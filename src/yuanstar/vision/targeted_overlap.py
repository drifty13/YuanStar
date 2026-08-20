from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
from hashlib import sha256
from pathlib import Path
from statistics import median
from typing import Literal

import cv2
import numpy as np

from .models import CardCandidate, RecognizedStar, SingleImageAnalysis
from .preprocess import crop


BoxStatus = Literal[
    "candidate_structurally_valid", "candidate_pending_review", "candidate_rejected",
]
RowConclusion = Literal["confirmed_overlap", "pending_review", "confirmed_no_overlap", "ignored"]
SemanticStatus = Literal["confirmed", "inferred", "pending", "unknown"]


@dataclass(frozen=True)
class TargetImageSpec:
    sample_id: str
    source_path: str
    page_kind: Literal["main", "support"]
    group: str
    is_new: bool


@dataclass(frozen=True)
class DirectedPair:
    pair_id: str
    before_id: str
    after_id: str
    group: str
    page_kind: Literal["main", "support"]


@dataclass(frozen=True)
class CandidateAudit:
    sample_id: str
    card_id: str
    row_index: int
    column_index: int
    box_original: tuple[int, int, int, int]
    box_status: BoxStatus
    status_reason: str
    is_complete: bool
    completeness_confidence: float
    star: RecognizedStar | None
    inventory_action: str = "keep"


@dataclass(frozen=True)
class RowAudit:
    sample_id: str
    row_index: int
    card_ids: tuple[str, str, str, str]
    terminal_partial: bool = False


@dataclass(frozen=True)
class CardSemanticSignature:
    sample_id: str
    row_index: int
    column_index: int
    canonical_name: str | None
    name_status: SemanticStatus
    level: int | None
    level_status: SemanticStatus
    quality: str | None
    quality_status: SemanticStatus
    card_visual_evidence: str
    warnings: tuple[str, ...]

    def readable(self) -> str:
        name = self.canonical_name or "unknown"
        level = f"{self.level}级" if self.level is not None else "等级 unknown"
        quality = self.quality or "品质 unknown"
        return f"c{self.column_index + 1} {name} {level} {quality}"


@dataclass(frozen=True)
class RowSemanticSignature:
    sample_id: str
    row_index: int
    cards: tuple[CardSemanticSignature, CardSemanticSignature, CardSemanticSignature, CardSemanticSignature]

    def readable(self) -> str:
        return " | ".join(card.readable() for card in self.cards)

    def exact_key(self) -> tuple[tuple[str, int], tuple[str, int], tuple[str, int], tuple[str, int]] | None:
        key: list[tuple[str, int]] = []
        for card in self.cards:
            if card.canonical_name is None or card.name_status != "confirmed":
                return None
            if card.level is None or card.level_status not in ("confirmed", "inferred"):
                return None
            key.append((card.canonical_name, card.level))
        return tuple(key)  # type: ignore[return-value]


@dataclass(frozen=True)
class SuffixPrefixAlignment:
    pair_id: str
    before_id: str
    after_id: str
    overlap_length: int
    rows: list["RowOverlapResult"]
    excluded_candidates: list[str]


@dataclass(frozen=True)
class RowOverlapResult:
    pair_id: str
    before_id: str
    after_id: str
    before_row: int
    after_row: int
    column_similarities: list[float]
    reliable_columns: list[bool]
    conclusion: RowConclusion
    occurrence_mapping: list[tuple[str, str]]
    before_semantic: RowSemanticSignature | None = None
    after_semantic: RowSemanticSignature | None = None
    warnings: list[str] = field(default_factory=list)


def source_sha256(path: Path) -> str:
    return sha256(path.read_bytes()).hexdigest()


def detector_fingerprint(paths: list[Path]) -> str:
    digest = sha256()
    for path in sorted(paths):
        digest.update(path.name.encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


def candidate_audits(analysis: SingleImageAnalysis) -> list[CandidateAudit]:
    stars = {star.card_id: star for star in analysis.stars}
    audits: list[CandidateAudit] = []
    for card in analysis.cards:
        star = stars.get(card.card_id)
        if card.is_complete and star is not None:
            status: BoxStatus = "candidate_structurally_valid"
            reason = "four_column_lattice_and_icon_evidence"
        elif card.completeness_confidence >= .55:
            status = "candidate_pending_review"
            reason = "edge_or_boundary_ambiguity"
        else:
            status = "candidate_rejected"
            reason = "incomplete_fragment_excluded_from_inventory"
        audits.append(CandidateAudit(
            analysis.image_id, card.card_id, card.row_index, card.column_index,
            card.box_original, status, reason, card.is_complete,
            card.completeness_confidence, star,
        ))
    return audits


def _full_rows(audits: list[CandidateAudit]) -> list[RowAudit]:
    grouped: dict[int, dict[int, CandidateAudit]] = {}
    for audit in audits:
        if audit.box_status == "candidate_structurally_valid":
            grouped.setdefault(audit.row_index, {})[audit.column_index] = audit
    rows: list[RowAudit] = []
    for row_index, by_column in sorted(grouped.items()):
        if set(by_column) == {0, 1, 2, 3}:
            rows.append(RowAudit(by_column[0].sample_id, row_index, tuple(by_column[index].card_id for index in range(4))))
    return rows


def _name_status(star: RecognizedStar | None) -> SemanticStatus:
    if star is None or not star.canonical_name:
        return "unknown"
    # Name inferences have an explicit provenance and remain auditable.  The
    # accepted canonical value is still an identity field, unlike raw pixels.
    return "confirmed"


def _level_status(star: RecognizedStar | None) -> SemanticStatus:
    if star is None or star.level is None:
        return "unknown"
    if star.level_source == "sort_order_inference":
        return "inferred"
    if star.level_source == "direct_ocr":
        return "confirmed"
    return "pending"


def _quality_status(star: RecognizedStar | None) -> SemanticStatus:
    if star is None or star.quality is None:
        return "unknown"
    return "pending" if star.quality_warnings else "confirmed"


def row_semantic_signature(analysis: SingleImageAnalysis, audits: list[CandidateAudit], row: RowAudit) -> RowSemanticSignature:
    by_card = {audit.card_id: audit for audit in audits}
    cards: list[CardSemanticSignature] = []
    for column_index, card_id in enumerate(row.card_ids):
        audit = by_card[card_id]
        star = audit.star
        warnings = tuple((star.warnings if star else []) + (star.quality_warnings if star else []))
        cards.append(CardSemanticSignature(
            sample_id=analysis.image_id,
            row_index=row.row_index,
            column_index=column_index,
            canonical_name=star.canonical_name if star else None,
            name_status=_name_status(star),
            level=star.level if star else None,
            level_status=_level_status(star),
            quality=star.quality if star else None,
            quality_status=_quality_status(star),
            card_visual_evidence=f"{audit.card_id}:complete={audit.is_complete}",
            warnings=warnings,
        ))
    return RowSemanticSignature(analysis.image_id, row.row_index, tuple(cards))  # type: ignore[arg-type]


def complete_row_preview_box(analysis: SingleImageAnalysis, row_index: int) -> tuple[int, int, int, int] | None:
    """Return the union of card, name, and level boxes for one complete row."""
    cards = [card for card in analysis.cards if card.row_index == row_index and card.is_complete]
    if len(cards) != 4 or {card.column_index for card in cards} != {0, 1, 2, 3}:
        return None
    boxes = [box for card in cards for box in (card.box_original, card.name_box_original, card.level_box_original) if box]
    x0 = min(box[0] for box in boxes); y0 = min(box[1] for box in boxes)
    x1 = max(box[0] + box[2] for box in boxes); y1 = max(box[1] + box[3] for box in boxes)
    return x0, y0, x1 - x0, y1 - y0


def terminal_partial_rows(audits: list[CandidateAudit]) -> list[tuple[str, int, list[str]]]:
    grouped: dict[int, list[CandidateAudit]] = {}
    for audit in audits:
        if audit.box_status == "candidate_structurally_valid":
            grouped.setdefault(audit.row_index, []).append(audit)
    if not grouped:
        return []
    last = max(grouped)
    cards = sorted(grouped[last], key=lambda item: item.column_index)
    if 1 <= len(cards) <= 3:
        return [(cards[0].sample_id, last, [card.card_id for card in cards])]
    return []


def _fingerprint(image: np.ndarray, card: CardCandidate) -> np.ndarray:
    region = crop(image, card.box_original)
    if region.size == 0:
        return np.empty((0,), dtype=np.float32)
    height, width = region.shape[:2]
    # The central icon disc is far more discriminating than the repeated card
    # background and label margins.  Use a pHash-style DCT signature plus the
    # local quality-background hue distribution, never OCR fields.
    icon = region[int(height * .12):int(height * .88), int(width * .12):int(width * .88)]
    def phash(source: np.ndarray) -> np.ndarray:
        if source.size == 0:
            return np.zeros(64, dtype=np.float32)
        resized = cv2.resize(source, (32, 32), interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY).astype(np.float32)
        dct = cv2.dct(gray)[:8, :8]
        return (dct >= np.median(dct[1:, 1:])).astype(np.float32).ravel()
    bits = phash(icon)
    name_bits = phash(crop(image, card.name_box_original)) if card.name_box_original else np.zeros(64, dtype=np.float32)
    level_bits = phash(crop(image, card.level_box_original)) if card.level_box_original else np.zeros(64, dtype=np.float32)
    resized = cv2.resize(icon, (32, 32), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(resized, cv2.COLOR_BGR2HSV)
    histogram = cv2.calcHist([hsv], [0], (hsv[:, :, 1] >= 42).astype(np.uint8), [12], [0, 180]).ravel()
    histogram /= max(histogram.sum(), 1.0)
    return np.concatenate((bits, name_bits, level_bits, histogram)).astype(np.float32)


def _similarity(left: np.ndarray, right: np.ndarray) -> float:
    if left.size == 0 or left.shape != right.shape:
        return 0.0
    icon_score = 1.0 - float(np.mean(left[:64] != right[:64]))
    name_score = 1.0 - float(np.mean(left[64:128] != right[64:128]))
    level_score = 1.0 - float(np.mean(left[128:192] != right[128:192]))
    histogram_score = float(np.minimum(left[192:], right[192:]).sum())
    return max(0.0, min(1.0, icon_score * .46 + name_score * .34 + level_score * .15 + histogram_score * .05))


def _continuous_suffix(rows: list[RowAudit]) -> list[RowAudit]:
    if not rows:
        return []
    result = [rows[-1]]
    for row in reversed(rows[:-1]):
        if row.row_index != result[-1].row_index - 1:
            break
        result.append(row)
    return list(reversed(result))


def _continuous_prefix(rows: list[RowAudit]) -> list[RowAudit]:
    if not rows:
        return []
    result = [rows[0]]
    for row in rows[1:]:
        if row.row_index != result[-1].row_index + 1:
            break
        result.append(row)
    return result


def _has_minimum_semantic_identity(signature: RowSemanticSignature) -> bool:
    """A level-only row is not a usable identity anchor or pending candidate."""
    return sum(card.name_status == "confirmed" and card.canonical_name is not None for card in signature.cards) >= 2


def _semantic_row_comparison(
    pair: DirectedPair,
    before_signature: RowSemanticSignature,
    before_image: np.ndarray,
    before_cards: dict[str, CardCandidate],
    before_row: RowAudit,
    after_signature: RowSemanticSignature,
    after_image: np.ndarray,
    after_cards: dict[str, CardCandidate],
    after_row: RowAudit,
) -> RowOverlapResult:
    """Compare one fixed-column semantic row; visual evidence only rejects conflicts."""
    warnings: list[str] = []
    reliable: list[bool] = []
    exact = True
    semantic_agreements = 0
    name_agreements = 0
    for left, right in zip(before_signature.cards, after_signature.cards):
        name_known = left.name_status == "confirmed" and right.name_status == "confirmed"
        if name_known and left.canonical_name != right.canonical_name:
            warnings.append(f"c{left.column_index + 1}:name_conflict")
        elif name_known:
            semantic_agreements += 1
            name_agreements += 1
        else:
            exact = False
        level_known = left.level_status in ("confirmed", "inferred") and right.level_status in ("confirmed", "inferred")
        if level_known and left.level != right.level:
            warnings.append(f"c{left.column_index + 1}:level_conflict")
        elif level_known:
            semantic_agreements += 1
        else:
            exact = False
        if left.quality_status == "confirmed" and right.quality_status == "confirmed" and left.quality != right.quality:
            warnings.append(f"c{left.column_index + 1}:quality_conflict")
        reliable.append(name_known and left.canonical_name == right.canonical_name and level_known and left.level == right.level)
    if warnings:
        return RowOverlapResult(pair.pair_id, pair.before_id, pair.after_id, before_row.row_index, after_row.row_index, [], reliable, "confirmed_no_overlap", [], before_signature, after_signature, warnings)
    if exact:
        state: RowConclusion = "confirmed_overlap"
    elif semantic_agreements >= 2 and name_agreements >= 2:
        state = "pending_review"
        warnings.append("semantic_fields_pending_or_unknown")
    else:
        return RowOverlapResult(pair.pair_id, pair.before_id, after_signature.sample_id, before_row.row_index, after_row.row_index, [], reliable, "ignored", [], before_signature, after_signature, ["insufficient_semantic_identity"])

    similarities = [
        _similarity(_fingerprint(before_image, before_cards[left]), _fingerprint(after_image, after_cards[right]))
        for left, right in zip(before_row.card_ids, after_row.card_ids)
    ]
    if any(value <= .50 for value in similarities):
        return RowOverlapResult(pair.pair_id, pair.before_id, pair.after_id, before_row.row_index, after_row.row_index, similarities, reliable, "confirmed_no_overlap", [], before_signature, after_signature, warnings + ["explicit_card_visual_conflict"])
    mapping = [(f"{pair.before_id}:r{before_row.row_index + 1}c{index + 1}", f"{pair.after_id}:r{after_row.row_index + 1}c{index + 1}") for index in range(4)] if state == "confirmed_overlap" else []
    return RowOverlapResult(pair.pair_id, pair.before_id, pair.after_id, before_row.row_index, after_row.row_index, similarities, reliable, state, mapping, before_signature, after_signature, warnings)


def align_directed_pair(
    pair: DirectedPair,
    before: SingleImageAnalysis,
    before_image: np.ndarray,
    after: SingleImageAnalysis,
    after_image: np.ndarray,
) -> SuffixPrefixAlignment:
    """Find the longest valid continuous A suffix / B prefix alignment."""
    before_audits = candidate_audits(before); after_audits = candidate_audits(after)
    all_before_rows = _full_rows(before_audits); all_after_rows = _full_rows(after_audits)
    before_signatures = {row.row_index: row_semantic_signature(before, before_audits, row) for row in all_before_rows}
    after_signatures = {row.row_index: row_semantic_signature(after, after_audits, row) for row in all_after_rows}
    before_rows = _continuous_suffix([row for row in all_before_rows if _has_minimum_semantic_identity(before_signatures[row.row_index])])
    after_rows = _continuous_prefix([row for row in all_after_rows if _has_minimum_semantic_identity(after_signatures[row.row_index])])
    before_cards = {card.card_id: card for card in before.cards}; after_cards = {card.card_id: card for card in after.cards}
    excluded: list[str] = []
    for length in range(min(len(before_rows), len(after_rows)), 0, -1):
        selected_before = before_rows[-length:]; selected_after = after_rows[:length]
        rows = [_semantic_row_comparison(pair, before_signatures[left.row_index], before_image, before_cards, left, after_signatures[right.row_index], after_image, after_cards, right) for left, right in zip(selected_before, selected_after)]
        if any(row.conclusion == "confirmed_no_overlap" for row in rows):
            excluded.append(f"k={length}:semantic_or_visual_conflict")
            continue
        if any(row.conclusion == "ignored" for row in rows):
            excluded.append(f"k={length}:insufficient_semantic_identity")
            continue
        if not any(row.conclusion == "confirmed_overlap" for row in rows):
            excluded.append(f"k={length}:no_exact_semantic_anchor")
            continue
        return SuffixPrefixAlignment(pair.pair_id, pair.before_id, pair.after_id, length, rows, excluded)
    return SuffixPrefixAlignment(pair.pair_id, pair.before_id, pair.after_id, 0, [], excluded or ["no_valid_suffix_prefix_alignment"])


def compare_directed_pair(
    pair: DirectedPair,
    before: SingleImageAnalysis,
    before_image: np.ndarray,
    after: SingleImageAnalysis,
    after_image: np.ndarray,
) -> list[RowOverlapResult]:
    """Compatibility wrapper returning only the final selected alignment rows."""
    return align_directed_pair(pair, before, before_image, after, after_image).rows


def unique_records(
    analyses: dict[str, SingleImageAnalysis],
    audits: dict[str, list[CandidateAudit]],
    row_results: list[RowOverlapResult],
) -> list[dict[str, object]]:
    occurrences: dict[str, CandidateAudit] = {}
    for sample_id, sample_audits in audits.items():
        for audit in sample_audits:
            if audit.box_status == "candidate_structurally_valid" and audit.inventory_action == "keep":
                occurrences[f"{sample_id}:r{audit.row_index + 1}c{audit.column_index + 1}"] = audit
    parent = {key: key for key in occurrences}

    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for row in row_results:
        if row.conclusion != "confirmed_overlap":
            continue
        for left, right in row.occurrence_mapping:
            left_root, right_root = find(left), find(right)
            if left_root != right_root:
                parent[right_root] = left_root
    grouped: dict[str, list[tuple[str, CandidateAudit]]] = {}
    for occurrence, audit in occurrences.items():
        grouped.setdefault(find(occurrence), []).append((occurrence, audit))
    records: list[dict[str, object]] = []
    for index, items in enumerate(grouped.values(), 1):
        primary_occurrence, primary = max(items, key=lambda item: item[1].star.overall_confidence if item[1].star else 0.0)
        star = primary.star
        records.append({
            "unique_record_id": f"unique_{index:04d}", "page_type": star.page_type if star else "unknown",
            "name": star.canonical_name if star else None, "level": star.level if star else None,
            "quality": star.quality if star else None, "field_status": "pending_review" if star and star.review_required else "resolved",
            "primary_occurrence": primary_occurrence, "all_sources": [occurrence for occurrence, _ in items],
            "merged_by_overlap": len(items) > 1,
        })
    return sorted(records, key=lambda item: (item["page_type"], -(item["level"] or 0), item["name"] or "", item["unique_record_id"]))


def analysis_metrics(analysis: SingleImageAnalysis, audits: list[CandidateAudit]) -> dict[str, object]:
    stars = [audit.star for audit in audits if audit.star]
    partial = terminal_partial_rows(audits)
    return {
        "candidate_total": len(audits),
        "structurally_valid": sum(audit.box_status == "candidate_structurally_valid" for audit in audits),
        "pending": sum(audit.box_status == "candidate_pending_review" for audit in audits),
        "rejected": sum(audit.box_status == "candidate_rejected" for audit in audits),
        "complete_cards": sum(audit.box_status == "candidate_structurally_valid" for audit in audits),
        "terminal_partial_rows": partial,
        "ignored_fragments": sum(audit.box_status == "candidate_rejected" for audit in audits),
        "name_direct": sum(star.name_source == "direct_ocr" and star.canonical_name is not None for star in stars),
        "name_sandwich": sum(star.name_source == "sort_sandwich_inference" for star in stars),
        "name_unknown": sum(star.canonical_name is None for star in stars),
        "level_direct": sum(star.level_source == "direct_ocr" and star.level is not None for star in stars),
        "level_inferred": sum(star.level_source == "sort_order_inference" for star in stars),
        "level_unknown": sum(star.level is None for star in stars),
        "level_conflicts": sum("level_order_conflict" in star.warnings for star in stars),
        "quality": {quality: sum(star.quality == quality for star in stars) for quality in ("橙", "紫", "蓝", "绿", "白")},
        "quality_unknown": sum(star.quality is None for star in stars),
        "quality_conflict": sum(bool(star.quality_warnings) for star in stars),
        "bag_current_count": analysis.bag.current if analysis.bag else None,
        "bag_capacity": analysis.bag.capacity if analysis.bag else None,
        "bag_warnings": analysis.bag.warnings if analysis.bag else ["bag_count_unavailable"],
    }


def as_jsonable(value: object) -> object:
    return asdict(value) if hasattr(value, "__dataclass_fields__") else value
