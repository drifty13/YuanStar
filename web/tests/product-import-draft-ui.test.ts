import { getImportDraft, saveImportDraft, type ImportDraftImageRecord, type SaveImportDraftInput } from "../src/business/persistence/import-draft-repository.js";
import { ProductImportDraftController, restoreProductImportDraft } from "../src/product-import-draft.js";
import { applyProductImportClassification, removeProductImportImage, type ProductImportImage, type ProductOverlapPair } from "../src/product-ocr-import.js";
import { classifyPageVisual } from "../src/structured/page-routing-visual-only.js";
import { toPageClassificationV1 } from "../src/structured/page-routing-logic.js";
import { createStarCatalog } from "../src/business/catalog.js";
import { commitReconciledAnalysis, type ReconcileDraftV1 } from "../src/business/reconcile.js";
import { getImage, getWorkspace } from "../src/business/persistence/repository.js";
import { buildPersistedProductReview, productReviewRowCropRect } from "../src/product-ocr-review.js";
import { reviewSourceBlob, runProductOcrCommitHandoff } from "../src/product-ocr-commit-handoff.js";

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
  failClear = false;
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
  delete(name: string, primary: unknown): void {
    if (this.db.failClear) throw new Error("injected Draft cleanup failure");
    this.records(name).delete(key(primary)); this.finishLater();
  }
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

const database = new FakeDatabase();
database.createObjectStore("importDrafts", { keyPath: "accountId" });
database.createObjectStore("importDraftImages", { keyPath: ["accountId", "sourceImageId"] });
const created: Array<{ url: string; file: File }> = [];
const revoked: string[] = [];
const urls = {
  createObjectUrl(file: File): string { const url = `blob:test-${created.length + 1}`; created.push({ url, file }); return url; },
  revokeObjectUrl(url: string): void { revoked.push(url); },
};
const controller = new ProductImportDraftController({ openDatabase: async () => database as unknown as IDBDatabase, urls });
const file = (name: string, content: string, lastModified: number) => new File([content], name, { type: "image/png", lastModified });
const pair = (beforeId: string, afterId: string): ProductOverlapPair => ({ pairId: `pair-${beforeId}-${afterId}`, pool: "主星", beforeId, afterId });
const expectIds = (images: ProductImportImage[], ids: string, message: string) => expect(images.map(({ sourceImageId }) => sourceImageId).join(",") === ids, message);

await controller.activate("A");
const first = controller.createImages([file("A1.png", "aaaa", 1234), file("A2.png", "bbbb", 5678)]);
const [a1, a2] = first;
expect(a1 && a2, "first batch must contain two images");
await controller.save(first, [], first);
const firstWrites = database.blobWrites;
expect(firstWrites === 2, "first batch writes both Blobs");
let images: ProductImportImage[] = first.map((item, index) => ({ ...item, pool: index ? "辅星" as const : "主星" as const, confirmed: true, suggestedPool: index ? "辅星" as const : "主星" as const, classificationStatus: "suggested" as const, classificationReviewRequired: false, poolSource: "manual" as const, width: 100, height: 200 }));
let pairs = [pair(a1.sourceImageId, a2.sourceImageId)];
await controller.saveMetadata(images, pairs);
expect(database.blobWrites === firstWrites, "metadata-only pool, confirmed, dimensions and overlap must not rewrite Blobs");
const earlierWrite = controller.saveMetadata(images.map((item) => ({ ...item, confirmed: false })), pairs);
const laterWrite = controller.saveMetadata(images, pairs);
await Promise.all([earlierWrite, laterWrite]);
expect((await getImportDraft(database as unknown as IDBDatabase, "A"))?.draft.images.every(({ confirmed }) => confirmed), "serialized writes preserve the latest metadata");

const second = controller.createImages([file("B1.png", "cccc", 9012)]);
images = [...images, ...second];
await controller.save(images, pairs, second);
expect(database.blobWrites === firstWrites + 1, "append writes only the new Blob");
const snapshot = await getImportDraft(database as unknown as IDBDatabase, "A");
expect(snapshot, "A Draft is readable after append");
expect(snapshot?.draft.imageOrder.join(",") === images.map(({ sourceImageId }) => sourceImageId).join(","), "append preserves sourceImageId and order");
expect(snapshot?.draft.images[0]?.pool === "主星" && snapshot.draft.images[1]?.pool === "辅星" && snapshot.draft.images[0]?.confirmed === true, "append retains old metadata");
expect(await snapshot.imageBlobs[0]!.blob.text() === "aaaa" && await snapshot.imageBlobs[1]!.blob.text() === "bbbb", "append retains original Blob contents");
expect(snapshot?.draft.overlapPairs[0]?.pairId === pairs[0]?.pairId, "append retains overlap");

