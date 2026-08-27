import aliasesResource from "../../../data/ocr_aliases.json" with { type: "json" };
import catalogResource from "../../../data/star_catalog.json" with { type: "json" };
import type { Completeness, OcrCandidate } from "./types.js";
import { classifyStarResultStatus, cleanName, parseLevel, resolveCatalogName, resolveLevel } from "./star-postprocess.js";

export { cleanName, parseLevel, resolveLevel };

interface CatalogStar {
  name: string;
  kind: string;
  aliases?: string[];
}

const mainEntries = (catalogResource.stars as CatalogStar[]).filter((entry) => entry.kind === "主星");
export const MAIN_STAR_NAMES: readonly string[] = mainEntries.map((entry) => entry.name);
const mainNameSet = new Set(MAIN_STAR_NAMES);
export const MAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...Object.entries(aliasesResource).filter(([, target]) => mainNameSet.has(target)),
  ...mainEntries.flatMap((entry) => (entry.aliases ?? []).map((alias) => [alias, entry.name] as const)),
]));

export function resolveName(candidates: OcrCandidate[]): { raw: string; normalized: string | null; confidence: number; reasons: string[] } {
  return resolveCatalogName(candidates, MAIN_STAR_NAMES, MAIN_ALIASES);
}

export function classifyResultStatus(completeness: Completeness, normalizedName: string | null, level: number | null): "accepted" | "needs_review" | "excluded_partial" {
  return classifyStarResultStatus(completeness, normalizedName, level);
}
