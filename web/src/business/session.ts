import type { StarCatalog } from "./catalog.js";
import { WorkspaceHistory } from "./history.js";
import type { EditableOccurrenceStateV1, ImagePool, Quality, GameVersion, StarInstanceV1, WorkspaceStateV1 } from "./model.js";
import { WorkspaceDomainError } from "./model.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "./snapshot.js";
import { invalidateConfirmedDuplicateRowsForOccurrence, recalculateWorkspacePostprocess, setRowOverlapResolution, type RowOverlapResolutionV1 } from "./postprocess.js";

export type StarInstanceIdFactory = () => string;
export type NewStarInstance = Omit<StarInstanceV1, "starInstanceId">;

export class WorkspaceSession {
  private current: WorkspaceStateV1;
  readonly history: WorkspaceHistory;

  constructor(workspace: WorkspaceStateV1, private readonly catalog: StarCatalog, private readonly createId: StarInstanceIdFactory) {
    this.current = restoreWorkspaceSnapshot(workspace, catalog);
    this.history = new WorkspaceHistory(catalog);
  }
  get state(): WorkspaceStateV1 { return createWorkspaceSnapshot(this.current, this.catalog); }
  private apply(next: WorkspaceStateV1): void {
    const validated = restoreWorkspaceSnapshot(next, this.catalog);
    this.history.record(this.current);
    this.current = validated;
  }
  private applyPostprocess(mutator: (next: WorkspaceStateV1) => void): void {
    const next = this.state;
    mutator(next);
    this.apply(recalculateWorkspacePostprocess(next, this.catalog, this.createId));
  }

