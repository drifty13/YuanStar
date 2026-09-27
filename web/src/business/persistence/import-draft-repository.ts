import type { ProductImportImage, ProductOverlapPair } from "../../product-ocr-import.js";

/** Pre-OCR state. It is deliberately separate from WorkspaceStateV1 and OCR evidence. */
export type ImportDraftImageMetadata = Omit<ProductImportImage, "file" | "objectUrl">;

export interface ImportDraftRecord {
  accountId: string;
  schemaVersion: 1;
  updatedAt: string;
  imageOrder: string[];
  images: ImportDraftImageMetadata[];
  overlapPairs: ProductOverlapPair[];
}

export interface ImportDraftImageRecord {
  accountId: string;
  sourceImageId: string;
  blob: Blob;
  filename: string;
  mimeType: string;
  lastModified: number;
}

export interface ImportDraftSnapshot {
  draft: ImportDraftRecord;
  imageBlobs: ImportDraftImageRecord[];
}

export type ImportDraftMetadataInput = Pick<ImportDraftRecord, "accountId" | "imageOrder" | "images" | "overlapPairs">;
export interface ReplaceImportDraftInput extends ImportDraftMetadataInput {
  imageBlobs: Array<Omit<ImportDraftImageRecord, "accountId">>;
}
export interface SaveImportDraftInput extends ImportDraftMetadataInput {
  /** Only new or changed files need to be supplied; retained Blobs are not rewritten. */
  imageBlobs: Array<Omit<ImportDraftImageRecord, "accountId">>;
}

export class ImportDraftIntegrityError extends Error {
  readonly code = "import_draft_integrity_error";
  constructor(message: string) { super(message); this.name = "ImportDraftIntegrityError"; }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Import Draft IndexedDB 请求失败"));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Import Draft transaction 已中止"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Import Draft transaction 失败"));
  });
}

function metadataOnly(input: ImportDraftMetadataInput): ImportDraftRecord {
  if (!input.accountId || new Set(input.imageOrder).size !== input.imageOrder.length || input.imageOrder.length !== input.images.length ||
      input.images.some((image, index) => !image.sourceImageId || image.sourceImageId !== input.imageOrder[index])) {
    throw new ImportDraftIntegrityError("Import Draft 图片顺序与 metadata 不匹配");
  }
  return {
    accountId: input.accountId, schemaVersion: 1, updatedAt: new Date().toISOString(),
    imageOrder: [...input.imageOrder],
    images: input.images.map((image) => ({
      sourceImageId: image.sourceImageId, filename: image.filename, size: image.size,
      pool: image.pool, confirmed: image.confirmed, suggestedPool: image.suggestedPool,
      classificationStatus: image.classificationStatus, classificationReviewRequired: image.classificationReviewRequired,
      poolSource: image.poolSource, width: image.width, height: image.height,
    })),
    overlapPairs: input.overlapPairs.map((pair) => ({ pairId: pair.pairId, pool: pair.pool, beforeId: pair.beforeId, afterId: pair.afterId })),
  };
}

function validateBlob(image: ImportDraftImageMetadata, record: Omit<ImportDraftImageRecord, "accountId">): void {
  if (record.sourceImageId !== image.sourceImageId || !(record.blob instanceof Blob) ||
      record.blob.size !== image.size || record.filename !== image.filename || !record.filename ||
      typeof record.mimeType !== "string" || record.blob.type !== record.mimeType ||
      !Number.isFinite(record.lastModified) || record.lastModified < 0) {
    throw new ImportDraftIntegrityError(`Import Draft 图片 ${image.sourceImageId} 的 Blob 或 File metadata 缺失/不匹配`);
  }
}

function accountImageKeys(keys: IDBValidKey[], accountId: string): IDBValidKey[] {
  return keys.filter((key) => Array.isArray(key) && key[0] === accountId);
}

/** Reads metadata and every Blob in one readonly transaction; corrupt drafts fail explicitly. */
export async function getImportDraft(db: IDBDatabase, accountId: string): Promise<ImportDraftSnapshot | undefined> {
  const transaction = db.transaction(["importDrafts", "importDraftImages"], "readonly");
  const done = transactionComplete(transaction);
  const draftStore = transaction.objectStore("importDrafts");
  const imageStore = transaction.objectStore("importDraftImages");
  const draft = await requestResult<ImportDraftRecord | undefined>(draftStore.get(accountId));
  if (!draft) { await done; return undefined; }
  const imageBlobs = await Promise.all(draft.imageOrder.map((sourceImageId) =>
    requestResult<ImportDraftImageRecord | undefined>(imageStore.get([accountId, sourceImageId]))));
  await done;
  const checked = metadataOnly(draft);
  if (draft.schemaVersion !== 1 || draft.accountId !== accountId || imageBlobs.some((item) => !item)) {
    throw new ImportDraftIntegrityError(`Import Draft ${accountId} 的 metadata 或 Blob 缺失`);
  }
  imageBlobs.forEach((item, index) => validateBlob(checked.images[index]!, item!));
  return { draft, imageBlobs: imageBlobs as ImportDraftImageRecord[] };
}

