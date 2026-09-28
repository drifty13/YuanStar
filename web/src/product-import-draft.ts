import { openDatabase } from "./business/persistence/repository.js";
import { clearImportDraft, getImportDraft, replaceImportDraft, saveImportDraft, saveImportDraftMetadata, ImportDraftIntegrityError, type ImportDraftImageMetadata, type ImportDraftSnapshot, type SaveImportDraftInput } from "./business/persistence/import-draft-repository.js";
import { createProductImportImages, type ProductImportImage, type ProductOverlapPair } from "./product-ocr-import.js";

export interface ProductImportDraftState { images: ProductImportImage[]; overlapPairs: ProductOverlapPair[] }
export interface ProductImportDraftUrls { createObjectUrl(file: File): string; revokeObjectUrl(url: string): void }
const browserUrls: ProductImportDraftUrls = { createObjectUrl: (file) => URL.createObjectURL(file), revokeObjectUrl: (url) => URL.revokeObjectURL(url) };

function metadata(images: ProductImportImage[]): ImportDraftImageMetadata[] {
  return images.map(({ sourceImageId, filename, size, pool, confirmed, suggestedPool, classificationStatus, classificationReviewRequired, poolSource, width, height }) =>
    ({ sourceImageId, filename, size, pool, confirmed, suggestedPool, classificationStatus, classificationReviewRequired, poolSource, width, height }));
}
function input(accountId: string, images: ProductImportImage[], overlapPairs: ProductOverlapPair[]) {
  return { accountId, imageOrder: images.map(({ sourceImageId }) => sourceImageId), images: metadata(images), overlapPairs: overlapPairs.map((pair) => ({ ...pair })) };
}
function blobs(images: ProductImportImage[]): SaveImportDraftInput["imageBlobs"] {
  return images.map(({ sourceImageId, file, filename }) => ({ sourceImageId, blob: file, filename, mimeType: file.type, lastModified: file.lastModified }));
}

/** A pending classification has no surviving Promise after refresh. Require manual review. */
export function normalizeRestoredClassification(image: ImportDraftImageMetadata): ImportDraftImageMetadata {
  return image.classificationStatus !== "classifying" ? image : {
    ...image, pool: image.poolSource === "manual" ? image.pool : "主星", confirmed: false,
    suggestedPool: null, classificationStatus: "failed", classificationReviewRequired: true,
    poolSource: image.poolSource === "manual" ? "manual" : "fallback",
  };
}

/** Rebuilds Files and URLs atomically from a validated repository snapshot. */
export function restoreProductImportDraft(snapshot: ImportDraftSnapshot | undefined, urls: ProductImportDraftUrls = browserUrls): ProductImportDraftState {
  if (!snapshot) return { images: [], overlapPairs: [] };
  const created: string[] = [];
  try {
    if (snapshot.draft.imageOrder.length !== snapshot.draft.images.length || snapshot.imageBlobs.length !== snapshot.draft.images.length) throw new ImportDraftIntegrityError("Import Draft 图片数量不匹配");
    const images = snapshot.draft.images.map((raw, index): ProductImportImage => {
      const stored = snapshot.imageBlobs[index];
      if (snapshot.draft.imageOrder[index] !== raw.sourceImageId || !stored || stored.sourceImageId !== raw.sourceImageId ||
          !(stored.blob instanceof Blob) || stored.blob.size !== raw.size || stored.filename !== raw.filename ||
          stored.blob.type !== stored.mimeType || !Number.isFinite(stored.lastModified)) throw new ImportDraftIntegrityError(`Import Draft 图片 ${raw.sourceImageId} 无法恢复 File`);
      const file = new File([stored.blob], stored.filename, { type: stored.mimeType, lastModified: stored.lastModified });
      const objectUrl = urls.createObjectUrl(file);
      created.push(objectUrl);
      return { ...normalizeRestoredClassification(raw), file, objectUrl };
    });
    return { images, overlapPairs: snapshot.draft.overlapPairs.map((pair) => ({ ...pair })) };
  } catch (error) { created.forEach((url) => urls.revokeObjectUrl(url)); throw error; }
}

