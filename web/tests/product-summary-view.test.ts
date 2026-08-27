import { buildInventorySummaryGroups, resolveSummaryExperienceScope, summaryGroupKey, summarySelectionStillVisible } from "../src/product-summary-view.js";

function expect(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const inventory = [
  { starInstanceId: "orange-tianfu", kind: "主星" as const, name: "天府", quality: "橙" as const, targetLevel: 60 },
  { starInstanceId: "purple-tianfu", kind: "主星" as const, name: "天府", quality: "紫" as const, targetLevel: 55 },
  { starInstanceId: "orange-wuqu", kind: "主星" as const, name: "武曲", quality: "橙" as const, targetLevel: 50 },
  { starInstanceId: "blue-pojun", kind: "主星" as const, name: "破军", quality: "蓝" as const, targetLevel: 45 },
];
const catalogOrder = (name: string): number => ["天府", "武曲", "破军"].indexOf(name);

const allGroups = buildInventorySummaryGroups(inventory, catalogOrder);
expect(allGroups.length === 3, "summary groups by kind plus canonical name");
expect(allGroups.find((group) => group.key === "主星|天府")?.count === 2, "quality does not participate in the group key");
expect(allGroups.map((group) => group.key).join(",") === "主星|天府,主星|武曲,主星|破军", "summary uses catalog name order");

const orangeOnly = inventory.filter((star) => star.quality === "橙");
const orangeGroups = buildInventorySummaryGroups(orangeOnly, catalogOrder);
expect(orangeGroups.find((group) => group.key === "主星|天府")?.count === 1, "filtering happens before grouping and updates the count");
expect(summarySelectionStillVisible(orangeGroups, summaryGroupKey({ kind: "主星", name: "天府" })), "visible selection is retained");
expect(!summarySelectionStillVisible(orangeGroups, summaryGroupKey({ kind: "辅星", name: "解神" })), "filtered-out selection is cleared");

const groupKey = summaryGroupKey({ kind: "主星", name: "天府" });
const scope = (filteredStars: typeof inventory, selectedGroupKey: string | null, hasActiveFilter: boolean) => resolveSummaryExperienceScope({ allStars: inventory, filteredStars, selectedGroupKey, hasActiveFilter });
const tianfuAndWuqu = inventory.slice(0, 3);
expect(scope(inventory, null, false).kind === "all" && scope(inventory, null, false).starIds.join(",") === "orange-tianfu,purple-tianfu,orange-wuqu,blue-pojun", "summary without filters or selection calculates all planned instances");
expect(scope(tianfuAndWuqu, null, true).kind === "filtered" && scope(tianfuAndWuqu, null, true).starIds.join(",") === "orange-tianfu,purple-tianfu,orange-wuqu", "天府、武曲筛选只计算实际筛选到的计划实例");
expect(scope(inventory, groupKey, false).kind === "summary-group" && scope(inventory, groupKey, false).starIds.join(",") === "orange-tianfu,purple-tianfu", "selected group wins even without filters");
expect(scope(inventory, groupKey, true).kind === "summary-group" && scope(inventory, groupKey, true).starIds.join(",") === "orange-tianfu,purple-tianfu", "selected group stays inside the applied name filter");
expect(scope(orangeOnly, groupKey, true).kind === "summary-group" && scope(orangeOnly, groupKey, true).starIds.join(",") === "orange-tianfu", "selected group stays inside the applied quality filter");
expect(scope(inventory.slice(2), groupKey, true).kind === "filtered" && scope(inventory.slice(2), groupKey, true).starIds.join(",") === "orange-wuqu,blue-pojun", "天府被武曲、破军筛选排除后安全回退到当前筛选");
expect(scope(inventory, groupKey, false).starIds.map((id) => inventory.find((star) => star.starInstanceId === id)?.targetLevel).join(",") === "60,55", "scope preserves selected instances and their plan target levels");