const oldUrls = images.map(({ objectUrl }) => objectUrl);
controller.releaseImages(images);
const restored = await controller.activate("A");
expectIds(restored.images, images.map(({ sourceImageId }) => sourceImageId).join(","), "restore follows imageOrder");
expect(restored.images.every(({ file: restoredFile, objectUrl }, index) => restoredFile instanceof File && objectUrl !== oldUrls[index]), "restore creates Files and fresh URLs");
expect(restored.images[0]?.file.name === "A1.png" && restored.images[0].file.type === "image/png" && restored.images[0].file.lastModified === 1234, "restore retains filename, MIME and timestamp");
expect(restored.images[0]?.confirmed && restored.images[1]?.pool === "辅星" && restored.images[1]?.poolSource === "manual" && restored.images[0]?.width === 100, "restore retains classification metadata");
expect(restored.overlapPairs[0]?.pairId === pairs[0]?.pairId, "restore retains overlap relation");
expect(oldUrls.every((url) => revoked.includes(url)), "old URLs are revoked on replacement");

const restoredWrites = database.blobWrites;
const changed = restored.images.map((item, index) => index === 0 ? { ...item, pool: "辅星" as const, confirmed: false } : item);
pairs = [];
await controller.saveMetadata(changed, pairs);
expect(database.blobWrites === restoredWrites && (await getImportDraft(database as unknown as IDBDatabase, "A"))?.draft.images[0]?.pool === "辅星", "pool and confirmation update metadata only");
expect((await getImportDraft(database as unknown as IDBDatabase, "A"))?.draft.overlapPairs.length === 0, "overlap removal persists");

const generationA = controller.generation;
const aUrls = restored.images.map(({ objectUrl }) => objectUrl);
controller.releaseImages(restored.images);
await controller.activate("B");
expect(!controller.isCurrent("A", generationA), "account switch invalidates old generation");
let resolveOld!: () => void;
const oldClassification = new Promise<void>((resolve) => { resolveOld = resolve; });
let wroteOldIntoB = false;
const oldCallback = oldClassification.then(() => { if (controller.isCurrent("A", generationA)) wroteOldIntoB = true; });
resolveOld(); await oldCallback;
expect(!wroteOldIntoB, "late A classification cannot apply to B");
expect(aUrls.every((url) => revoked.includes(url)), "switch revokes A URLs");
const bImages = controller.createImages([file("B-only.png", "dddd", 2222)]);
await controller.save(bImages, [], bImages);
expect((await getImportDraft(database as unknown as IDBDatabase, "B"))?.draft.imageOrder.length === 1, "B has independent Draft");
controller.releaseImages(bImages);
const againA = await controller.activate("A");
expectIds(againA.images, images.map(({ sourceImageId }) => sourceImageId).join(","), "A to B to A restores A only");
expect(againA.images.every(({ filename }) => filename !== "B-only.png"), "account images do not mix");

// A delayed classification callback uses the same guard as the page before touching UI or storage.
const staleGeneration = controller.generation;
let finishClassification!: () => void;
const delayed = new Promise<void>((resolve) => { finishClassification = resolve; });
let staleApplied = false;
const callback = delayed.then(() => { if (controller.isCurrent("A", staleGeneration)) staleApplied = true; });
await controller.clear();
finishClassification();
await callback;
expect(!staleApplied && !(await getImportDraft(database as unknown as IDBDatabase, "A")), "clear rejects stale classification and prevents resurrection");
controller.releaseImages(againA.images);
const empty = await controller.activate("A");
expect(empty.images.length === 0, "refresh after clear stays empty");

const classifying = controller.createImages([file("pending.png", "eeee", 3333)]);
await controller.save(classifying, [], classifying);
controller.releaseImages(classifying);
const normalized = await controller.activate("A");
expect(normalized.images[0]?.classificationStatus === "failed" && normalized.images[0]?.classificationReviewRequired === true && normalized.images[0]?.confirmed === false, "persisted classifying becomes failed and requires review");
expect((await getImportDraft(database as unknown as IDBDatabase, "A"))?.draft.images[0]?.classificationStatus === "failed", "normalized classification is saved");
controller.releaseImages(normalized.images);

