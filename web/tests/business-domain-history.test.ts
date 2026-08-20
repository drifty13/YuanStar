import { createStarCatalog } from "../src/business/catalog.js";
import { WorkspaceHistory } from "../src/business/history.js";
import { createEmptyWorkspace, validateStarInstance, WorkspaceDomainError, type StarInstanceV1 } from "../src/business/model.js";
import { WorkspaceSession } from "../src/business/session.js";
import { createWorkspaceSnapshot, restoreWorkspaceSnapshot } from "../src/business/snapshot.js";
import { pythonSessionGoldenFixture } from "./fixtures/python-session-golden.fixture.js";

function expect(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function expectError(action: () => unknown, message: string): void { try { action(); } catch (error) { expect(error instanceof WorkspaceDomainError, message); return; } throw new Error(message); }

const catalog = createStarCatalog([
  { name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "解神", kind: "辅星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
], { "天府别名": "天府" });

function instance(id: string, level = 40): StarInstanceV1 {
  return { starInstanceId: id, kind: "主星", name: "天府", level, quality: "橙", equippedState: "unequipped", provenance: { sourceOrder: 1, sourceImageId: "golden-image", row: 0, column: 0 }, manualStatus: "synthetic" };
}

const workspace = createEmptyWorkspace("golden-account");
workspace.bag = { currentCount: pythonSessionGoldenFixture.bag_current_count, capacity: pythonSessionGoldenFixture.bag_capacity, resolution: { status: "manual" }, manualFields: ["currentCount", "capacity"] };
workspace.inventory = [instance("golden-main", 40), { ...instance("golden-support", 20), kind: "辅星", name: "解神", quality: "紫" }];
workspace.planTargets = { "golden-main": 60 };
workspace.experience = { orange: 3, purple: 4, white: 5, evidence: { source: "synthetic" }, manualFields: [] };
workspace.importReview = { imagePools: { "golden-image": "main" }, confirmedImagePools: ["golden-image"], overlapPairs: { main: [["golden-image", "golden-image-2"]], support: [] }, overlapAudit: [{ status: "synthetic" }], imageAudit: { "golden-image": { status: "synthetic" } }, occurrences: {} };
workspace.postprocessRevision = pythonSessionGoldenFixture.postprocess_revision;

const snapshot = createWorkspaceSnapshot(workspace, catalog);
const roundTrip = restoreWorkspaceSnapshot(JSON.parse(JSON.stringify(snapshot)), catalog);
expect(roundTrip.inventory.map((item) => item.starInstanceId).includes("golden-main"), "JSON round trip must preserve starInstanceId");
workspace.inventory[0]!.level = 1;
expect(snapshot.inventory.find((item) => item.starInstanceId === "golden-main")?.level === 40, "snapshot must not reference source state");

const three = createEmptyWorkspace("three-identical");
three.inventory = [instance("same-a"), instance("same-b"), instance("same-c")];
expect(createWorkspaceSnapshot(three, catalog).inventory.length === 3, "three identical stars must remain physical instances");

const stale = createWorkspaceSnapshot(snapshot, catalog);
stale.planTargets = { stale: 50, "golden-main": 1 };
const normalized = restoreWorkspaceSnapshot(stale, catalog);
expect(!("stale" in normalized.planTargets), "stale plan targets must be removed");
expect(normalized.planTargets["golden-main"] === 40, "low plan target must normalize to current level");
validateStarInstance(snapshot.inventory[0]!, catalog);
expect(catalog.normalize("天府别名") === "天府", "catalog may normalize an alias before formal domain entry");
expectError(() => validateStarInstance({ ...snapshot.inventory[0]!, name: "天府别名" }, catalog), "formal instance validation must reject alias inventory name");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, name: "天府别名" }] }, catalog), "formal snapshot must reject alias inventory name");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, level: 0 }] }, catalog), "level 0 must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, level: 61 }] }, catalog), "level 61 must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, name: "不存在" }] }, catalog), "unknown name must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, kind: "辅星" }] }, catalog), "name/kind mismatch must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [{ ...snapshot.inventory[0]!, quality: "金" }] }, catalog), "invalid quality must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: [snapshot.inventory[0]!, snapshot.inventory[0]!] }, catalog), "duplicate starInstanceId must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, planTargets: { "golden-main": 61 } }, catalog), "invalid plan target must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, bag: { ...snapshot.bag, currentCount: 41 } }, catalog), "current count above capacity must fail");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, experience: { ...snapshot.experience, orange: -1 } }, catalog), "negative experience must fail");
const nullableExperience = restoreWorkspaceSnapshot({ ...snapshot, experience: { ...snapshot.experience, orange: null, purple: 0 } }, catalog);
expect(nullableExperience.experience.orange === null && nullableExperience.experience.purple === 0, "null and zero experience must remain valid");
expectError(() => restoreWorkspaceSnapshot({}, catalog), "empty snapshot must return WorkspaceDomainError");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, bag: undefined }, catalog), "missing bag must return WorkspaceDomainError");
expectError(() => restoreWorkspaceSnapshot({ ...snapshot, inventory: undefined }, catalog), "missing inventory must return WorkspaceDomainError");

let nextId = 0;
const session = new WorkspaceSession(createEmptyWorkspace("history-account"), catalog, () => `session-${++nextId}`);
const added = session.addInstance({ kind: "主星", name: "天府", level: 40, quality: "橙", equippedState: "unequipped", provenance: { sourceOrder: 0 }, manualStatus: "manual" });
session.updateInstance(added, { level: 41 });
expect(session.state.inventory[0]?.starInstanceId === added, "update must preserve instance ID");
expect(session.undo(), "undo should succeed");
expect(session.state.inventory[0]?.level === 40, "undo should restore previous snapshot");
expect(session.redo(), "redo should succeed");
session.undo();
const beforeInvalidInstance = JSON.stringify(session.state);
expect(session.history.canRedo, "undo should make redo available before failed mutation");
expectError(() => session.updateInstance(added, { level: 61 }), "invalid instance mutation must fail");
expect(JSON.stringify(session.state) === beforeInvalidInstance && session.history.canRedo, "failed instance mutation must not change state or clear redo");
expectError(() => session.setBagValues(-1, 100), "invalid bag mutation must fail");
expect(JSON.stringify(session.state) === beforeInvalidInstance && session.history.canRedo, "failed bag mutation must not change state or clear redo");
session.setPlanTarget(added, 50);
expect(!session.history.canRedo, "new mutation after undo must clear redo");
for (let value = 0; value < 35; value += 1) session.setBagValues(value, 100);
let undoCount = 0; while (session.undo()) undoCount += 1;
expect(undoCount === 30, "history must retain only 30 steps");

const history = new WorkspaceHistory(catalog, 30);
history.record(snapshot);
expect(history.undo(snapshot)?.inventory.some((item) => item.starInstanceId === "golden-main"), "history snapshot must retain IDs");
console.log("Phase 2A business domain, snapshot, history checks passed");
