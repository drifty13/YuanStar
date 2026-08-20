import type { Completeness, OcrCandidate } from "./types.js";
import { classifyStarResultStatus, cleanName, parseLevel, resolveCatalogName, resolveLevel } from "./star-postprocess.js";

export { cleanName, parseLevel, resolveLevel };

export const MAIN_STAR_NAMES = ["天府", "武曲", "天相", "太阳", "巨门", "七杀", "破军", "贪狼", "紫微", "天同", "太阴", "天机", "天梁", "廉贞"] as const;
const ALIASES: Record<string, string> = { 紫薇: "紫微" };

export function resolveName(candidates: OcrCandidate[]): { raw: string; normalized: string | null; confidence: number; reasons: string[] } {
  return resolveCatalogName(candidates, MAIN_STAR_NAMES, ALIASES);
}

export function classifyResultStatus(completeness: Completeness, normalizedName: string | null, level: number | null): "accepted" | "needs_review" | "excluded_partial" {
  return classifyStarResultStatus(completeness, normalizedName, level);
}
