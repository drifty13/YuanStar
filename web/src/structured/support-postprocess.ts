import aliasesResource from "../../../data/ocr_aliases.json" with { type: "json" };
import catalogResource from "../../../data/star_catalog.json" with { type: "json" };
import type { OcrCandidate } from "./types.js";
import { resolveCatalogName } from "./star-postprocess.js";

interface CatalogStar {
  name: string;
  kind: string;
  aliases?: string[];
}

const supportEntries = (catalogResource.stars as CatalogStar[]).filter((entry) => entry.kind === "辅星");
export const SUPPORT_STAR_NAMES: readonly string[] = supportEntries.map((entry) => entry.name);
const supportNameSet = new Set(SUPPORT_STAR_NAMES);
export const SUPPORT_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries([
  ...Object.entries(aliasesResource).filter(([, target]) => supportNameSet.has(target)),
  ...supportEntries.flatMap((entry) => (entry.aliases ?? []).map((alias) => [alias, entry.name] as const)),
]));

export function resolveSupportName(candidates: OcrCandidate[]) {
  return resolveCatalogName(candidates, SUPPORT_STAR_NAMES, SUPPORT_ALIASES);
}
