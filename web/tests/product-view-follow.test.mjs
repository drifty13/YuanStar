import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = resolve(web, ".tmp");
mkdirSync(tempBase, { recursive: true });
const output = mkdtempSync(resolve(tempBase, "view-follow-"));
after(() => { assert.ok(output.startsWith(tempBase + sep)); rmSync(output, { recursive: true, force: true }); });
const source = readFileSync(resolve(web, "src/product.ts"), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export type \{[^\n]+;\r?\n/gm, "")
  .replace(/const rootElement[\s\S]*?const storedTab/, "let root; const displayLocaleAdapter = { apply() {} }; const storedTab")
  .replace("const workspaceController =", "let workspaceController =")
  .replace(/\nbindGlobalPaste\(\);[\s\S]*$/, "");
writeFileSync(resolve(output, "page.ts"), source, "utf8");
assert.equal(spawnSync(process.execPath, [resolve(web, "node_modules/typescript/bin/tsc"),
  "--ignoreConfig", "--noCheck", "--noResolve", "--target", "ES2022", "--module", "ESNext",
  "--outDir", output, resolve(output, "page.ts")], { stdio: "inherit" }).status, 0);
const code = readFileSync(resolve(output, "page.js"), "utf8").replace(/^export /gm, "");

function harness() {
  const intents = [], panes = {}, nodes = new Map();
  const root = { querySelector: selector => nodes.get(selector) ?? null, querySelectorAll: () => [] };
  const context = vm.createContext({ console, __root: root, __intents: intents,
    ProductWorkspaceController: class {}, ProductOcrImportCoordinator: class {}, ProductImportDraftController: class {}, HTMLSelectElement: class {},
    requestAnimationFrame: callback => callback(), window: { scrollY: 0, localStorage: { getItem: () => null } },
    browserCatalog: { orderIndex: name => ["太阳", "天府", "武曲"].indexOf(name), isNameForKind: () => true },
    buildCurrentInstanceUpdate: (current, draft) => Object.fromEntries(["name", "level", "quality"].filter(key => current[key] !== draft[key]).map(key => [key, draft[key]])),
    hasCurrentInstanceUpdate: update => Object.keys(update).length > 0,
  });
  vm.runInContext(code, context);
  const run = script => vm.runInContext(script, context);
  run(`root = __root; isOcrLocked = () => false; isCurrentMountGeneration = () => true;
    captureReviewViewport = () => null; pruneStaleReviewUiOnlyHistory = () => {}; syncPendingOcrReviewFromWorkspace = () => {};
    activatePane = pane => { selectedPane = pane }; showToast = () => {};
    applyWorkspaceContext = () => {};
    renderReview = (intent = 'keep') => { __intents.push(intent); if (typeof intent === 'object') scrollStarRowsToVisualRow(intent) };
    stars = Array.from({ length: 20 }, (_, index) => ({ starInstanceId: 's' + index, kind: '主星', name: '天府', level: 60 - index, targetLevel: 60, quality: '橙' }));
    selectedId = 's8'; workspaceController = { mutate: async mutation => ({ context: {}, result: mutation({
      state: { inventory: stars }, addInstance: draft => { stars.push({ ...draft, starInstanceId: 'new', targetLevel: draft.level }); return 'new' },
      updateInstance: (id, update) => Object.assign(stars.find(star => star.starInstanceId === id), update),
      deleteInstance: id => { stars = stars.filter(star => star.starInstanceId !== id) },
      setPlanTarget: (id, targetLevel) => { stars.find(star => star.starInstanceId === id).targetLevel = targetLevel }
    }) }) };`);
  function geometry(maxScroll = 600) {
    for (const pane of ["current", "plan"]) {
      const ids = JSON.parse(run("JSON.stringify(effectiveReviewStars().map(star => star.starInstanceId))"));
      const rows = ids.map((id, index) => ({ offsetTop: 30 + index * 32, closest: () => ({ querySelector: () => ({ getBoundingClientRect: () => ({ height: 30 }) }) }) }));
      const container = { scrollTop: 100, scrollHeight: maxScroll + 200, clientHeight: 200, querySelectorAll: () => rows };
      panes[pane] = container; nodes.set(`#${pane}-scroll`, container);
      ids.forEach((id, index) => nodes.set(`[data-star-id="${id}"][data-pane="${pane}"]`, rows[index]));
    }
  }
  context.__geometry = geometry;
  run("const originalRender = renderReview; renderReview = intent => { __geometry(); originalRender(intent) }");
  return { run, panes, nodes, geometry, intents };
}

test("new instance remains selected and follows its final sorted row in both panes", async () => {
  const h = harness();
  await h.run("runWorkspaceMutation(session => session.addInstance({kind:'主星', name:'武曲', level:48, quality:'紫'}), id => setSelectedInstance(id), {selectsNewInstance:true})");
  assert.equal(h.run("selectedId"), "new");
  const index = h.run("effectiveReviewStars().findIndex(star => star.starInstanceId === 'new')");
  assert.equal(h.panes.current.scrollTop, (index - 4) * 32);
  assert.equal(h.panes.plan.scrollTop, h.panes.current.scrollTop);
  assert.equal(h.intents.at(-1).starInstanceId, "new");
});
for (const [field, value, sort] of [["name", "太阳", "name"], ["level", 59, "level"], ["quality", "白", "catalog"]]) {
  test(`${field} edit follows the same instance only when sorted position changes`, async () => {
    const h = harness();
    h.run(`sortFilter = ${JSON.stringify(sort)}; stars[9].level = stars[8].level; currentEditDraft = { ...stars[8], ${field}: ${JSON.stringify(value)} }; commitCurrentEditor()`);
    await h.run("Promise.resolve()");
    assert.equal(h.run("selectedId"), "s8");
    assert.equal(h.intents.at(-1).starInstanceId, "s8");
    assert.equal(h.panes.current.scrollTop, Math.max(0, (h.run("effectiveReviewStars().findIndex(star => star.starInstanceId === 's8')") - 4) * 32));
  });
}
test("edit with unchanged final index preserves scroll", async () => {
  const h = harness();
  await h.run("runWorkspaceMutation(session => session.updateInstance('s8', {quality:'紫'}), () => setSelectedInstance('s8'))");
  assert.equal(h.intents.at(-1), "keep");
  assert.equal(h.panes.current.scrollTop, 100);
});
test("plan sort follows same-name instance identity", async () => {
  const h = harness();
  h.run("sortFilter = 'target'; stars.forEach((star, index) => star.targetLevel = 60 - index); stars[8].targetLevel = 54");
  await h.run("runWorkspaceMutation(session => session.setPlanTarget('s8', 60))");
  assert.equal(h.intents.at(-1).starInstanceId, "s8");
  assert.equal(h.run("selectedId"), "s8");
});
test("fifth-row context clamps at top and bottom without blank space", () => {
  const h = harness(); h.geometry(160);
  h.run("selectedId = 's1'; scrollStarRowsToVisualRow({starInstanceId:'s1', targetVisualRow:5})");
  assert.equal(h.panes.current.scrollTop, 0);
  h.run("selectedId = 's19'; scrollStarRowsToVisualRow({starInstanceId:'s19', targetVisualRow:5})");
  assert.equal(h.panes.current.scrollTop, 160); assert.equal(h.panes.plan.scrollTop, 160);
});
test("fifth-row context uses the actual preceding row when heights vary", () => {
  const h = harness(); h.geometry();
  for (const pane of ["current", "plan"]) {
    h.panes[pane].querySelectorAll()[4].offsetTop = 210;
  }
  h.run("scrollStarRowsToVisualRow({starInstanceId:'s8', targetVisualRow:5})");
  assert.equal(h.panes.current.scrollTop, 180); assert.equal(h.panes.plan.scrollTop, 180);
});

test("filtered-out identity and stale scheduled intent never reselect another row", async () => {
  const h = harness(); h.run("pendingOnly = true; selectedId = 's8'");
  await h.run("runWorkspaceMutation(session => session.setPlanTarget('s8', stars[8].level))");
  assert.equal(h.intents.at(-1), "keep");
  const selection = h.run("selectedId");
  h.run("scrollStarRowsToVisualRow({starInstanceId:'s8', targetVisualRow:5})");
  assert.equal(h.run("selectedId"), selection);
});