const corrupt: SaveImportDraftInput = {
  accountId: "C", imageOrder: ["c1", "c2"], images: ["c1", "c2"].map((sourceImageId) => ({ ...normalized.images[0]!, sourceImageId, filename: `${sourceImageId}.png`, size: 4 })), overlapPairs: [],
  imageBlobs: ["c1", "c2"].map((sourceImageId) => ({ sourceImageId, blob: file(`${sourceImageId}.png`, "zzzz", 1), filename: `${sourceImageId}.png`, mimeType: "image/png", lastModified: 1 })),
};
await saveImportDraft(database as unknown as IDBDatabase, corrupt);
const corruptSnapshot = await getImportDraft(database as unknown as IDBDatabase, "C");
expect(corruptSnapshot, "corrupt test fixture exists");
corruptSnapshot.imageBlobs[1]!.filename = "mismatch.png";
const createdBeforeError = created.length;
let integrityFailed = false;
try { restoreProductImportDraft(corruptSnapshot, urls); } catch { integrityFailed = true; }
expect(integrityFailed && revoked.includes(created[createdBeforeError]!.url), "integrity error revokes partial restore URLs");
controller.releaseAll();
expect(created.every(({ url }) => revoked.includes(url)), "all Draft-owned URLs are released on page cleanup");

// Mirror the page boundary: remove state, release the removed URL, then save metadata.
{
  const removalDatabase = new FakeDatabase();
  removalDatabase.createObjectStore("importDrafts", { keyPath: "accountId" });
  removalDatabase.createObjectStore("importDraftImages", { keyPath: ["accountId", "sourceImageId"] });
  const removalCreated: string[] = [];
  const removalRevoked: string[] = [];
  const removalController = new ProductImportDraftController({
    openDatabase: async () => removalDatabase as unknown as IDBDatabase,
    urls: {
      createObjectUrl(): string { const url = `blob:removal-${removalCreated.length + 1}`; removalCreated.push(url); return url; },
      revokeObjectUrl(url): void { removalRevoked.push(url); },
    },
  });
  await removalController.activate("A");
  const removalImages = removalController.createImages([file("removed.png", "removed-content", 1111), file("retained.png", "retained-content", 2222)])
    .map((image): ProductImportImage => ({ ...image, classificationStatus: "suggested", suggestedPool: "主星", confirmed: true }));
  const [removedImage, retainedImage] = removalImages;
  expect(removedImage && retainedImage, "removal lifecycle starts with two images in Draft A");
  await removalController.save(removalImages, [], removalImages);
  const retainedKey = key(["A", retainedImage.sourceImageId]);
  const retainedBefore = removalDatabase.stores.get("importDraftImages")!.get(retainedKey) as ImportDraftImageRecord;
  const writesBeforeRemoval = removalDatabase.blobWrites;

  const reduced = removeProductImportImage(removalImages, [], removedImage.sourceImageId);
  expect(reduced.removed === removedImage, "state removal identifies the removed image");
  removalController.releaseImages([reduced.removed]);
  expect(removalRevoked.filter((url) => url === removedImage.objectUrl).length === 1, "page removal releases the removed URL exactly once");
  expect(!removalRevoked.includes(retainedImage.objectUrl), "retained image URL remains live while displayed");
  await removalController.saveMetadata(reduced.images, reduced.pairs);

  const reducedSnapshot = await getImportDraft(removalDatabase as unknown as IDBDatabase, "A");
  expect(reducedSnapshot && reducedSnapshot.draft.imageOrder.join(",") === retainedImage.sourceImageId &&
    reducedSnapshot.draft.images.length === 1 && reducedSnapshot.draft.images[0]?.sourceImageId === retainedImage.sourceImageId,
  "removed image is absent from persisted order and metadata");
  expect(!removalDatabase.stores.get("importDraftImages")!.has(key(["A", removedImage.sourceImageId])), "metadata persistence deletes the removed image Blob record");
  const retainedAfter = removalDatabase.stores.get("importDraftImages")!.get(retainedKey) as ImportDraftImageRecord;
  expect(retainedAfter.blob === retainedBefore.blob && await retainedAfter.blob.text() === "retained-content" &&
    retainedAfter.filename === retainedBefore.filename && retainedAfter.mimeType === retainedBefore.mimeType && retainedAfter.lastModified === retainedBefore.lastModified &&
    removalDatabase.blobWrites === writesBeforeRemoval, "retained Blob and File metadata are unchanged without a Blob rewrite");

  removalController.releaseImages(reduced.images);
  const afterRemovalRestore = await removalController.activate("A");
  expectIds(afterRemovalRestore.images, retainedImage.sourceImageId, "release and activate A restores only the retained image");
  expect(afterRemovalRestore.images.every(({ sourceImageId }) => sourceImageId !== removedImage.sourceImageId), "removed image does not reappear after restore");
  expect(afterRemovalRestore.images[0]?.objectUrl !== retainedImage.objectUrl && await afterRemovalRestore.images[0]!.file.text() === "retained-content", "retained image restores its unchanged content with a fresh URL");
  removalController.releaseAll();
  expect(removalCreated.every((url) => removalRevoked.filter((revokedUrl) => revokedUrl === url).length === 1), "all removal lifecycle URLs are revoked exactly once");
  console.log("PASS removed Draft image: metadata and Blob deletion, retained Blob, restore and URL ownership");
}

