import { runStructuredStar } from "./star-pipeline.js";
import { resolveSupportName } from "./support-postprocess.js";
import type { StructuredStarOptions } from "./star-pipeline.js";

export function runStructuredSupport(file: File, options: Omit<StructuredStarOptions, "pageType"> = {}) {
  return runStructuredStar(file, resolveSupportName, { ...options, pageType: "support" });
}
