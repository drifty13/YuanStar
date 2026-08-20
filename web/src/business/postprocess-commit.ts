import type { StarCatalog } from "./catalog.js";
import { WorkspaceDomainError } from "./model.js";
import { WorkspaceSession, defaultStarInstanceId, type StarInstanceIdFactory } from "./session.js";
import { commitWorkspaceTransaction, getWorkspace, type WorkspaceRecord } from "./persistence/repository.js";

/**
 * Transaction boundary for ordinary postprocess edits. The callback operates only
 * on an in-memory session; no restore point or image writes are created here.
 */
export async function commitWorkspacePostprocessMutation(input: {
  db: IDBDatabase;
  accountId: string;
  catalog: StarCatalog;
  mutate: (session: WorkspaceSession) => void;
  createStarInstanceId?: StarInstanceIdFactory;
}): Promise<WorkspaceRecord> {
  const current = await getWorkspace(input.db, input.accountId);
  if (!current) throw new WorkspaceDomainError("workspace_missing", "未找到当前 workspace");
  const session = new WorkspaceSession(current.snapshot, input.catalog, input.createStarInstanceId ?? defaultStarInstanceId);
  input.mutate(session);
  const committed = await commitWorkspaceTransaction(input.db, {
    accountId: input.accountId,
    expectedRevision: current.revision,
    nextSnapshot: session.state,
  });
  const reloaded = await getWorkspace(input.db, input.accountId);
  if (!reloaded || reloaded.revision !== committed.revision) throw new Error("workspace postprocess reload verification failed");
  return committed;
}
