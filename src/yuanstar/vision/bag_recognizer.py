from __future__ import annotations

import re

import numpy as np

from .models import BagCountResult
from .preprocess import crop


_COUNTS = re.compile(r"(\d{1,4})\s*/\s*(\d{1,4})")


def recognize_bag_count(image: np.ndarray, viewport: tuple[int, int, int, int], engine) -> BagCountResult:
    """Read only the lower-right count region, never global OCR/resource values."""
    x, y, width, height = viewport
    region = crop(image, (x + int(width * .67), y + int(height * .78), int(width * .31), int(height * .16)))
    candidates: list[tuple[int, int, float, str]] = []
    for item in engine.recognize(region, single_line=False):
        match = _COUNTS.search(item.text.replace("O", "0").replace("o", "0"))
        if match:
            current, capacity = int(match.group(1)), int(match.group(2))
            if current <= capacity:
                candidates.append((current, capacity, item.confidence, item.text))
    if not candidates:
        return BagCountResult(None, None, warnings=["bag_count_unknown"])
    current, capacity, confidence, raw = max(candidates, key=lambda item: item[2])
    return BagCountResult(current, capacity, confidence, [raw])
