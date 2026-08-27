import { browserCatalog } from "./business/browser-catalog.js";
import { createEmptyWorkspace, type WorkspaceStateV1 } from "./business/model.js";
import { commitReconciledAnalysis, type ReconcileDraftV1, type ReconcileResolutionV1, type ReconcileSourceImageInput } from "./business/reconcile.js";
import { WorkspaceSession, defaultStarInstanceId } from "./business/session.js";
import { WorkspaceRevisionConflictError, closeDatabase, commitWorkspaceTransaction, createAccountWorkspace, deleteAccountData, getAccount, getImage, getMeta, getRestorePoint, getRestorePointImage, getWorkspace, listAccounts, listImagesForAccount, listRestorePoints, openDatabase, putAccount, setMeta, updateAccountMetadata, type AccountRecord, type ImageRecord, type RestorePointInput, type RestorePointRecord, type WorkspaceRecord } from "./business/persistence/repository.js";
import { assertOcrSessionAccount } from "./product-account-session.js";
import type { Rect } from "./structured/contracts.js";

export const PRODUCT_CURRENT_ACCOUNT_META_KEY = "product.currentAccountId";
export const PRODUCT_DEMO_ACCOUNT_ID = "browser-product-demo-account";

export type ProductWorkspaceContext = { account: AccountRecord; record: WorkspaceRecord };
export type ProductAccountInput = Pick<AccountRecord, "displayName" | "gameVersion">;

function demoAccount(accountId: string): AccountRecord {
  const now = new Date().toISOString();
  return { accountId, displayName: "浏览器演示账号", gameVersion: "代号鸢", createdAt: now, updatedAt: now };
}

