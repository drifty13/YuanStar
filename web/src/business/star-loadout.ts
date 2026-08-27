import type { OperatorStarLoadoutSlot, OperatorStarLoadoutSlots, StarInstanceV1, StarKind, WorkspaceStateV1 } from "./model.js";
import { operatorStarLoadoutSlots, WorkspaceDomainError } from "./model.js";

export type StarLoadoutRequirementV1 = Readonly<{ kind: StarKind; name: string }>;
export type StarLoadoutOccupancyV1 = Readonly<{ operatorId: string; slot: OperatorStarLoadoutSlot }>;
export type UnavailableStarLoadoutRequirementV1 = Readonly<{
  requirementIndex: number;
  reason: "missing" | "occupied" | "no_slot";
  occupiedByOperatorIds: readonly string[];
}>;
export type StarLoadoutPreviewV1 = Readonly<{
  operatorId: string;
  slots: OperatorStarLoadoutSlots;
  unavailable: readonly UnavailableStarLoadoutRequirementV1[];
}>;

export function emptyOperatorStarLoadoutSlots(): OperatorStarLoadoutSlots {
  return { main1: null, main2: null, main3: null, support1: null, support2: null, support3: null };
}

function slotKind(slot: OperatorStarLoadoutSlot): StarKind { return slot.startsWith("main") ? "主星" : "辅星"; }
function qualityRank(quality: StarInstanceV1["quality"]): number { return ({ "橙": 5, "紫": 4, "蓝": 3, "绿": 2, "白": 1 } as const)[quality]; }

export function findStarLoadoutOccupancy(workspace: Pick<WorkspaceStateV1, "operatorStarLoadouts">): Map<string, StarLoadoutOccupancyV1> {
  const result = new Map<string, StarLoadoutOccupancyV1>();
  Object.values(workspace.operatorStarLoadouts).forEach((loadout) => {
    operatorStarLoadoutSlots.forEach((slot) => {
      const id = loadout.slots[slot];
      if (id != null) result.set(id, { operatorId: loadout.operatorId, slot });
    });
  });
  return result;
}

/** Reject dangling, wrong-kind, or multiply-equipped instance references. */
export function validateOperatorStarLoadouts(workspace: Pick<WorkspaceStateV1, "inventory" | "operatorStarLoadouts">): void {
  if (!workspace.operatorStarLoadouts || typeof workspace.operatorStarLoadouts !== "object" || Array.isArray(workspace.operatorStarLoadouts)) {
    throw new WorkspaceDomainError("workspace_validation_error", "密探星石佩戴关系必须是对象");
  }
  const inventory = new Map(workspace.inventory.map((item) => [item.starInstanceId, item]));
  const occupied = new Map<string, StarLoadoutOccupancyV1>();
  Object.entries(workspace.operatorStarLoadouts).forEach(([key, loadout]) => {
    if (!loadout || typeof loadout !== "object" || Array.isArray(loadout) || typeof loadout.operatorId !== "string" || !loadout.operatorId.trim() || loadout.operatorId !== key) {
      throw new WorkspaceDomainError("workspace_validation_error", "密探星石佩戴关系的 operatorId 无效");
    }
    if (!loadout.slots || typeof loadout.slots !== "object" || Array.isArray(loadout.slots)) throw new WorkspaceDomainError("workspace_validation_error", "密探星石槽位无效");
    const keys = Object.keys(loadout.slots);
    if (keys.length !== operatorStarLoadoutSlots.length || keys.some((slot) => !operatorStarLoadoutSlots.includes(slot as OperatorStarLoadoutSlot))) {
      throw new WorkspaceDomainError("workspace_validation_error", "密探星石槽位必须完整且不能含未知槽位");
    }
    operatorStarLoadoutSlots.forEach((slot) => {
      const id = loadout.slots[slot];
      if (id !== null && (typeof id !== "string" || !id.trim())) throw new WorkspaceDomainError("workspace_validation_error", "密探星石实例 ID 必须为非空字符串或 null");
      if (id == null) return;
      const instance = inventory.get(id);
      if (!instance) throw new WorkspaceDomainError("workspace_validation_error", "密探槽位引用了不存在的星石实例");
      if (instance.kind !== slotKind(slot)) throw new WorkspaceDomainError("workspace_validation_error", "密探槽位与星石大类不匹配");
      const previous = occupied.get(id);
      if (previous) throw new WorkspaceDomainError("workspace_validation_error", "同一星石实例不能同时被多个密探槽位佩戴");
      occupied.set(id, { operatorId: loadout.operatorId, slot });
    });
  });
}

