import type { StarCatalog } from "./catalog.js";
import type { EditableOccurrenceStateV1, ImagePool, Quality, StarInstanceV1, StarKind, WorkspaceStateV1 } from "./model.js";
import { WorkspaceDomainError } from "./model.js";
import { createWorkspaceSnapshot } from "./snapshot.js";

export type StarInstanceIdFactory = () => string;
export type RowOverlapResolutionV1 = "merge" | "keep_separate";

interface RowAuditV1 {
  type: "row_overlap";
  rowReviewId: string;
  pool: "main" | "support";
  beforeImageId: string;
  afterImageId: string;
  beforeRow: number;
  afterRow: number;
  status: "duplicate" | "pending" | "not_duplicate" | "keep_separate" | "invalidated";
  resolution: RowOverlapResolutionV1 | null;
  occurrenceIds: string[];
  invalidated?: boolean;
}

interface CompleteRow {
  imageId: string;
  row: number;
  cells: EditableOccurrenceStateV1[];
}

class UnionFind {
  private readonly parents = new Map<string, string>();
  constructor(ids: Iterable<string>) { for (const id of ids) this.parents.set(id, id); }
  root(id: string): string {
    const parent = this.parents.get(id);
    if (parent == null) throw new WorkspaceDomainError("postprocess_occurrence_missing", `未找到 occurrence ${id}`);
    if (parent === id) return id;
    const root = this.root(parent); this.parents.set(id, root); return root;
  }
  union(left: string, right: string): void { const a = this.root(left); const b = this.root(right); if (a !== b) this.parents.set(b, a); }
  groups(): string[][] {
    const groups = new Map<string, string[]>();
    for (const id of this.parents.keys()) { const root = this.root(id); groups.set(root, [...(groups.get(root) ?? []), id]); }
    return [...groups.values()];
  }
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function isLegalLevel(value: number | null): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 60; }
function primary<T extends Pick<EditableOccurrenceStateV1, "sourceOrder" | "row" | "column" | "occurrenceId">>(items: T[]): T {
  return [...items].sort((a, b) => a.sourceOrder - b.sourceOrder || a.row - b.row || a.column - b.column || a.occurrenceId.localeCompare(b.occurrenceId))[0]!;
}
function asRowAudit(value: unknown): RowAuditV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const audit = value as Partial<RowAuditV1>;
  return audit.type === "row_overlap" && typeof audit.rowReviewId === "string" && (audit.resolution === "merge" || audit.resolution === "keep_separate" || audit.resolution === null) ? value as RowAuditV1 : null;
}
function isQualityConflictAudit(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "quality_conflict";
}
function rowId(pool: "main" | "support", before: CompleteRow, after: CompleteRow): string { return `${pool}:${before.imageId}:${before.row}->${after.imageId}:${after.row}`; }
function evidenceActive(occurrence: EditableOccurrenceStateV1): boolean {
  return occurrence.completeness === "complete" && occurrence.inventoryAction === "keep" && (occurrence.kind === "主星" || occurrence.kind === "辅星");
}
function comparableRow(occurrences: EditableOccurrenceStateV1[], imageId: string): CompleteRow[] {
  const grouped = new Map<number, Map<number, EditableOccurrenceStateV1>>();
  for (const occurrence of occurrences) {
    if (occurrence.sourceImageId !== imageId || !evidenceActive(occurrence)) continue;
    const columns = grouped.get(occurrence.row) ?? new Map<number, EditableOccurrenceStateV1>();
    if (columns.has(occurrence.column)) throw new WorkspaceDomainError("postprocess_row_ambiguous", `图片 ${imageId} 的 r${occurrence.row} 有重复列`);
    columns.set(occurrence.column, occurrence); grouped.set(occurrence.row, columns);
  }
  return [...grouped.entries()].filter(([, columns]) => [0, 1, 2, 3].every((column) => columns.has(column))).map(([row, columns]) => ({ imageId, row, cells: [0, 1, 2, 3].map((column) => columns.get(column)!) })).sort((a, b) => a.row - b.row);
}
function rowStatus(left: CompleteRow, right: CompleteRow): "duplicate" | "pending" | "not_duplicate" {
  let unresolved = false;
  for (let column = 0; column < 4; column += 1) {
    const a = left.cells[column]!; const b = right.cells[column]!;
    if (a.name != null && b.name != null && a.name !== b.name) return "not_duplicate";
    if (isLegalLevel(a.level) && isLegalLevel(b.level) && a.level !== b.level) return "not_duplicate";
    if (a.name == null || b.name == null || !isLegalLevel(a.level) || !isLegalLevel(b.level)) unresolved = true;
  }
  return unresolved ? "pending" : "duplicate";
}
function poolFor(workspace: WorkspaceStateV1, imageId: string): ImagePool { return workspace.importReview.imagePools[imageId] ?? "unknown"; }
function finalizable(occurrence: EditableOccurrenceStateV1, catalog: StarCatalog): boolean {
  if (!evidenceActive(occurrence) || occurrence.name == null || !isLegalLevel(occurrence.level) || occurrence.quality == null) return false;
  const entry = catalog.entry(occurrence.name);
  return !!entry && entry.name === occurrence.name && entry.kind === occurrence.kind;
}
function qualityFor(members: EditableOccurrenceStateV1[]): { quality: Quality | null; conflict: boolean } {
  const manual = members.filter((member) => member.manualOverride && member.quality != null);
  const values = [...new Set(manual.map((member) => member.quality!))];
  if (values.length > 1) return { quality: null, conflict: true };
  if (values.length === 1) return { quality: values[0]!, conflict: false };
  const selected = [...members].sort((a, b) => b.qualityConfidence - a.qualityConfidence || a.sourceOrder - b.sourceOrder || a.row - b.row || a.column - b.column || a.occurrenceId.localeCompare(b.occurrenceId))[0]!;
  return { quality: selected.quality, conflict: false };
}
function oldOccurrenceIds(instance: StarInstanceV1): string[] {
  const audit = instance.provenance.audit;
  if (audit && typeof audit === "object" && !Array.isArray(audit) && Array.isArray((audit as Record<string, unknown>).sourceOccurrenceIds)) return ((audit as Record<string, unknown>).sourceOccurrenceIds as unknown[]).filter((value): value is string => typeof value === "string").sort();
  return instance.provenance.occurrenceId ? [instance.provenance.occurrenceId] : [];
}
function manualOnly(instance: StarInstanceV1): boolean { return instance.provenance.occurrenceId == null && oldOccurrenceIds(instance).length === 0; }
interface PhysicalComponent { members: EditableOccurrenceStateV1[]; ids: string[]; primary: EditableOccurrenceStateV1; kind: StarKind; name: string; level: number; quality: Quality; starInstanceId?: string; }
function resolveComponent(members: EditableOccurrenceStateV1[], catalog: StarCatalog): { component: PhysicalComponent | null; qualityConflict: boolean } {
  const names = [...new Set(members.map((member) => member.name).filter((value): value is string => value != null))];
  const levels = [...new Set(members.map((member) => member.level).filter(isLegalLevel))];
  const kinds = [...new Set(members.map((member) => member.kind).filter((value): value is StarKind => value === "主星" || value === "辅星"))];
  const quality = qualityFor(members);
  if (quality.conflict) return { component: null, qualityConflict: true };
  if (names.length !== 1 || levels.length !== 1 || kinds.length !== 1 || quality.quality == null) return { component: null, qualityConflict: false };
  const entry = catalog.entry(names[0]!);
  if (!entry || entry.name !== names[0] || entry.kind !== kinds[0]) return { component: null, qualityConflict: false };
  return { component: { members, ids: members.map((member) => member.occurrenceId).sort(), primary: primary(members), kind: kinds[0]!, name: names[0]!, level: levels[0]!, quality: quality.quality }, qualityConflict: false };
}
function allocateComponentIds(components: PhysicalComponent[], previous: StarInstanceV1[], makeId: StarInstanceIdFactory): void {
  const old = previous.filter((item) => !manualOnly(item)); const used = new Set<string>();
  const ordered = [...components].sort((a, b) => a.primary.occurrenceId.localeCompare(b.primary.occurrenceId));
  for (const component of ordered) {
    const exact = old.filter((item) => !used.has(item.starInstanceId) && JSON.stringify(oldOccurrenceIds(item)) === JSON.stringify(component.ids)).sort((a, b) => a.starInstanceId.localeCompare(b.starInstanceId))[0];
    if (exact) { component.starInstanceId = exact.starInstanceId; used.add(exact.starInstanceId); }
  }
  for (const component of ordered.filter((item) => !item.starInstanceId)) {
    const owners = old.filter((item) => !used.has(item.starInstanceId) && item.provenance.occurrenceId != null && component.ids.includes(item.provenance.occurrenceId));
    const preferred = owners.filter((item) => item.provenance.occurrenceId === component.primary.occurrenceId).sort((a, b) => a.starInstanceId.localeCompare(b.starInstanceId))[0]
      ?? owners.sort((a, b) => a.starInstanceId.localeCompare(b.starInstanceId))[0];
    if (preferred) { component.starInstanceId = preferred.starInstanceId; used.add(preferred.starInstanceId); }
  }
  for (const component of ordered.filter((item) => !item.starInstanceId)) {
    const fresh = makeId();
    if (!fresh || used.has(fresh) || previous.some((item) => item.starInstanceId === fresh)) throw new WorkspaceDomainError("star_instance_id_invalid", "postprocess 生成了重复或空 starInstanceId");
    component.starInstanceId = fresh; used.add(fresh);
  }
}

