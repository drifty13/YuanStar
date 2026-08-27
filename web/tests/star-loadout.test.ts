import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace, WorkspaceDomainError } from "../src/business/model.js";
import { WorkspaceSession } from "../src/business/session.js";
import { restoreWorkspaceSnapshot } from "../src/business/snapshot.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function expectError(action: () => unknown, code: string): void {
  try { action(); } catch (error) { expect(error instanceof WorkspaceDomainError && error.code === code, `expected ${code}`); return; }
  throw new Error(`expected ${code}`);
}

const catalog = createStarCatalog([
  { name: "天府", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "武曲", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
  { name: "解神", kind: "辅星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null },
], { "天府别名": "天府" });

let id = 0;
const session = new WorkspaceSession(createEmptyWorkspace("loadout-account"), catalog, () => `star-${++id}`);
const tianfuOrange = session.addInstance({ kind: "主星", name: "天府", level: 50, quality: "橙", equippedState: "unknown", provenance: { sourceOrder: 1 }, manualStatus: "manual" });
const tianfuPurple = session.addInstance({ kind: "主星", name: "天府", level: 50, quality: "紫", equippedState: "unknown", provenance: { sourceOrder: 2 }, manualStatus: "manual" });
const wuqu = session.addInstance({ kind: "主星", name: "武曲", level: 60, quality: "蓝", equippedState: "unknown", provenance: { sourceOrder: 3 }, manualStatus: "manual" });
const jieshen = session.addInstance({ kind: "辅星", name: "解神", level: 40, quality: "白", equippedState: "unknown", provenance: { sourceOrder: 4 }, manualStatus: "manual" });

session.setOperatorStarLoadout("operator-a", { main1: tianfuOrange, main2: null, main3: null, support1: null, support2: null, support3: null });
expect(session.state.operatorStarLoadouts["operator-a"]?.slots.main1 === tianfuOrange, "loadout must reference the account inventory instance, not a name copy");
expectError(() => session.setOperatorStarLoadout("operator-b", { main1: tianfuOrange, main2: null, main3: null, support1: null, support2: null, support3: null }), "star_instance_occupied");
expectError(() => session.setOperatorStarLoadout("operator-b", { main1: jieshen, main2: null, main3: null, support1: null, support2: null, support3: null }), "workspace_validation_error");
expectError(() => session.deleteInstance(tianfuOrange), "star_instance_in_use");

const preserved = session.previewStarLoadout("operator-a", [
  { kind: "主星", name: "武曲" },
  { kind: "主星", name: "天府" },
  { kind: "主星", name: "天府" },
  { kind: "辅星", name: "解神" },
]);
expect(preserved.slots.main1 === tianfuOrange, "a matching current instance must remain in its existing slot even when its requirement appears later");
expect(preserved.slots.main2 === wuqu && preserved.slots.main3 === tianfuPurple && preserved.slots.support1 === jieshen, "remaining requirements must fill compatible slots with distinct instances");
expect(Object.values(preserved.slots).filter((item) => item === tianfuOrange).length === 1 && session.state.operatorStarLoadouts["operator-a"]?.slots.main2 === null, "preview must use an instance once and remain non-mutating");

const preview = session.previewStarLoadout("operator-b", [
  { kind: "主星", name: "天府别名" },
  { kind: "主星", name: "武曲" },
  { kind: "辅星", name: "解神" },
]);
expect(preview.slots.main1 === tianfuPurple, "preview must exclude an instance occupied by another operator");
expect(preview.slots.main2 === wuqu && preview.slots.support1 === jieshen, "preview must match kinds and fill deterministic compatible slots");
expect(preview.unavailable.length === 0, "available requirements must not be reported as unavailable");

session.moveStarInstance(tianfuOrange, "operator-a", "main1", "operator-b", "main1");
expect(session.state.operatorStarLoadouts["operator-a"]?.slots.main1 === null && session.state.operatorStarLoadouts["operator-b"]?.slots.main1 === tianfuOrange, "explicit move must clear the source before assigning the target");
session.moveStarInstance(tianfuOrange, "operator-b", "main1", "operator-b", "main2");
expect(session.state.operatorStarLoadouts["operator-b"]?.slots.main1 === null && session.state.operatorStarLoadouts["operator-b"]?.slots.main2 === tianfuOrange, "same-operator moves must also preserve one-slot-only occupancy");

const occupiedPreview = session.previewStarLoadout("operator-c", [{ kind: "主星", name: "天府" }]);
expect(occupiedPreview.slots.main1 === tianfuPurple, "a free identical instance remains selectable even if another is occupied");
session.setOperatorStarLoadout("operator-c", { main1: tianfuPurple, main2: null, main3: null, support1: null, support2: null, support3: null });
const fullyOccupied = session.previewStarLoadout("operator-d", [{ kind: "主星", name: "天府" }]);
expect(fullyOccupied.unavailable[0]?.reason === "occupied" && fullyOccupied.unavailable[0]?.occupiedByOperatorIds.join(",") === "operator-b,operator-c", "preview must expose owners instead of stealing occupied stars");

const invalid = session.state;
invalid.operatorStarLoadouts["operator-d"] = { operatorId: "operator-d", slots: { main1: null, main2: null, main3: null, support1: tianfuOrange, support2: null, support3: null } };
expectError(() => restoreWorkspaceSnapshot(invalid, catalog), "workspace_validation_error");
const legacy = session.state as any;
delete legacy.operatorStarLoadouts;
expect(Object.keys(restoreWorkspaceSnapshot(legacy, catalog).operatorStarLoadouts).length === 0, "legacy workspaces must backfill an empty independent loadout collection");

console.log("Star inventory/loadout v0 schema checks passed");
