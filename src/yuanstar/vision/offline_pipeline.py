from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import cv2

from ..catalog import StarCatalog, load_catalog
from ..domain import StarKind
from .bottom_toolbar import locate_bottom_toolbar
from .card_detector import detect_cards
from .layout_profiles import select_layout_profile
from .level_recognizer import recognize_level, resolve_level_candidates
from .models import PageClassification, RecognizedStar, SingleImageAnalysis
from .name_recognizer import recognize_name, resolve_name_candidates
from .ocr_engine import LocalRapidOcr
from .page_classifier import classify_page
from .experience_recognizer import recognize_experience_stones
from .hierarchical_order import (
    apply_hierarchical_name_sandwich,
    apply_hierarchical_order,
    recognize_equipped_on_demand,
)
from .quality_recognizer import recognize_quality
from .bag_recognizer import recognize_bag_count
from .preprocess import crop, image_variants
from .viewport import detect_viewport


class OfflineSingleImagePipeline:
    """Authoritative single-image OCR and normalization pipeline for UI and tests."""

    def __init__(self, catalog: StarCatalog | None = None, engine: LocalRapidOcr | None = None) -> None:
        self.catalog = catalog or load_catalog()
        self.engine = engine or LocalRapidOcr()

    def analyze_path(self, path: Path) -> tuple[SingleImageAnalysis, object]:
        image = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            raise ValueError(f"无法解码图片：{path}")
        return self.analyze_image(image, path.stem)

    def analyze_image(self, image, image_id: str) -> tuple[SingleImageAnalysis, object]:
        viewport = detect_viewport(image)
        profile = select_layout_profile((viewport.viewport_box[2], viewport.viewport_box[3]))
        viewport = type(viewport)(viewport.original_size, viewport.viewport_box, profile.profile_id, viewport.confidence, viewport.warnings)
        page = classify_page(image, viewport.viewport_box, self.engine)
        anchors_present = bool(page.evidence and any(item.startswith(("selected_tab_visual:", "tab_ocr:")) for item in page.evidence))
        experience = recognize_experience_stones(
            image, viewport.viewport_box, self.engine, page=page, viewport_warnings=viewport.warnings,
        ) if page.page_type == "experience" else None
        bag = recognize_bag_count(image, viewport.viewport_box, self.engine)
        detection_audit: dict[str, object] = {}
        toolbar = (
            locate_bottom_toolbar(image, viewport.viewport_box, self.engine)
            if page.page_type in {"main", "support", "unknown"}
            else None
        )
        cards = detect_cards(
            image,
            viewport.viewport_box,
            profile,
            anchors_present=anchors_present,
            bottom_toolbar_anchor_boxes=toolbar.anchor_boxes if toolbar else (),
            dark_panel_top=toolbar.dark_panel_top if toolbar else None,
            detection_audit=detection_audit,
        ) if page.page_type in {"main", "support", "unknown"} else []
        stars: list[RecognizedStar] = []
        complete_cards = [
            card
            for card in cards
            if card.is_complete
            and card.name_box_original is not None
            and card.level_box_original is not None
        ]
        variant_images = []
        variant_keys: list[tuple[str, str, str]] = []
        for card in complete_cards:
            name_crop = crop(image, card.name_box_original)
            level_crop = crop(image, card.level_box_original)
            if name_crop.size:
                for variant_name, variant in image_variants(name_crop):
                    variant_images.append(variant)
                    variant_keys.append((card.card_id, "name", variant_name))
            if level_crop.size:
                for variant_name, variant in image_variants(level_crop):
                    variant_images.append(variant)
                    variant_keys.append((card.card_id, "level", variant_name))
        recognized = self.engine.recognize_many_single_line(variant_images)
        recognized_by_card: dict[str, dict[str, list[object]]] = {}
        for key, item in zip(variant_keys, recognized, strict=True):
            card_id, field_name, variant_name = key
            fields = recognized_by_card.setdefault(card_id, {"name": [], "level": []})
            if field_name == "name":
                fields["name"].append((variant_name, item))
            else:
                fields["level"].append(item)

        for card in complete_cards:
            candidates = recognized_by_card.get(card.card_id, {"name": [], "level": []})
            raw_name, canonical_name, name_score, name_warnings = resolve_name_candidates(
                candidates["name"], self.catalog, page.page_type
            )
            raw_level, level, level_score, level_warnings = resolve_level_candidates(
                candidates["level"]
            )
            evidence, quality, quality_score, quality_warnings = recognize_quality(image, card)
            warnings = name_warnings + level_warnings
            review = canonical_name is None or level is None or quality is None or page.page_type == "unknown"
            stars.append(RecognizedStar(
                card.card_id, page.page_type, raw_name, canonical_name, name_score,
                raw_level, level, level_score, min(name_score, level_score), review, warnings,
                direct_level=level, raw_quality_evidence=evidence, quality=quality,
                quality_confidence=quality_score,
                quality_source="visual_background" if quality else "unknown",
                quality_warnings=quality_warnings,
            ))
        equipped, equipped_classifier_calls = recognize_equipped_on_demand(
            image, cards, stars, self.catalog.order_index,
        )
        stars = apply_hierarchical_order(cards, stars, equipped)
        stars = apply_hierarchical_name_sandwich(cards, stars)
        # Name evidence is permitted only as a low-confidence fallback when the tabs are absent.
        if page.page_type == "unknown":
            main_hits = sum(star.canonical_name in self.catalog.names_for_kind(StarKind.MAIN) for star in stars if star.canonical_name)
            support_hits = sum(star.canonical_name in self.catalog.names_for_kind(StarKind.SUPPORT) for star in stars if star.canonical_name)
            if main_hits and not support_hits:
                page = PageClassification("main", 0.45, ["name_dictionary_fallback"])
            elif support_hits and not main_hits:
                page = PageClassification("support", 0.45, ["name_dictionary_fallback"])
            if page.page_type != "unknown":
                stars = finalize_stars(stars, page)
        warnings = list(viewport.warnings)
        bottom_ui_count = int(detection_audit.get("auto_excluded_bottom_ui", 0))
        if bottom_ui_count:
            warnings.append(f"auto_excluded_bottom_ui:{bottom_ui_count}")
        if not cards and page.page_type in {"main", "support", "unknown"}:
            warnings.append("card_detection_empty")
        content_bounds = (
            int(detection_audit["card_content_top"]),
            int(detection_audit["card_content_bottom"]),
        ) if "card_content_top" in detection_audit and "card_content_bottom" in detection_audit else None
        return SingleImageAnalysis(
            image_id, viewport, page, cards, stars, warnings, experience, bag,
            equipped_classifier_calls, content_bounds,
        ), image


