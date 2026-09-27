import { deleteAccountData, openDatabase, PRODUCTION_DB_VERSION, PRODUCTION_STORES } from "../src/business/persistence/repository.js";
import { clearImportDraft, getImportDraft, replaceImportDraft, saveImportDraft, saveImportDraftMetadata, type ImportDraftImageMetadata, type ReplaceImportDraftInput } from "../src/business/persistence/import-draft-repository.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function key(value: unknown): string { return JSON.stringify(value); }

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

type Store = Map<string, unknown>;
class FakeDatabase {
  stores = new Map<string, Store>();
  keyPaths = new Map<string, string | string[] | null>();
  version = 1;
  blobWrites = 0;
  failBlobId: string | null = null;
  failDraftWrite = false;
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string, options?: { keyPath?: string | string[] }): void { if (this.stores.has(name)) throw new Error(`duplicate store ${name}`); this.stores.set(name, new Map()); this.keyPaths.set(name, options?.keyPath ?? null); }
  transaction(): FakeTransaction { return new FakeTransaction(this); }
  close(): void { /* no-op */ }
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;
  error: Error | null = null;
  readonly working: Map<string, Store>;
  private pending = 0;
  private settled = false;
  private scheduled = false;
  constructor(private readonly db: FakeDatabase) { this.working = new Map([...db.stores].map(([name, records]) => [name, new Map(records)])); }
  objectStore(name: string): FakeObjectStore { return new FakeObjectStore(this, name); }
  records(name: string): Store { const found = this.working.get(name); if (!found) throw new Error(`missing store ${name}`); return found; }
  request<T>(read: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending++;
    queueMicrotask(() => {
      if (this.settled) return;
      try { request.result = read(); request.onsuccess?.(); }
      catch (error) { request.error = error instanceof Error ? error : new Error(String(error)); this.error = request.error; request.onerror?.(); this.abort(); return; }
      this.pending--;
      this.finishLater();
    });
    return request;
  }
  put(name: string, value: unknown): void {
    if (this.settled) throw new Error("transaction closed");
    const record = value as Record<string, unknown>;
    if (name === "importDraftImages") {
      if (record.sourceImageId === this.db.failBlobId) throw new Error("injected Blob write failure");
      this.db.blobWrites++;
    }
    if (name === "importDrafts" && this.db.failDraftWrite) throw new Error("injected metadata write failure");
    const primary = name === "meta" ? undefined : name === "accounts" || name === "workspaces" || name === "importDrafts" ? record.accountId
      : name === "images" ? [record.accountId, record.imageId]
      : name === "importDraftImages" ? [record.accountId, record.sourceImageId]
      : name === "restorePoints" ? [record.accountId, record.restorePointId]
      : [record.accountId, record.restorePointId, record.imageId];
    this.records(name).set(key(primary), structuredClone(value));
    this.finishLater();
  }
  delete(name: string, primary: unknown): void { this.records(name).delete(key(primary)); this.finishLater(); }
  abort(): void { if (this.settled) return; this.settled = true; queueMicrotask(() => this.onabort?.()); }
  private finishLater(): void {
    if (this.settled || this.pending || this.scheduled) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      if (this.settled || this.pending) return;
      this.settled = true;
      this.db.stores = new Map([...this.working].map(([name, records]) => [name, new Map(records)]));
      this.oncomplete?.();
    }, 0);
  }
}

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction, private readonly name: string) {}
  get(primary: unknown): FakeRequest<unknown> { return this.tx.request(() => structuredClone(this.tx.records(this.name).get(key(primary)))); }
  getAll(): FakeRequest<unknown[]> { return this.tx.request(() => [...this.tx.records(this.name).values()].map((item) => structuredClone(item))); }
  getAllKeys(): FakeRequest<IDBValidKey[]> { return this.tx.request(() => [...this.tx.records(this.name).keys()].map((item) => JSON.parse(item) as IDBValidKey)); }
  put(value: unknown): void { this.tx.put(this.name, value); }
  delete(primary: unknown): void { this.tx.delete(this.name, primary); }
}

