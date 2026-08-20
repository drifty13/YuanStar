from __future__ import annotations

import cv2
import numpy as np


def image_variants(image: np.ndarray, scale: int = 3) -> list[tuple[str, np.ndarray]]:
    enlarged = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(enlarged, cv2.COLOR_BGR2GRAY)
    contrast = cv2.convertScaleAbs(gray, alpha=1.7, beta=-35)
    _, otsu = cv2.threshold(contrast, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return [("color", enlarged), ("contrast", contrast), ("otsu", otsu)]


def crop(image: np.ndarray, box: tuple[int, int, int, int]) -> np.ndarray:
    x, y, width, height = box
    return image[max(0, y):max(0, y + height), max(0, x):max(0, x + width)].copy()
