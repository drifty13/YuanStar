import type { BackupRecord, StoredOcrRecord } from "./types";

const DB_NAME = "yuanstar-browser-ocr-poc";
const STORE_NAME = "ocr-records";
const DB_VERSION = 1;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开 IndexedDB"));
  });
}

export async function saveRecord(record: StoredOcrRecord): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    await requestResult(transaction.objectStore(STORE_NAME).put(record));
  } finally {
    db.close();
  }
}

export async function latestRecord(): Promise<StoredOcrRecord | undefined> {
  const db = await openDatabase();
  try {
    const records = await requestResult(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()) as StoredOcrRecord[];
    return records.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  } finally {
    db.close();
  }
}

export async function deleteRecord(id?: string): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    if (id) await requestResult(store.delete(id));
    else await requestResult(store.clear());
  } finally {
    db.close();
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片 Blob"));
    reader.readAsDataURL(blob);
  });
}

export async function toBackup(record: StoredOcrRecord): Promise<BackupRecord> {
  const { image_blob, ...rest } = record;
  return { ...rest, image_data_url: await blobToDataUrl(image_blob), image_mime_type: image_blob.type };
}

export async function fromBackup(backup: BackupRecord): Promise<StoredOcrRecord> {
  if (backup.schema_version !== 1 || !backup.image_data_url?.startsWith("data:image/")) {
    throw new Error("备份格式或 schema_version 不受支持");
  }
  const separator = backup.image_data_url.indexOf(",");
  if (separator < 0) throw new Error("备份图片 data URL 无效");
  const header = backup.image_data_url.slice(0, separator);
  const payload = backup.image_data_url.slice(separator + 1);
  const mime = /^data:([^;,]+)/u.exec(header)?.[1] ?? backup.image_mime_type;
  const binary = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const image_blob = new Blob([bytes], { type: mime });
  const { image_data_url: _data, image_mime_type: _mime, ...rest } = backup;
  return { ...rest, image_blob };
}