class FakeIndexedDb {
  readonly db = new FakeDatabase();
  open(_name: string, version: number): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      request.result = this.db;
      if (version > this.db.version) { request.onupgradeneeded?.(); this.db.version = version; }
      request.onsuccess?.();
    });
    return request;
  }
}

const indexed = new FakeIndexedDb();
for (const name of ["meta", "accounts", "workspaces", "images", "restorePoints", "restorePointImages"]) indexed.db.createObjectStore(name);
for (const name of ["accounts", "workspaces", "images", "restorePoints", "restorePointImages"]) {
  indexed.db.stores.get(name)!.set("legacy", { accountId: "legacy", marker: name });
}
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = indexed as unknown as IDBFactory;
const db = await openDatabase();
expect(PRODUCTION_DB_VERSION === 2 && indexed.db.version === 2, "production database must upgrade to v2");
expect(PRODUCTION_STORES.length === 8 && PRODUCTION_STORES.every((name) => indexed.db.objectStoreNames.contains(name)), "v2 must contain old and draft stores");
expect(indexed.db.keyPaths.get("importDrafts") === "accountId" && JSON.stringify(indexed.db.keyPaths.get("importDraftImages")) === JSON.stringify(["accountId", "sourceImageId"]), "draft keys must be account scoped");
for (const name of ["accounts", "workspaces", "images", "restorePoints", "restorePointImages"]) {
  expect(indexed.db.stores.get(name)?.get("legacy") != null, `v1 ${name} data must survive migration`);
}

function image(id: string, size = 4): ImportDraftImageMetadata {
  return { sourceImageId: id, filename: `${id}.png`, size, pool: "主星", confirmed: false, suggestedPool: null,
    classificationStatus: "classifying", classificationReviewRequired: false, poolSource: "manual", width: 12, height: 24 };
}
function input(accountId: string, ids: string[]): ReplaceImportDraftInput {
  return { accountId, imageOrder: ids, images: ids.map((id) => image(id)),
    overlapPairs: ids.length > 1 ? [{ pairId: "pair-1", pool: "主星", beforeId: ids[0]!, afterId: ids[1]! }] : [],
    imageBlobs: ids.map((id) => ({ sourceImageId: id, blob: new Blob(["data"], { type: "image/png" }), filename: `${id}.png`, mimeType: "image/png", lastModified: 123456 })) };
}

const a = input("A", ["a1", "a2"]);
(a.images[0] as ImportDraftImageMetadata & { objectUrl: string }).objectUrl = "blob:transient";
await replaceImportDraft(db, a);
await replaceImportDraft(db, input("B", ["b1"]));
const first = await getImportDraft(db, "A");
expect(first?.draft.imageOrder.join(",") === "a1,a2" && first.draft.overlapPairs[0]?.afterId === "a2", "order and overlap must round trip");
expect(first.imageBlobs[0]?.blob instanceof Blob && await first.imageBlobs[0].blob.text() === "data" && first.imageBlobs[0].lastModified === 123456, "Blob bytes and File reconstruction fields must round trip");
expect(!JSON.stringify(first.draft).includes("objectUrl") && !Object.hasOwn(first.imageBlobs[0]!, "objectUrl"), "transient URL must not persist");
expect((await getImportDraft(db, "B"))?.draft.imageOrder.join(",") === "b1", "account B must remain separate");

const beforeAppendWrites = indexed.db.blobWrites;
await saveImportDraft(db, { accountId: "A", imageOrder: ["a1", "a2", "a3"], images: [...first.draft.images, image("a3")],
  overlapPairs: first.draft.overlapPairs, imageBlobs: input("A", ["a3"]).imageBlobs });
