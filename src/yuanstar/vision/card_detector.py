from __future__ import annotations

from dataclasses import dataclass
from statistics import median

import cv2
import numpy as np

from .layout_profiles import LayoutProfile
from .models import CardCandidate


@dataclass(frozen=True)
class CircleProposal:
    """A raw local circle observation, never an official card by itself."""

    center_x: int
    center_y: int
    radius: int
    source: str = "hough"

    @property
    def box(self) -> tuple[int, int, int, int]:
        return (self.center_x - self.radius, self.center_y - self.radius, self.radius * 2, self.radius * 2)


def _normalized(box: tuple[int, int, int, int], viewport: tuple[int, int, int, int]) -> tuple[float, float, float, float]:
    x, y, width, height = box
    vx, vy, vw, vh = viewport
    return ((x - vx) / vw, (y - vy) / vh, width / vw, height / vh)


def _hough_proposals(image: np.ndarray, viewport: tuple[int, int, int, int], search_top: float) -> list[CircleProposal]:
    """Return debug-only Hough proposals from the adaptable grid search area."""
    vx, vy, vw, vh = viewport
    top = vy + int(vh * search_top)
    region = image[top:vy + int(vh * 0.96), vx:vx + vw]
    if region.size == 0:
        return []
    gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
    circles = cv2.HoughCircles(
        cv2.medianBlur(gray, 7), cv2.HOUGH_GRADIENT, 1.2, max(36, int(vw * 0.06)),
        param1=120, param2=35, minRadius=max(12, int(vw * 0.055)), maxRadius=max(14, int(vw * 0.115)),
    )
    if circles is None:
        return []
    return [CircleProposal(int(x + vx), int(y + top), int(radius)) for x, y, radius in circles[0]]


def _iou(left: CircleProposal, right: CircleProposal) -> float:
    lx, ly, lw, lh = left.box
    rx, ry, rw, rh = right.box
    ix = max(0, min(lx + lw, rx + rw) - max(lx, rx))
    iy = max(0, min(ly + lh, ry + rh) - max(ly, ry))
    intersection = ix * iy
    union = lw * lh + rw * rh - intersection
    return intersection / union if union else 0.0


def _nms_2d(proposals: list[CircleProposal]) -> list[CircleProposal]:
    """Suppress duplicate Hough rings using both centre proximity and IoU."""
    selected: list[CircleProposal] = []
    for proposal in sorted(proposals, key=lambda item: item.radius, reverse=True):
        duplicate = False
        for existing in selected:
            distance = float(np.hypot(proposal.center_x - existing.center_x, proposal.center_y - existing.center_y))
            if distance <= min(proposal.radius, existing.radius) * 0.55 or _iou(proposal, existing) >= 0.58:
                duplicate = True
                break
        if not duplicate:
            selected.append(proposal)
    return selected


def _main_radius_cluster(proposals: list[CircleProposal]) -> list[CircleProposal]:
    """Find the densest local radius mode instead of averaging decorative circles.

    Tablet screenshots contain much larger ornamental rings.  The game icons form
    a tight repeated radius mode, while those ornaments do not; the same rule is
    resolution-independent for phone and edge captures.
    """
    if not proposals:
        return []
    best: list[CircleProposal] = []
    for seed in proposals:
        cluster = [item for item in proposals if abs(item.radius - seed.radius) <= max(3, seed.radius * 0.09)]
        if len(cluster) > len(best) or (len(cluster) == len(best) and median(item.radius for item in cluster) < median(item.radius for item in best)):
            best = cluster
    if len(best) < 2:
        return []
    centre = median(item.radius for item in best)
    return [item for item in best if abs(item.radius - centre) <= max(3, centre * 0.10)]


