from __future__ import annotations

import cv2
import numpy as np

from .models import PageClassification
from .ocr_engine import LocalRapidOcr
from .preprocess import crop


PAGE_TOKENS = {"main": ("主星",), "support": ("辅星",), "experience": ("经验星石", "紫星曜", "白星曜")}


def classify_page(image, viewport_box: tuple[int, int, int, int], engine: LocalRapidOcr | None = None) -> PageClassification:
    x, y, width, height = viewport_box
    # A selected tab is a broad light-gold rounded rectangle. Detect that shape,
    # not merely brightness: cropped images begin with bright icon circles.
    top, bottom = y + int(height * 0.07), y + int(height * 0.24)
    band = image[top:bottom, x:x + width]
    header_probe = image[y:y + int(height * 0.16), x:x + width]
    top_icons = None if header_probe.size == 0 else cv2.HoughCircles(
        cv2.medianBlur(cv2.cvtColor(header_probe, cv2.COLOR_BGR2GRAY), 7), cv2.HOUGH_GRADIENT, 1.2, max(24, int(width * 0.12)),
        param1=120, param2=35, minRadius=max(12, int(width * 0.055)), maxRadius=max(14, int(width * 0.115)),
    )
    # Four icon circles across the top means the screenshot is already cropped
    # into the grid; no header/tab visual evidence may be inferred there.
    cropped_grid_top = top_icons is not None and len(top_icons[0]) >= 3
    if band.size and not cropped_grid_top:
        hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
        mask = cv2.inRange(hsv, np.array([8, 25, 120]), np.array([42, 210, 255]))
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), dtype=np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        choices = []
        for contour in contours:
            left, local_y, tab_width, tab_height = cv2.boundingRect(contour)
            aspect = tab_width / max(tab_height, 1)
            if tab_width >= width * 0.14 and 1.4 <= aspect <= 8 and tab_height <= height * 0.10:
                choices.append((tab_width * tab_height, left + tab_width / 2))
        if choices:
            _, center = max(choices)
            page = "main" if center < width * 0.35 else "support" if center < width * 0.65 else "experience"
            return PageClassification(page, 0.82, [f"selected_tab_visual:{page}"])
    tab = crop(image, (x + int(width * 0.05), y + int(height * 0.07), int(width * 0.90), int(height * 0.12)))
    texts = [] if engine is None else [item.text.replace(" ", "") for item in engine.recognize(tab)]
    evidence: list[str] = []
    scores = {page: 0 for page in PAGE_TOKENS}
    joined = " ".join(texts)
    for page, tokens in PAGE_TOKENS.items():
        for token in tokens:
            if token in joined:
                scores[page] += 1
                evidence.append(f"tab_ocr:{token}")
    best = max(scores, key=scores.get)
    if scores[best] == 0:
        return PageClassification("unknown", 0.0, evidence)
    ties = sum(1 for value in scores.values() if value == scores[best])
    if ties > 1:
        return PageClassification("unknown", 0.2, evidence + ["page_evidence_conflict"])
    return PageClassification(best, 0.75 if best != "experience" else 0.70, evidence)
