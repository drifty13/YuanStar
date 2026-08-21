import { prepareRectVariants, recognizePreparedRectVariants } from "../ocr.js";
import type { Rect } from "./contracts.js";
import { classifyPageVisual as classifyVisual, croppedGridTopCircleCount } from "./page-routing-visual.js";
import type { ScreenshotProfile } from "./types.js";
import { routeTabOcrCandidates, type PageRoutingEvidence } from "./page-routing-logic.js";

export { croppedGridTopCircleCount };
export type { PageRoutingEvidence } from "./page-routing-logic.js";
export { toPageClassificationV1 } from "./page-routing-logic.js";

function tabRect(viewport: Rect): Rect {
  return {
    x: viewport.x + Math.trunc(viewport.width * 0.05),
    y: viewport.y + Math.trunc(viewport.height * 0.07),
    width: Math.max(1, Math.trunc(viewport.width * 0.90)),
    height: Math.max(1, Math.trunc(viewport.height * 0.12)),
  };
}

export function classifyPageVisual(image: ImageData, viewport: Rect): PageRoutingEvidence {
  const visual = classifyVisual(image, viewport);
  return {
    pageType: visual.pageType,
    confidence: visual.confidence,
    evidence: visual.evidence.map((item) => item.value),
    selected: visual.pageType !== "unknown",
    tabOcrCandidates: [],
    warning: visual.warning,
    reviewRequired: visual.pageType === "unknown",
    tabOcrMs: 0,
  };
}

export async function classifyPageWithTabOcr(bitmap: ImageBitmap, profile: ScreenshotProfile, visual: PageRoutingEvidence): Promise<PageRoutingEvidence> {
  if (visual.pageType !== "unknown") return visual;
  const started = performance.now();
  try {
    const candidates = await recognizePreparedRectVariants(prepareRectVariants(bitmap, tabRect(profile.viewport)));
    const routed = routeTabOcrCandidates(candidates);
    return {
      pageType: routed.pageType,
      confidence: routed.confidence,
      evidence: routed.evidence,
      selected: routed.pageType !== "unknown",
      tabOcrCandidates: candidates,
      warning: routed.warning ?? (routed.pageType === "unknown" ? visual.warning : null),
      reviewRequired: routed.pageType === "unknown" || routed.warning != null,
      tabOcrMs: performance.now() - started,
    };
  } catch {
    return {
      ...visual,
      tabOcrCandidates: [],
      warning: "tab_ocr_unavailable",
      reviewRequired: true,
      tabOcrMs: performance.now() - started,
    };
  }
}
