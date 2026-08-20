import { createEmptyWorkspace } from "../src/business/model.js";
import { commitWorkspaceTransaction, createAccountWorkspace, deleteAccountData, getAccount, getMeta, getWorkspace, listAccounts, listImagesForAccount, listRestorePoints, setMeta, updateAccountMetadata, type AccountRecord } from "../src/business/persistence/repository.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

type StoreRecords = Map<string, unknown>;

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;
  private readonly working: Map<string, StoreRecords>;
  private pending = 0;
  private settled = false;
  private completionScheduled = false;

  constructor(private readonly database: FakeDatabase) {
    this.working = new Map([...database.stores].map(([name, records]) => [name, new Map(records)]));
  }

  objectStore(name: string): FakeStore { return new FakeStore(this, name); }

  request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.settled) return;
      try { request.result = operation(); request.onsuccess?.(); }
      catch (error) { request.error = error instanceof Error ? error : new Error(String(error)); request.onerror?.(); this.error = request.error; this.abort(); return; }
      this.pending -= 1;
      this.scheduleCompletion();
    });
    return request;
  }

  put(name: string, value: unknown, key?: unknown): void {
    if (this.settled) throw new Error("transaction closed");
    this.records(name).set(this.keyFor(name, value, key), structuredClone(value));
    this.scheduleCompletion();
  }

  delete(name: string, key: unknown): void {
    if (this.settled) throw new Error("transaction closed");
    this.records(name).delete(JSON.stringify(key));
    this.scheduleCompletion();
  }

  get(name: string, key: unknown): unknown { const value = this.records(name).get(JSON.stringify(key)); return value == null ? undefined : structuredClone(value); }
  getAll(name: string): unknown[] { return [...this.records(name).values()].map((value) => structuredClone(value)); }

  abort(): void {
    if (this.settled) return;
    this.settled = true;
    queueMicrotask(() => this.onabort?.());
  }

  private records(name: string): StoreRecords {
    const records = this.working.get(name);
    if (!records) throw new Error(`missing store ${name}`);
    return records;
  }

  private keyFor(name: string, value: unknown, explicitKey?: unknown): string {
    if (name === "meta") return JSON.stringify(explicitKey);
    const record = value as Record<string, unknown>;
    if (name === "accounts" || name === "workspaces") return JSON.stringify(record.accountId);
    if (name === "images") return JSON.stringify([record.accountId, record.imageId]);
    if (name === "restorePoints") return JSON.stringify([record.accountId, record.restorePointId]);
    return JSON.stringify([record.accountId, record.restorePointId, record.imageId]);
  }

  private scheduleCompletion(): void {
    if (this.settled || this.pending || this.completionScheduled) return;
    this.completionScheduled = true;
    setTimeout(() => {
      this.completionScheduled = false;
      if (this.settled || this.pending) return;
      this.settled = true;
      this.database.stores = new Map([...this.working].map(([name, records]) => [name, new Map(records)]));
      this.oncomplete?.();
    }, 0);
  }
}

class FakeStore {
  constructor(private readonly transaction: FakeTransaction, private readonly name: string) {}
  get(key: unknown): FakeRequest<unknown> { return this.transaction.request(() => this.transaction.get(this.name, key)); }
  getAll(): FakeRequest<unknown[]> { return this.transaction.request(() => this.transaction.getAll(this.name)); }
  put(value: unknown, key?: unknown): void { this.transaction.put(this.name, value, key); }
  delete(key: unknown): void { this.transaction.delete(this.name, key); }
}

class FakeDatabase {
  stores = new Map(["meta", "accounts", "workspaces", "images", "restorePoints", "restorePointImages"].map((name) => [name, new Map<string, unknown>()]));
  transaction(): FakeTransaction { return new FakeTransaction(this); }
}

const db = new FakeDatabase() as unknown as IDBDatabase;
const now = "2026-08-15T00:00:00.000Z";
const accountA: AccountRecord = { accountId: "account-a", displayName: "账号 A", gameVersion: "代号鸢", createdAt: now, updatedAt: now };
const accountB: AccountRecord = { accountId: "account-b", displayName: "账号 B", gameVersion: "代号鸢", createdAt: "2026-08-15T00:00:01.000Z", updatedAt: "2026-08-15T00:00:01.000Z" };

const createdA = await createAccountWorkspace(db, accountA, createEmptyWorkspace(accountA.accountId, accountA.gameVersion));
const createdB = await createAccountWorkspace(db, accountB, createEmptyWorkspace(accountB.accountId, accountB.gameVersion));
expect(createdA.revision === 1 && createdB.revision === 1, "new accounts must each receive an independent initial workspace");
expect((await listAccounts(db)).map((account) => account.accountId).join(",") === "account-a,account-b", "account list must use stable account IDs and a deterministic order");

const aRecord = await getWorkspace(db, accountA.accountId);
expect(aRecord, "account A workspace must exist");
const writtenA = await commitWorkspaceTransaction(db, { accountId: accountA.accountId, expectedRevision: aRecord.revision, nextSnapshot: { ...aRecord.snapshot, bag: { ...aRecord.snapshot.bag, currentCount: 7 } } });
expect((await getWorkspace(db, accountB.accountId))?.snapshot.bag.currentCount == null, "account B must not inherit account A canonical data");

await setMeta(db, "product.currentAccountId", accountA.accountId);
expect(await getMeta<string>(db, "product.currentAccountId") === accountA.accountId, "current account must persist independently from display names");

const renamedA = await updateAccountMetadata(db, { accountId: accountA.accountId, displayName: "账号 A 已重命名", gameVersion: "如鸢" });
expect(renamedA.account.accountId === accountA.accountId && renamedA.record.snapshot.bag.currentCount === 7 && renamedA.record.snapshot.gameVersion === "如鸢", "metadata edits must preserve stable ownership and canonical inventory");
let duplicateRejected = false;
try { await createAccountWorkspace(db, { ...accountB, accountId: "duplicate", displayName: "账号 A 已重命名", gameVersion: "如鸢" }, createEmptyWorkspace("duplicate", "如鸢")); } catch { duplicateRejected = true; }
expect(duplicateRejected && !await getAccount(db, "duplicate"), "invalid duplicate account creation must not leave partial data");

const bRecord = await getWorkspace(db, accountB.accountId);
expect(bRecord, "account B workspace must remain available before deletion");
await commitWorkspaceTransaction(db, { accountId: accountB.accountId, expectedRevision: bRecord.revision, nextSnapshot: bRecord.snapshot, imageUpserts: [{ imageId: "b-image", blob: new Blob(["b"]), filename: "b.png", mimeType: "image/png", width: 1, height: 1, createdAt: now }], optionalRestorePoint: { restorePointId: "b-restore", reason: "test", createdAt: now, imageIds: [], images: [] } });
await deleteAccountData(db, accountB.accountId);
expect(!await getAccount(db, accountB.accountId) && !await getWorkspace(db, accountB.accountId) && (await listImagesForAccount(db, accountB.accountId)).length === 0 && (await listRestorePoints(db, accountB.accountId)).length === 0, "deleting B must remove only B-owned persisted business data");
expect((await getWorkspace(db, accountA.accountId))?.revision === writtenA.revision + 1 && (await getWorkspace(db, accountA.accountId))?.snapshot.bag.currentCount === 7, "deleting B must not alter A data");

console.log("account persistence checks passed");
