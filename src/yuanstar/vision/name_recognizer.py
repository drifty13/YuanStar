from __future__ import annotations

import re
from difflib import SequenceMatcher

from ..catalog import StarCatalog
from ..domain import StarKind
from .ocr_engine import LocalRapidOcr, OcrText
from .preprocess import image_variants


def clean_name(value: str) -> str:
    return re.sub(r"[\s\W_级]+", "", value, flags=re.UNICODE).replace("级", "")


def _allowed_names(catalog: StarCatalog, page_type: str) -> list[str]:
    if page_type == "main":
        return catalog.names_for_kind(StarKind.MAIN)
    if page_type == "support":
        return catalog.names_for_kind(StarKind.SUPPORT)
    return catalog.names_for_kind(StarKind.MAIN) + catalog.names_for_kind(StarKind.SUPPORT)


def resolve_name_candidates(
    recognized_variants: list[tuple[str, OcrText]],
    catalog: StarCatalog,
    page_type: str,
) -> tuple[str | None, str | None, float, list[str]]:
    candidates = []
    for variant_name, item in recognized_variants:
        cleaned = clean_name(item.text)
        if cleaned:
            candidates.append((cleaned, item.confidence, variant_name))
    if not candidates:
        return None, None, 0.0, ["name_ocr_empty"]
    raw, raw_score, _ = max(candidates, key=lambda item: item[1])
    normalized = catalog.normalize(raw)
    allowed = _allowed_names(catalog, page_type)
    if normalized in allowed:
        agreement = sum(1 for text, _, _ in candidates if catalog.normalize(text) == normalized)
        return raw, normalized, min(0.99, raw_score * 0.85 + min(agreement, 3) * 0.05), []
    # Conservative fuzzy matching: only a near-perfect match may confirm a two-character name.
    matches = sorted(((SequenceMatcher(None, normalized, name).ratio(), name) for name in allowed), reverse=True)
    if matches and matches[0][0] >= 0.86 and raw_score >= 0.72:
        best_ratio, best_name = matches[0]
        tie = len(matches) > 1 and matches[1][0] >= best_ratio - 0.05
        agreement = sum(1 for text, _, _ in candidates if SequenceMatcher(None, catalog.normalize(text), best_name).ratio() >= 0.86)
        if not tie and agreement >= 2:
            return raw, best_name, min(0.88, (raw_score + best_ratio) / 2), ["name_fuzzy_confirmed"]
    return raw, None, raw_score * 0.5, ["name_unknown"]


def recognize_name(image, engine: LocalRapidOcr, catalog: StarCatalog, page_type: str) -> tuple[str | None, str | None, float, list[str]]:
    recognized_variants: list[tuple[str, OcrText]] = []
    for variant_name, variant in image_variants(image):
        for item in engine.recognize(variant, single_line=True):
            recognized_variants.append((variant_name, item))
    return resolve_name_candidates(recognized_variants, catalog, page_type)
