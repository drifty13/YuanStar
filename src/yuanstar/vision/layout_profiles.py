from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class LayoutProfile:
    profile_id: str
    ratio_min: float
    ratio_max: float
    column_centers: tuple[float, float, float, float]
    grid_region: tuple[float, float, float, float]
    row_spacing_range: tuple[float, float]
    bottom_safe_y: float


PHONE_PORTRAIT_V1 = LayoutProfile(
    "phone_portrait_v1", 0.39, 0.50, (0.165, 0.380, 0.597, 0.812), (0.05, 0.18, 0.90, 0.94), (0.075, 0.135), 0.89
)
TABLET_PORTRAIT_V1 = LayoutProfile(
    "tablet_portrait_v1", 0.50, 0.78, (0.165, 0.380, 0.597, 0.812), (0.05, 0.18, 0.90, 0.94), (0.075, 0.145), 0.89
)
UNKNOWN_PORTRAIT_FALLBACK = LayoutProfile(
    "unknown_portrait_fallback", 0.25, 0.90, (0.165, 0.380, 0.597, 0.812), (0.05, 0.18, 0.90, 0.94), (0.070, 0.150), 0.87
)


def select_layout_profile(viewport_size: tuple[int, int]) -> LayoutProfile:
    width, height = viewport_size
    ratio = width / height if height else 0
    if PHONE_PORTRAIT_V1.ratio_min <= ratio < PHONE_PORTRAIT_V1.ratio_max:
        return PHONE_PORTRAIT_V1
    if TABLET_PORTRAIT_V1.ratio_min <= ratio < TABLET_PORTRAIT_V1.ratio_max:
        return TABLET_PORTRAIT_V1
    return UNKNOWN_PORTRAIT_FALLBACK