/** Replaces metadata and all account-owned draft Blobs atomically. */
export async function replaceImportDraft(db: IDBDatabase, input: ReplaceImportDraftInput): Promise<ImportDraftRecord> {
  const draft = metadataOnly(input);
  if (input.imageBlobs.length !== draft.images.length) throw new ImportDraftIntegrityError("Import Draft Blob 数量不匹配");
  input.imageBlobs.forEach((image, index) => validateBlob(draft.images[index]!, image));
  const transaction = db.transaction(["importDrafts", "importDraftImages"], "readwrite");
  const done = transactionComplete(transaction);
  const imageStore = transaction.objectStore("importDraftImages");
  try {
    const keys = await requestResult<IDBValidKey[]>(imageStore.getAllKeys());
    accountImageKeys(keys, input.accountId).forEach((key) => imageStore.delete(key));
    input.imageBlobs.forEach((image) => imageStore.put({
      accountId: input.accountId, sourceImageId: image.sourceImageId, blob: image.blob,
      filename: image.filename, mimeType: image.mimeType, lastModified: image.lastModified,
    } satisfies ImportDraftImageRecord));
    transaction.objectStore("importDrafts").put(draft);
    await done;
    return draft;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction may already have aborted */ }
    try { await done; } catch { /* expected after abort */ }
    throw error;
  }
}

/** Saves a draft or appends images while retaining existing account-owned Blobs. */
export async function saveImportDraft(db: IDBDatabase, input: SaveImportDraftInput): Promise<ImportDraftRecord> {
  const transaction = db.transaction(["importDrafts", "importDraftImages"], "readwrite");
  const done = transactionComplete(transaction);
  const draftStore = transaction.objectStore("importDrafts");
  const imageStore = transaction.objectStore("importDraftImages");
  try {
    const draft = metadataOnly(input);
    const supplied = new Map(input.imageBlobs.map((image) => [image.sourceImageId, image]));
    if (supplied.size !== input.imageBlobs.length || input.imageBlobs.some((image) => !draft.imageOrder.includes(image.sourceImageId))) {
      throw new ImportDraftIntegrityError("Import Draft Blob ID 重复或未包含在图片顺序中");
    }
    const retained = await Promise.all(draft.imageOrder.map((sourceImageId) => supplied.has(sourceImageId) ? undefined :
      requestResult<ImportDraftImageRecord | undefined>(imageStore.get([input.accountId, sourceImageId]))));
    draft.images.forEach((image, index) => {
      const blob = supplied.get(image.sourceImageId) ?? retained[index];
      if (!blob) throw new ImportDraftIntegrityError(`Import Draft 图片 ${image.sourceImageId} 缺失 Blob`);
      validateBlob(image, blob);
    });
    const keys = await requestResult<IDBValidKey[]>(imageStore.getAllKeys());
    accountImageKeys(keys, input.accountId)
      .filter((key) => !draft.imageOrder.includes((key as string[])[1]!))
      .forEach((key) => imageStore.delete(key));
    input.imageBlobs.forEach((image) => imageStore.put({
      accountId: input.accountId, sourceImageId: image.sourceImageId, blob: image.blob,
      filename: image.filename, mimeType: image.mimeType, lastModified: image.lastModified,
    } satisfies ImportDraftImageRecord));
    draftStore.put(draft);
    await done;
    return draft;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction may already have aborted */ }
    try { await done; } catch { /* expected after abort */ }
    throw error;
  }
}

/** Updates order, pools, classification and overlaps without writing retained Blobs. */
export async function saveImportDraftMetadata(db: IDBDatabase, input: ImportDraftMetadataInput): Promise<ImportDraftRecord> {
  const transaction = db.transaction(["importDrafts", "importDraftImages"], "readwrite");
  const done = transactionComplete(transaction);
  const draftStore = transaction.objectStore("importDrafts");
  const imageStore = transaction.objectStore("importDraftImages");
  try {
    const existing = await requestResult<ImportDraftRecord | undefined>(draftStore.get(input.accountId));
    if (!existing) throw new ImportDraftIntegrityError("Import Draft metadata 不存在；新 draft 必须提供 Blob");
    const draft = metadataOnly(input);
    const blobs = await Promise.all(draft.imageOrder.map((sourceImageId) =>
      requestResult<ImportDraftImageRecord | undefined>(imageStore.get([input.accountId, sourceImageId]))));
    if (blobs.some((item) => !item)) throw new ImportDraftIntegrityError("Import Draft metadata 引用了缺失的 Blob");
    blobs.forEach((item, index) => validateBlob(draft.images[index]!, item!));
    const keys = await requestResult<IDBValidKey[]>(imageStore.getAllKeys());
    accountImageKeys(keys, input.accountId)
      .filter((key) => !draft.imageOrder.includes((key as string[])[1]!))
      .forEach((key) => imageStore.delete(key));
    draftStore.put(draft);
    await done;
    return draft;
  } catch (error) {
    try { transaction.abort(); } catch { /* transaction may already have aborted */ }
    try { await done; } catch { /* expected after abort */ }
    throw error;
  }
}

export async function clearImportDraft(db: IDBDatabase, accountId: string): Promise<void> {
  const transaction = db.transaction(["importDrafts", "importDraftImages"], "readwrite");
  const done = transactionComplete(transaction);
  const imageStore = transaction.objectStore("importDraftImages");
  const keys = await requestResult<IDBValidKey[]>(imageStore.getAllKeys());
  accountImageKeys(keys, accountId).forEach((key) => imageStore.delete(key));
  transaction.objectStore("importDrafts").delete(accountId);
  await done;
}