function defaultAccountId(): string {
  return `browser-product-account-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Workspace schema V1 gained persisted OCR-review evidence after early browser
 * builds had already written V1 records. Keep those records readable by only
 * filling absent review fields; all existing canonical data remains untouched.
 */
export function backfillLegacyWorkspaceSnapshot(snapshot: WorkspaceStateV1): { snapshot: WorkspaceStateV1; changed: boolean } {
  const defaults = createEmptyWorkspace(snapshot.accountId, snapshot.gameVersion).importReview;
  const source = record((snapshot as unknown as { importReview?: unknown }).importReview);
  // Shape validation remains centralized in restoreWorkspaceSnapshot; this
  // compatibility layer only preserves an existing JSON object verbatim.
  const operatorStarLoadouts = record((snapshot as unknown as { operatorStarLoadouts?: unknown }).operatorStarLoadouts) as WorkspaceStateV1["operatorStarLoadouts"] | null;
  const overlapPairs = record(source?.overlapPairs);
  const review = {
    ...defaults,
    ...(source ?? {}),
    imagePools: record(source?.imagePools) ?? defaults.imagePools,
    confirmedImagePools: Array.isArray(source?.confirmedImagePools) ? source.confirmedImagePools : defaults.confirmedImagePools,
    overlapPairs: { ...defaults.overlapPairs, ...(overlapPairs ?? {}) },
    overlapAudit: Array.isArray(source?.overlapAudit) ? source.overlapAudit : defaults.overlapAudit,
    imageAudit: record(source?.imageAudit) ?? defaults.imageAudit,
    occurrences: record(source?.occurrences) ?? defaults.occurrences,
  } as WorkspaceStateV1["importReview"];
  const changed = !source
    || !operatorStarLoadouts
    || !record(source.imagePools)
    || !Array.isArray(source.confirmedImagePools)
    || !overlapPairs
    || !Array.isArray(source.overlapAudit)
    || !record(source.imageAudit)
    || !record(source.occurrences);
  return { snapshot: changed ? { ...snapshot, operatorStarLoadouts: operatorStarLoadouts ?? {}, importReview: review } : snapshot, changed };
}

/** Lightweight product bridge. It owns no business state beyond the committed record. */
export class ProductWorkspaceController {
  private db: IDBDatabase | null = null;
  private context: ProductWorkspaceContext | null = null;
  /** This lives only for the tab lifetime; reload/account changes intentionally clear it. */
  private session: WorkspaceSession | null = null;

  get current(): ProductWorkspaceContext | null { return this.context; }

  private async ensureCompatibleWorkspace(record: WorkspaceRecord): Promise<WorkspaceRecord> {
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    const backfilled = backfillLegacyWorkspaceSnapshot(record.snapshot);
    return backfilled.changed
      ? commitWorkspaceTransaction(this.db, { accountId: record.accountId, expectedRevision: record.revision, nextSnapshot: backfilled.snapshot })
      : record;
  }

  async load(): Promise<ProductWorkspaceContext> {
    this.db ??= await openDatabase();
    const resolved = await getMeta<string>(this.db, PRODUCT_CURRENT_ACCOUNT_META_KEY);
    const accounts = await listAccounts(this.db);
    let account = typeof resolved === "string" && resolved.trim() ? accounts.find((item) => item.accountId === resolved) : undefined;
    if (!account && accounts.length) account = accounts[0];
    let record: WorkspaceRecord | undefined;
    if (!account) {
      // Pre-account product builds already stored the demo workspace under this
      // stable key. Adopt it before creating anything so legacy inventory is
      // never replaced. A genuinely fresh product starts as an empty account.
      const legacyAccount = demoAccount(PRODUCT_DEMO_ACCOUNT_ID);
      record = await getWorkspace(this.db, legacyAccount.accountId);
      if (record) {
        account = legacyAccount;
        await putAccount(this.db, account);
      } else account = await this.createDefaultAccount();
    }
    record ??= await getWorkspace(this.db, account.accountId);
    if (!record) {
      record = await commitWorkspaceTransaction(this.db, { accountId: account.accountId, expectedRevision: 0, nextSnapshot: createEmptyWorkspace(account.accountId, account.gameVersion) });
    }
    record = await this.ensureCompatibleWorkspace(record);
    if (resolved !== account.accountId) await setMeta(this.db, PRODUCT_CURRENT_ACCOUNT_META_KEY, account.accountId);
    this.context = { account, record };
    this.session = new WorkspaceSession(record.snapshot, browserCatalog, defaultStarInstanceId);
    return this.context;
  }

  async listAccounts(): Promise<AccountRecord[]> {
    await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    return listAccounts(this.db);
  }

  async createAccount(input: ProductAccountInput): Promise<AccountRecord> {
    this.db ??= await openDatabase();
    const displayName = input.displayName.trim();
    if (!displayName) throw new Error("账号名称不能为空。");
    const now = new Date().toISOString();
    const account: AccountRecord = { accountId: defaultAccountId(), displayName, gameVersion: input.gameVersion, createdAt: now, updatedAt: now };
    await createAccountWorkspace(this.db, account, createEmptyWorkspace(account.accountId, account.gameVersion));
    return account;
  }

  async createDefaultAccount(): Promise<AccountRecord> {
    this.db ??= await openDatabase();
    const names = new Set((await listAccounts(this.db))
      .filter((account) => account.gameVersion === "如鸢")
      .map((account) => account.displayName));
    let suffix = 1;
    let displayName = "默认账号";
    while (names.has(displayName)) displayName = `默认账号${++suffix}`;
    return this.createAccount({ displayName, gameVersion: "如鸢" });
  }

  async switchAccount(accountId: string): Promise<ProductWorkspaceContext> {
    await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    const account = await getAccount(this.db, accountId);
    if (!account) throw new Error("目标账号不存在，已停止切换。");
    let record = await getWorkspace(this.db, accountId);
    if (!record) record = await commitWorkspaceTransaction(this.db, { accountId, expectedRevision: 0, nextSnapshot: createEmptyWorkspace(accountId, account.gameVersion) });
    record = await this.ensureCompatibleWorkspace(record);
    await setMeta(this.db, PRODUCT_CURRENT_ACCOUNT_META_KEY, accountId);
    this.context = { account, record };
    this.session = new WorkspaceSession(record.snapshot, browserCatalog, defaultStarInstanceId);
    return this.context;
  }

  async updateAccountMetadata(accountId: string, input: ProductAccountInput): Promise<ProductWorkspaceContext> {
    this.db ??= await openDatabase();
    const nextName = input.displayName.trim();
    if (!nextName) throw new Error("账号名称不能为空。");
    const updated = await updateAccountMetadata(this.db, { accountId, displayName: nextName, gameVersion: input.gameVersion });
    const context = { account: updated.account, record: updated.record };
    if (this.context?.account.accountId === accountId) {
      this.context = context;
      this.session = new WorkspaceSession(updated.record.snapshot, browserCatalog, defaultStarInstanceId);
    }
    return context;
  }

  async renameAccount(accountId: string, displayName: string): Promise<AccountRecord> {
    const account = await getAccount(this.db ??= await openDatabase(), accountId);
    if (!account) throw new Error("目标账号不存在，已停止重命名。");
    return (await this.updateAccountMetadata(accountId, { displayName, gameVersion: account.gameVersion })).account;
  }

  async deleteAccount(accountId: string): Promise<ProductWorkspaceContext | null> {
    await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    if (!await getAccount(this.db, accountId)) throw new Error("目标账号不存在，已停止删除。");
    const remaining = (await listAccounts(this.db)).filter((account) => account.accountId !== accountId);
    const wasCurrent = this.context?.account.accountId === accountId;
    await deleteAccountData(this.db, accountId);
    if (!wasCurrent) return this.context;
    if (remaining.length) return this.switchAccount(remaining[0]!.accountId);
    const fallback = await this.createDefaultAccount();
    return this.switchAccount(fallback.accountId);
  }

  async reload(): Promise<ProductWorkspaceContext> {
    if (!this.db || !this.context) return this.load();
    const [account, storedRecord] = await Promise.all([getAccount(this.db, this.context.account.accountId), getWorkspace(this.db, this.context.account.accountId)]);
    const record = storedRecord ? await this.ensureCompatibleWorkspace(storedRecord) : undefined;
    if (!account || !record) throw new Error("当前工作区不存在或无法读取。");
    this.context = { account, record };
    this.session = new WorkspaceSession(record.snapshot, browserCatalog, defaultStarInstanceId);
    return this.context;
  }

  async readLatestCommitted(): Promise<ProductWorkspaceContext> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    const record = await getWorkspace(this.db, current.account.accountId);
    if (!record) throw new Error("当前工作区不存在或无法读取。");
    return { account: current.account, record };
  }

  get canUndo(): boolean { return this.session?.history.canUndo ?? false; }
  get canRedo(): boolean { return this.session?.history.canRedo ?? false; }

  private restoreInput(reason: string, images: ImageRecord[]): RestorePointInput {
    return {
      restorePointId: defaultStarInstanceId(), reason, createdAt: new Date().toISOString(), imageIds: images.map((image) => image.imageId),
      images: images.map((image) => ({ imageId: image.imageId, blob: image.blob, metadata: { filename: image.filename, mimeType: image.mimeType, width: image.width, height: image.height } })),
    };
  }

  private async commitSession(): Promise<ProductWorkspaceContext> {
    const current = this.context;
    const session = this.session;
    if (!current || !session || !this.db) throw new Error("当前工作区尚未加载。");
    try {
      const committed = await commitWorkspaceTransaction(this.db, { accountId: current.account.accountId, expectedRevision: current.record.revision, nextSnapshot: session.state });
      this.context = { account: current.account, record: committed };
      return this.context;
    } catch (error) {
      // A failed IndexedDB write must not leave an invisible in-memory branch.
      await this.reload();
      throw error;
    }
  }

  async mutate<T>(mutation: (session: WorkspaceSession) => T): Promise<{ context: ProductWorkspaceContext; result: T }> {
    await (this.context ? Promise.resolve() : this.load());
    const session = this.session;
    if (!session) throw new Error("当前工作区尚未加载。");
    try {
      const result = mutation(session);
      return { context: await this.commitSession(), result };
    } catch (error) {
      // Mutation callbacks may validate after changing more than one field.
      // The stored workspace remains authoritative for every failed operation.
      await this.reload();
      throw error;
    }
  }

  async undo(): Promise<ProductWorkspaceContext | null> {
    await (this.context ? Promise.resolve() : this.load());
    if (!this.session?.undo()) return null;
    return this.commitSession();
  }

  async redo(): Promise<ProductWorkspaceContext | null> {
    await (this.context ? Promise.resolve() : this.load());
    if (!this.session?.redo()) return null;
    return this.commitSession();
  }

  async listLatestRestorePoints(): Promise<RestorePointRecord[]> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    return (await listRestorePoints(this.db, current.account.accountId)).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 3);
  }

  async listCurrentImages(): Promise<ImageRecord[]> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    return listImagesForAccount(this.db, current.account.accountId);
  }

  async getCurrentImage(imageId: string): Promise<ImageRecord | undefined> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    return getImage(this.db, current.account.accountId, imageId);
  }

  async commitOcrReconcile(input: { sessionAccountId: string; draft: ReconcileDraftV1; resolution?: ReconcileResolutionV1; sourceImages: ReconcileSourceImageInput[]; reviewRowRects?: Record<string, Record<string, Rect>> }): Promise<ProductWorkspaceContext> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    assertOcrSessionAccount({ sessionAccountId: input.sessionAccountId, draftAccountId: input.draft.task.accountId, currentAccountId: current.account.accountId, sessionAccountExists: Boolean(await getAccount(this.db, input.sessionAccountId)) });
    try {
      const committed = await commitReconciledAnalysis({
        db: this.db,
        draft: input.draft,
        resolution: input.resolution,
        catalog: browserCatalog,
        gameVersion: current.account.gameVersion,
        sourceImages: input.sourceImages,
        reviewRowRects: input.reviewRowRects,
      });
      this.context = { account: current.account, record: committed };
      this.session = new WorkspaceSession(committed.snapshot, browserCatalog, defaultStarInstanceId);
      return this.context;
    } catch (error) {
      if (error instanceof WorkspaceRevisionConflictError) await this.reload();
      throw error;
    }
  }

  async replaceWorkspace(nextSnapshot: WorkspaceStateV1, restoreReason = "导入数据前安全恢复点"): Promise<ProductWorkspaceContext> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    const currentImages = await listImagesForAccount(this.db, current.account.accountId);
    const replacement: WorkspaceStateV1 = { ...nextSnapshot, accountId: current.account.accountId, gameVersion: current.account.gameVersion, revision: current.record.revision };
    const committed = await commitWorkspaceTransaction(this.db, { accountId: current.account.accountId, expectedRevision: current.record.revision, nextSnapshot: replacement, imageDeletes: currentImages.map((image) => image.imageId), optionalRestorePoint: this.restoreInput(restoreReason, currentImages) });
    this.context = { account: current.account, record: committed };
    this.session = new WorkspaceSession(committed.snapshot, browserCatalog, defaultStarInstanceId);
    return this.context;
  }

  async restoreRestorePoint(restorePointId: string): Promise<ProductWorkspaceContext> {
    const current = this.context ?? await this.load();
    if (!this.db) throw new Error("IndexedDB 尚未打开。");
    const point = await getRestorePoint(this.db, current.account.accountId, restorePointId);
    if (!point) throw new Error("该恢复点已不存在，请刷新列表后重试。");
    const currentImages = await listImagesForAccount(this.db, current.account.accountId);
    const pointImages = await Promise.all(point.imageIds.map((imageId) => getRestorePointImage(this.db!, current.account.accountId, restorePointId, imageId)));
    if (pointImages.some((image) => !image)) throw new Error("恢复点图片不完整，已停止恢复以保护当前数据。");
    const snapshot: WorkspaceStateV1 = { ...point.snapshot, accountId: current.account.accountId, gameVersion: current.account.gameVersion, revision: current.record.revision };
    const committed = await commitWorkspaceTransaction(this.db, { accountId: current.account.accountId, expectedRevision: current.record.revision, nextSnapshot: snapshot, imageUpserts: pointImages.filter((image): image is NonNullable<typeof image> => Boolean(image)).map((image) => ({ imageId: image.imageId, blob: image.blob, filename: typeof (image.metadata as Record<string, unknown>).filename === "string" ? (image.metadata as Record<string, unknown>).filename as string : image.imageId, mimeType: typeof (image.metadata as Record<string, unknown>).mimeType === "string" ? (image.metadata as Record<string, unknown>).mimeType as string : "application/octet-stream", width: typeof (image.metadata as Record<string, unknown>).width === "number" ? (image.metadata as Record<string, unknown>).width as number : null, height: typeof (image.metadata as Record<string, unknown>).height === "number" ? (image.metadata as Record<string, unknown>).height as number : null, createdAt: new Date().toISOString() })), imageDeletes: currentImages.map((image) => image.imageId).filter((imageId) => !point.imageIds.includes(imageId)), optionalRestorePoint: this.restoreInput("手动恢复前安全点", currentImages) });
    this.context = { account: current.account, record: committed };
    this.session = new WorkspaceSession(committed.snapshot, browserCatalog, defaultStarInstanceId);
    return this.context;
  }

  async dispose(): Promise<void> { if (this.db) closeDatabase(this.db); this.db = null; this.context = null; this.session = null; }
}

export { WorkspaceRevisionConflictError };
