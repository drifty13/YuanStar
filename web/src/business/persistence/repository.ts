import type { GameVersion, JsonValue, WorkspaceStateV1 } from "../model.js";
import { WorkspaceDomainError } from "../model.js";
import { asJsonExample } from "../snapshot.js";

export const PRODUCTION_DB_NAME = "yuanstar-static";
export const PRODUCTION_DB_VERSION = 1;
export const PRODUCTION_STORES = ["meta", "accounts", "workspaces", "images", "restorePoints", "restorePointImages"] as const;
export type ProductionStore = typeof PRODUCTION_STORES[number];

export interface AccountRecord { accountId: string; displayName: string; gameVersion: GameVersion; createdAt: string; updatedAt: string; }
export interface WorkspaceRecord { accountId: string; revision: number; schemaVersion: 1; snapshot: WorkspaceStateV1; updatedAt: string; }
export interface ImageRecord { accountId: string; imageId: string; blob: Blob; filename: string; mimeType: string; width: number | null; height: number | null; createdAt: string; }
export interface RestorePointRecord { accountId: string; restorePointId: string; reason: string; createdAt: string; workspaceRevision: number; snapshot: WorkspaceStateV1; imageIds: string[]; }
export interface RestorePointImageRecord { accountId: string; restorePointId: string; imageId: string; blob: Blob; metadata: JsonValue; }
export interface RestorePointInput { restorePointId: string; reason: string; createdAt: string; imageIds: string[]; images: Array<Omit<RestorePointImageRecord, "accountId" | "restorePointId">>; }
export interface CommitWorkspaceTransactionInput {
  accountId: string;
  expectedRevision: number;
  nextSnapshot: WorkspaceStateV1;
  imageUpserts?: Array<Omit<ImageRecord, "accountId">>;
  imageDeletes?: string[];
  optionalRestorePoint?: RestorePointInput;
  /** Test/diagnostic-only hook proving IndexedDB abort has no partial writes. */
  abortAfterWritesForTest?: boolean;
}
export class WorkspaceRevisionConflictError extends Error {
  readonly code = "workspace_revision_conflict";
  constructor(readonly accountId: string, readonly expectedRevision: number, readonly actualRevision: number) {
    super(`workspace ${accountId} revision 冲突：expected ${expectedRevision}, actual ${actualRevision}`); this.name = "WorkspaceRevisionConflictError";
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败")); });
}
function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction 已中止")); transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction 失败")); });
}

export async function openDatabase(name = PRODUCTION_DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, PRODUCTION_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("accounts")) db.createObjectStore("accounts", { keyPath: "accountId" });
      if (!db.objectStoreNames.contains("workspaces")) db.createObjectStore("workspaces", { keyPath: "accountId" });
      if (!db.objectStoreNames.contains("images")) db.createObjectStore("images", { keyPath: ["accountId", "imageId"] });
      if (!db.objectStoreNames.contains("restorePoints")) db.createObjectStore("restorePoints", { keyPath: ["accountId", "restorePointId"] });
      if (!db.objectStoreNames.contains("restorePointImages")) db.createObjectStore("restorePointImages", { keyPath: ["accountId", "restorePointId", "imageId"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开 yuanstar-static"));
  });
}

