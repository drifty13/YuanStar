import type { StarCatalog } from "./catalog.js";

export type GameVersion = "如鸢" | "代号鸢";
export type StarKind = "主星" | "辅星";
export type Quality = "橙" | "紫" | "蓝" | "绿" | "白";
export type EquippedState = "not_evaluated" | "equipped" | "unequipped" | "unknown";
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type ImagePool = "main" | "support" | "experience" | "unknown";

export interface StarSourceProvenanceV1 {
  sourceOrder: number;
  sourceImageId?: string | null;
  occurrenceId?: string | null;
  row?: number | null;
  column?: number | null;
  audit?: JsonValue;
}

export interface StarInstanceV1 {
  starInstanceId: string;
  kind: StarKind;
  name: string;
  level: number;
  quality: Quality;
  equippedState: EquippedState;
  provenance: StarSourceProvenanceV1;
  manualStatus: string;
}

/** YuanStar uses main/support terminology throughout its local workspace. */
export const operatorStarLoadoutSlots = ["main1", "main2", "main3", "support1", "support2", "support3"] as const;
export type OperatorStarLoadoutSlot = typeof operatorStarLoadoutSlots[number];
export type OperatorStarLoadoutSlots = Record<OperatorStarLoadoutSlot, string | null>;

/**
 * A local, account-scoped relationship. Inventory instances never carry an
 * operator id; the relationship is kept here so the two facts cannot drift.
 */
export interface OperatorStarLoadoutV1 {
  operatorId: string;
  slots: OperatorStarLoadoutSlots;
}

/** Lightweight, JSON-safe evidence retained for a later postprocess rebuild without OCR. */
export interface EditableOccurrenceStateV1 {
  occurrenceId: string;
  sourceImageId: string;
  sourceOrder: number;
  row: number;
  column: number;
  completeness: "complete" | "partial_top" | "partial_bottom" | "invalid";
  kind: StarKind | null;
  name: string | null;
  level: number | null;
  quality: Quality | null;
  nameConfidence: number;
  levelConfidence: number;
  qualityConfidence: number;
  reviewRequired: boolean;
  inventoryAction: "keep" | "exclude_fragment" | "exclude_false_box" | "exclude_unresolved";
  /** Business-inventory state only; it never invalidates OCR/overlap evidence. */
  removedFromCurrentInventory: boolean;
  manualOverride: boolean;
  /** Absent means the occurrence still needs its explicit review decision. */
  reviewResolution?: "accepted" | "ignored";
  equippedState: EquippedState;
}

export interface WorkspaceStateV1 {
  schemaVersion: 1;
  accountId: string;
  revision: number;
  gameVersion: GameVersion;
  bag: { currentCount: number | null; capacity: number | null; resolution: JsonValue; manualFields: string[] };
  inventory: StarInstanceV1[];
  operatorStarLoadouts: Record<string, OperatorStarLoadoutV1>;
  planTargets: Record<string, number>;
  experience: { orange: number | null; purple: number | null; white: number | null; evidence: JsonValue; manualFields: string[] };
  importReview: {
    imagePools: Record<string, ImagePool>;
    confirmedImagePools: string[];
    overlapPairs: { main: [string, string][]; support: [string, string][] };
    overlapAudit: JsonValue[];
    imageAudit: Record<string, JsonValue>;
    occurrences: Record<string, EditableOccurrenceStateV1>;
  };
  postprocessRevision: number;
}

export class WorkspaceDomainError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "WorkspaceDomainError"; }
}

const qualities = new Set<Quality>(["橙", "紫", "蓝", "绿", "白"]);
const equippedStates = new Set<EquippedState>(["not_evaluated", "equipped", "unequipped", "unknown"]);

export function assertJsonSafe(value: unknown, path = "value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new WorkspaceDomainError("workspace_not_json_safe", `${path} 必须是有限数字`);
  }
  if (Array.isArray(value)) { value.forEach((item, index) => assertJsonSafe(item, `${path}[${index}]`)); return; }
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new WorkspaceDomainError("workspace_not_json_safe", `${path} 必须是普通 JSON 对象`);
    Object.entries(value as Record<string, unknown>).forEach(([key, item]) => assertJsonSafe(item, `${path}.${key}`));
    return;
  }
  throw new WorkspaceDomainError("workspace_not_json_safe", `${path} 不是 JSON-safe`);
}

function assertInteger(value: unknown, label: string, minimum: number, maximum?: number): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (maximum != null && (value as number) > maximum)) {
    throw new WorkspaceDomainError("workspace_validation_error", `${label} 必须是 ${maximum == null ? `不小于 ${minimum}` : `${minimum}–${maximum}`} 的整数`);
  }
}

export function validateStarInstance(instance: StarInstanceV1, catalog: StarCatalog): void {
  if (!instance.starInstanceId.trim()) throw new WorkspaceDomainError("workspace_validation_error", "starInstanceId 不能为空");
  if (instance.kind !== "主星" && instance.kind !== "辅星") throw new WorkspaceDomainError("workspace_validation_error", "星石大类无效");
  const entry = catalog.entry(instance.name);
  if (!entry || entry.kind !== instance.kind || entry.name !== instance.name) throw new WorkspaceDomainError("workspace_validation_error", "正式背包必须使用 catalog canonical 星石名称与大类");
  assertInteger(instance.level, "等级", 1, 60);
  if (!qualities.has(instance.quality)) throw new WorkspaceDomainError("workspace_validation_error", "品质无效");
  if (!equippedStates.has(instance.equippedState)) throw new WorkspaceDomainError("workspace_validation_error", "佩戴状态无效");
  assertInteger(instance.provenance.sourceOrder, "来源顺序", 0);
  assertJsonSafe(instance.provenance.audit ?? null, "provenance.audit");
}

export function createEmptyWorkspace(accountId: string, gameVersion: GameVersion = "如鸢"): WorkspaceStateV1 {
  if (!accountId.trim()) throw new WorkspaceDomainError("workspace_validation_error", "accountId 不能为空");
  return {
    schemaVersion: 1, accountId, revision: 0, gameVersion,
    bag: { currentCount: null, capacity: null, resolution: {}, manualFields: [] }, inventory: [], operatorStarLoadouts: {}, planTargets: {},
    experience: { orange: null, purple: null, white: null, evidence: {}, manualFields: [] },
    importReview: { imagePools: {}, confirmedImagePools: [], overlapPairs: { main: [], support: [] }, overlapAudit: [], imageAudit: {}, occurrences: {} },
    postprocessRevision: 0,
  };
}