// P3 suggestions still round-trip through the unchanged P2 metadata APIs.
{
  const visualDb = new FakeDatabase();
  visualDb.createObjectStore("importDrafts", { keyPath: "accountId" });
  visualDb.createObjectStore("importDraftImages", { keyPath: ["accountId", "sourceImageId"] });
  let urlOrdinal = 0;
  const visualDraft = new ProductImportDraftController({ openDatabase: async () => visualDb as unknown as IDBDatabase, urls: {
    createObjectUrl: () => `blob:visual-draft-${++urlOrdinal}`, revokeObjectUrl: () => {},
  } });
  await visualDraft.activate("visual-A");
  const types = ["main", "support", "experience", "unknown"] as const;
  let visualImages = visualDraft.createImages(types.map((type) => file(`${type}.png`, type, 1234)));
  await visualDraft.save(visualImages, [], visualImages);
  const blobWrites = visualDb.blobWrites;
  for (const [index, type] of types.entries()) {
    const width = 300, height = 600;
    const data = new Uint8ClampedArray(width * height * 4);
    data.fill(40);
    if (type !== "unknown") {
      const left = { main: 12, support: 112, experience: 212 }[type];
      for (let y = 52; y < 72; y++) for (let x = left; x < left + 75; x++) {
        const at = (y * width + x) * 4;
        data[at] = 220; data[at + 1] = 180; data[at + 2] = 100; data[at + 3] = 255;
      }
    }
    const result = toPageClassificationV1(classifyPageVisual({ width, height, data } as ImageData, { x: 0, y: 0, width, height }));
    expect(result.pageType === type, `P3 ${type} visual result reaches P2 persistence`);
    visualImages = applyProductImportClassification(visualImages, visualImages[index]!.sourceImageId, result);
    await visualDraft.saveMetadata(visualImages, []);
  }
  expect(visualDb.blobWrites === blobWrites, "visual result metadata saves never rewrite image Blobs");
  const metadata = (items: ProductImportImage[]) => items.map(({ pool, suggestedPool, confirmed, classificationStatus, classificationReviewRequired, poolSource }) => ({ pool, suggestedPool, confirmed, classificationStatus, classificationReviewRequired, poolSource }));
  const expectedMetadata = key(metadata(visualImages));
  visualDraft.releaseImages(visualImages);
  const refreshed = await visualDraft.activate("visual-A");
  expect(key(metadata(refreshed.images)) === expectedMetadata, "refresh preserves all visual suggestion and unknown/manual-review metadata");
  expect(refreshed.images.every((item) => !item.confirmed) && refreshed.images[3]?.classificationReviewRequired && refreshed.images[3]?.classificationStatus === "failed", "P2 restore never auto-confirms visual suggestions or unknown");
  visualDraft.releaseAll();
  console.log("PASS P3 visual metadata: main/support/experience/unknown persistence, refresh and no Blob rewrite");
}

console.log("PASS product Import Draft UI lifecycle: restore, append, removal, metadata, accounts, clear, generation, recovery and URL ownership");

