from __future__ import annotations

from dataclasses import dataclass
import re

import cv2
import numpy as np

from .models import Box
from .preprocess import crop


TOOLBAR_LABELS = (
    "取消分解",
    "一键解锁",
    "一键选择",
    "分解",
    "自动",
    "筛选",
)
CAPACITY_PATTERN = re.compile(r"\d{1,4}\s*/\s*\d{1,4}")


@dataclass(frozen=True)
class BottomToolbarEvidence:
    anchor_boxes: tuple[Box, ...] = ()
    labels: tuple[str, ...] = ()
    dark_panel_top: int | None = None

    @property
    def present(self) -> bool:
        return len(self.anchor_boxes) >= 2


def _toolbar_label(text: str) -> str | None:
    normalized = text.replace(" ", "")
    for label in TOOLBAR_LABELS:
        if label in normalized:
            return label
    return "capacity" if CAPACITY_PATTERN.search(normalized) else None


def _horizontal_groups(
    entries: list[tuple[str, Box]],
    viewport_height: int,
) -> list[list[tuple[str, Box]]]:
    tolerance = max(12, round(viewport_height * 0.025))
    groups: list[list[tuple[str, Box]]] = []
    for entry in sorted(entries, key=lambda item: item[1][1] + item[1][3] / 2):
        center = entry[1][1] + entry[1][3] / 2
        group_center = (
            sum(item[1][1] + item[1][3] / 2 for item in groups[-1])
            / len(groups[-1])
            if groups
            else None
        )
        if groups and group_center is not None and abs(center - group_center) <= tolerance:
            groups[-1].append(entry)
        else:
            groups.append([entry])
    return groups


def _dark_panel_top(
    image: np.ndarray,
    viewport: Box,
    earliest_anchor_top: int,
) -> int | None:
    x, y, width, height = viewport
    left = x + round(width * 0.05)
    band_width = max(1, round(width * 0.90))
    start = max(y, earliest_anchor_top - round(height * 0.14))
    end = min(y + height, earliest_anchor_top + round(height * 0.04))
    region = crop(image, (left, start, band_width, max(0, end - start)))
    if region.size == 0 or region.shape[0] < 32:
        return None
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    means = np.mean(gray, axis=1)
    kernel = np.ones(9, dtype=np.float32) / 9
    smooth = np.convolve(means, kernel, mode="same")
    best: tuple[float, int] | None = None
    for index in range(12, len(smooth) - 20):
        above = float(np.mean(smooth[index - 10 : index]))
        below = float(np.mean(smooth[index : index + 18]))
        drop = above - below
        if drop >= 12 and below <= 120:
            candidate = (drop, start + index)
            if best is None or candidate[0] > best[0]:
                best = candidate
    return best[1] if best else None


def locate_bottom_toolbar(
    image: np.ndarray,
    viewport: Box,
    engine,
) -> BottomToolbarEvidence:
    """Locate a real bottom toolbar from positioned OCR anchors.

    The lower-half ratio limits OCR work only. It never creates a masked bottom
    zone: without two aligned text anchors this function returns no toolbar.
    """
    positioned = getattr(engine, "recognize_positioned", None)
    if positioned is None:
        return BottomToolbarEvidence()
    x, y, width, height = viewport
    search_top = y + round(height * 0.52)
    region = crop(image, (x, search_top, width, y + height - search_top))
    entries: list[tuple[str, Box]] = []
    for item in positioned(region):
        label = _toolbar_label(str(item.text))
        if label is None or float(item.confidence) < 0.30:
            continue
        bx, by, bw, bh = item.box
        entries.append((label, (x + bx, search_top + by, bw, bh)))
    qualified = [
        group
        for group in _horizontal_groups(entries, height)
        if len({label for label, _ in group}) >= 2
    ]
    if not qualified:
        return BottomToolbarEvidence()
    anchors = [entry for group in qualified for entry in group]
    earliest = min(box[1] for _, box in anchors)
    return BottomToolbarEvidence(
        anchor_boxes=tuple(box for _, box in anchors),
        labels=tuple(label for label, _ in anchors),
        dark_panel_top=_dark_panel_top(image, viewport, earliest),
    )