/** Owns Draft URLs and serializes account-scoped IndexedDB writes. */
export class ProductImportDraftController {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private lastError: unknown = null;
  private accountId: string | null = null;
  private epoch = 0;
  private urlsOwned = new Set<string>();
  constructor(private readonly options: { openDatabase?: () => Promise<IDBDatabase>; urls?: ProductImportDraftUrls } = {}) {}
  get generation(): number { return this.epoch; }
  get currentAccountId(): string | null { return this.accountId; }
  isCurrent(accountId: string, generation: number): boolean { return this.accountId === accountId && this.epoch === generation; }
  private get urls(): ProductImportDraftUrls { return this.options.urls ?? browserUrls; }
  private database(): Promise<IDBDatabase> { return this.dbPromise ??= (this.options.openDatabase ?? openDatabase)(); }
  createImages(files: Iterable<File>): ProductImportImage[] {
    const created: string[] = [];
    try { return createProductImportImages(files, { createObjectUrl: (file) => { const url = this.urls.createObjectUrl(file); created.push(url); this.urlsOwned.add(url); return url; } }); }
    catch (error) { created.forEach((url) => { this.urlsOwned.delete(url); this.urls.revokeObjectUrl(url); }); throw error; }
  }
  releaseImages(images: ProductImportImage[]): void { images.forEach(({ objectUrl }) => { if (this.urlsOwned.delete(objectUrl)) this.urls.revokeObjectUrl(objectUrl); }); }
  releaseAll(): void { for (const url of this.urlsOwned) this.urls.revokeObjectUrl(url); this.urlsOwned.clear(); }
  private enqueue<T>(accountId: string, epoch: number, write: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> {
    if (this.accountId !== accountId) return Promise.reject(new Error("Import Draft 账号不可用"));
    let executed = false;
    const result = this.tail.then(async () => { if (!this.isCurrent(accountId, epoch)) return undefined; executed = true; return write(await this.database()); });
    this.tail = result.then(() => { if (executed) this.lastError = null; }, (error: unknown) => { this.lastError = error; });
    return result;
  }
  async flush(): Promise<void> { await this.tail; if (this.lastError) throw this.lastError; }
  async activate(accountId: string): Promise<ProductImportDraftState> {
    await this.flush();
    const epoch = ++this.epoch;
    this.accountId = accountId;
    const snapshot = await getImportDraft(await this.database(), accountId);
    const state = restoreProductImportDraft(snapshot, this.urls);
    if (!this.isCurrent(accountId, epoch)) { state.images.forEach(({ objectUrl }) => this.urls.revokeObjectUrl(objectUrl)); throw new Error("Import Draft 恢复期间账号已切换"); }
    if (snapshot?.draft.images.some(({ classificationStatus }) => classificationStatus === "classifying")) {
      try { await this.saveMetadata(state.images, state.overlapPairs); }
      catch (error) { state.images.forEach(({ objectUrl }) => this.urls.revokeObjectUrl(objectUrl)); throw error; }
    }
    this.releaseAll();
    state.images.forEach(({ objectUrl }) => this.urlsOwned.add(objectUrl));
    return state;
  }
  save(images: ProductImportImage[], pairs: ProductOverlapPair[], newImages: ProductImportImage[]): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const value = { ...input(accountId, images, pairs), imageBlobs: blobs(newImages) };
    return this.enqueue(accountId, this.epoch, async (db) => { await saveImportDraft(db, value); }).then(() => undefined);
  }
  saveMetadata(images: ProductImportImage[], pairs: ProductOverlapPair[]): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const value = input(accountId, images, pairs);
    return this.enqueue(accountId, this.epoch, async (db) => { await saveImportDraftMetadata(db, value); }).then(() => undefined);
  }
  replace(images: ProductImportImage[], pairs: ProductOverlapPair[]): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const epoch = ++this.epoch;
    return this.enqueue(accountId, epoch, async (db) => { await replaceImportDraft(db, { ...input(accountId, images, pairs), imageBlobs: blobs(images) }); }).then(() => undefined);
  }
  clear(): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const epoch = ++this.epoch;
    return this.enqueue(accountId, epoch, async (db) => { await clearImportDraft(db, accountId); }).then(() => undefined);
  }
}