// P5: committed source identities must suppress a stale Draft before creating URLs.
{
  const db = new FakeDatabase();
  db.createObjectStore("importDrafts", { keyPath: "accountId" });
  db.createObjectStore("importDraftImages", { keyPath: ["accountId", "sourceImageId"] });
  const created: string[] = [], revoked: string[] = [];
  const draft = new ProductImportDraftController({ openDatabase: async () => db as unknown as IDBDatabase, urls: {
    createObjectUrl: () => { const url = `blob:p5-${created.length}`; created.push(url); return url; },
    revokeObjectUrl: (url) => { revoked.push(url); },
  } });
  await draft.activate("A");
  const images = draft.createImages([file("same.png", "same-content", 1)]);
  await draft.save(images, [], images);
  draft.releaseImages(images);
  const ids = images.map((image) => image.sourceImageId);
  const witness = { accountId: "A", sourceImageIds: ids, reviewSourceImageIds: ids };
  db.failClear = true;
  const before = created.length;
  const activate = draft.activate.bind(draft) as (accountId: string, committed: typeof witness) => ReturnType<typeof draft.activate>;
  const restored = await activate("A", witness);
  expect(restored.images.length === 0 && created.length === before, "P5 stale committed Draft never restores or creates URLs, even when cleanup fails");
  await draft.flush();
  expect(await getImportDraft(db as unknown as IDBDatabase, "A"), "failed housekeeping leaves durable stale metadata for later retry");
  db.failClear = false;
  await activate("A", witness);
  expect(!(await getImportDraft(db as unknown as IDBDatabase, "A")), "later recovery eventually removes stale committed Draft");
  const next = draft.createImages([file("same.png", "same-content", 1)]);
  expect(next[0]!.sourceImageId !== ids[0], "same File content receives a new identity");
  await draft.save(next, [], next);
  const priorWrite = draft.saveMetadata(next.map((image) => ({ ...image, confirmed: true })), []);
  const epoch = draft.generation;
  db.failClear = true;
  const retiring = draft.retireCommitted("A", epoch);
  const lateOldWrite = draft.saveMetadata(next.map((image) => ({ ...image, confirmed: false })), []);
  await priorWrite;
  const result = await retiring;
  await lateOldWrite;
  expect(result.retired && result.cleanupError, "failed retirement returns housekeeping warning");
  await draft.flush();
  const retained = await getImportDraft(db as unknown as IDBDatabase, "A");
  expect(retained?.draft.images[0]?.confirmed === true, "retirement follows prior metadata writes and invalidates later old writes");
  draft.releaseImages(next);
  const refreshed = await activate("A", witness);
  expect(refreshed.images[0]?.sourceImageId === next[0]!.sourceImageId, "new source IDs survive old committed witness despite identical filename and content");
  let strictFailed = false;
  try { await draft.clear(); } catch { strictFailed = true; }
  expect(strictFailed && await getImportDraft(db as unknown as IDBDatabase, "A"), "ordinary clear still rejects and retains durable Draft on failure");
  db.failClear = false;
  await draft.saveMetadata(refreshed.images, []);
  await draft.flush();
  await draft.activate("B");
  const b = draft.createImages([file("B.png", "B", 1)]);
  await draft.save(b, [], b);
  db.failClear = true;
  await draft.retireCommitted("B", draft.generation);
  await draft.flush();
  const a = await activate("A", witness);
  expect(a.images.length === 1, "post-commit cleanup failure does not poison account switch or restore");
  db.failClear = false;
  draft.releaseAll();
  expect(created.every((url) => revoked.filter((item) => item === url).length === 1), "P5 owned URLs revoke exactly once");
  console.log("PASS P5 Draft recovery: exact identities, cleanup retry, queue ordering, strict clear and account recovery");
}

