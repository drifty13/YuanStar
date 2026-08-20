from __future__ import annotations

from dataclasses import dataclass
import re

import cv2
import numpy as np

from .layout_profiles import TABLET_PORTRAIT_V1, select_layout_profile
from .models import Box, ExperienceStoneResult, PageClassification
from .preprocess import crop


ORDER = {"orange": 0, "purple": 1, "white": 2}
EXPERIENCE_COUNT_X_OFFSET = 0.40
EXPERIENCE_COUNT_Y_OFFSET = 0.78
EXPERIENCE_COUNT_WIDTH = 0.60
EXPERIENCE_COUNT_HEIGHT = 0.24


@dataclass(frozen=True)
class ExperienceRoiObservation:
    icon_box: Box
    count_box: Box
    kind: str | None
    kind_confidence: float
    raw_texts: tuple[str, ...]
    count: int | None
    count_confidence: float


def _kind(image: np.ndarray, box: tuple[int, int, int, int]) -> tuple[str | None, float]:
    x, y, width, height = box
    region = crop(image, (x + int(width * .22), y + int(height * .22), int(width * .56), int(height * .56)))
    if region.size == 0:
        return None, 0.0
    hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
    mask = hsv[:, :, 1] > 70
    if not np.any(mask):
        return None, 0.0
    hue = float(np.median(hsv[:, :, 0][mask]))
    targets = {"orange": 10, "purple": 130, "white": 100}
    kind = min(targets, key=lambda key: abs(hue - targets[key]))
    return kind, max(0.0, 1 - abs(hue - targets[kind]) / 35)


def experience_count_box(box: Box) -> Box:
    """Cover the icon's local lower-right number pill without scanning the page."""
    x, y, width, height = box
    return (
        x + int(width * EXPERIENCE_COUNT_X_OFFSET),
        y + int(height * EXPERIENCE_COUNT_Y_OFFSET),
        max(1, int(width * EXPERIENCE_COUNT_WIDTH)),
        max(1, int(height * EXPERIENCE_COUNT_HEIGHT)),
    )


def _count(
    image: np.ndarray,
    box: Box,
    engine,
) -> tuple[int | None, float, tuple[str, ...]]:
    values: list[tuple[int, float]] = []
    raw_texts: list[str] = []
    local = crop(image, experience_count_box(box))
    for item in engine.recognize(local, single_line=True):
        raw_texts.append(item.text)
        match = re.fullmatch(r"\d{1,6}", item.text.strip())
        if match:
            values.append((int(match.group()), item.confidence))
    if not values:
        return None, 0.0, tuple(raw_texts)
    value, confidence = max(values, key=lambda candidate: candidate[1])
    return value, confidence, tuple(raw_texts)


def _dominant_icon_row(circles: np.ndarray) -> list[tuple[float, float, float]]:
    """Keep the horizontally aligned icon row and reject tab/background circles."""
    candidates = [tuple(map(float, circle)) for circle in circles]
    clusters: list[list[tuple[float, float, float]]] = []
    for circle in sorted(candidates, key=lambda value: value[1]):
        for cluster in clusters:
            centre = float(np.median([item[1] for item in cluster]))
            tolerance = max(18.0, float(np.median([item[2] for item in cluster])) * .38)
            if abs(circle[1] - centre) <= tolerance:
                cluster.append(circle)
                break
        else:
            clusters.append([circle])
    selected = max(
        clusters,
        key=lambda cluster: (
            len(cluster),
            -abs(float(np.median([item[1] for item in cluster]))),
        ),
    )
    return sorted(selected, key=lambda circle: circle[0])


def _tab_is_selected(page: PageClassification | None) -> bool:
    return bool(page and page.page_type == "experience" and page.confidence >= .65 and any(
        item.startswith(("selected_tab_visual:", "tab_ocr:")) for item in page.evidence
    ))


def _exclude_selected_tablet_tab_band(viewport: Box, page: PageClassification | None) -> bool:
    """Exclude navigation circles only for a reliably classified tablet page."""
    if not _tab_is_selected(page):
        return False
    _, _, width, height = viewport
    return select_layout_profile((width, height)) == TABLET_PORTRAIT_V1