/** Pure persisted-occurrence rebuild. It deliberately has no OCR, Worker, pixel, Blob, File, or IndexedDB dependency. */
export function recalculateWorkspacePostprocess(workspace: WorkspaceStateV1, catalog: StarCatalog, createId: StarInstanceIdFactory): WorkspaceStateV1 {
  const next = clone(workspace);
  const occurrences = Object.values(next.importReview.occurrences);
  const byId = new Map(occurrences.map((item) => [item.occurrenceId, item]));
  if (byId.size !== occurrences.length) throw new WorkspaceDomainError("postprocess_occurrence_duplicate", "occurrenceId 不能重复");
  const evidence = occurrences.filter(evidenceActive);
  const evidenceIds = new Set(evidence.map((item) => item.occurrenceId));
  const union = new UnionFind(evidence.map((item) => item.occurrenceId));
  const priorAudits = new Map(next.importReview.overlapAudit.map(asRowAudit).filter((item): item is RowAuditV1 => item != null).map((item) => [item.rowReviewId, item]));
  const audits: RowAuditV1[] = [];
  const confirmed = new Set(next.importReview.confirmedImagePools);
  const validPairs = new Set<string>();
  const pairKey = (pool: "main" | "support", before: string, after: string) => `${pool}:${before}->${after}`;
  for (const pool of ["main", "support"] as const) {
    for (const [beforeImageId, afterImageId] of next.importReview.overlapPairs[pool]) {
      if (!confirmed.has(beforeImageId) || !confirmed.has(afterImageId) || poolFor(next, beforeImageId) !== pool || poolFor(next, afterImageId) !== pool) continue;
      validPairs.add(pairKey(pool, beforeImageId, afterImageId));
      const beforeRows = comparableRow(occurrences, beforeImageId);
      const afterRows = comparableRow(occurrences, afterImageId);
      let selected: Array<{ before: CompleteRow; after: CompleteRow; status: "duplicate" | "pending" }> = [];
      for (let length = Math.min(beforeRows.length, afterRows.length); length >= 1; length -= 1) {
        const candidate = Array.from({ length }, (_, offset) => ({ before: beforeRows[beforeRows.length - length + offset]!, after: afterRows[offset]! }));
        const statuses = candidate.map(({ before, after }) => rowStatus(before, after));
        if (statuses.includes("not_duplicate")) continue;
        selected = candidate.map(({ before, after }, index) => ({ before, after, status: statuses[index]! as "duplicate" | "pending" }));
        break;
      }
      for (const { before, after, status } of selected) {
        const reviewId = rowId(pool, before, after); const previous = priorAudits.get(reviewId);
        if (previous?.invalidated || previous?.status === "invalidated") {
          audits.push({ ...previous, status: "invalidated", resolution: null, invalidated: true });
          continue;
        }
        const resolution = previous?.resolution === "keep_separate" ? "keep_separate" : previous?.resolution === "merge" ? "merge" : null;
        const effective = resolution === "keep_separate" ? "keep_separate" : status === "duplicate" ? "duplicate" : "pending";
        if (effective === "duplicate" || (status === "pending" && resolution === "merge")) {
          for (let column = 0; column < 4; column += 1) {
            const left = before.cells[column]!; const right = after.cells[column]!;
            if (evidenceIds.has(left.occurrenceId) && evidenceIds.has(right.occurrenceId)) union.union(left.occurrenceId, right.occurrenceId);
          }
        }
        audits.push({ type: "row_overlap", rowReviewId: reviewId, pool, beforeImageId, afterImageId, beforeRow: before.row, afterRow: after.row, status: effective, resolution: effective === "keep_separate" ? "keep_separate" : status === "pending" ? resolution : null, occurrenceIds: [...before.cells, ...after.cells].map((item) => item.occurrenceId) });
      }
    }
  }
  for (const audit of priorAudits.values()) {
    if (!validPairs.has(pairKey(audit.pool, audit.beforeImageId, audit.afterImageId)) || audits.some((item) => item.rowReviewId === audit.rowReviewId)) continue;
    if (audit.invalidated || audit.status === "invalidated") { audits.push({ ...audit, status: "invalidated", resolution: null, invalidated: true }); continue; }
    if (audit.resolution === "keep_separate") audits.push({ ...audit, status: "keep_separate", resolution: "keep_separate" });
  }
  const components: PhysicalComponent[] = []; const qualityConflicts: Array<{ type: "quality_conflict"; occurrenceIds: string[] }> = [];
  for (const ids of union.groups()) {
    const members = ids.map((id) => byId.get(id)!).sort((a, b) => a.occurrenceId.localeCompare(b.occurrenceId));
    const resolved = resolveComponent(members, catalog);
    if (resolved.qualityConflict) {
      qualityConflicts.push({ type: "quality_conflict", occurrenceIds: ids.sort() });
      for (const member of members) {
        const singleton = resolveComponent([member], catalog).component;
        if (singleton && !member.removedFromCurrentInventory) components.push(singleton);
      }
      continue;
    }
    if (resolved.component && !members.every((member) => member.removedFromCurrentInventory)) components.push(resolved.component);
  }
  allocateComponentIds(components, next.inventory, createId);
  const inventory: StarInstanceV1[] = components.map((component) => ({ starInstanceId: component.starInstanceId!, kind: component.kind, name: component.name, level: component.level, quality: component.quality, equippedState: component.primary.equippedState, provenance: { sourceOrder: component.primary.sourceOrder, sourceImageId: component.primary.sourceImageId, occurrenceId: component.primary.occurrenceId, row: component.primary.row, column: component.primary.column, audit: { sourceOccurrenceIds: component.ids } }, manualStatus: component.members.some((item) => item.manualOverride) ? "user_resolved" : "ocr_reconciled" }));
  inventory.push(...next.inventory.filter(manualOnly));
  const planTargets: Record<string, number> = {};
  for (const item of inventory) { const target = next.planTargets[item.starInstanceId]; if (typeof target === "number" && Number.isInteger(target) && target > item.level && target <= 60) planTargets[item.starInstanceId] = target; }
  const retainedAudits = next.importReview.overlapAudit.filter((value) => asRowAudit(value) == null && !isQualityConflictAudit(value));
  next.inventory = inventory; next.planTargets = planTargets; next.importReview.overlapAudit = [...retainedAudits, ...audits, ...qualityConflicts] as unknown as WorkspaceStateV1["importReview"]["overlapAudit"]; next.postprocessRevision += 1;
  return createWorkspaceSnapshot(next, catalog);
}

export function setRowOverlapResolution(workspace: WorkspaceStateV1, rowReviewId: string, resolution: RowOverlapResolutionV1): WorkspaceStateV1 {
  const next = clone(workspace); let found = false;
  next.importReview.overlapAudit = next.importReview.overlapAudit.map((value) => {
    const audit = asRowAudit(value); if (!audit || audit.rowReviewId !== rowReviewId) return value;
    found = true; return { ...audit, resolution };
  });
  if (!found) throw new WorkspaceDomainError("overlap_row_missing", "未找到 overlap row review");
  return next;
}

/** A manual change makes a previously confirmed row unreliable; never partially re-infer it. */
export function invalidateConfirmedDuplicateRowsForOccurrence(workspace: WorkspaceStateV1, occurrenceId: string): boolean {
  let changed = false;
  workspace.importReview.overlapAudit = workspace.importReview.overlapAudit.map((value) => {
    const audit = asRowAudit(value);
    if (!audit || audit.status !== "duplicate" || !audit.occurrenceIds.includes(occurrenceId)) return value;
    changed = true;
    return { ...audit, status: "invalidated", resolution: null, invalidated: true };
  });
  return changed;
}