def finalize_stars(stars: list[RecognizedStar], page: PageClassification) -> list[RecognizedStar]:
    """Apply the final page decision to confidence and review state."""
    return [replace(
        star,
        page_type=page.page_type,
        overall_confidence=min(star.name_confidence, star.level_confidence, page.confidence),
        review_required=star.canonical_name is None or star.level is None or star.quality is None or page.page_type == "unknown",
    ) for star in stars]


def _reading_neighbours(left, current, right) -> bool:
    """Require unbroken four-column reading order; no implied missing slots."""
    return (
        (left.row_index == current.row_index and left.column_index + 1 == current.column_index or left.row_index + 1 == current.row_index and left.column_index == 3 and current.column_index == 0)
        and (current.row_index == right.row_index and current.column_index + 1 == right.column_index or current.row_index + 1 == right.row_index and current.column_index == 3 and right.column_index == 0)
    )


def _adjacent(left, right) -> bool:
    return (
        (left.row_index == right.row_index and left.column_index + 1 == right.column_index)
        or (left.row_index + 1 == right.row_index and left.column_index == 3 and right.column_index == 0)
    )


def _direct_level(star: RecognizedStar) -> int | None:
    """Read only the immutable direct-OCR snapshot, never an inferred value."""
    if star.level_source != "direct_ocr" or star.level_confidence < 0.72:
        return None
    return star.direct_level if star.direct_level is not None else star.level


