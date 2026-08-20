export type CurrentInstanceEditableFields = {
  kind: "主星" | "辅星";
  name: string;
  level: number;
  quality: "橙" | "紫" | "蓝" | "绿" | "白";
};

export type CurrentInstanceUpdate = Partial<CurrentInstanceEditableFields>;

/**
 * OCR-backed instances retain their OCR occurrence as the canonical source.
 * Cross-kind edits are valid only when kind and a deliberate name are present
 * in the same mutation.
 */
export function buildCurrentInstanceUpdate(
  current: CurrentInstanceEditableFields,
  draft: CurrentInstanceEditableFields,
  isOcrBacked: boolean,
): CurrentInstanceUpdate | null {
  if (current.kind !== draft.kind && !draft.name.trim()) return null;
  const update: CurrentInstanceUpdate = {};
  if (current.name !== draft.name) update.name = draft.name;
  if (current.level !== draft.level) update.level = draft.level;
  if (current.quality !== draft.quality) update.quality = draft.quality;
  if (current.kind !== draft.kind) update.kind = draft.kind;
  return update;
}

export function hasCurrentInstanceUpdate(update: CurrentInstanceUpdate | null): update is CurrentInstanceUpdate {
  if (update == null) return false;
  return Object.keys(update).length > 0;
}