// Actual repository commit -> retirement -> persisted review, including failed housekeeping.
for (const failCleanup of [false, true]) {
  const db = new FakeDatabase();
  for (const name of ["meta", "accounts", "workspaces", "images", "restorePoints", "restorePointImages", "importDrafts", "importDraftImages"]) db.createObjectStore(name);
  const idb = db as unknown as IDBDatabase;
  const revoked: string[] = [];
  const controller = new ProductImportDraftController({ openDatabase: async () => idb, urls: {
    createObjectUrl: () => `blob:committed-${failCleanup}`, revokeObjectUrl: (url) => { revoked.push(url); },
  } });
  await controller.activate("A");
  let images = controller.createImages([file("same.png", "durable-source", 1)]);
  await controller.save(images, [], images);
  const image = images[0]!;
  const catalog = createStarCatalog([{ name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null }], {});
  const candidate = { occurrenceId: "occ", sourceImageId: image.sourceImageId, sourceOrder: 1, row: 0, column: 0,
    kind: "主星" as const, name: "天府", level: 10, quality: "橙" as const, qualityConfidence: 1, equippedState: "unknown" as const };
  const draft: ReconcileDraftV1 = {
    schemaVersion: 1, task: { taskId: "job", accountId: "A", baseRevision: 0 }, status: "ready_to_finalize", blockReasonCodes: [],
    candidates: [candidate], occurrences: [{ ...candidate, completeness: "complete", nameConfidence: 1, levelConfidence: 1,
      reviewRequired: false, inventoryAction: "keep", removedFromCurrentInventory: false, manualOverride: false }],
    ordinaryGroups: [{ groupId: "group", occurrenceIds: ["occ"], primaryOccurrenceId: "occ", duplicateRelationIds: [] }],
    ordinaryReviewItems: [], overlapReviewItems: [], duplicateRows: [], excludedOrdinaryOccurrences: [],
    bag: { currentCount: 1, capacity: 100, reviewReasonCodes: [] }, experience: { orange: 0, purple: 0, white: 0, reviewReasonCodes: [] },
    sourceImages: [{ sourceImageId: image.sourceImageId, sourceOrder: 1, suggestedPageType: "main", confirmedPool: "main", reviewRequired: false, warningCodes: [] }],
    confirmedOverlapPairs: [], overlapAuditItems: [], reviewReasonCodes: [],
  };
  let review: ReturnType<typeof buildPersistedProductReview> = null;
  let saved = false;
  const outcome = await runProductOcrCommitHandoff({
    commit: () => commitReconciledAnalysis({ db: idb, draft, catalog, gameVersion: "如鸢",
      sourceImages: [{ sourceImageId: image.sourceImageId, blob: image.file, filename: image.filename, mimeType: image.file.type, width: 100, height: 100 }],
      reviewRowRects: { [image.sourceImageId]: { "0": { x: 0, y: 0, width: 100, height: 30 } } } }),
    isCurrent: () => true,
    applyCommitted: () => { saved = true; db.failClear = failCleanup; },
    retireDraft: async () => { const result = await controller.retireCommitted("A", controller.generation); if (result.cleanupError) throw result.cleanupError; },
    retireMemory: () => { controller.releaseImages(images); images = []; },
    usePersistedReview: () => {},
  });
  const committed = await getWorkspace(idb, "A");
  expect(saved && committed?.revision === 1 && outcome === (failCleanup ? "cleanup_failed" : "saved"), "real workspace transaction remains successful after housekeeping");
  expect(images.length === 0 && revoked.length === 1, "real commit releases Draft memory and ownership once");
  const source = await getImage(idb, "A", image.sourceImageId);
  expect(source?.filename === image.filename && await source.blob.text() === "durable-source", "official source identity, filename and Blob survive Draft retirement");
  review = buildPersistedProductReview(committed.snapshot);
  expect(review && productReviewRowCropRect(review.evidence, image.sourceImageId, 0)?.height === 30, "refreshed review keeps persisted row crop geometry");
  const cropBlob = await reviewSourceBlob(null, image.sourceImageId, async (id) => (await getImage(idb, "A", id))?.blob);
  expect(cropBlob && await cropBlob.text() === "durable-source", "refreshed crop reads official source Blob without File/runContext");
  await controller.flush();
  const restored = await controller.activate("A", { accountId: "A", sourceImageIds: [source.imageId], reviewSourceImageIds: Object.keys(committed.snapshot.importReview.imageAudit) });
  expect(restored.images.length === 0 && await getWorkspace(idb, "A"), "failed cleanup refresh cannot resurrect Draft or remove workspace");
  db.failClear = false;
  await controller.activate("A", { accountId: "A", sourceImageIds: [source.imageId], reviewSourceImageIds: [source.imageId] });
  expect(!(await getImportDraft(idb, "A")), "eventual cleanup succeeds without a second OCR commit");
  console.log(`PASS real repository P5 commit, persisted review and refresh; cleanup failure=${failCleanup}`);
}
