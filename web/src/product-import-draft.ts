import { openDatabase } from "./business/persistence/repository.js";
import { clearImportDraft, getImportDraft, replaceImportDraft, saveImportDraft, saveImportDraftMetadata, ImportDraftIntegrityError, type ImportDraftImageMetadata, type ImportDraftSnapshot, type SaveImportDraftInput } from "./business/persistence/import-draft-repository.js";
import { createProductImportImages, type ProductImportImage, type ProductOverlapPair } from "./product-ocr-import.js";
import { isCommittedImportDraft, type CommittedDraftSources } from "./product-ocr-commit-handoff.js";

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

export interface ImportDraftFailureDiagnostic { phase: string; name: string; message: string; code?: string | number }
export function describeImportDraftFailure(error: unknown, phase: string): ImportDraftFailureDiagnostic {
  const value = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  return { phase, name: typeof value?.name === "string" ? value.name : "UnknownError",
    message: typeof value?.message === "string" ? value.message : String(error),
    ...(typeof value?.code === "string" || typeof value?.code === "number" ? { code: value.code } : {}) };
}

/** Owns Draft URLs and serializes account-scoped IndexedDB writes. */
export class ProductImportDraftController {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private lastError: unknown = null;
  private blockedMetadataError: unknown = null;
  private diagnostic: ImportDraftFailureDiagnostic | null = null;
  private accountId: string | null = null;
  private epoch = 0;
  private urlsOwned = new Set<string>();
  constructor(private readonly options: { openDatabase?: () => Promise<IDBDatabase>; urls?: ProductImportDraftUrls } = {}) {}
  get persistenceFailure(): ImportDraftFailureDiagnostic | null { return this.diagnostic ? { ...this.diagnostic } : null; }
  get generation(): number { return this.epoch; }
  get currentAccountId(): string | null { return this.accountId; }
  isCurrent(accountId: string, generation: number): boolean { return this.accountId === accountId && this.epoch === generation; }
  private get urls(): ProductImportDraftUrls { return this.options.urls ?? browserUrls; }
  private database(): Promise<IDBDatabase> {
    return this.dbPromise ??= (this.options.openDatabase ?? openDatabase)().catch((error: unknown) => { this.dbPromise = null; throw error; });
  }
  createImages(files: Iterable<File>): ProductImportImage[] {
    const created: string[] = [];
    try { return createProductImportImages(files, { createObjectUrl: (file) => { const url = this.urls.createObjectUrl(file); created.push(url); this.urlsOwned.add(url); return url; } }); }
    catch (error) { created.forEach((url) => { this.urlsOwned.delete(url); this.urls.revokeObjectUrl(url); }); throw error; }
  }
  releaseImages(images: ProductImportImage[]): void { images.forEach(({ objectUrl }) => { if (this.urlsOwned.delete(objectUrl)) this.urls.revokeObjectUrl(objectUrl); }); }
  releaseAll(): void { for (const url of this.urlsOwned) this.urls.revokeObjectUrl(url); this.urlsOwned.clear(); }
  private enqueue<T>(accountId: string, epoch: number, write: (db: IDBDatabase) => Promise<T>, housekeeping = false, operation = "save"): Promise<T | undefined> {
    if (this.accountId !== accountId) return Promise.reject(new Error("Import Draft 账号不可用"));
    let executed = false;
    let phase = "open_database";
    const result = this.tail.then(async () => {
      if (!this.isCurrent(accountId, epoch)) return undefined;
      // Metadata alone cannot repair a failed Blob/metadata transaction.
      if (operation === "metadata" && this.blockedMetadataError) throw this.blockedMetadataError;
      executed = true;
      const db = await this.database();
      if (!this.isCurrent(accountId, epoch)) return undefined;
      phase = operation;
      return write(db);
    });
    this.tail = result.then(() => {
      if (executed && this.isCurrent(accountId, epoch)) { this.lastError = null; this.blockedMetadataError = null; this.diagnostic = null; }
    }, (error: unknown) => {
      if (!this.isCurrent(accountId, epoch) || housekeeping) return;
      if (this.lastError !== error) {
        this.diagnostic = describeImportDraftFailure(error, phase);
        console.warn("[Import Draft]", this.diagnostic);
      }
      this.lastError = error;
      if (operation === "save" || operation === "metadata") this.blockedMetadataError = error;
    });
    return result;
  }

  async flush(): Promise<void> { await this.tail; if (this.lastError) throw this.lastError; }
  async activate(accountId: string, committed?: CommittedDraftSources): Promise<ProductImportDraftState> {
    await this.flush();
    const epoch = ++this.epoch;
    this.accountId = accountId;
    const snapshot = await getImportDraft(await this.database(), accountId);
    if (!this.isCurrent(accountId, epoch)) throw new Error("Import Draft 恢复期间账号已切换");
    if (snapshot && isCommittedImportDraft(snapshot.draft, committed)) {
      // Suppress before rebuilding Files/URLs, even when a retry of housekeeping fails.
      await this.retireCommitted(accountId, epoch);
      if (!this.isCurrent(accountId, epoch + 1)) throw new Error("Import Draft 恢复期间账号已切换");
      this.releaseAll();
      return { images: [], overlapPairs: [] };
    }
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
    return this.enqueue(accountId, this.epoch, async (db) => { await saveImportDraft(db, this.lastError ? { ...value, imageBlobs: blobs(images) } : value); }).then(() => undefined);
  }
  saveMetadata(images: ProductImportImage[], pairs: ProductOverlapPair[]): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const value = input(accountId, images, pairs);
    return this.enqueue(accountId, this.epoch, async (db) => { await saveImportDraftMetadata(db, value); }, false, "metadata").then(() => undefined);
  }
  replace(images: ProductImportImage[], pairs: ProductOverlapPair[]): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const epoch = ++this.epoch;
    return this.enqueue(accountId, epoch, async (db) => { await replaceImportDraft(db, { ...input(accountId, images, pairs), imageBlobs: blobs(images) }); }, false, "replace").then(() => undefined);
  }
  clear(): Promise<void> {
    const accountId = this.accountId; if (!accountId) return Promise.reject(new Error("Import Draft 账号尚未确定"));
    const epoch = ++this.epoch;
    return this.enqueue(accountId, epoch, async (db) => { await clearImportDraft(db, accountId); }, false, "clear").then(() => undefined);
  }

  /** Runs after prior writes; invalidates later old writes without poisoning strict flush/clear. */
  async retireCommitted(accountId: string, epoch: number): Promise<{ retired: boolean; cleanupError?: unknown }> {
    if (!this.isCurrent(accountId, epoch)) return { retired: false };
    try {
      const retired = await this.enqueue(accountId, epoch, async (db) => {
        if (!this.isCurrent(accountId, epoch)) return false;
        ++this.epoch;
        await clearImportDraft(db, accountId);
        return true;
      }, true);
      return { retired: retired === true };
    } catch (cleanupError) {
      if (this.isCurrent(accountId, epoch)) ++this.epoch;
      return { retired: true, cleanupError };
    }
  }
}