const appended = await getImportDraft(db, "A");
expect(appended?.draft.imageOrder.join(",") === "a1,a2,a3" && indexed.db.blobWrites === beforeAppendWrites + 1, "append retains old identity and writes only the new Blob");
expect((await appended.imageBlobs[0]!.blob.text()) === "data" && (await appended.imageBlobs[2]!.blob.text()) === "data", "old and new bytes survive append");

const beforeMetadataWrites = indexed.db.blobWrites;
await saveImportDraftMetadata(db, { accountId: "A", imageOrder: appended.draft.imageOrder,
  images: appended.draft.images.map((item) => ({ ...item, pool: "辅星", confirmed: true })), overlapPairs: appended.draft.overlapPairs });
expect(indexed.db.blobWrites === beforeMetadataWrites && (await getImportDraft(db, "A"))?.draft.images.every((item) => item.pool === "辅星"), "metadata change must not rewrite Blobs");

let rejected = false;
try { await replaceImportDraft(db, { ...input("A", ["missing"]), imageBlobs: [] }); } catch { rejected = true; }
expect(rejected && (await getImportDraft(db, "A"))?.draft.imageOrder.join(",") === "a1,a2,a3", "missing Blob must not change existing draft");
rejected = false;
try { await saveImportDraft(db, { ...input("A", ["duplicate", "duplicate"]) }); } catch { rejected = true; }
expect(rejected && (await getImportDraft(db, "A"))?.draft.imageOrder.join(",") === "a1,a2,a3", "duplicate IDs must be rejected without pollution");

indexed.db.failBlobId = "fail";
rejected = false;
try { await replaceImportDraft(db, input("A", ["new", "fail"])); } catch { rejected = true; }
indexed.db.failBlobId = null;
const afterFailure = await getImportDraft(db, "A");
expect(rejected && afterFailure?.draft.imageOrder.join(",") === "a1,a2,a3" &&
  !indexed.db.stores.get("importDraftImages")?.has(key(["A", "new"])) &&
  await afterFailure.imageBlobs[0]!.blob.text() === "data", "failed second Blob write must roll back prior Blob deletion/write and metadata");
indexed.db.failDraftWrite = true;
rejected = false;
try { await replaceImportDraft(db, input("A", ["metadata-fail"])); } catch { rejected = true; }
indexed.db.failDraftWrite = false;
expect(rejected && (await getImportDraft(db, "A"))?.draft.imageOrder.join(",") === "a1,a2,a3" &&
  !indexed.db.stores.get("importDraftImages")?.has(key(["A", "metadata-fail"])), "failed metadata write must roll back the preceding Blob write");

await replaceImportDraft(db, input("A", ["replacement"]));
expect((await getImportDraft(db, "A"))?.draft.imageOrder.join(",") === "replacement" &&
  !indexed.db.stores.get("importDraftImages")?.has(key(["A", "a1"])), "replace must remove old A Blobs");
expect((await getImportDraft(db, "B"))?.draft.imageOrder.join(",") === "b1", "replace A must not change B");

await clearImportDraft(db, "A");
expect(!await getImportDraft(db, "A") && !indexed.db.stores.get("importDraftImages")?.has(key(["A", "replacement"])) &&
  (await getImportDraft(db, "B"))?.draft.imageOrder.join(",") === "b1", "clear A must retain B");
await replaceImportDraft(db, input("A", ["again"]));
await deleteAccountData(db, "A");
expect(!await getImportDraft(db, "A") && !indexed.db.stores.get("importDraftImages")?.has(key(["A", "again"])) &&
  (await getImportDraft(db, "B"))?.draft.imageOrder.join(",") === "b1", "account deletion must cascade both draft stores only for A");

indexed.db.stores.get("importDraftImages")?.delete(key(["B", "b1"]));
rejected = false;
try { await getImportDraft(db, "B"); } catch { rejected = true; }
expect(rejected, "missing persisted Blob must fail loudly on restore");
console.log("public import draft persistence checks passed");
