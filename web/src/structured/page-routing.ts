import { prepareRectVariants, recognizePreparedRectVariants } from "../ocr.js";
import type { PageClassificationV1, PageType, Rect } from "./contracts.js";
import { classifyPageVisual as classifyVisual, croppedGridTopCircleCount } from "./page-routing-visual.js";
import type { ScreenshotProfile } from "./types.js";
import { applyPageOverrides, routeTabOcrCandidates } from "./page-routing-logic.js";

export { croppedGridTopCircleCount };

export interface PageRoutingEvidence {
  pageType: PageType;
  confidence: number;
  evidence: string[];
  selected: boolean;
  tabOcrCandidates: Array<{ text: string; confidence: number; variant: string }>;
  warning: string | null;
  reviewRequired: boolean;
  tabOcrMs: number;
}

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

export function toPageClassificationV1(routing: PageRoutingEvidence, confirmedPool?: { imageId: string; pageType: Exclude<PageType, "unknown"> }, expectedPageType?: PageType): PageClassificationV1 {
  const auto: PageClassificationV1 = {
    pageType: routing.pageType,
    visualEvidence: routing.evidence.map((value) => ({
      source: value.startsWith("selected_tab_visual:") ? "visual" as const : "tab_ocr" as const,
      value,
      confidence: routing.confidence,
    })),
    tabOcrEvidence: routing.tabOcrCandidates,
    confidence: routing.confidence,
    warning: routing.warning,
    reviewRequired: routing.reviewRequired,
  };
  return applyPageOverrides(auto, confirmedPool, expectedPageType);
}
