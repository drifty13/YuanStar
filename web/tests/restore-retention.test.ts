import "./helpers/idb-key-range.js";
import { createEmptyWorkspace } from "../src/business/model.js";
import { commitWorkspaceTransaction, createAccountWorkspace, deleteAccountData, getAccount, getMeta, getWorkspace, listAccounts, listImagesForAccount, listRestorePoints, setMeta, updateAccountMetadata, getRestorePoint, getRestorePointImage, type AccountRecord } from "../src/business/persistence/repository.js";

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
    if (this.database.failDeleteStore === name) throw new Error("injected Blob delete failure");
    this.records(name).delete(JSON.stringify(key));
    this.scheduleCompletion();
  }

  get(name: string, key: unknown): unknown { const value = this.records(name).get(JSON.stringify(key)); return value == null ? undefined : structuredClone(value); }
  getAll(name: string): unknown[] {
    if (this.database.failReadStore === name) throw new Error("injected pruning read failure");
    return [...this.records(name).values()].map((value) => structuredClone(value));
  }

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
    if (name === "accounts" || name === "workspaces" || name === "importDrafts") return JSON.stringify(record.accountId);
    if (name === "images") return JSON.stringify([record.accountId, record.imageId]);
    if (name === "importDraftImages") return JSON.stringify([record.accountId, record.sourceImageId]);
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
  getAll(range?: IDBKeyRange): FakeRequest<unknown[]> {
    return this.transaction.request(() => this.transaction.getAll(this.name).filter(value => {
      if (!range) return true;
      const row = value as { accountId: string; restorePointId: string; imageId?: string };
      return range.includes([row.accountId, row.restorePointId, ...(row.imageId ? [row.imageId] : [])]);
    }));
  }
  put(value: unknown, key?: unknown): void { this.transaction.put(this.name, value, key); }
  delete(key: unknown): void { this.transaction.request(() => this.transaction.delete(this.name, key)); }
}

class FakeDatabase {
  failDeleteStore: string | null = null;
  failReadStore: string | null = null;
  stores = new Map(["meta", "accounts", "workspaces", "images", "restorePoints", "restorePointImages", "importDrafts", "importDraftImages"].map((name) => [name, new Map<string, unknown>()]));
  transaction(): FakeTransaction { return new FakeTransaction(this); }
}


const database = new FakeDatabase();
const db = database as unknown as IDBDatabase;
const stamp = "2026-10-06T00:00:00.000Z";
for (const accountId of ["A", "B"]) {
  await createAccountWorkspace(db, { accountId, displayName: accountId, gameVersion: "代号鸢", createdAt: stamp, updatedAt: stamp }, createEmptyWorkspace(accountId, "代号鸢"));
}
async function checkpoint(accountId: string, id: string, createdAt = stamp, abort = false): Promise<void> {
  const current = (await getWorkspace(db, accountId))!;
  await commitWorkspaceTransaction(db, {
    accountId, expectedRevision: current.revision,
    nextSnapshot: { ...current.snapshot, bag: { ...current.snapshot.bag, currentCount: current.revision } },
    imageUpserts: [{ imageId: "shared", blob: new Blob(["live"]), filename: "live.png", mimeType: "image/png", width: 1, height: 1, createdAt: stamp }],
    optionalRestorePoint: { restorePointId: id, reason: "test", createdAt, imageIds: ["shared"], images: [{ imageId: "shared", blob: new Blob([id]), metadata: {} }] },
    abortAfterWritesForTest: abort,
  });
}
const rawPoints = (accountId: string) => [...database.stores.get("restorePoints")!.values()].filter(value => (value as { accountId: string }).accountId === accountId);
const rawImages = (accountId: string) => [...database.stores.get("restorePointImages")!.values()].filter(value => (value as { accountId: string }).accountId === accountId);
await checkpoint("B", "other");
for (let n = 1; n <= 5; n++) {
  await checkpoint("A", `point-${n}`, `2026-10-06T00:00:0${n}.000Z`);
  expect(rawPoints("A").length === Math.min(n, 3), `creation ${n} physically retains exactly latest three`);
  expect(rawImages("A").length === Math.min(n, 3), `creation ${n} physically removes companions`);
  expect(rawPoints("B").length === 1 && rawImages("B").length === 1, "A pruning preserves B");
}
expect(!await getRestorePoint(db, "A", "point-1") && !await getRestorePointImage(db, "A", "point-1", "shared"), "old snapshot and Blob both deleted");
for (const id of ["point-3", "point-4", "point-5"]) expect(await (await getRestorePointImage(db, "A", id, "shared"))!.blob.text() === id, "retained same-name images remain independent and recoverable");
expect((await listImagesForAccount(db, "A")).length === 1, "shared live image is retained");
expect((await listRestorePoints(db, "A")).map(point => point.restorePointId).join(",") === "point-5,point-4,point-3", "UI query returns actual latest three");
function fingerprint(): string { return JSON.stringify([...database.stores].map(([name, rows]) => [name, [...rows]])); }
const beforeAbort = fingerprint();
let aborted = false;
try { await checkpoint("A", "aborted", "2026-10-06T00:00:06.000Z", true); } catch { aborted = true; }
expect(aborted && fingerprint() === beforeAbort, "abort rolls back checkpoint, workspace, live images and pruned companions");
database.failDeleteStore = "restorePointImages";
let failed = false;
try { await checkpoint("A", "failed", "2026-10-06T00:00:06.000Z"); } catch { failed = true; }
database.failDeleteStore = null;
expect(failed && fingerprint() === beforeAbort, "Blob deletion failure rolls back the entire transaction including snapshot deletion");
database.failReadStore = "restorePointImages";
failed = false;
try { await checkpoint("A", "failed-read", "2026-10-06T00:00:06.000Z"); } catch { failed = true; }
database.failReadStore = null;
expect(failed && fingerprint() === beforeAbort, "pruning query failure rolls back all writes without an unhandled transaction rejection");

// Legacy v2 records may exceed the UI limit or contain unlisted companions.
const snapshot = (await getWorkspace(db, "A"))!.snapshot;
for (const id of ["tie-a", "tie-b", "tie-c", "tie-d"]) {
  database.stores.get("restorePoints")!.set(JSON.stringify(["A", id]), { accountId: "A", restorePointId: id, reason: "legacy", createdAt: "2026-10-07T00:00:00.000Z", workspaceRevision: 1, snapshot, imageIds: [] });
  database.stores.get("restorePointImages")!.set(JSON.stringify(["A", id, "unlisted"]), { accountId: "A", restorePointId: id, imageId: "unlisted", blob: new Blob([id]), metadata: {} });
}
database.stores.get("restorePointImages")!.set(JSON.stringify(["A", "missing", "orphan"]), { accountId: "A", restorePointId: "missing", imageId: "orphan", blob: new Blob(["orphan"]), metadata: {} });
const recent = await listRestorePoints(db, "A");
expect(recent.map(point => point.restorePointId).join(",") === "tie-d,tie-c,tie-b", "equal timestamps deterministically sort by restore identity");
expect(rawPoints("A").length === 3 && rawImages("A").length === 3, "listing physically maintains legacy storage and cleans unlisted/orphan companions");
expect(!await getRestorePointImage(db, "A", "tie-a", "unlisted") && !await getRestorePointImage(db, "A", "missing", "orphan"), "no orphan records after pruning");
expect(rawPoints("B").length === 1 && rawImages("B").length === 1, "legacy maintenance remains account isolated");
console.log("PASS restore retention: 1/2/3/4/5, snapshots and Blobs, shared identities, deterministic ties, accounts, legacy cleanup, abort and Blob failure rollback");
