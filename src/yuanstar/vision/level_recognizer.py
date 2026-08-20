from __future__ import annotations

import re

from .ocr_engine import LocalRapidOcr, OcrText
from .preprocess import image_variants


def parse_level(value: str) -> int | None:
    if "-" in value or "负" in value:
        return None
    digits = re.findall(r"\d+", value.replace("O", "0").replace("o", "0"))
    if len(digits) != 1:
        return None
    level = int(digits[0])
    return level if 1 <= level <= 60 else None


def resolve_level_candidates(
    recognized_variants: list[OcrText],
) -> tuple[str | None, int | None, float, list[str]]:
    candidates: list[tuple[str, int, float]] = []
    raw_values: list[tuple[str, float]] = []
    for item in recognized_variants:
        raw_values.append((item.text, item.confidence))
        level = parse_level(item.text)
        if level is not None:
            candidates.append((item.text, level, item.confidence))
    if not candidates:
        raw = max(raw_values, key=lambda item: item[1])[0] if raw_values else None
        return raw, None, 0.0, ["level_unknown"]
    counts: dict[int, list[tuple[str, float]]] = {}
    for raw, level, score in candidates:
        counts.setdefault(level, []).append((raw, score))
    def weighted(items: list[tuple[str, float]]) -> float:
        return sum(score + (0.22 if "级" in raw else 0.0) for raw, score in items)
    ranked = sorted(((weighted(items), value, items) for value, items in counts.items()), reverse=True)
    _, level, supporting = ranked[0]
    runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
    raw, best_score = max(supporting, key=lambda item: item[1])
    complete_high_confidence = "级" in raw and best_score >= 0.85
    if len(ranked) > 1 and not complete_high_confidence and ranked[0][0] - runner_up < 0.15:
        return raw, None, 0.0, ["level_strategy_conflict", "level_candidates:" + "/".join(str(value) for _, value, _ in ranked)]
    confidence = min(0.99, best_score * 0.82 + min(len(supporting), 3) * 0.06)
    warning = [] if len(ranked) == 1 else ["level_weighted_consensus:" + "/".join(str(value) for _, value, _ in ranked)]
    return raw, level, confidence, warning


def recognize_level(image, engine: LocalRapidOcr) -> tuple[str | None, int | None, float, list[str]]:
    recognized_variants: list[OcrText] = []
    for _, variant in image_variants(image):
        recognized_variants.extend(engine.recognize(variant, single_line=True))
    return resolve_level_candidates(recognized_variants)