def apply_sort_order_level_inference(cards, stars: list[RecognizedStar]) -> list[RecognizedStar]:
    """Apply one-pass, non-chaining descending-level validation.

    Every card reads the same direct-OCR snapshot.  A missing or conflicting
    value is filled only when its independently derived legal interval is a
    singleton; otherwise it becomes a visible review item.
    """
    by_id = {star.card_id: star for star in stars}
    card_order = sorted(cards, key=lambda card: (card.row_index, card.column_index))
    result: dict[str, RecognizedStar] = {}
    for index, card in enumerate(card_order):
        current = by_id.get(card.card_id)
        if current is None or not card.is_complete:
            continue
        left_card = card_order[index - 1] if index else None
        right_card = card_order[index + 1] if index + 1 < len(card_order) else None
        if left_card is not None and (not left_card.is_complete or not _adjacent(left_card, card)):
            continue
        if right_card is not None and (not right_card.is_complete or not _adjacent(card, right_card)):
            continue
        left = by_id.get(left_card.card_id) if left_card else None
        right = by_id.get(right_card.card_id) if right_card else None
        if left_card is not None and left is None or right_card is not None and right is None:
            continue
        upper = _direct_level(left) if left else 60
        lower = _direct_level(right) if right else 1
        # An unavailable neighbour provides no evidence beyond the global bound.
        upper = upper if upper is not None else 60
        lower = lower if lower is not None else 1
        if upper < lower:
            result[current.card_id] = replace(
                current, level=None, level_confidence=0.0, review_required=True,
                warnings=current.warnings + ["level_order_conflict"],
            )
            continue
        direct = _direct_level(current)
        satisfies = direct is not None and lower <= direct <= upper
        if satisfies:
            continue
        if upper == lower:
            result[current.card_id] = replace(
                current, level=upper, level_confidence=min(0.82, current.level_confidence or 0.82),
                level_source="sort_order_inference",
                level_provenance=current.level_provenance + [f"direct_interval:{lower}-{upper}"],
                review_required=current.canonical_name is None or current.quality is None,
                warnings=current.warnings + ["level_inferred_by_sort_order"],
            )
        else:
            result[current.card_id] = replace(
                current, level=None, level_confidence=0.0, review_required=True,
                warnings=current.warnings + ["level_order_conflict"],
            )
    return [result.get(star.card_id, star) for star in stars]


def apply_sort_sandwich_inference(cards, stars: list[RecognizedStar]) -> list[RecognizedStar]:
    """Fill only strict direct-OCR name sandwiches, never inferred neighbours."""
    by_id = {star.card_id: star for star in stars}
    ordered = sorted((card for card in cards if card.card_id in by_id), key=lambda card: (card.row_index, card.column_index))
    inferred: dict[str, RecognizedStar] = {}
    for index in range(1, len(ordered) - 1):
        left_card, current_card, right_card = ordered[index - 1:index + 2]
        left, current, right = (by_id[item.card_id] for item in (left_card, current_card, right_card))
        if not (left_card.is_complete and current_card.is_complete and right_card.is_complete and _reading_neighbours(left_card, current_card, right_card)):
            continue
        if current.canonical_name is not None or current.level is None:
            continue
        if not (left.canonical_name and left.canonical_name == right.canonical_name and left.level == right.level == current.level):
            continue
        if not (left.name_source == right.name_source == "direct_ocr" and left.name_confidence >= 0.72 and right.name_confidence >= 0.72):
            continue
        confidence = min(0.82, left.name_confidence, right.name_confidence, current.level_confidence)
        inferred[current.card_id] = replace(current, canonical_name=left.canonical_name, name_confidence=confidence, overall_confidence=min(confidence, current.level_confidence), review_required=current.level is None or current.quality is None, warnings=current.warnings + ["name_inferred_by_sort_sandwich"], name_source="sort_sandwich_inference")
    return [inferred.get(star.card_id, star) for star in stars]