/**
 * OCR reconciliation may retire an ID. Clear only that stale reference; it
 * never guesses a replacement, so a user must confirm any reassignment.
 */
export function removeMissingStarLoadoutReferences(workspace: WorkspaceStateV1): void {
  const ids = new Set(workspace.inventory.map((item) => item.starInstanceId));
  Object.values(workspace.operatorStarLoadouts).forEach((loadout) => {
    operatorStarLoadoutSlots.forEach((slot) => {
      const id = loadout.slots[slot];
      if (id != null && !ids.has(id)) loadout.slots[slot] = null;
    });
  });
}

/** Build a suggestion only. Callers must explicitly save it as a loadout. */
export function previewStarLoadout(workspace: WorkspaceStateV1, operatorId: string, requirements: readonly StarLoadoutRequirementV1[]): StarLoadoutPreviewV1 {
  if (!operatorId.trim()) throw new WorkspaceDomainError("workspace_validation_error", "operatorId 不能为空");
  const slots = emptyOperatorStarLoadoutSlots();
  const occupied = findStarLoadoutOccupancy(workspace);
  const targetLoadout = workspace.operatorStarLoadouts[operatorId];
  const used = new Set<string>();
  const consumedRequirements = new Set<number>();
  const unavailable: UnavailableStarLoadoutRequirementV1[] = [];
  const inventory = new Map(workspace.inventory.map((item) => [item.starInstanceId, item]));
  requirements.forEach((requirement) => {
    if ((requirement.kind !== "主星" && requirement.kind !== "辅星") || !requirement.name.trim()) throw new WorkspaceDomainError("workspace_validation_error", "套组要求必须提供有效星石名称与大类");
  });

  // Preserve a current matching instance in its existing slot before filling
  // anything else. This keeps a preview from needlessly repacking equipment.
  if (targetLoadout) operatorStarLoadoutSlots.forEach((slot) => {
    const id = targetLoadout.slots[slot];
    const instance = id == null ? undefined : inventory.get(id);
    if (!instance || used.has(instance.starInstanceId)) return;
    const requirementIndex = requirements.findIndex((requirement, index) => !consumedRequirements.has(index) && requirement.kind === instance.kind && requirement.name === instance.name);
    if (requirementIndex < 0) return;
    slots[slot] = instance.starInstanceId;
    used.add(instance.starInstanceId);
    consumedRequirements.add(requirementIndex);
  });

  requirements.forEach((requirement, requirementIndex) => {
    if (consumedRequirements.has(requirementIndex)) return;
    const targetSlot = operatorStarLoadoutSlots.find((slot) => slotKind(slot) === requirement.kind && slots[slot] === null);
    if (!targetSlot) { unavailable.push({ requirementIndex, reason: "no_slot", occupiedByOperatorIds: [] }); return; }
    const matches = workspace.inventory.filter((item) => item.kind === requirement.kind && item.name === requirement.name && !used.has(item.starInstanceId));
    const candidates = matches.filter((item) => occupied.get(item.starInstanceId)?.operatorId !== undefined && occupied.get(item.starInstanceId)?.operatorId !== operatorId ? false : true)
      .sort((left, right) => right.level - left.level || qualityRank(right.quality) - qualityRank(left.quality) || left.starInstanceId.localeCompare(right.starInstanceId));
    const selected = candidates[0];
    if (selected) { slots[targetSlot] = selected.starInstanceId; used.add(selected.starInstanceId); return; }
    const occupiers = [...new Set(matches.map((item) => occupied.get(item.starInstanceId)).filter((item): item is StarLoadoutOccupancyV1 => Boolean(item && item.operatorId !== operatorId)).map((item) => item.operatorId))].sort();
    unavailable.push({ requirementIndex, reason: occupiers.length ? "occupied" : "missing", occupiedByOperatorIds: occupiers });
  });
  return { operatorId, slots, unavailable };
}
