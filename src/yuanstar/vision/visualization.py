from __future__ import annotations

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from .models import CardCandidate, RecognizedStar, ViewportResult


def render_overlay(image: np.ndarray, viewport: ViewportResult, cards: list[CardCandidate], stars: list[RecognizedStar]) -> np.ndarray:
    output = image.copy()
    vx, vy, vw, vh = viewport.viewport_box
    cv2.rectangle(output, (vx, vy), (vx + vw, vy + vh), (255, 190, 0), 2)
    by_id = {star.card_id: star for star in stars}
    labels: list[tuple[tuple[int, int], str, tuple[int, int, int]]] = []
    for card in cards:
        x, y, width, height = card.box_original
        star = by_id.get(card.card_id)
        if not card.is_complete:
            color = (130, 130, 130)
        elif star and not star.review_required:
            color = (35, 210, 35)
        else:
            color = (0, 220, 255)
        cv2.rectangle(output, (x, y), (x + width, y + height), color, 2)
        label = f"r{card.row_index + 1}c{card.column_index + 1}"
        if star:
            label += f" {star.canonical_name or '待复核'} {star.level or '待复核'}"
        labels.append(((x, max(18, y - 24)), label, color))
    font_path = next((path for path in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf") if __import__("os").path.exists(path)), None)
    if font_path:
        canvas = Image.fromarray(cv2.cvtColor(output, cv2.COLOR_BGR2RGB))
        painter = ImageDraw.Draw(canvas)
        font = ImageFont.truetype(font_path, 16)
        for position, label, bgr in labels:
            painter.text(position, label, font=font, fill=(bgr[2], bgr[1], bgr[0]))
        return cv2.cvtColor(np.asarray(canvas), cv2.COLOR_RGB2BGR)
    # A safe fallback preserves identifiers and state instead of replacing Chinese
    # text with question marks on systems without a CJK font.
    for position, label, color in labels:
        fallback = label.split()[0] + " status"
        cv2.putText(output, fallback, position, cv2.FONT_HERSHEY_SIMPLEX, 0.45, color, 1, cv2.LINE_AA)
    return output