def locate_experience_rois(
    image: np.ndarray,
    viewport: Box,
    engine,
    *,
    page: PageClassification | None = None,
) -> list[ExperienceRoiObservation]:
    vx, vy, vw, vh = viewport
    # Tablet experience pages put the navigation circles above the real icon
    # row. Phone and partial layouts retain the wider, already validated range.
    top = vy + int(vh * (.24 if _exclude_selected_tablet_tab_band(viewport, page) else .18))
    bottom = vy + int(vh * .62)
    region = image[top:bottom, vx:vx + vw]
    if region.size == 0:
        return []
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    circles = cv2.HoughCircles(
        cv2.medianBlur(gray, 7),
        cv2.HOUGH_GRADIENT,
        1.2,
        max(32, int(vw * .10)),
        param1=110,
        param2=22,
        minRadius=max(18, int(vw * .045)),
        maxRadius=max(30, int(vw * .11)),
    )
    if circles is None:
        return []
    observations: list[ExperienceRoiObservation] = []
    for cx, cy, radius in _dominant_icon_row(circles[0]):
        box = (
            int(vx + cx - radius),
            int(top + cy - radius),
            int(2 * radius),
            int(2 * radius),
        )
        kind, kind_confidence = _kind(image, box)
        count, count_confidence, raw_texts = _count(image, box, engine)
        observations.append(ExperienceRoiObservation(
            icon_box=box,
            count_box=experience_count_box(box),
            kind=kind,
            kind_confidence=kind_confidence,
            raw_texts=raw_texts,
            count=count,
            count_confidence=count_confidence,
        ))
    return observations


def recognize_experience_stones(
    image: np.ndarray,
    viewport: tuple[int, int, int, int],
    engine,
    *,
    page: PageClassification | None = None,
    viewport_warnings: list[str] | None = None,
) -> ExperienceStoneResult:
    """Bind each local number to its icon and only emit missing-kind zero safely."""
    observations = locate_experience_rois(image, viewport, engine, page=page)
    if not observations:
        return ExperienceStoneResult(None, None, None, warnings=["experience_icons_not_found"])
    values: dict[str, tuple[int | None, float, float, ExperienceRoiObservation]] = {}
    warnings: list[str] = []
    unclassified = 0
    for observation in observations:
        if observation.kind is None:
            unclassified += 1
            continue
        candidate = (
            observation.count,
            min(observation.kind_confidence, observation.count_confidence),
            float(observation.icon_box[0]),
            observation,
        )
        if observation.kind not in values or candidate[1] > values[observation.kind][1]:
            values[observation.kind] = candidate
    ordered = [kind for kind, _ in sorted(values.items(), key=lambda item: item[1][2])]
    if ordered != sorted(ordered, key=lambda kind: ORDER[kind]):
        warnings.append("experience_order_conflict")
    if unclassified:
        warnings.append("experience_icon_unclassified")
    for kind, value in values.items():
        if value[0] is None:
            warnings.append(f"experience_count_unparsed:{kind}")
    cropped = any("crop" in warning or "viewport" in warning for warning in (viewport_warnings or []))
    complete = _tab_is_selected(page) and not cropped and not warnings
    if not _tab_is_selected(page):
        warnings.append("experience_tab_selection_unverified")
    if cropped:
        warnings.append("experience_viewport_cropped")

    def field(kind: str) -> tuple[int | None, float]:
        value = values.get(kind)
        if value is not None:
            return value[0], value[1]
        return (0, .95) if complete else (None, 0.0)

    orange, orange_confidence = field("orange")
    purple, purple_confidence = field("purple")
    white, white_confidence = field("white")
    evidence = {
        kind: {
            "icon_detected": True,
            "icon_box": value[3].icon_box,
            "count_box": value[3].count_box,
            "raw_texts": list(value[3].raw_texts),
        }
        for kind, value in values.items()
    }
    return ExperienceStoneResult(
        orange, purple, white, orange_confidence, purple_confidence, white_confidence,
        complete, warnings, evidence,
    )
