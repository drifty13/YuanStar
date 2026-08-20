import aliasesJson from "../../../data/ocr_aliases.json" with { type: "json" };
import catalogJson from "../../../data/star_catalog.json" with { type: "json" };
import { browserCatalogDescriptions } from "./browser-catalog-descriptions.js";
import { createStarCatalog, type CatalogEntry, type CatalogKind } from "./catalog.js";

const entries: CatalogEntry[] = catalogJson.stars.map((item) => ({
  name: item.name,
  kind: item.kind as CatalogKind,
  aliases: item.aliases ?? [],
  displayGroup: item.display_group ?? null,
  usageTags: item.usage_tags ?? [],
  rawEffectText: item.raw_effect_text ?? null,
  experiencePerItem: item.experience_per_item,
  description: browserCatalogDescriptions[item.name] ?? (item.aliases ?? []).map((alias) => browserCatalogDescriptions[alias]).find(Boolean) ?? null,
}));

export const browserCatalog = createStarCatalog(entries, aliasesJson);