export function closeDatabase(database: IDBDatabase): void { database.close(); }
export async function deleteDatabaseForTest(name = PRODUCTION_DB_NAME): Promise<void> {
  return new Promise((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error ?? new Error("无法删除测试数据库")); request.onblocked = () => reject(new Error("测试数据库仍被打开")); });
}
export async function getMeta<T extends JsonValue>(db: IDBDatabase, key: string): Promise<T | undefined> { return requestResult<T | undefined>(db.transaction("meta", "readonly").objectStore("meta").get(key)); }
export async function setMeta(db: IDBDatabase, key: string, value: JsonValue): Promise<void> { const transaction = db.transaction("meta", "readwrite"); const done = transactionComplete(transaction); transaction.objectStore("meta").put(value, key); await done; }
export async function getAccount(db: IDBDatabase, accountId: string): Promise<AccountRecord | undefined> { return requestResult<AccountRecord | undefined>(db.transaction("accounts", "readonly").objectStore("accounts").get(accountId)); }
export async function listAccounts(db: IDBDatabase): Promise<AccountRecord[]> {
  const accounts = await requestResult<AccountRecord[]>(db.transaction("accounts", "readonly").objectStore("accounts").getAll());
  return accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.accountId.localeCompare(right.accountId));
}
export async function putAccount(db: IDBDatabase, account: AccountRecord): Promise<void> { const transaction = db.transaction("accounts", "readwrite"); const done = transactionComplete(transaction); transaction.objectStore("accounts").put(account); await done; }
export async function getWorkspace(db: IDBDatabase, accountId: string): Promise<WorkspaceRecord | undefined> { return requestResult<WorkspaceRecord | undefined>(db.transaction("workspaces", "readonly").objectStore("workspaces").get(accountId)); }
export async function getImage(db: IDBDatabase, accountId: string, imageId: string): Promise<ImageRecord | undefined> { return requestResult<ImageRecord | undefined>(db.transaction("images", "readonly").objectStore("images").get([accountId, imageId])); }
export async function listImagesForAccount(db: IDBDatabase, accountId: string): Promise<ImageRecord[]> { return (await requestResult<ImageRecord[]>(db.transaction("images", "readonly").objectStore("images").getAll())).filter((item) => item.accountId === accountId); }
export async function listRestorePoints(db: IDBDatabase, accountId: string): Promise<RestorePointRecord[]> { return (await requestResult<RestorePointRecord[]>(db.transaction("restorePoints", "readonly").objectStore("restorePoints").getAll())).filter((item) => item.accountId === accountId); }
export async function getRestorePoint(db: IDBDatabase, accountId: string, restorePointId: string): Promise<RestorePointRecord | undefined> { return requestResult<RestorePointRecord | undefined>(db.transaction("restorePoints", "readonly").objectStore("restorePoints").get([accountId, restorePointId])); }
export async function getRestorePointImage(db: IDBDatabase, accountId: string, restorePointId: string, imageId: string): Promise<RestorePointImageRecord | undefined> { return requestResult<RestorePointImageRecord | undefined>(db.transaction("restorePointImages", "readonly").objectStore("restorePointImages").get([accountId, restorePointId, imageId])); }

function assertAccountNameAvailable(accounts: AccountRecord[], candidate: AccountRecord): void {
  if (accounts.some((account) => account.accountId !== candidate.accountId && account.gameVersion === candidate.gameVersion && account.displayName === candidate.displayName)) {
    throw new WorkspaceDomainError("account_name_conflict", "同一游戏版本内账号名称不能重复");
  }
}

/** Creates the account and its empty owner-scoped workspace in one transaction. */
export async function createAccountWorkspace(db: IDBDatabase, account: AccountRecord, snapshot: WorkspaceStateV1): Promise<WorkspaceRecord> {
  if (snapshot.accountId !== account.accountId || snapshot.gameVersion !== account.gameVersion) throw new WorkspaceDomainError("workspace_validation_error", "账号与 workspace 元数据不匹配");
  const transaction = db.transaction(["accounts", "workspaces"], "readwrite");
  const done = transactionComplete(transaction);
  const accounts = transaction.objectStore("accounts");
  const workspaces = transaction.objectStore("workspaces");
  const [existingAccount, existingWorkspace, allAccounts] = await Promise.all([
    requestResult<AccountRecord | undefined>(accounts.get(account.accountId)),
    requestResult<WorkspaceRecord | undefined>(workspaces.get(account.accountId)),
    requestResult<AccountRecord[]>(accounts.getAll()),
  ]);
  if (existingAccount || existingWorkspace) {
    transaction.abort();
    try { await done; } catch { /* expected abort */ }
    throw new WorkspaceDomainError("account_id_conflict", "账号 ID 已存在");
  }
  try { assertAccountNameAvailable(allAccounts, account); }
  catch (error) { transaction.abort(); try { await done; } catch { /* expected abort */ } throw error; }
  const record: WorkspaceRecord = { accountId: account.accountId, revision: 1, schemaVersion: 1, snapshot: { ...snapshot, revision: 1 }, updatedAt: account.updatedAt };
  asJsonExample(record.snapshot);
  accounts.put(account);
  workspaces.put(record);
  await done;
  return record;
}

/** Renaming and game-version edits preserve the account ID and update its workspace atomically. */
export async function updateAccountMetadata(db: IDBDatabase, input: { accountId: string; displayName: string; gameVersion: GameVersion }): Promise<{ account: AccountRecord; record: WorkspaceRecord }> {
  const transaction = db.transaction(["accounts", "workspaces"], "readwrite");
  const done = transactionComplete(transaction);
  const accounts = transaction.objectStore("accounts");
  const workspaces = transaction.objectStore("workspaces");
  const [current, currentRecord, allAccounts] = await Promise.all([
    requestResult<AccountRecord | undefined>(accounts.get(input.accountId)),
    requestResult<WorkspaceRecord | undefined>(workspaces.get(input.accountId)),
    requestResult<AccountRecord[]>(accounts.getAll()),
  ]);
  if (!current || !currentRecord) {
    transaction.abort();
    try { await done; } catch { /* expected abort */ }
    throw new WorkspaceDomainError("workspace_missing", "当前账号或工作区不存在");
  }
  const changed = current.displayName !== input.displayName || current.gameVersion !== input.gameVersion;
  if (!changed) { await done; return { account: current, record: currentRecord }; }
  const updatedAt = new Date().toISOString();
  const account: AccountRecord = { ...current, displayName: input.displayName, gameVersion: input.gameVersion, updatedAt };
  try { assertAccountNameAvailable(allAccounts, account); }
  catch (error) { transaction.abort(); try { await done; } catch { /* expected abort */ } throw error; }
  const revision = currentRecord.revision + 1;
  const snapshot = { ...currentRecord.snapshot, gameVersion: input.gameVersion, revision } as WorkspaceStateV1;
  asJsonExample(snapshot);
  const record: WorkspaceRecord = { ...currentRecord, revision, snapshot, updatedAt };
  accounts.put(account);
  workspaces.put(record);
  await done;
  return { account, record };
}

