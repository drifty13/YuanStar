import { MAIN_ALIASES, resolveName } from "./main-postprocess.js";
import { runStructuredStar, type StructuredStarOptions } from "./star-pipeline.js";

export function runStructuredMain(file: File, options: Omit<StructuredStarOptions, "pageType" | "exactNameAliases"> = {}) {
  return runStructuredStar(file, resolveName, { ...options, pageType: "main", exactNameAliases: MAIN_ALIASES });
}
