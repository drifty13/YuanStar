import { runStructuredStar } from "./star-pipeline.js";
import { SUPPORT_ALIASES, resolveSupportName } from "./support-postprocess.js";
import type { StructuredStarOptions } from "./star-pipeline.js";

export function runStructuredSupport(file: File, options: Omit<StructuredStarOptions, "pageType" | "exactNameAliases"> = {}) {
  return runStructuredStar(file, resolveSupportName, { ...options, pageType: "support", exactNameAliases: SUPPORT_ALIASES });
}
