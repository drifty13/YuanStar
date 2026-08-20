from __future__ import annotations

import cv2
import numpy as np

from .models import CardCandidate
from .preprocess import crop


QUALITY_HUES = {"橙": 12, "紫": 142, "蓝": 106, "绿": 61}
QUALITY_VALUES = {"橙", "紫", "蓝", "绿", "白"}


def _annulus(card_image: np.ndarray) -> np.ndarray:
    """Return a relative icon-background ring; never use page coordinates."""
    height, width = card_image.shape[:2]
    if not height or not width:
        return np.empty((0, 0, 3), dtype=np.uint8)
    yy, xx = np.ogrid[:height, :width]
    radius = np.sqrt(((xx - (width - 1) / 2) / (width / 2)) ** 2 + ((yy - (height - 1) / 2) / (height / 2)) ** 2)
    # The outer half of the circular card captures quality backing while avoiding
    # the often differently-coloured star artwork in the middle.
    mask = (radius >= 0.62) & (radius <= 0.96)
    return card_image[mask]


def classify_quality_pixels(pixels: np.ndarray) -> tuple[str | None, float, str, list[str]]:
    if pixels.size == 0:
        return None, 0.0, "empty_relative_quality_region", ["quality_unknown"]
    hsv = cv2.cvtColor(pixels.reshape(-1, 1, 3), cv2.COLOR_BGR2HSV).reshape(-1, 3)
    saturation = hsv[:, 1].astype(float)
    value = hsv[:, 2].astype(float)
    colourful = saturation >= 52
    bright_neutral = (saturation <= 45) & (value >= 150)
    colour_ratio = float(np.mean(colourful))
    white_ratio = float(np.mean(bright_neutral))
    if white_ratio >= 0.56 and colour_ratio <= 0.24:
        return "白", min(0.92, 0.55 + white_ratio * 0.42), f"neutral={white_ratio:.2f};saturated={colour_ratio:.2f}", []
    if colour_ratio < 0.16:
        return None, 0.0, f"saturated={colour_ratio:.2f}", ["quality_low_saturation", "quality_unknown"]
    hue = float(np.median(hsv[colourful, 0]))
    distances = {quality: min(abs(hue - target), 180 - abs(hue - target)) for quality, target in QUALITY_HUES.items()}
    quality, distance = min(distances.items(), key=lambda item: item[1])
    # A wide HSV margin and a substantial coloured-background share keep this
    # deliberately conservative under compression and star-art colour leakage.
    if distance > 19 or colour_ratio < 0.34:
        return None, 0.0, f"hue={hue:.1f};distance={distance:.1f};saturated={colour_ratio:.2f}", ["quality_visual_conflict", "quality_unknown"]
    confidence = min(0.93, 0.40 + colour_ratio * 0.38 + (19 - distance) / 19 * 0.25)
    return quality, confidence, f"hue={hue:.1f};distance={distance:.1f};saturated={colour_ratio:.2f}", []


def recognize_quality(image: np.ndarray, card: CardCandidate) -> tuple[str, str | None, float, list[str]]:
    quality, confidence, evidence, warnings = classify_quality_pixels(_annulus(crop(image, card.box_original)))
    return evidence, quality, confidence, warnings
