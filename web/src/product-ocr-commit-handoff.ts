/** Exact durable identities are the only witness that a pending Draft was committed. */
export interface CommittedDraftSources {
  accountId: string;
  sourceImageIds: readonly string[];
  reviewSourceImageIds: readonly string[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  const ids = new Set(left);
  return left.length > 0 && ids.size === left.length && new Set(right).size === right.length &&
    left.length === right.length && right.every((id) => !!id && ids.has(id));
}

export function isCommittedImportDraft(draft: { accountId: string; imageOrder: readonly string[] }, committed?: CommittedDraftSources): boolean {
  return !!committed && draft.accountId === committed.accountId &&
    sameIds(draft.imageOrder, committed.sourceImageIds) && sameIds(draft.imageOrder, committed.reviewSourceImageIds);
}

export function reviewRunContext<T>(options: { runContext?: T | null }, prior: T | null): T | null {
  return Object.prototype.hasOwnProperty.call(options, "runContext") ? options.runContext ?? null : prior;
}

export async function reviewSourceBlob(
  runContext: { images: Array<{ sourceImageId: string; file: Blob }> } | null,
  sourceImageId: string,
  getPersisted: (id: string) => Promise<Blob | undefined>,
): Promise<Blob | undefined> {
  return runContext?.images.find((image) => image.sourceImageId === sourceImageId)?.file ?? getPersisted(sourceImageId);
}

/** A rejected commit never retires the Draft. Housekeeping cannot reject a successful commit. */
export async function runProductOcrCommitHandoff<T>(options: {
  commit(): Promise<T>;
  isCurrent(): boolean;
  applyCommitted(committed: T): void;
  retireDraft(): Promise<void>;
  retireMemory(): void;
  usePersistedReview(): void;
}): Promise<"saved" | "cleanup_failed" | "stale"> {
  const committed = await options.commit();
  if (!options.isCurrent()) return "stale";
  options.applyCommitted(committed);
  let cleanupFailed = false;
  try { await options.retireDraft(); }
  catch { cleanupFailed = true; }
  if (!options.isCurrent()) return "stale";
  options.retireMemory();
  options.usePersistedReview();
  return cleanupFailed ? "cleanup_failed" : "saved";
}
