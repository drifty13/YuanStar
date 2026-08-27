export type SummaryStar = {
  kind: "主星" | "辅星";
  name: string;
  quality: "橙" | "紫" | "蓝" | "绿" | "白";
};

export type InventorySummaryGroup = {
  key: string;
  kind: SummaryStar["kind"];
  name: string;
  count: number;
};

export type SummaryExperienceStar = SummaryStar & {
  starInstanceId: string;
};

export type SummaryExperienceScope =
  | { kind: "summary-group"; groupKey: string; starIds: string[] }
  | { kind: "filtered"; starIds: string[] }
  | { kind: "all"; starIds: string[] };

export function summaryGroupKey(star: Pick<SummaryStar, "kind" | "name">): string {
  return `${star.kind}|${star.name}`;
}

/** Input must already have the review filters applied; quality deliberately is not part of the key. */
export function buildInventorySummaryGroups(stars: readonly SummaryStar[], catalogOrder: (name: string) => number): InventorySummaryGroup[] {
  const groups = new Map<string, InventorySummaryGroup>();
  for (const star of stars) {
    const key = summaryGroupKey(star);
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { key, kind: star.kind, name: star.name, count: 1 });
  }
  return [...groups.values()].sort((left, right) => (
    (left.kind === right.kind ? 0 : left.kind === "主星" ? -1 : 1)
    || catalogOrder(left.name) - catalogOrder(right.name)
    || left.name.localeCompare(right.name)
  ));
}

export function summarySelectionStillVisible(groups: readonly InventorySummaryGroup[], selectedGroupKey: string | null): boolean {
  return selectedGroupKey != null && groups.some((group) => group.key === selectedGroupKey);
}

/**
 * Summary experience always prefers its visible selection, then the applied
 * filter result, then the complete plan. The caller owns clearing stale UI
 * selection; the fallback keeps calculation safe while that refresh happens.
 */
export function resolveSummaryExperienceScope(input: Readonly<{
  allStars: readonly SummaryExperienceStar[];
  filteredStars: readonly SummaryExperienceStar[];
  selectedGroupKey: string | null;
  hasActiveFilter: boolean;
}>): SummaryExperienceScope {
  if (input.selectedGroupKey != null) {
    const selected = input.filteredStars.filter((star) => summaryGroupKey(star) === input.selectedGroupKey);
    if (selected.length > 0) return { kind: "summary-group", groupKey: input.selectedGroupKey, starIds: selected.map((star) => star.starInstanceId) };
  }
  if (input.hasActiveFilter) return { kind: "filtered", starIds: input.filteredStars.map((star) => star.starInstanceId) };
  return { kind: "all", starIds: input.allStars.map((star) => star.starInstanceId) };
}