def _cluster_rows(proposals: list[CircleProposal]) -> list[list[CircleProposal]]:
    if not proposals:
        return []
    tolerance = max(12, median(item.radius for item in proposals) * 0.65)
    rows: list[list[CircleProposal]] = []
    for proposal in sorted(proposals, key=lambda item: item.center_y):
        center_y = median(item.center_y for item in rows[-1]) if rows else None
        if rows and abs(proposal.center_y - center_y) <= tolerance:
            rows[-1].append(proposal)
        else:
            rows.append([proposal])
    return rows


def _column_centers(rows: list[list[CircleProposal]], viewport: tuple[int, int, int, int], profile: LayoutProfile) -> list[float]:
    vx, _, vw, _ = viewport
    best: list[CircleProposal] | None = None
    best_score = float("inf")
    for row in rows:
        if len(row) < 4:
            continue
        xs = sorted(item.center_x for item in row)[:4]
        gaps = [xs[index + 1] - xs[index] for index in range(3)]
        score = max(gaps) - min(gaps)
        if score < best_score:
            best, best_score = row, score
    if best:
        return [float(value) for value in sorted(item.center_x for item in best)[:4]]
    return [vx + vw * value for value in profile.column_centers]


def _row_lattice(
    rows: list[list[CircleProposal]],
    columns: list[float],
    viewport: tuple[int, int, int, int],
    row_spacing_range: tuple[float, float] | None = None,
) -> list[list[CircleProposal]]:
    """Keep populated grid rows and reject isolated middle decorations.

    A formal complete row needs two anchors.  Partial bottom rows are handled
    separately, so this rule can be intentionally strict without hiding them.
    """
    _, _, vw, _ = viewport
    max_column_deviation = vw * 0.075
    lattice_rows: list[list[CircleProposal]] = []
    for row in rows:
        slots: dict[int, CircleProposal] = {}
        row_radius = median(item.radius for item in row)
        for item in row:
            if not row_radius * 0.82 <= item.radius <= row_radius * 1.20:
                continue
            column = min(range(4), key=lambda index: abs(item.center_x - columns[index]))
            if abs(item.center_x - columns[column]) > max_column_deviation:
                continue
            current = slots.get(column)
            if current is None or abs(item.radius - row_radius) < abs(current.radius - row_radius):
                slots[column] = item
        if slots:
            lattice_rows.append([slots[index] for index in sorted(slots)])
    if len(lattice_rows) < 2:
        return []

    # A false tablet decoration can occasionally share the icon radius and line
    # up with two or three columns.  It is still squeezed beside a stronger,
    # regular grid row.  Resolve each close pair in favour of the better anchor
    # row before admitting terminal one-card rows.
    def row_y(row: list[CircleProposal]) -> float:
        return float(median(item.center_y for item in row))

    # Four-column rows are the strongest anchors.  Infer the vertical cadence
    # from them first, rather than letting a three-column ornament alter the
    # median.  A legitimate cropped edge row may have fewer anchors, but it
    # must still fall on that cadence.
    full_anchor_centres = [row_y(row) for row in lattice_rows if len(row) == 4]
    if len(full_anchor_centres) >= 3:
        anchor_gaps = [right - left for left, right in zip(full_anchor_centres, full_anchor_centres[1:]) if right > left]
        _, _, _, viewport_height = viewport
        cadence_gaps = anchor_gaps
        if row_spacing_range is not None:
            minimum_gap = viewport_height * row_spacing_range[0]
            maximum_gap = viewport_height * row_spacing_range[1]
            cadence_gaps = [
                gap for gap in anchor_gaps
                if minimum_gap <= gap <= maximum_gap
            ]
        # A detector can miss one whole row, producing a 2x gap between full
        # anchors.  Prefer the profile-valid cadence instead of averaging the
        # normal and doubled gap and discarding both intervening real rows.
        anchor_gap = median(cadence_gaps) if cadence_gaps else median(anchor_gaps) if anchor_gaps else 0.0
        if anchor_gap:
            base = full_anchor_centres[0]
            aligned: dict[int, list[CircleProposal]] = {}
            for row in lattice_rows:
                offset = round((row_y(row) - base) / anchor_gap)
                if abs(row_y(row) - (base + offset * anchor_gap)) > anchor_gap * 0.18:
                    continue
                previous = aligned.get(offset)
                if previous is None or len(row) > len(previous):
                    aligned[offset] = row
            lattice_rows = [aligned[index] for index in sorted(aligned)]
            if len(lattice_rows) < 2:
                return []

    centres = [row_y(row) for row in lattice_rows]
    gaps = sorted(right - left for left, right in zip(centres, centres[1:]) if right > left)
    typical_gap = median(gaps[len(gaps) // 2:]) if gaps else 0.0
    changed = True
    while changed and typical_gap:
        changed = False
        for index, (left, right) in enumerate(zip(lattice_rows, lattice_rows[1:])):
            if row_y(right) - row_y(left) >= typical_gap * 0.60:
                continue
            remove = index if len(left) < len(right) else index + 1
            # Equal-anchor close rows have no lattice proof; favour the row
            # nearest the expected sequence established by its neighbours.
            if len(left) == len(right) and index > 0 and index + 2 < len(lattice_rows):
                previous_gap = row_y(left) - row_y(lattice_rows[index - 1])
                next_gap = row_y(lattice_rows[index + 2]) - row_y(right)
                remove = index if abs(previous_gap - typical_gap) < abs(next_gap - typical_gap) else index + 1
            lattice_rows.pop(remove)
            changed = True
            break

    accepted: list[list[CircleProposal]] = []
    for index, row in enumerate(lattice_rows):
        if len(row) >= 2:
            accepted.append(row)
            continue
        neighbour_gap = row_y(lattice_rows[1]) - row_y(row) if index == 0 else row_y(row) - row_y(lattice_rows[index - 1]) if index == len(lattice_rows) - 1 else 0.0
        if typical_gap and typical_gap * 0.75 <= neighbour_gap <= typical_gap * 1.45:
            accepted.append(row)
    return accepted


def _icon_evidence(image: np.ndarray, proposal: CircleProposal) -> bool:
    """Check that the proposed icon region has actual local visual structure."""
    x, y, width, height = proposal.box
    crop = image[max(0, y):min(image.shape[0], y + height), max(0, x):min(image.shape[1], x + width)]
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 130)
    return float(np.count_nonzero(edges)) / edges.size >= 0.012


def _boxes(proposal: CircleProposal) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int], tuple[int, int, int, int]]:
    cx, cy, radius = proposal.center_x, proposal.center_y, proposal.radius
    box = (int(cx - radius * 1.05), int(cy - radius), int(radius * 2.1), int(radius * 2.05))
    name_box = (int(cx - radius * 0.92), int(cy + radius * 1.08), int(radius * 1.84), max(12, int(radius * 0.62)))
    level_box = (int(cx + radius * 0.02), int(cy - radius * 1.06), int(radius * 1.08), max(12, int(radius * 0.58)))
    return box, name_box, level_box


