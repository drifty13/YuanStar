import { createEmptyWorkspace } from "../src/business/model.js";
import { commitWorkspaceTransaction, getAccount, getMeta, getWorkspace, openDatabase, putAccount, type AccountRecord } from "../src/business/persistence/repository.js";
import type { ReconcileDraftV1 } from "../src/business/reconcile.js";
import { PRODUCT_CURRENT_ACCOUNT_META_KEY, PRODUCT_DEMO_ACCOUNT_ID, ProductWorkspaceController, backfillLegacyWorkspaceSnapshot } from "../src/product-workspace.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

function emptyOcrDraft(accountId: string, baseRevision: number): ReconcileDraftV1 {
  return {
    schemaVersion: 1, task: { taskId: "account-session-test", accountId, baseRevision }, status: "ready_to_finalize", blockReasonCodes: [],
    candidates: [], occurrences: [], ordinaryGroups: [], ordinaryReviewItems: [], overlapReviewItems: [], duplicateRows: [], excludedOrdinaryOccurrences: [],
    bag: { currentCount: null, capacity: null, reviewReasonCodes: [] }, experience: { orange: null, purple: null, white: null, reviewReasonCodes: [] },
    sourceImages: [], confirmedOverlapPairs: [], overlapAuditItems: [], reviewReasonCodes: [],
  };
}

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
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
  abort(): void { if (!this.settled) { this.settled = true; queueMicrotask(() => this.onabort?.()); } }
  private records(name: string): StoreRecords { const records = this.working.get(name); if (!records) throw new Error(`missing store ${name}`); return records; }
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
  stores = new Map<string, StoreRecords>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(): FakeTransaction { return new FakeTransaction(this); }
  close(): void { /* no-op for test database */ }
}

