export type ReviewHistoryRevisionEntry = {
  revisionAfter: number;
  workspaceMutation: boolean;
};

/** UI-only navigation is valid only for the workspace revision that produced it. */
export function pruneStaleUiOnlyHistory<T extends ReviewHistoryRevisionEntry>(entries: readonly T[], currentRevision: number): T[] {
  return entries.filter((entry) => entry.workspaceMutation || entry.revisionAfter === currentRevision);
}

export function canUseUiOnlyHistory(entry: ReviewHistoryRevisionEntry, currentRevision: number): boolean {
  return entry.workspaceMutation || entry.revisionAfter === currentRevision;
}