def _is_inside(box: tuple[int, int, int, int], viewport: tuple[int, int, int, int]) -> bool:
    x, y, width, height = box
    vx, vy, vw, vh = viewport
    return x >= vx and y >= vy and x + width <= vx + vw and y + height <= vy + vh


def _toolbar_top(
    anchor_boxes: tuple[tuple[int, int, int, int], ...],
    radius: float,
    dark_panel_top: int | None,
) -> int | None:
    if len(anchor_boxes) < 2:
        return None
    anchor_top = min(box[1] for box in anchor_boxes) - round(radius * 0.10)
    # A broad dark list background can look like a toolbar panel far above the
    # actual controls.  Accept a dark-panel edge only when it remains close to
    # the OCR-confirmed toolbar anchors at this icon scale.
    if dark_panel_top is not None and anchor_top - dark_panel_top <= radius * 2.5:
        return min(anchor_top, dark_panel_top)
    return anchor_top


def _overlaps_bottom_toolbar(proposal: CircleProposal, toolbar_top: int) -> bool:
    circle_top = proposal.center_y - proposal.radius
    circle_bottom = proposal.center_y + proposal.radius
    overlap = max(0, circle_bottom - max(circle_top, toolbar_top))
    return proposal.center_y >= toolbar_top or overlap >= proposal.radius * 0.50


