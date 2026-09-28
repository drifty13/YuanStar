import type { Rect } from "./contracts.js";
import { classifyPageVisual as classifyVisual } from "./page-routing-visual.js";
import type { PageRoutingEvidence } from "./page-routing-logic.js";

/** Visual routing shared by manual-import suggestions and the full OCR engine. */
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
