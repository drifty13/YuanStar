from __future__ import annotations

from dataclasses import replace
from typing import Literal

import cv2
import numpy as np

from .models import CardCandidate, RecognizedStar
from .preprocess import crop


EquippedState = Literal["not_evaluated", "equipped", "unequipped", "unknown"]
QUALITY_RANK = {"橙": 5, "紫": 4, "蓝": 3, "绿": 2, "白": 1}
KIND_RANK = {"主星": 0, "辅星": 1}
EQUIPPED_RANK = {"equipped": 0, "unequipped": 1, "unknown": 2, "not_evaluated": 3}
EQUIPPED_ROI_X_OFFSET = -0.065
EQUIPPED_ROI_Y_OFFSET = 0.00
EQUIPPED_ROI_WIDTH = 0.37
EQUIPPED_ROI_HEIGHT = 0.36
EQUIPPED_MIN_RELIABLE_CONFIDENCE = 0.72


def classify_equipped_roi(roi: np.ndarray) -> tuple[EquippedState, float, list[str]]:
    """Classify only avatar-vs-simple-anchor evidence; never identify a person."""
    if roi.size == 0 or min(roi.shape[:2]) < 8:
        return "unknown", 0.0, ["equipped_roi_missing"]
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    saturation = float(np.mean(hsv[:, :, 1] >= 48))
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    texture = float(np.std(cv2.Laplacian(gray, cv2.CV_32F)))
    quantized = (cv2.resize(roi, (24, 24)) // 32).reshape(-1, 3)
    _, counts = np.unique(quantized, axis=0, return_counts=True)
    probabilities = counts / counts.sum()
    colour_entropy = float(-(probabilities * np.log2(probabilities)).sum())
    if colour_entropy >= 4.05:
        confidence = min(.94, .62 + (colour_entropy - 4.05) * .18 + min(texture, 80) / 500)
        return "equipped", confidence, []
    if colour_entropy <= 3.95:
        confidence = min(.92, .62 + (3.95 - colour_entropy) * .12 + saturation * .08)
        if confidence < EQUIPPED_MIN_RELIABLE_CONFIDENCE:
            return "unknown", .45, ["equipped_unequipped_low_confidence"]
        return "unequipped", confidence, []
    return "unknown", .45, ["equipped_colour_entropy_conflict"]


def recognize_equipped(image: np.ndarray, card: CardCandidate) -> tuple[EquippedState, float, str, list[str]]:
    roi = crop(image, equipped_roi_box(card, image.shape))
    state, confidence, warnings = classify_equipped_roi(roi)
    return state, confidence, "relative_anchor_colour_entropy", warnings


def equipped_roi_box(
    card: CardCandidate,
    image_shape: tuple[int, ...] | None = None,
) -> tuple[int, int, int, int]:
    """Return the relative avatar/lock anchor used by production."""
    x, y, width, height = card.box_original
    left = max(0, x + round(width * EQUIPPED_ROI_X_OFFSET))
    top = max(0, y + round(height * EQUIPPED_ROI_Y_OFFSET))
    roi_width = max(1, round(width * EQUIPPED_ROI_WIDTH))
    roi_height = max(1, round(height * EQUIPPED_ROI_HEIGHT))
    if image_shape is not None:
        image_height, image_width = image_shape[:2]
        left = min(left, image_width)
        top = min(top, image_height)
        roi_width = max(0, min(roi_width, image_width - left))
        roi_height = max(0, min(roi_height, image_height - top))
    return left, top, roi_width, roi_height


def _ordered_cards(
    cards: list[CardCandidate], stars: list[RecognizedStar],
) -> list[CardCandidate]:
    star_ids = {star.card_id for star in stars}
    return [
        card
        for card in sorted(cards, key=lambda value: (value.row_index, value.column_index))
        if card.is_complete and card.card_id in star_ids
    ]


def equipped_boundary_indexes(
    cards: list[CardCandidate],
    stars: list[RecognizedStar],
    catalog_order: dict[str, int] | None = None,
) -> list[int]:
    """Return right-hand indexes whose quality/level reset needs equipped evidence."""
    by_id = {star.card_id: star for star in stars}
    ordered = _ordered_cards(cards, stars)
    boundaries: list[int] = []
    for index, (left_card, right_card) in enumerate(zip(ordered, ordered[1:]), 1):
        left = by_id[left_card.card_id]
        right = by_id[right_card.card_id]
        left_quality = QUALITY_RANK.get(left.quality or "")
        right_quality = QUALITY_RANK.get(right.quality or "")
        if left_quality is None or right_quality is None:
            continue
        if left_quality < right_quality:
            boundaries.append(index)
            continue
        if left_quality != right_quality:
            continue
        left_level = left.direct_level if left.direct_level is not None else left.level
        right_level = right.direct_level if right.direct_level is not None else right.level
        if left_level is None or right_level is None:
            continue
        if left_level < right_level:
            boundaries.append(index)
    return boundaries


def infer_equipped_sandwiches(
    cards: list[CardCandidate],
    stars: list[RecognizedStar],
    equipped: dict[str, tuple[EquippedState, float, str, list[str]]],
) -> dict[str, tuple[EquippedState, float, str, list[str]]]:
    """Infer only the confirmed E / unknown / E local sandwich."""
    ordered = _ordered_cards(cards, stars)
    updated = dict(equipped)
    snapshot = dict(equipped)
    for index in range(1, len(ordered) - 1):
        left, current, right = ordered[index - 1:index + 2]
        left_state = snapshot.get(left.card_id, ("not_evaluated", 0.0, "", []))[0]
        current_state = snapshot.get(current.card_id, ("not_evaluated", 0.0, "", []))[0]
        right_state = snapshot.get(right.card_id, ("not_evaluated", 0.0, "", []))[0]
        if (left_state, current_state, right_state) == ("equipped", "unknown", "equipped"):
            updated[current.card_id] = (
                "equipped", .82, "equipped_sandwich_inference", ["equipped_inferred_by_sandwich"],
            )
    return updated


def recognize_equipped_on_demand(
    image: np.ndarray,
    cards: list[CardCandidate],
    stars: list[RecognizedStar],
    catalog_order: dict[str, int] | None = None,
    *,
    classifier=recognize_equipped,
) -> tuple[dict[str, tuple[EquippedState, float, str, list[str]]], int]:
    """Classify the smallest local window around otherwise unexplained boundaries."""
    ordered = _ordered_cards(cards, stars)
    boundaries = equipped_boundary_indexes(cards, stars, catalog_order)
    results: dict[str, tuple[EquippedState, float, str, list[str]]] = {}
    calls = 0

    def classify_indexes(indexes: set[int]) -> None:
        nonlocal calls
        for index in sorted(indexes):
            if not (0 <= index < len(ordered)):
                continue
            card = ordered[index]
            if card.card_id in results:
                continue
            results[card.card_id] = classifier(image, card)
            calls += 1

    def boundary_is_resolved(index: int) -> bool:
        inferred = infer_equipped_sandwiches(cards, stars, results)
        left_state = inferred.get(ordered[index - 1].card_id, ("not_evaluated", 0.0, "", []))[0]
        right_state = inferred.get(ordered[index].card_id, ("not_evaluated", 0.0, "", []))[0]
        return left_state in {"equipped", "unequipped"} and right_state in {"equipped", "unequipped"}

    available_rows = sorted({card.row_index for card in ordered})
    for boundary in boundaries:
        classify_indexes({boundary - 1, boundary})
        if boundary_is_resolved(boundary):
            continue
        boundary_row = ordered[boundary].row_index
        classify_indexes({
            index for index, card in enumerate(ordered) if card.row_index == boundary_row
        })
        if boundary_is_resolved(boundary):
            continue
        adjacent_rows = sorted(available_rows, key=lambda row: (abs(row - boundary_row), row))
        adjacent_row = next((row for row in adjacent_rows if abs(row - boundary_row) == 1), None)
        if adjacent_row is not None:
            classify_indexes({
                index for index, card in enumerate(ordered) if card.row_index == adjacent_row
            })
    return infer_equipped_sandwiches(cards, stars, results), calls


def apply_manual_overrides(stars: list[RecognizedStar], overrides: dict[str, dict[str, object]]) -> list[RecognizedStar]:
    result: list[RecognizedStar] = []
    for star in stars:
        item = overrides.get(star.card_id, {})
        name = item.get("name", star.canonical_name)
        level = item.get("level", star.level)
        quality = item.get("quality", star.quality)
        name_unknown = name == "unknown"; level_unknown = level == "unknown"; quality_unknown = quality == "unknown"
        result.append(replace(star,
            canonical_name=None if name_unknown else name,
            level=None if level_unknown else level,
            quality=None if quality_unknown else quality,
            name_source="manual_review" if "name" in item else star.name_source,
            level_source="manual_review" if "level" in item else star.level_source,
            quality_source="manual_review" if "quality" in item else star.quality_source,
            review_required=name_unknown or level_unknown or quality_unknown or name is None or level is None or quality is None,
        ))
    return result


def apply_hierarchical_order(cards: list[CardCandidate], stars: list[RecognizedStar], equipped: dict[str, tuple[EquippedState, float, str, list[str]]]) -> list[RecognizedStar]:
    """The sole level-order validator: continuous equipped+quality segments."""
    stale_warnings = {
        "level_order_conflict",
        "hierarchical_level_order_conflict",
        "level_inferred_by_sort_order",
        "level_inferred_by_hierarchical_order",
    }
    by_id = {star.card_id: star for star in stars}
    ordered = [
        card
        for card in sorted(cards, key=lambda value: (value.row_index, value.column_index))
        if card.card_id in by_id and card.is_complete
    ]
    base: dict[str, RecognizedStar] = {}
    for card in ordered:
        state, confidence, source, equipped_warnings = equipped.get(
            card.card_id,
            ("not_evaluated", 0.0, "not_evaluated", []),
        )
        star = by_id[card.card_id]
        base[card.card_id] = replace(
            star,
            equipped_state=state,
            equipped_confidence=confidence,
            equipped_source=source,
            equipped_warnings=equipped_warnings,
            warnings=[warning for warning in star.warnings if warning not in stale_warnings],
        )

    for left_card, right_card in zip(ordered, ordered[1:]):
        left = base[left_card.card_id]
        right = base[right_card.card_id]
        if left.equipped_state == "unequipped" and right.equipped_state == "equipped":
            warning = "equipped_order_reversal"
            base[right_card.card_id] = replace(
                right,
                review_required=True,
                warnings=right.warnings + ([warning] if warning not in right.warnings else []),
                equipped_warnings=right.equipped_warnings
                + ([warning] if warning not in right.equipped_warnings else []),
            )

    groups: list[list[CardCandidate]] = []
    for card in ordered:
        current = base[card.card_id]
        key = (current.equipped_state, current.quality)
        previous = base[groups[-1][-1].card_id] if groups else None
        previous_key = (previous.equipped_state, previous.quality) if previous else None
        uncertain = key[0] == "unknown" or key[1] is None
        if uncertain or not groups or previous_key != key:
            groups.append([card])
        else:
            groups[-1].append(card)

    updated = dict(base)
    for group in groups:
        direct = {
            card.card_id: (
                base[card.card_id].direct_level
                if base[card.card_id].level_source == "direct_ocr"
                else base[card.card_id].level
                if base[card.card_id].level_source == "manual_review"
                else None
            )
            for card in group
        }
        for index, card in enumerate(group):
            star = base[card.card_id]
            value = direct[card.card_id]
            left = direct[group[index - 1].card_id] if index else None
            right = direct[group[index + 1].card_id] if index + 1 < len(group) else None
            if star.level_source == "manual_review":
                manual_warnings = [
                    warning
                    for warning in star.warnings
                    if warning != "manual_value_overrides_sort_rule"
                ]
                if left is not None and value is not None and left < value:
                    manual_warnings.append("manual_value_overrides_sort_rule")
                updated[card.card_id] = replace(star, warnings=manual_warnings)
            elif value is not None and left is not None and left < value:
                # Descending order is directional: only the later rising item
                # is the deterministic conflict, not both neighbours.
                updated[card.card_id] = replace(
                    star,
                    level=None,
                    level_confidence=0.0,
                    review_required=True,
                    warnings=star.warnings + ["hierarchical_level_order_conflict"],
                )
            elif value is None and left is not None and right is not None and left == right:
                updated[card.card_id] = replace(
                    star,
                    level=left,
                    level_source="hierarchical_sort_inference",
                    level_confidence=.82,
                    review_required=star.canonical_name is None or star.quality is None,
                    warnings=star.warnings + ["level_inferred_by_hierarchical_order"],
                )
    return [updated.get(star.card_id, star) for star in stars]


def needs_equipped_evidence(cards: list[CardCandidate], stars: list[RecognizedStar]) -> bool:
    """Request avatar/lock evidence only when same-quality level order conflicts."""
    return bool(equipped_boundary_indexes(cards, stars))


def apply_hierarchical_name_sandwich(cards: list[CardCandidate], stars: list[RecognizedStar]) -> list[RecognizedStar]:
    by_id = {star.card_id: star for star in stars}; ordered = sorted((card for card in cards if card.is_complete and card.card_id in by_id), key=lambda card: (card.row_index, card.column_index)); updates = {}
    for index in range(1, len(ordered) - 1):
        left_card, current_card, right_card = ordered[index - 1:index + 2]; left, current, right = (by_id[card.card_id] for card in (left_card, current_card, right_card))
        adjacent = (left_card.row_index == current_card.row_index and left_card.column_index + 1 == current_card.column_index) and (current_card.row_index == right_card.row_index and current_card.column_index + 1 == right_card.column_index)
        if not adjacent or current.canonical_name is not None or current.equipped_state == "unknown" or current.quality is None or current.level is None: continue
        if not (left.equipped_state == current.equipped_state == right.equipped_state and left.quality == current.quality == right.quality and left.level == current.level == right.level and left.canonical_name and left.canonical_name == right.canonical_name): continue
        if left.name_source not in {"direct_ocr", "manual_review"} or right.name_source not in {"direct_ocr", "manual_review"}: continue
        updates[current.card_id] = replace(current, canonical_name=left.canonical_name, name_source="hierarchical_sort_sandwich_inference", name_confidence=.82, review_required=current.level is None or current.quality is None, warnings=[w for w in current.warnings if w != "name_inferred_by_sort_sandwich"] + ["name_inferred_by_hierarchical_sandwich"])
    return [updates.get(star.card_id, star) for star in stars]


def resolved_catalog_order(record: dict[str, object], catalog_order: dict[str, int] | None = None) -> int:
    """Resolve catalog order at the UI boundary even when a record omitted it."""
    explicit = record.get("catalog_order")
    if isinstance(explicit, int):
        return explicit
    name = record.get("name")
    if catalog_order is not None and isinstance(name, str):
        return catalog_order.get(name, 9999)
    return 9999


def web_sort_key(record: dict[str, object], catalog_order: dict[str, int] | None = None) -> tuple[object, ...]:
    order = record.get("source_order", {})
    if not isinstance(order, dict):
        order = {}
    return (
        KIND_RANK.get(record.get("kind"), 99),
        EQUIPPED_RANK.get(record.get("equipped_state"), 3),
        -(QUALITY_RANK.get(record.get("quality"), 0)),
        -(record.get("level") or -1),
        resolved_catalog_order(record, catalog_order),
        str(record.get("name") or ""),
        order.get("upload_batch_index", 0),
        order.get("source_image_index", 0),
        order.get("row_index", 0),
        order.get("column_index", 0),
        order.get("occurrence_id", ""),
        record.get("unique_record_id", ""),
    )


def game_page_sort_key(
    record: dict[str, object],
    catalog_order: dict[str, int] | None = None,
) -> tuple[object, ...]:
    """The game's visible hierarchy used to explain OCR ordering."""
    return (
        EQUIPPED_RANK.get(record.get("equipped_state"), 3),
        -QUALITY_RANK.get(record.get("quality"), 0),
        -(record.get("level") or -1),
        resolved_catalog_order(record, catalog_order),
        str(record.get("name") or ""),
    )


def sort_web_records(records: list[dict[str, object]], catalog_order: dict[str, int]) -> list[dict[str, object]]:
    """Attach authoritative catalog positions before sorting web-visible records."""
    enriched = [
        {**record, "catalog_order": resolved_catalog_order(record, catalog_order)}
        for record in records
    ]
    return sorted(enriched, key=lambda record: web_sort_key(record, catalog_order))