def _circle_complete(
    proposal: CircleProposal,
    image: np.ndarray,
    viewport: tuple[int, int, int, int],
    *,
    content_top: int | None = None,
) -> bool:
    vx, vy, vw, vh = viewport
    return (
        proposal.center_y - proposal.radius >= (
            content_top if content_top is not None else vy
        )
        and proposal.center_y + proposal.radius <= min(image.shape[0], vy + vh)
        and proposal.center_x - proposal.radius >= vx
        and proposal.center_x + proposal.radius <= vx + vw
    )


def _box_complete(
    box: tuple[int, int, int, int],
    viewport: tuple[int, int, int, int],
    *,
    content_top: int | None,
    content_bottom: int,
) -> bool:
    x, y, width, height = box
    vx, vy, vw, _ = viewport
    return (
        x >= vx
        and x + width <= vx + vw
        and y >= (content_top if content_top is not None else vy)
        and y + height <= content_bottom
    )


def _card_complete(
    proposal: CircleProposal,
    name_box: tuple[int, int, int, int],
    level_box: tuple[int, int, int, int],
    image: np.ndarray,
    viewport: tuple[int, int, int, int],
    *,
    content_top: int | None,
    content_bottom: int,
) -> bool:
    """A formal card needs its disc and both OCR fields inside content bounds."""
    return (
        _circle_complete(
            proposal,
            image,
            viewport,
            content_top=content_top,
        )
        and _box_complete(name_box, viewport, content_top=content_top, content_bottom=content_bottom)
        and _box_complete(level_box, viewport, content_top=content_top, content_bottom=content_bottom)
    )


