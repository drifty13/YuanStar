import type { Rect, ScreenshotProfile } from "./types.js";

/** Only a selected-tab rectangle validated in viewport coordinates can tighten the top. */
export function refineStarContentBounds(profile: ScreenshotProfile, selectedTab: Rect | null): ScreenshotProfile {
  const { viewport, contentBounds } = profile;
  if (!selectedTab || !Object.values(selectedTab).every(Number.isFinite)
    || selectedTab.width < viewport.width * .14 || selectedTab.height <= 0
    || selectedTab.x < viewport.x || selectedTab.x + selectedTab.width > viewport.x + viewport.width
    || selectedTab.y < viewport.y + viewport.height * .07
    || selectedTab.y + selectedTab.height > viewport.y + viewport.height * .24) return profile;
  const top = Math.max(contentBounds.y, selectedTab.y + selectedTab.height);
  const bottom = contentBounds.y + contentBounds.height;
  if (bottom <= top) return profile;
  return {
    ...profile, contentBounds: { ...contentBounds, y: top, height: bottom - top },
    evidence: [...profile.evidence, `content_top:selected_tab_bottom:${top}`],
  };
}