/** Deletes exactly one account and every persisted record that is keyed by it. */
export async function deleteAccountData(db: IDBDatabase, accountId: string): Promise<void> {
  const transaction = db.transaction(["accounts", "workspaces", "images", "restorePoints", "restorePointImages"], "readwrite");
  const done = transactionComplete(transaction);
  const images = transaction.objectStore("images");
  const restorePoints = transaction.objectStore("restorePoints");
  const restorePointImages = transaction.objectStore("restorePointImages");
  const [accountImages, accountRestorePoints, accountRestorePointImages] = await Promise.all([
    requestResult<ImageRecord[]>(images.getAll()),
    requestResult<RestorePointRecord[]>(restorePoints.getAll()),
    requestResult<RestorePointImageRecord[]>(restorePointImages.getAll()),
  ]);
  transaction.objectStore("accounts").delete(accountId);
  transaction.objectStore("workspaces").delete(accountId);
  accountImages.filter((item) => item.accountId === accountId).forEach((item) => images.delete([item.accountId, item.imageId]));
  accountRestorePoints.filter((item) => item.accountId === accountId).forEach((item) => restorePoints.delete([item.accountId, item.restorePointId]));
  accountRestorePointImages.filter((item) => item.accountId === accountId).forEach((item) => restorePointImages.delete([item.accountId, item.restorePointId, item.imageId]));
  await done;
}

export async function commitWorkspaceTransaction(db: IDBDatabase, input: CommitWorkspaceTransactionInput): Promise<WorkspaceRecord> {
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new WorkspaceDomainError("workspace_validation_error", "expectedRevision 必须为非负整数");
  if (input.nextSnapshot.accountId !== input.accountId) throw new WorkspaceDomainError("workspace_validation_error", "workspace accountId 不匹配");
  const transaction = db.transaction(PRODUCTION_STORES, "readwrite");
  const done = transactionComplete(transaction);
  const workspaceStore = transaction.objectStore("workspaces");
  const current = await requestResult<WorkspaceRecord | undefined>(workspaceStore.get(input.accountId));
  const actualRevision = current?.revision ?? 0;
  if (actualRevision !== input.expectedRevision) {
    transaction.abort();
    try { await done; } catch { /* expected abort */ }
    throw new WorkspaceRevisionConflictError(input.accountId, input.expectedRevision, actualRevision);
  }
  let preChangeRestore: WorkspaceRecord | undefined;
  if (input.optionalRestorePoint && !current) {
    transaction.abort();
    try { await done; } catch { /* expected abort */ }
    throw new WorkspaceDomainError("workspace_restore_point_requires_current", "创建 pre-change restore point 前必须存在当前 workspace");
  }
  if (input.optionalRestorePoint) preChangeRestore = current;
  const revision = actualRevision + 1;
  const snapshot = { ...input.nextSnapshot, revision } as WorkspaceStateV1;
  asJsonExample(snapshot);
  const record: WorkspaceRecord = { accountId: input.accountId, revision, schemaVersion: 1, snapshot, updatedAt: new Date().toISOString() };
  workspaceStore.put(record);
  const imageStore = transaction.objectStore("images");
  input.imageUpserts?.forEach((image) => imageStore.put({ ...image, accountId: input.accountId }));
  input.imageDeletes?.forEach((imageId) => imageStore.delete([input.accountId, imageId]));
  if (input.optionalRestorePoint && preChangeRestore) {
    const restore = input.optionalRestorePoint;
    transaction.objectStore("restorePoints").put({ accountId: input.accountId, restorePointId: restore.restorePointId, reason: restore.reason, createdAt: restore.createdAt, workspaceRevision: preChangeRestore.revision, snapshot: preChangeRestore.snapshot, imageIds: [...restore.imageIds] } satisfies RestorePointRecord);
    restore.images.forEach((image) => transaction.objectStore("restorePointImages").put({ ...image, accountId: input.accountId, restorePointId: restore.restorePointId }));
  }
  if (input.abortAfterWritesForTest) { transaction.abort(); await done; }
  await done;
  return record;
}