class FakeIndexedDb {
  private readonly databases = new Map<string, FakeDatabase>();
  open(name: string): FakeRequest<FakeDatabase> {
    const request = new FakeRequest<FakeDatabase>();
    queueMicrotask(() => {
      let database = this.databases.get(name);
      const isNew = !database;
      if (!database) { database = new FakeDatabase(); this.databases.set(name, database); }
      request.result = database;
      if (isNew) request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  }
}

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FakeIndexedDb() as unknown as IDBFactory;

const freshController = new ProductWorkspaceController();
const fresh = await freshController.load();
expect(fresh.account.gameVersion === "如鸢" && fresh.account.displayName === "默认账号", "a genuinely fresh database must start with the empty 如鸢 default account");
expect(fresh.record.snapshot.inventory.length === 0 && Object.keys(fresh.record.snapshot.planTargets).length === 0 && fresh.record.snapshot.bag.currentCount === null && fresh.record.snapshot.bag.capacity === null && fresh.record.snapshot.experience.orange === null && fresh.record.snapshot.experience.purple === null && fresh.record.snapshot.experience.white === null && Object.keys(fresh.record.snapshot.importReview.occurrences).length === 0, "a genuinely fresh database must not seed demo workspace data");
expect((await freshController.listCurrentImages()).length === 0 && (await freshController.listLatestRestorePoints()).length === 0 && !(await freshController.listAccounts()).some((account) => account.accountId === PRODUCT_DEMO_ACCOUNT_ID), "a fresh default account must have no images, restore points, or demo account");
const afterFreshLastDelete = await freshController.deleteAccount(fresh.account.accountId);
expect(afterFreshLastDelete?.account.gameVersion === "如鸢" && afterFreshLastDelete.account.displayName === "默认账号" && afterFreshLastDelete.record.snapshot.inventory.length === 0, "deleting the final account must recreate an empty 如鸢 default account");

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new FakeIndexedDb() as unknown as IDBFactory;

// This is the exact legacy shape from the prior Product: a demo-keyed workspace
// existed without an account record. Loading must adopt it, not reseed it.
const legacyDb = await openDatabase();
const legacyWorkspace = createEmptyWorkspace(PRODUCT_DEMO_ACCOUNT_ID, "代号鸢");
legacyWorkspace.bag.currentCount = 17;
legacyWorkspace.inventory = [{ starInstanceId: "legacy-star", kind: "主星", name: "太阳", level: 1, quality: "橙", equippedState: "not_evaluated", provenance: { sourceOrder: 0, audit: {} }, manualStatus: "manual" }];
await commitWorkspaceTransaction(legacyDb, { accountId: PRODUCT_DEMO_ACCOUNT_ID, expectedRevision: 0, nextSnapshot: legacyWorkspace });
legacyDb.close();

const controller = new ProductWorkspaceController();
const adopted = await controller.load();
expect(adopted.account.accountId === PRODUCT_DEMO_ACCOUNT_ID && adopted.record.snapshot.bag.currentCount === 17 && adopted.record.snapshot.inventory.map((item) => item.starInstanceId).join(",") === "legacy-star", "legacy demo workspace must be adopted in place without loss");
expect((await getAccount(await openDatabase(), PRODUCT_DEMO_ACCOUNT_ID)) != null, "legacy adoption must create its stable account record");
const again = await controller.load();
expect(again.record.snapshot.bag.currentCount === 17 && again.record.snapshot.inventory.map((item) => item.starInstanceId).join(",") === "legacy-star" && (await controller.listAccounts()).length === 1, "legacy adoption must be idempotent on reload without duplicating inventory");

const preReviewWorkspace = createEmptyWorkspace("pre-review-account", "如鸢");
preReviewWorkspace.inventory = [{ starInstanceId: "pre-review-star", kind: "主星", name: "太阳", level: 1, quality: "橙", equippedState: "not_evaluated", provenance: { sourceOrder: 0, audit: {} }, manualStatus: "manual" }];
delete (preReviewWorkspace as { importReview?: unknown }).importReview;
const backfilledPreReview = backfillLegacyWorkspaceSnapshot(preReviewWorkspace);
expect(backfilledPreReview.changed && backfilledPreReview.snapshot.inventory[0]?.starInstanceId === "pre-review-star" && Object.keys(backfilledPreReview.snapshot.importReview.imagePools).length === 0, "older V1 workspace records without OCR review evidence must gain empty review fields without altering inventory");
const preLoadoutWorkspace = createEmptyWorkspace("pre-loadout-account", "如鸢");
delete (preLoadoutWorkspace as { operatorStarLoadouts?: unknown }).operatorStarLoadouts;
const backfilledPreLoadout = backfillLegacyWorkspaceSnapshot(preLoadoutWorkspace);
expect(backfilledPreLoadout.changed && Object.keys(backfilledPreLoadout.snapshot.operatorStarLoadouts).length === 0 && !("operatorStarLoadouts" in backfilledPreLoadout.snapshot.importReview), "older V1 workspaces must add loadouts at the workspace root, separate from OCR review evidence");
const legacySwitchAccount: AccountRecord = { accountId: "pre-review-account", displayName: "早期账号", gameVersion: "如鸢", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z" };
const storedPreReviewWorkspace = createEmptyWorkspace(legacySwitchAccount.accountId, legacySwitchAccount.gameVersion);
delete (storedPreReviewWorkspace as { importReview?: unknown }).importReview;
const compatibilityDb = await openDatabase();
await putAccount(compatibilityDb, legacySwitchAccount);
await commitWorkspaceTransaction(compatibilityDb, { accountId: legacySwitchAccount.accountId, expectedRevision: 0, nextSnapshot: storedPreReviewWorkspace });
const switchedLegacyWorkspace = await controller.switchAccount(legacySwitchAccount.accountId);
expect(Object.keys(switchedLegacyWorkspace.record.snapshot.importReview.imagePools).length === 0 && switchedLegacyWorkspace.record.revision === 2, "switching to an older workspace must backfill review fields before rendering without losing its owner scope");
await controller.deleteAccount(legacySwitchAccount.accountId);

const accountA = await controller.createAccount({ displayName: "测试", gameVersion: "如鸢" });
await controller.switchAccount(accountA.accountId);
await controller.mutate((session) => session.setBagValues(7, null));
const defaultAccount = await controller.createDefaultAccount();
expect(defaultAccount.displayName === "默认账号" && defaultAccount.gameVersion === "如鸢", "new accounts must begin as the 如鸢 default account");
const defaultAccountContext = await controller.switchAccount(defaultAccount.accountId);
expect(defaultAccountContext.record.snapshot.inventory.length === 0 && defaultAccountContext.record.snapshot.bag.currentCount === null && defaultAccountContext.record.snapshot.bag.capacity === null, "a default account must be an empty independent workspace");
const numberedDefaultAccount = await controller.createDefaultAccount();
expect(numberedDefaultAccount.displayName === "默认账号2" && numberedDefaultAccount.gameVersion === "如鸢", "existing 如鸢 default names must receive the next minimal suffix");
expect((await controller.switchAccount(accountA.accountId)).record.snapshot.bag.currentCount === 7, "creating a default account must not alter the current 如鸢 test account");
const accountB = await controller.createAccount({ displayName: "账号 B", gameVersion: "代号鸢" });
const committedForA = await controller.commitOcrReconcile({ sessionAccountId: accountA.accountId, draft: emptyOcrDraft(accountA.accountId, controller.current!.record.revision), sourceImages: [] });
expect(committedForA.account.accountId === accountA.accountId && committedForA.record.snapshot.accountId === accountA.accountId, "OCR final commit must write to the account captured by the session");
await controller.mutate((session) => session.setBagValues(9, null));
await controller.switchAccount(accountB.accountId);
expect(controller.current?.record.snapshot.bag.currentCount == null, "a newly created account must not inherit canonical inventory or bag data");
const bRevisionBeforeWrongSession = controller.current!.record.revision;
let wrongSessionRejected = false;
try { await controller.commitOcrReconcile({ sessionAccountId: accountA.accountId, draft: emptyOcrDraft(accountA.accountId, committedForA.record.revision), sourceImages: [] }); }
catch { wrongSessionRejected = true; }
expect(wrongSessionRejected && controller.current?.account.accountId === accountB.accountId && controller.current.record.revision === bRevisionBeforeWrongSession, "an OCR session from A must fail closed after UI context switches to B without altering B");
await controller.mutate((session) => session.setBagValues(3, null));
const switchedBack = await controller.switchAccount(accountA.accountId);
expect(switchedBack.record.snapshot.bag.currentCount === 9, "switching back must restore account A data");
const renamed = await controller.updateAccountMetadata(accountA.accountId, { displayName: "测试 已重命名", gameVersion: "代号鸢" });
expect(renamed.account.accountId === accountA.accountId && renamed.record.snapshot.bag.currentCount === 9, "rename and game version edits must retain the stable owner and canonical data");

const reloadedController = new ProductWorkspaceController();
const reloaded = await reloadedController.load();
expect(reloaded.account.accountId === accountA.accountId && reloaded.record.snapshot.bag.currentCount === 9, "current account and its data must survive controller reload");
expect(await getMeta<string>(await openDatabase(), PRODUCT_CURRENT_ACCOUNT_META_KEY) === accountA.accountId, "currentAccountId must be persisted independently of display name");

const afterDeleteA = await reloadedController.deleteAccount(accountA.accountId);
expect(afterDeleteA?.account.accountId === PRODUCT_DEMO_ACCOUNT_ID, "deleting the current account must select a deterministic remaining account");
expect((await getWorkspace(await openDatabase(), accountB.accountId))?.snapshot.bag.currentCount === 3, "deleting A must not alter B");
await reloadedController.deleteAccount(PRODUCT_DEMO_ACCOUNT_ID);
const afterDeleteB = await reloadedController.deleteAccount(accountB.accountId);
expect(afterDeleteB?.account.accountId && afterDeleteB.record.snapshot.accountId === afterDeleteB.account.accountId, "deleting the final account must immediately create an owner-scoped fallback workspace");

console.log("product account controller checks passed");
