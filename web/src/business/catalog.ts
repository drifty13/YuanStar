export type CatalogKind = "主星" | "辅星" | "经验星石";

export interface CatalogEntry {
  name: string;
  kind: CatalogKind;
  aliases: readonly string[];
  displayGroup: string | null;
  usageTags: readonly string[];
  rawEffectText: string | null;
  experiencePerItem?: number;
  description?: string | null;
}

export interface StarCatalog {
  entry(name: string): CatalogEntry | undefined;
  namesForKind(kind: CatalogKind): readonly string[];
  isNameForKind(name: string, kind: CatalogKind): boolean;
  orderIndex(name: string): number;
  normalize(value: string): string;
}

export function createStarCatalog(entries: readonly CatalogEntry[], aliases: Readonly<Record<string, string>>): StarCatalog {
  const byName = new Map<string, CatalogEntry>();
  const normalizedAliases = new Map<string, string>();
  entries.forEach((entry, index) => {
    if (byName.has(entry.name)) throw new Error(`重复的标准星石名称：${entry.name}`);
    byName.set(entry.name, entry);
    entry.aliases.forEach((alias) => normalizedAliases.set(alias, entry.name));
    normalizedAliases.set(entry.name, entry.name);
  });
  Object.entries(aliases).forEach(([alias, name]) => {
    if (!byName.has(name) && alias !== "星耀") throw new Error(`别名指向未知名称：${alias}`);
    normalizedAliases.set(alias, name);
  });

  const order = new Map<string, number>();
  entries.forEach((entry, index) => { if (entry.kind !== "经验星石") order.set(entry.name, index); });
  const fallbackOrder = order.size;
  const normalize = (value: string) => normalizedAliases.get(value.trim()) ?? value.trim();
  return {
    entry: (name) => byName.get(normalize(name)),
    namesForKind: (kind) => entries.filter((entry) => entry.kind === kind).map((entry) => entry.name),
    isNameForKind: (name, kind) => byName.get(normalize(name))?.kind === kind,
    orderIndex: (name) => order.get(normalize(name)) ?? fallbackOrder,
    normalize,
  };
}