  addInstance(input: NewStarInstance): string {
    const starInstanceId = this.createId();
    if (!starInstanceId || this.current.inventory.some((item) => item.starInstanceId === starInstanceId)) throw new WorkspaceDomainError("star_instance_id_invalid", "starInstanceId 必须在 workspace 内唯一");
    const next = { ...this.current, inventory: [...this.current.inventory, { ...input, starInstanceId }], postprocessRevision: this.current.postprocessRevision + 1 };
    this.apply(next); return starInstanceId;
  }
  updateInstance(starInstanceId: string, update: Partial<Omit<StarInstanceV1, "starInstanceId">>): void {
    const existing = this.current.inventory.find((item) => item.starInstanceId === starInstanceId);
    if (!existing) throw new WorkspaceDomainError("star_instance_missing", "未找到星石实例");
    if (existing.provenance.occurrenceId) {
      const forbidden = Object.keys(update).filter((key) => !["kind", "name", "level", "quality"].includes(key));
      if (forbidden.length) throw new WorkspaceDomainError("workspace_validation_error", "OCR-backed 实例只能修改大类、名称、等级或品质");
      if ("kind" in update && (!("name" in update) || !update.name)) throw new WorkspaceDomainError("workspace_validation_error", "OCR-backed 修改大类时必须同时提供有效名称");
      this.editOccurrence(existing.provenance.occurrenceId, update);
      return;
    }
    const next = { ...this.current, inventory: this.current.inventory.map((item) => item.starInstanceId === starInstanceId ? { ...item, ...update, starInstanceId } : item), postprocessRevision: this.current.postprocessRevision + 1 };
    this.apply(next);
  }
  deleteInstance(starInstanceId: string): void {
    const instance = this.current.inventory.find((item) => item.starInstanceId === starInstanceId);
    if (!instance) throw new WorkspaceDomainError("star_instance_missing", "未找到星石实例");
    if (instance.provenance.occurrenceId) {
      const audit = instance.provenance.audit;
      const sourceIds = audit && typeof audit === "object" && !Array.isArray(audit) && Array.isArray((audit as Record<string, unknown>).sourceOccurrenceIds)
        ? (audit as Record<string, unknown>).sourceOccurrenceIds as unknown[] : [instance.provenance.occurrenceId];
      const ids = sourceIds.filter((value): value is string => typeof value === "string");
      this.applyPostprocess((next) => { for (const occurrenceId of ids) { const occurrence = next.importReview.occurrences[occurrenceId]; if (occurrence) next.importReview.occurrences[occurrenceId] = { ...occurrence, removedFromCurrentInventory: true }; } });
      return;
    }
    const { [starInstanceId]: _removed, ...planTargets } = this.current.planTargets;
    this.apply({ ...this.current, inventory: this.current.inventory.filter((item) => item.starInstanceId !== starInstanceId), planTargets, postprocessRevision: this.current.postprocessRevision + 1 });
  }
  setPlanTarget(starInstanceId: string, target: number): void {
    const instance = this.current.inventory.find((item) => item.starInstanceId === starInstanceId);
    if (!instance) throw new WorkspaceDomainError("star_instance_missing", "未找到星石实例");
    if (!Number.isInteger(target) || target < instance.level || target > 60) throw new WorkspaceDomainError("workspace_validation_error", "计划等级必须是当前等级至 60 的整数");
    const planTargets = { ...this.current.planTargets };
    if (target === instance.level) delete planTargets[starInstanceId]; else planTargets[starInstanceId] = target;
    this.apply({ ...this.current, planTargets });
  }
  /** A bulk UI action is deliberately one undo/redo history entry. */
  resetAllPlanTargets(): void {
    this.apply({ ...this.current, planTargets: {} });
  }
  setBagValues(currentCount: number | null, capacity: number | null): void {
    this.apply({ ...this.current, bag: { ...this.current.bag, currentCount, capacity, manualFields: ["currentCount", "capacity"] } });
  }
  setExperienceQuantity(color: "orange" | "purple" | "white", quantity: number | null): void {
    this.apply({ ...this.current, experience: { ...this.current.experience, [color]: quantity, manualFields: [...new Set([...this.current.experience.manualFields, color])] } });
  }
  setExperienceQuantities(values: { orange: number | null; purple: number | null; white: number | null }): void {
    this.apply({ ...this.current, experience: { ...this.current.experience, ...values, manualFields: [...new Set([...this.current.experience.manualFields, "orange", "purple", "white"])] } });
  }
  editOccurrence(occurrenceId: string, update: Partial<Pick<EditableOccurrenceStateV1, "kind" | "name" | "level" | "quality">>): boolean {
    const existing = this.current.importReview.occurrences[occurrenceId];
    if (!existing) throw new WorkspaceDomainError("occurrence_missing", "未找到 editable occurrence");
    const kindWasEdited = "kind" in update;
    if (kindWasEdited && (!("name" in update) || update.name == null || update.name.trim() === "")) throw new WorkspaceDomainError("workspace_validation_error", "修改大类时必须同时提供有效名称");
    const requestedKind = kindWasEdited ? update.kind ?? null : existing.kind;
    if (kindWasEdited && requestedKind !== "主星" && requestedKind !== "辅星") throw new WorkspaceDomainError("workspace_validation_error", "星石大类无效");
    const name = "name" in update ? update.name ?? null : existing.name;
    const canonical = name == null ? null : this.catalog.normalize(name);
    const entry = canonical == null ? null : this.catalog.entry(canonical);
    let kind = requestedKind;
    if (canonical != null) {
      if (!entry || entry.kind === "经验星石") throw new WorkspaceDomainError("workspace_validation_error", "名称必须是普通星石 canonical 名称");
      if (kind !== "主星" && kind !== "辅星") kind = entry.kind;
      if (entry.kind !== kind) throw new WorkspaceDomainError("workspace_validation_error", "名称与大类不匹配");
    }
    const level = "level" in update ? update.level ?? null : existing.level;
    if (level != null && (!Number.isInteger(level) || level < 1 || level > 60)) throw new WorkspaceDomainError("workspace_validation_error", "等级必须是 1–60 的整数或 null");
    const quality = "quality" in update ? update.quality ?? null : existing.quality;
    if (quality != null && !(["橙", "紫", "蓝", "绿", "白"] as Quality[]).includes(quality)) throw new WorkspaceDomainError("workspace_validation_error", "品质无效");
    const overlapIdentityChanged = kind !== existing.kind || canonical !== existing.name || level !== existing.level;
    let invalidatedDuplicate = false;
    this.applyPostprocess((next) => {
      next.importReview.occurrences[occurrenceId] = { ...existing, name: canonical, kind, level, quality, completeness: "complete", manualOverride: true, inventoryAction: "keep" };
      if (overlapIdentityChanged) invalidatedDuplicate = invalidateConfirmedDuplicateRowsForOccurrence(next, occurrenceId);
    });
    return invalidatedDuplicate;
  }
  setOccurrenceInventoryAction(occurrenceId: string, inventoryAction: EditableOccurrenceStateV1["inventoryAction"]): void {
    const existing = this.current.importReview.occurrences[occurrenceId];
    if (!existing) throw new WorkspaceDomainError("occurrence_missing", "未找到 editable occurrence");
    if (!["keep", "exclude_fragment", "exclude_false_box"].includes(inventoryAction)) throw new WorkspaceDomainError("workspace_validation_error", "inventory action 无效");
    this.applyPostprocess((next) => { next.importReview.occurrences[occurrenceId] = { ...existing, inventoryAction }; });
  }
  resolveOccurrenceReview(occurrenceId: string, resolution: "accepted" | "ignored"): boolean {
    const existing = this.current.importReview.occurrences[occurrenceId];
    if (!existing) throw new WorkspaceDomainError("occurrence_missing", "未找到 editable occurrence");
    let invalidatedDuplicate = false;
    this.applyPostprocess((next) => {
      const current = next.importReview.occurrences[occurrenceId]!;
      next.importReview.occurrences[occurrenceId] = {
        ...current,
        reviewResolution: resolution,
        inventoryAction: resolution === "ignored" ? "exclude_false_box" : "keep",
        removedFromCurrentInventory: false,
      };
      if (resolution === "ignored") invalidatedDuplicate = invalidateConfirmedDuplicateRowsForOccurrence(next, occurrenceId);
    });
    return invalidatedDuplicate;
  }
  setImagePool(imageId: string, pool: Exclude<ImagePool, "unknown">): void {
    if (!["main", "support", "experience"].includes(pool)) throw new WorkspaceDomainError("workspace_validation_error", "图片池无效");
    const existing = this.current.importReview.imagePools[imageId] ?? "unknown";
    this.applyPostprocess((next) => {
      next.importReview.imagePools[imageId] = pool;
      next.importReview.confirmedImagePools = [...new Set([...next.importReview.confirmedImagePools, imageId])].sort();
      const audit = next.importReview.imageAudit[imageId];
      next.importReview.imageAudit[imageId] = audit && typeof audit === "object" && !Array.isArray(audit) ? { ...(audit as Record<string, unknown>), confirmedPool: pool } : { suggestedPageType: existing, confirmedPool: pool };
      if (existing !== pool) for (const kind of ["main", "support"] as const) next.importReview.overlapPairs[kind] = next.importReview.overlapPairs[kind].filter(([before, after]) => before !== imageId && after !== imageId);
    });
  }
  addOverlapPair(pool: "main" | "support", beforeImageId: string, afterImageId: string): void {
    if (beforeImageId === afterImageId) throw new WorkspaceDomainError("workspace_validation_error", "overlap pair 必须是两张不同图片");
    const confirmed = new Set(this.current.importReview.confirmedImagePools);
    if (!confirmed.has(beforeImageId) || !confirmed.has(afterImageId) || this.current.importReview.imagePools[beforeImageId] !== pool || this.current.importReview.imagePools[afterImageId] !== pool) throw new WorkspaceDomainError("workspace_validation_error", "pair 必须是同一已确认 main/support 图片池");
    if (this.current.importReview.overlapPairs[pool].some(([before, after]) => before === beforeImageId && after === afterImageId)) throw new WorkspaceDomainError("workspace_validation_error", "overlap pair 已存在");
    this.applyPostprocess((next) => { next.importReview.overlapPairs[pool] = [...next.importReview.overlapPairs[pool], [beforeImageId, afterImageId]]; });
  }
  removeOverlapPair(pool: "main" | "support", beforeImageId: string, afterImageId: string): void {
    if (!this.current.importReview.overlapPairs[pool].some(([before, after]) => before === beforeImageId && after === afterImageId)) throw new WorkspaceDomainError("overlap_pair_missing", "未找到 overlap pair");
    this.applyPostprocess((next) => { next.importReview.overlapPairs[pool] = next.importReview.overlapPairs[pool].filter(([before, after]) => before !== beforeImageId || after !== afterImageId); });
  }
  setRowOverlapResolution(rowReviewId: string, resolution: RowOverlapResolutionV1): void {
    this.applyPostprocess((next) => Object.assign(next, setRowOverlapResolution(next, rowReviewId, resolution)));
  }
  undo(): boolean { const previous = this.history.undo(this.current); if (!previous) return false; this.current = previous; return true; }
  redo(): boolean { const following = this.history.redo(this.current); if (!following) return false; this.current = following; return true; }
}

export function defaultStarInstanceId(): string {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new WorkspaceDomainError("star_instance_id_unavailable", "当前环境无法生成安全的 starInstanceId");
  return id;
}

export function createSession(workspace: WorkspaceStateV1, catalog: StarCatalog, idFactory = defaultStarInstanceId): WorkspaceSession {
  return new WorkspaceSession(workspace, catalog, idFactory);
}