def detect_cards(
    image: np.ndarray,
    viewport: tuple[int, int, int, int],
    profile: LayoutProfile,
    *,
    anchors_present: bool = True,
    bottom_toolbar_anchor_boxes: tuple[tuple[int, int, int, int], ...] = (),
    dark_panel_top: int | None = None,
    detection_audit: dict[str, object] | None = None,
) -> list[CardCandidate]:
    """Build official cards through proposals, NMS, a 2-D lattice, and evidence."""
    vx, vy, vw, vh = viewport
    search_top = profile.grid_region[1] if anchors_present else 0.015
    content_top = vy + round(vh * search_top) if anchors_present else None
    proposals = _nms_2d(_hough_proposals(image, viewport, search_top))
    main = _main_radius_cluster(proposals)
    if not main:
        if detection_audit is not None:
            detection_audit.update(
                {
                    "bottom_toolbar_present": False,
                    "bottom_toolbar_top": None,
                    "auto_excluded_bottom_ui": 0,
                }
            )
        return []

    reference_radius = float(median(item.radius for item in main))
    toolbar_top = _toolbar_top(
        bottom_toolbar_anchor_boxes,
        reference_radius,
        dark_panel_top,
    )
    content_bottom = min(
        image.shape[0],
        toolbar_top if toolbar_top is not None else vy + round(vh * profile.bottom_safe_y),
    )
    excluded_bottom_ui = (
        [
            proposal
            for proposal in proposals
            if _overlaps_bottom_toolbar(proposal, toolbar_top)
        ]
        if toolbar_top is not None
        else []
    )
    if excluded_bottom_ui:
        excluded_ids = {id(proposal) for proposal in excluded_bottom_ui}
        proposals = [proposal for proposal in proposals if id(proposal) not in excluded_ids]
        main = _main_radius_cluster(proposals)
    if detection_audit is not None:
        detection_audit.update(
            {
                "bottom_toolbar_present": toolbar_top is not None,
                "bottom_toolbar_top": toolbar_top,
                "card_content_top": content_top if content_top is not None else vy,
                "card_content_bottom": content_bottom,
                "auto_excluded_bottom_ui": len(excluded_bottom_ui),
            }
        )
    if not main:
        return []

    rows = _cluster_rows(main)
    columns = _column_centers(rows, viewport, profile)
    lattice_rows = _row_lattice(
        rows,
        columns,
        viewport,
        profile.row_spacing_range,
    )
    cards: list[CardCandidate] = []
    for row_index, row in enumerate(lattice_rows):
        by_column = {min(range(4), key=lambda index: abs(proposal.center_x - columns[index])): proposal for proposal in row}
        # A regular three-card row can have one icon missed by Hough.  Infer the
        # empty lattice slot only after checking that its local icon region has
        # visual evidence; this is not a blind four-column completion rule.
        if len(by_column) == 3:
            missing_column = next(index for index in range(4) if index not in by_column)
            inferred = CircleProposal(int(columns[missing_column]), int(median(item.center_y for item in row)), int(median(item.radius for item in row)), "lattice_inferred")
            if _icon_evidence(image, inferred):
                by_column[missing_column] = inferred
        for column_index, proposal in sorted(by_column.items()):
            box, name_box, level_box = _boxes(proposal)
            complete = _card_complete(
                proposal,
                name_box,
                level_box,
                image,
                viewport,
                content_top=content_top,
                content_bottom=content_bottom,
            )
            # Strong lattice geometry plus icon-region evidence is sufficient for
            # a formal card. OCR remains a separate conservative recognition step.
            if complete and not _icon_evidence(image, proposal):
                continue
            cards.append(CardCandidate(
                f"card_{len(cards) + 1:03d}",
                row_index,
                column_index,
                box,
                _normalized(box, viewport),
                complete,
                0.97 if complete else 0.45,
                name_box,
                level_box,
                (proposal.center_x, proposal.center_y, proposal.radius),
            ))

    # Preserve only a partial final row: it is deliberately excluded from formal
    # inventory but remains visible for human review.  Decorative middle rings
    # cannot pass because they are not below the established lattice.
    last_lattice_y = max((median(item.center_y for item in row) for row in lattice_rows), default=vy)
    main_radius = median(item.radius for item in main)
    lattice_centres = [
        float(median(item.center_y for item in row))
        for row in lattice_rows
    ]
    lattice_gaps = [
        right - left
        for left, right in zip(lattice_centres, lattice_centres[1:])
        if right > left
    ]
    expected_gap = (
        median(lattice_gaps)
        if lattice_gaps
        else vh * median(profile.row_spacing_range)
    )
    expected_partial_y = last_lattice_y + expected_gap
    bottom = [
        item
        for item in proposals
        if item.center_y > last_lattice_y + main_radius * 1.25
        and abs(item.center_y - expected_partial_y) <= expected_gap * 0.35
    ]
    partial_slots: dict[int, CircleProposal] = {}
    for proposal in bottom:
        column = min(range(4), key=lambda index: abs(proposal.center_x - columns[index]))
        if abs(proposal.center_x - columns[column]) > vw * 0.09:
            continue
        current = partial_slots.get(column)
        if current is None or proposal.center_y > current.center_y:
            partial_slots[column] = proposal
    for column_index, proposal in sorted(partial_slots.items()):
        box, name_box, level_box = _boxes(proposal)
        complete = _card_complete(
            proposal,
            name_box,
            level_box,
            image,
            viewport,
            content_top=content_top,
            content_bottom=content_bottom,
        )
        cards.append(CardCandidate(
            f"card_{len(cards) + 1:03d}",
            len(lattice_rows),
            column_index,
            box,
            _normalized(box, viewport),
            complete,
            0.97 if complete else 0.45,
            name_box,
            level_box,
            (proposal.center_x, proposal.center_y, proposal.radius),
        ))
    return cards
