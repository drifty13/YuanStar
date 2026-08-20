from __future__ import annotations

import cv2
import numpy as np

from .models import ViewportResult


def _edge_depth(gray: np.ndarray, axis: int, reverse: bool) -> int:
    """Return a conservative continuous black-bar depth, never inspecting game interior."""
    limit = max(1, int(gray.shape[axis] * 0.18))
    depth = 0
    for offset in range(limit):
        index = gray.shape[axis] - 1 - offset if reverse else offset
        strip = gray[:, index] if axis == 1 else gray[index, :]
        if float(strip.mean()) <= 10 and float(strip.std()) <= 8:
            depth += 1
        else:
            break
    return depth


def detect_viewport(image: np.ndarray) -> ViewportResult:
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    left, right = _edge_depth(gray, 1, False), _edge_depth(gray, 1, True)
    top, bottom = _edge_depth(gray, 0, False), _edge_depth(gray, 0, True)
    # A one-pixel dark frame is not a black bar and should not change coordinates.
    left = left if left >= 8 else 0
    right = right if right >= 8 else 0
    top = top if top >= 8 else 0
    bottom = bottom if bottom >= 8 else 0
    usable_width, usable_height = width - left - right, height - top - bottom
    warnings: list[str] = []
    if usable_width < width * 0.45 or usable_height < height * 0.45:
        left = right = top = bottom = 0
        usable_width, usable_height = width, height
        warnings.append("black_bar_detection_rejected")
    cropped_ratio = 1 - (usable_width * usable_height) / (width * height)
    confidence = 0.95 if cropped_ratio == 0 else 0.80
    return ViewportResult(
        original_size=(width, height),
        viewport_box=(left, top, usable_width, usable_height),
        profile_id=None,
        confidence=confidence,
        warnings=warnings,
    )
