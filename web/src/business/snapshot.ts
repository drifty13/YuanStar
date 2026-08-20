import type { StarCatalog } from "./catalog.js";
import { assertJsonSafe, type ImagePool, type JsonValue, type StarInstanceV1, type WorkspaceStateV1, WorkspaceDomainError } from "./model.js";

function clone<T>(value: T): T {
  assertJsonSafe(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNullableNonNegativeInteger(value: unknown, label: string): asserts value is number | null {
  if (value !== null && (!Number.isInteger(value) || (value as number) < 0)) throw new WorkspaceDomainError("workspace_validation_error", `${label} 必须为 null 或非负整数`);
}

function assertNullablePositiveInteger(value: unknown, label: string): asserts value is number | null {
  if (value !== null && (!Number.isInteger(value) || (value as number) < 1)) throw new WorkspaceDomainError("workspace_validation_error", `${label} 必须为 null 或正整数`);
}

function sortedInventory(inventory: StarInstanceV1[], catalog: StarCatalog): StarInstanceV1[] {
  const kindOrder: Record<StarInstanceV1["kind"], number> = { "主星": 0, "辅星": 1 };
  const qualityOrder: Record<StarInstanceV1["quality"], number> = { "橙": 0, "紫": 1, "蓝": 2, "绿": 3, "白": 4 };
  return [...inventory].sort((left, right) => (
    kindOrder[left.kind] - kindOrder[right.kind]
    || catalog.orderIndex(left.name) - catalog.orderIndex(right.name)
    || right.level - left.level
    || qualityOrder[left.quality] - qualityOrder[right.quality]
    || left.provenance.sourceOrder - right.provenance.sourceOrder
    || (left.provenance.row ?? -1) - (right.provenance.row ?? -1)
    || (left.provenance.column ?? -1) - (right.provenance.column ?? -1)
    || left.starInstanceId.localeCompare(right.starInstanceId)
  ));
}

export function normalizeWorkspaceState(snapshot: WorkspaceStateV1, catalog: StarCatalog): WorkspaceStateV1 {
  const normalized = clone(snapshot) as WorkspaceStateV1;
  if (!normalized.importReview.occurrences) normalized.importReview.occurrences = {};
  for (const occurrence of Object.values(normalized.importReview.occurrences)) {
    if (typeof occurrence.removedFromCurrentInventory === "undefined") occurrence.removedFromCurrentInventory = false;
    if (typeof occurrence.removedFromCurrentInventory !== "boolean") throw new WorkspaceDomainError("workspace_validation_error", "当前背包删除标记必须为布尔值");
    if (typeof occurrence.reviewResolution !== "undefined" && occurrence.reviewResolution !== "accepted" && occurrence.reviewResolution !== "ignored") throw new WorkspaceDomainError("workspace_validation_error", "复核完成状态无效");
  }
  assertJsonSafe(normalized as unknown);
  if (normalized.schemaVersion !== 1) throw new WorkspaceDomainError("workspace_schema_version_unsupported", "仅支持 Workspace schemaVersion 1");
  if (!normalized.accountId.trim()) throw new WorkspaceDomainError("workspace_validation_error", "accountId 不能为空");
  if (!Number.isInteger(normalized.revision) || normalized.revision < 0) throw new WorkspaceDomainError("workspace_validation_error", "revision 必须为非负整数");
  if (normalized.gameVersion !== "如鸢" && normalized.gameVersion !== "代号鸢") throw new WorkspaceDomainError("workspace_validation_error", "游戏版本无效");
  assertNullableNonNegativeInteger(normalized.bag.currentCount, "背包当前数量");
  assertNullablePositiveInteger(normalized.bag.capacity, "背包容量");
  if (normalized.bag.currentCount != null && normalized.bag.capacity != null && normalized.bag.currentCount > normalized.bag.capacity) {
    throw new WorkspaceDomainError("workspace_validation_error", "背包当前数量不能大于容量");
  }
  ([normalized.experience.orange, normalized.experience.purple, normalized.experience.white]).forEach((value) => assertNullableNonNegativeInteger(value, "经验星曜数量"));
  if (!Number.isInteger(normalized.postprocessRevision) || normalized.postprocessRevision < 0) throw new WorkspaceDomainError("workspace_validation_error", "postprocessRevision 必须为非负整数");

  const seenIds = new Set<string>();
  normalized.inventory.forEach((instance) => {
    if (seenIds.has(instance.starInstanceId)) throw new WorkspaceDomainError("workspace_validation_error", "starInstanceId 不能重复");
    seenIds.add(instance.starInstanceId);
    const entry = catalog.entry(instance.name);
    if (!entry || entry.kind !== instance.kind || entry.name !== instance.name) throw new WorkspaceDomainError("workspace_validation_error", "正式背包必须使用 catalog canonical 星石名称与大类");
    if (!Number.isInteger(instance.level) || instance.level < 1 || instance.level > 60) throw new WorkspaceDomainError("workspace_validation_error", "等级必须是 1–60 的整数");
    if (!["橙", "紫", "蓝", "绿", "白"].includes(instance.quality)) throw new WorkspaceDomainError("workspace_validation_error", "品质无效");
    if (!["not_evaluated", "equipped", "unequipped", "unknown"].includes(instance.equippedState)) throw new WorkspaceDomainError("workspace_validation_error", "佩戴状态无效");
    if (!Number.isInteger(instance.provenance.sourceOrder) || instance.provenance.sourceOrder < 0) throw new WorkspaceDomainError("workspace_validation_error", "来源顺序无效");
  });

  const inventoryById = new Map(normalized.inventory.map((instance) => [instance.starInstanceId, instance]));
  const planTargets: Record<string, number> = {};
  Object.entries(normalized.planTargets).forEach(([id, target]) => {
    if (!Number.isInteger(target) || target < 1 || target > 60) throw new WorkspaceDomainError("workspace_validation_error", "计划等级必须是 1–60 的整数");
    const current = inventoryById.get(id);
    if (current) planTargets[id] = Math.max(target, current.level);
  });
  const validPools = new Set<ImagePool>(["main", "support", "experience", "unknown"]);
  Object.values(normalized.importReview.imagePools).forEach((pool) => {
    if (!validPools.has(pool)) throw new WorkspaceDomainError("workspace_validation_error", "图片池无效");
  });
  return { ...normalized, inventory: sortedInventory(normalized.inventory, catalog), planTargets };
}

export function createWorkspaceSnapshot(workspace: WorkspaceStateV1, catalog: StarCatalog): WorkspaceStateV1 {
  return normalizeWorkspaceState(clone(workspace), catalog);
}

export function restoreWorkspaceSnapshot(snapshot: unknown, catalog: StarCatalog): WorkspaceStateV1 {
  try {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new WorkspaceDomainError("workspace_validation_error", "workspace snapshot 必须是对象");
    return normalizeWorkspaceState(clone(snapshot as WorkspaceStateV1), catalog);
  } catch (error) {
    if (error instanceof WorkspaceDomainError) throw error;
    throw new WorkspaceDomainError("workspace_validation_error", "workspace snapshot 结构不完整或字段类型无效");
  }
}

export function asJsonExample(workspace: WorkspaceStateV1): JsonValue {
  return clone(workspace) as unknown as JsonValue;
}
