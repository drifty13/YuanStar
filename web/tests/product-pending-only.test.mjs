import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

// Execute the real page functions and event bindings without adding a DOM dependency.
// Only browser layout, persistence transport and the workbook calculation boundary are faked.
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = resolve(web, ".tmp");
mkdirSync(tempBase, { recursive: true });
const output = mkdtempSync(resolve(tempBase, "pending-only-test-"));
process.on("exit", () => {
  assert.ok(output.startsWith(tempBase + sep) && output.includes("pending-only-test-"));
  rmSync(output, { recursive: true, force: true });
});
const compile = spawnSync(process.execPath, [resolve(web, "node_modules/typescript/bin/tsc"),
  "--ignoreConfig", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext",
  "--resolveJsonModule", "--lib", "ES2022,DOM", "--skipLibCheck", "--strict", "--noEmitOnError",
  "--rootDir", "..", "--outDir", output, "src/product-summary-view.ts", "src/product-current-instance-update.ts",
  "src/product-review-history.ts", "src/business/model.ts", "src/business/session.ts", "src/business/browser-catalog.ts"], { cwd: web, stdio: "inherit" });
assert.equal(compile.status, 0, "fresh test dependency compilation");
const load = (path) => import(pathToFileURL(resolve(output, "web/src", path)).href);
const summary = await load("product-summary-view.js");
const currentUpdate = await load("product-current-instance-update.js");
const reviewHistory = await load("product-review-history.js");
const { createEmptyWorkspace } = await load("business/model.js");
const { WorkspaceSession } = await load("business/session.js");
const { browserCatalog } = await load("business/browser-catalog.js");
const source = readFileSync(resolve(web, "src/product.ts"), "utf8");
// Use the repository compiler so this also runs on its supported Node 20 runtime.
// The page imports are supplied above; production type correctness has its separate typecheck gate.
const pageInput = resolve(output, "product-page.ts");
writeFileSync(pageInput, source.replace(/^import[\s\S]*?;\r?\n/gm, "")
  .replace(/^export type \{[^\n]+;\r?\n/gm, "")
  .replace(/const rootElement[\s\S]*?const storedTab/, "let root; const displayLocaleAdapter = { apply() {} }; const storedTab")
  .replace("const workspaceController =", "let workspaceController =")
  .replace(/\nbindGlobalPaste\(\);[\s\S]*$/, ""), "utf8");
const pageCompile = spawnSync(process.execPath, [resolve(web, "node_modules/typescript/bin/tsc"),
  "--ignoreConfig", "--noCheck", "--target", "ES2022", "--module", "ESNext",
  "--outDir", resolve(output, "page"), pageInput], { cwd: web, stdio: "inherit" });
assert.equal(pageCompile.status, 0, "fresh page function compilation");
const code = readFileSync(resolve(output, "page/product-page.js"), "utf8").replace(/^export /gm, "");

const row = (id, name, level, targetLevel, quality = "橙", kind = "主星") => ({ starInstanceId: id, name, level, targetLevel, quality, kind });
const inventory = [
  row("tf-done-1", "天府", 60, 60), row("tf-pending", "天府", 40, 60),
  row("tf-done-2", "天府", 30, 30, "紫"), row("tf-done-3", "天府", 50, 50),
  row("tf-done-4", "天府", 20, 20), row("jm-pending-1", "巨门", 30, 60),
  row("jm-pending-2", "巨门", 20, 50, "紫"), row("jm-done-1", "巨门", 60, 60),
  row("jm-done-2", "巨门", 10, 10), row("done-group", "武曲", 60, 60),
  row("support-pending", "解神", 30, 60, "橙", "辅星"),
];
const ids = (rows) => rows.map((star) => star.starInstanceId);
const plain = (value) => JSON.parse(JSON.stringify(value));

class Element {
  constructor(root, tag = "div") { this.root = root; this.tag = tag; this.events = new Map(); this.value = ""; this.checked = false; this.dataset = {}; this.innerHTML = ""; this.scrollTop = 0; }
  addEventListener(type, handler) { this.events.set(type, handler); }
  querySelector(selector) { return this.root.querySelector(selector); }
  querySelectorAll() { return []; }
  contains() { return false; }
  fire(type) { this.events.get(type)?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} }); }
}
class Select extends Element {}
class Root {
  constructor() {
    this.nodes = new Map();
    this.content = new Element(this);
    Object.defineProperty(this.content, "innerHTML", { get: () => this.markup, set: (value) => this.parse(value) });
  }
  parse(markup) {
    this.markup = markup;
    this.nodes.clear();
    for (const match of markup.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const element = match[1] === "select" ? new Select(this) : new Element(this, match[1]);
      element.value = match[2].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
      element.checked = /\bchecked\b/.test(match[2]);
      this.nodes.set(`#${match[3]}`, element);
    }
    for (const pane of ["current", "plan"]) if (markup.includes(`data-edit-panel="${pane}"`)) this.nodes.set(`[data-edit-panel="${pane}"]`, new Element(this));
  }
  querySelector(selector) { return selector === "#page-content" ? this.content : this.nodes.get(selector) ?? null; }
  querySelectorAll() { return []; }
}

function harness(rows = inventory) {
  const root = new Root();
  const frames = [];
  const experienceCalls = [];
  let pendingMutation = Promise.resolve();
  const context = vm.createContext({
    ...summary, ...currentUpdate, ...reviewHistory, browserCatalog, HTMLSelectElement: Select,
    Error, WorkspaceRevisionConflictError: class extends Error {},
    ProductWorkspaceController: class {}, ProductOcrImportCoordinator: class {}, ProductImportDraftController: class {},
    window: { localStorage: { getItem: () => null, setItem() {} }, clearTimeout() {} },
    document: { activeElement: null, querySelector: () => null }, requestAnimationFrame: (fn) => frames.push(fn),
    summarizeExperiencePlans(plans) {
      experienceCalls.push(plain(ids(plans)));
      return { required: { purple: 0, white: 0, experience: 0 }, remaining: { purple: 0, white: 0, experience: 0 } };
    }, stage624RunsRequired: () => 0,
  });
  vm.runInContext(code, context);
  const run = (script) => vm.runInContext(script, context);
  const snapshot = createEmptyWorkspace("pending-test", "代号鸢");
  snapshot.inventory = rows.map(({ targetLevel, ...star }) => ({ ...star, equippedState: "not_evaluated", provenance: { sourceOrder: 0 }, manualStatus: "manual" }));
  snapshot.planTargets = Object.fromEntries(rows.filter((star) => star.targetLevel >= star.level).map((star) => [star.starInstanceId, star.targetLevel]));
  snapshot.bag = { ...snapshot.bag, currentCount: Math.max(0, rows.length - 1), capacity: 200 };
  const session = new WorkspaceSession(snapshot, browserCatalog, () => "new-row");
  const workspace = () => ({ account: { accountId: "pending-test", gameVersion: "代号鸢" }, record: { revision: 1, snapshot: session.state } });
  context.testRoot = root;
  context.testWorkspace = workspace();
  context.testController = { mutate: (mutation) => {
    const result = mutation(session);
    pendingMutation = Promise.resolve({ result, context: workspace() });
    return pendingMutation;
  } };
  // Layout and OCR are outside this review interaction test; renderReview and bindings remain real.
  run(`root = testRoot; workspaceController = testController; applyWorkspaceContext(testWorkspace); experienceRules = {};
    captureReviewViewport = () => null; captureScroll = () => ({}); restoreScroll = () => {};
    restoreReviewViewport = () => {}; closeOpenDropdowns = () => {}; enhanceEmbeddedSoftDropdowns = () => {};
    syncPendingOcrReviewFromWorkspace = () => {}; pendingOcrReviewTemplate = () => "";
    workspaceToolsTemplate = () => ""; isCurrentMountGeneration = () => true;`);
  const render = () => { run("renderReview()"); while (frames.length) frames.shift()(); };
  const toggle = (checked) => { const input = root.querySelector("#pending-only"); assert.ok(input, "title checkbox is mounted"); input.checked = checked; input.fire("change"); while (frames.length) frames.shift()(); };
  const fire = (selector, value, type = "change") => { const element = root.querySelector(selector); assert.ok(element, selector); element.value = value; element.fire(type); while (frames.length) frames.shift()(); };
  return { run, root, render, toggle, fire, experienceCalls, frames, session,
    async settled() { await pendingMutation; await new Promise((resolve) => setImmediate(resolve)); while (frames.length) frames.shift()(); assert.equal(run("reviewSaveState"), "saved", run("reviewError")); },
  };
}
let passed = 0;
async function test(name, fn) { await fn(); console.log(`PASS ${name}`); passed++; }
function rowMarkup(markup, id) { return markup.match(new RegExp(`<tr[^>]*data-star-id="${id}"[\\s\\S]*?</tr>`))?.[0] ?? ""; }
function levelCell(markup) { return [...markup.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][3]?.[1] ?? ""; }
const text = (markup) => markup.replace(/<[^>]*>/g, "").trim();
const detailInventory = [
  row("tf-orange-pending-1", "天府", 40, 60), row("tf-orange-pending-2", "天府", 40, 50),
  row("tf-orange-done", "天府", 40, 40), row("tf-purple-pending", "天府", 30, 60, "紫"),
  row("tf-purple-done", "天府", 30, 30, "紫"), row("jm-pending", "巨门", 20, 60),
  row("jm-done", "巨门", 20, 20), row("support-pending", "解神", 30, 60, "橙", "辅星"),
  row("support-done", "解神", 30, 30, "橙", "辅星"),
];
const quantity = (h, id, pane = "plan") => text([...rowMarkup(h.run(`panelRows("${pane}")`), id).matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][5]?.[1] ?? "");

await test("detail quantity disabled preserves original catalog and name grouping", () => {
  const h = harness(detailInventory);
  assert.equal(quantity(h, "tf-orange-done"), "共3颗");
  assert.equal(quantity(h, "tf-orange-pending-1"), "—");
  h.run('sortFilter = "name"');
  assert.equal(quantity(h, "tf-orange-done"), "共5颗");
  assert.equal(quantity(h, "tf-purple-pending"), "—");
});
await test("pending detail quantity keeps existing level/quality key and counts base rows", () => {
  const h = harness(detailInventory); h.run("pendingOnly = true");
  for (const pane of ["current", "plan"]) {
    assert.equal(quantity(h, "tf-orange-pending-1", pane), "待养 2 / 共 3");
    assert.equal(quantity(h, "tf-purple-pending", pane), "待养 1 / 共 2");
    assert.equal(quantity(h, "support-pending", pane), "待养 1 / 共 2");
  }
});
await test("pending detail denominator follows applied kind, quality and name filters", () => {
  const h = harness(detailInventory); h.run('sortFilter = "name"'); h.render(); h.toggle(true);
  h.fire("#kind-filter", "主星"); h.fire("#name-filter", "天府", "input"); h.fire("#apply-filter", "", "click");
  assert.equal(quantity(h, "tf-orange-pending-1"), "待养 3 / 共 5");
  assert.ok(!h.run('panelRows("plan")').includes('data-star-id="jm-pending"'));
  assert.ok(!h.run('panelRows("plan")').includes('data-star-id="support-pending"'));
  h.fire("#quality-filter", "橙");
  assert.equal(quantity(h, "tf-orange-pending-1"), "待养 2 / 共 3");
  h.fire("#quality-filter", "紫");
  assert.equal(quantity(h, "tf-purple-pending"), "待养 1 / 共 2");
  h.fire("#clear-filter", "", "click"); h.fire("#kind-filter", "辅星");
  assert.equal(quantity(h, "support-pending"), "待养 1 / 共 2");
  assert.ok(!h.run('panelRows("plan")').includes('data-star-id="tf-orange-pending-1"'));
  h.fire("#clear-filter", "", "click"); h.fire("#name-filter", "巨门", "input"); h.fire("#apply-filter", "", "click");
  assert.equal(quantity(h, "jm-pending"), "待养 1 / 共 2");
});
await test("pending detail subsequent visible rows remain dash for both grouping modes", () => {
  const h = harness(detailInventory); h.run("pendingOnly = true");
  for (const pane of ["current", "plan"]) {
    assert.equal(quantity(h, "tf-orange-pending-2", pane), "—");
    h.run('sortFilter = "name"');
    assert.equal(quantity(h, "tf-orange-pending-1", pane), "待养 3 / 共 5");
    assert.equal(quantity(h, "tf-orange-pending-2", pane), "—");
    assert.equal(quantity(h, "tf-purple-pending", pane), "—");
    h.run('sortFilter = "catalog"');
  }
});

await test("default checkbox, original rows and sorting", () => {
  const h = harness(); h.render();
  assert.equal(h.run("pendingOnly"), false);
  assert.equal(h.root.querySelector("#pending-only")?.checked, false);
  assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), plain(h.run("filteredStars().map(s => s.starInstanceId)")));
  h.run('sortFilter = "level"'); const before = plain(h.run("filteredStars().map(s => s.starInstanceId)"));
  h.toggle(true); assert.equal(h.run("sortFilter"), "level"); assert.equal(h.run("hasActiveReviewFilter()"), false);
  h.toggle(false); assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), before);
});
await test("detail completed and pending levels use existing target emphasis", () => {
  const h = harness();
  const done = levelCell(rowMarkup(h.run('panelRows("plan")'), "tf-done-1"));
  assert.equal(text(done), "60"); assert.ok(!done.includes("→"));
  const pending = levelCell(rowMarkup(h.run('panelRows("plan")'), "tf-pending"));
  assert.equal(text(pending), "40→60");
  assert.match(pending, /class="planned-level is-planned">60/);
  const css = readFileSync(resolve(web, "src/product.css"), "utf8");
  assert.match(css, /th,\s*td[^}]*text-align: center/);
});
await test("strict target greater than current predicate", () => {
  const h = harness(); h.run('stars = [{starInstanceId:"equal", level:60, targetLevel:60}, {starInstanceId:"lower", level:50, targetLevel:40}, {starInstanceId:"higher", level:40, targetLevel:60}].map(s => ({...s, name:"天府", kind:"主星", quality:"橙"})); pendingOnly = true');
  assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), ["higher"]);
});
await test("filter before toggle and toggle before filters share the same IDs", () => {
  for (const first of [true, false]) {
    const h = harness(); h.render();
    if (first) h.toggle(true);
    h.fire("#kind-filter", "主星"); h.fire("#quality-filter", "橙");
    h.fire("#name-filter", "天府", "input"); h.fire("#apply-filter", "", "click");
    if (!first) h.toggle(true);
    assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), ["tf-pending"]);
    assert.ok(h.run("effectiveReviewStars().every(s => filteredStars().some(b => b.starInstanceId === s.starInstanceId))"));
  }
});
await test("pending-only search typing preserves the active input until filters are applied", () => {
  const h = harness(); h.render(); h.toggle(true);
  const input = h.root.querySelector("#name-filter");
  h.fire("#name-filter", "天", "input");
  assert.ok(h.root.querySelector("#name-filter") === input, "typing must not replace the focused DOM input");
  h.fire("#name-filter", "天府", "input");
  assert.equal(h.run("nameFilter"), "天府"); assert.equal(h.run("appliedNameFilter"), "");
});
await test("summary visibility and pending N / base M after quality and kind filters", () => {
  const h = harness(); h.render(); h.toggle(true); h.run('viewMode = "summary"'); h.render();
  const markup = h.run('summaryPanelRows("plan")');
  assert.match(markup, /待养 1 \/ 共 5/); assert.match(markup, /待养 2 \/ 共 4/);
  assert.ok(!markup.includes("武曲")); assert.ok(!markup.includes("→"));
  assert.match(markup, /<td>—<\/td>/);
  h.fire("#quality-filter", "橙"); h.fire("#kind-filter", "主星");
  assert.match(h.run('summaryPanelRows("current")'), /待养 1 \/ 共 4/);
  assert.match(h.run('summaryPanelRows("current")'), /待养 1 \/ 共 3/);
  h.fire("#kind-filter", "辅星");
  assert.deepEqual(plain(h.run("summaryGroups().map(g => g.key)")), ["辅星|解神"]);
});
await test("drill down and return restore navigation while retaining checkbox and N/M", () => {
  const h = harness(); h.render(); h.fire("#kind-filter", "主星");
  h.fire("#name-filter", "天府 巨门", "input"); h.fire("#apply-filter", "", "click");
  h.toggle(true); h.run('viewMode = "summary"; summarySelectedGroupKey = "主星|天府"');
  const before = plain(h.run("captureReviewNavigation()"));
  assert.ok(!Object.hasOwn(before, "pendingOnly"));
  h.run('drillDownSummaryGroup("主星|天府")');
  assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), ["tf-pending"]);
  h.run("toggleReviewView()");
  assert.deepEqual(plain(h.run("captureReviewNavigation()")), before);
  assert.equal(h.run("pendingOnly"), true); assert.match(h.root.markup, /待养 1 \/ 共 5/);
});
await test("hidden selection converges, drafts reset, visible selection retained", () => {
  const h = harness(); h.run('selectedId = "tf-done-1"; planEditDraft = 45; currentEditDraft = {name:"天府", kind:"主星", quality:"橙", level:60}'); h.render(); h.toggle(true);
  assert.equal(h.run("selectedId"), h.run("effectiveReviewStars()[0].starInstanceId"));
  assert.equal(h.run("planEditDraft"), null); assert.equal(h.run("currentEditDraft"), null);
  h.run('selectStar("jm-pending-1", "plan"); planEditDraft = 55'); h.toggle(true);
  assert.equal(h.run("selectedId"), "jm-pending-1"); assert.equal(h.run("planEditDraft"), 55);
  h.fire("#quality-filter", "紫");
  assert.equal(h.run("selectedId"), "jm-pending-2"); assert.equal(h.run("planEditDraft"), null);
  assert.equal(h.root.querySelector("#target-level").value, "50");
});
await test("zero pending keeps filters, full review shell and no hidden editor or experience ID", () => {
  const h = harness(); h.render(); h.toggle(true); h.fire("#name-filter", "武曲", "input"); h.fire("#apply-filter", "", "click");
  assert.equal(h.run("selectedStar()"), null); assert.equal(h.run("selectedId"), "");
  assert.equal(h.run("appliedNameFilter"), "武曲"); assert.equal(h.root.querySelector("#pending-only").checked, true);
  assert.ok(h.root.querySelector("#kind-filter")); assert.ok(h.root.querySelector("#experience-title"));
  assert.ok(!h.root.markup.includes('data-edit-panel="'));
  assert.match(h.root.markup, /当前显示范围暂无待养成星石/);
  h.experienceCalls.length = 0; h.render(); assert.ok(h.experienceCalls.every((scope) => scope.length === 0));
  h.run('viewMode = "summary"'); h.render(); assert.deepEqual(plain(h.run("summaryGroups()")), []);
  h.run('viewMode = "detail"'); h.toggle(false); assert.equal(h.run("appliedNameFilter"), "武曲"); assert.ok(h.root.markup.includes('data-edit-panel="current"'));
});
await test("saving current level at target selects another pending without stale scroll reselect", async () => {
  const h = harness([row("first", "天府", 40, 60), row("next", "巨门", 30, 50)]); h.render(); h.toggle(true);
  h.run('selectStar("first", "current"); planEditDraft = 55; currentEditDraft = {kind:"主星", name:"天府", quality:"橙", level:60}; commitCurrentEditor()');
  await h.settled();
  assert.equal(h.run("selectedId"), "next"); assert.equal(h.run("planEditDraft"), null);
  assert.deepEqual(plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)")), ["next"]);
  assert.equal(h.root.querySelector("#target-level").value, "50");
});
await test("saving last pending level and plan reset both enter zero result without unchecking", async () => {
  for (const current of [true, false]) {
    const h = harness([row("last", "天府", 40, 60)]); h.render(); h.toggle(true);
    h.run(current ? 'currentEditDraft = {kind:"主星", name:"天府", quality:"橙", level:60}; commitCurrentEditor()' : "planEditDraft = 40; commitPlanEditor()");
    await h.settled();
    assert.equal(h.run("selectedStar()"), null); assert.equal(h.run("selectedId"), "");
    assert.equal(h.root.querySelector("#pending-only").checked, true);
    assert.ok(!h.root.markup.includes('data-edit-panel="'));
    assert.match(h.root.markup, /当前显示范围暂无待养成星石/);
  }
});
await test("experience receives exact effective IDs in detail, summary, selected group and drill-down", () => {
  const h = harness(); h.render(); h.toggle(true);
  const effective = plain(h.run("effectiveReviewStars().map(s => s.starInstanceId)"));
  h.experienceCalls.length = 0; h.run("experienceNeedsTemplate(selectedStar())");
  assert.deepEqual(h.experienceCalls[0], [h.run("selectedId")]); assert.deepEqual(h.experienceCalls[1], effective);
  h.run('viewMode = "summary"'); h.experienceCalls.length = 0; h.run("summaryExperienceNeedsTemplate()");
  assert.deepEqual(h.experienceCalls[0], effective);
  h.run('summarySelectedGroupKey = "主星|巨门"'); h.experienceCalls.length = 0; h.run("summaryExperienceNeedsTemplate()");
  assert.deepEqual([...h.experienceCalls[0]].sort(), ["jm-pending-1", "jm-pending-2"]);
  h.run('drillDownSummaryGroup("主星|天府")'); h.experienceCalls.length = 0; h.run("experienceNeedsTemplate(selectedStar())");
  assert.deepEqual(h.experienceCalls[0], ["tf-pending"]); assert.deepEqual(h.experienceCalls[1], ["tf-pending"]);
});
await test("top inventory integrity diagnostic unchanged by pending-only", () => {
  const h = harness(); h.render();
  const overview = () => h.root.markup.match(/<p class="review-overview">[\s\S]*?<\/p>/)[0];
  const before = overview(); assert.match(before, /当前汇总 11 颗，背包数量 10 颗/);
  h.toggle(true); assert.equal(overview(), before); assert.match(h.run('reviewCountLabel("plan")'), /对应 4 颗/);
});
await test("disabled regression: ordinary hidden selection, edits, summary, navigation and experience", async () => {
  const h = harness(); h.render(); h.run('selectStar("tf-done-1", "current")');
  h.fire("#name-filter", "巨门", "input"); h.fire("#apply-filter", "", "click");
  assert.equal(h.run("selectedId"), "tf-done-1"); assert.equal(h.run("selectedStar().starInstanceId"), "tf-done-1");
  h.experienceCalls.length = 0; h.run("experienceNeedsTemplate(selectedStar())");
  assert.deepEqual(h.experienceCalls[0], ["tf-done-1"]);
  assert.deepEqual(h.experienceCalls[1], plain(h.run("filteredStars().map(s => s.starInstanceId)")));
  h.run('viewMode = "summary"'); assert.match(h.run('summaryPanelRows("plan")'), /共4颗/);
  assert.ok(!h.run('summaryPanelRows("plan")').includes("待养"));
  const before = plain(h.run("captureReviewNavigation()")); h.run('drillDownSummaryGroup("主星|巨门"); toggleReviewView()');
  assert.deepEqual(plain(h.run("captureReviewNavigation()")), before);
  h.run('viewMode = "detail"; selectStar("tf-pending", "plan"); planEditDraft = 50; commitPlanEditor()'); await h.settled();
  assert.equal(h.session.state.planTargets["tf-pending"], 50);
});
await test("page remount resets pending-only and true empty inventory uses target heading", () => {
  const h = harness(); assert.equal(h.run("pendingOnly"), false, "fresh standalone page defaults to all");
  const empty = harness([]); empty.render(); assert.match(empty.root.markup, /<th>养成目标<\/th>/); assert.ok(!empty.root.markup.includes("<th>计划等级</th>"));
});
await test("paired panes use the same instance IDs and toggling leaves persisted data intact", () => {
  const h = harness(); h.render();
  const before = JSON.stringify(h.session.state);
  h.run('selectedId = "tf-pending"'); h.toggle(true);
  const paneIds = pane => [...h.run(`panelRows("${pane}")`).matchAll(/data-star-id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paneIds("current"), paneIds("plan"));
  assert.equal(h.run("selectedId"), "tf-pending");
  h.fire("#view-mode-toggle", "", "click"); assert.equal(h.run("pendingOnly"), true);
  h.toggle(false); assert.equal(h.run("viewMode"), "summary");
  assert.equal(JSON.stringify(h.session.state), before);
  assert.equal(h.run("effectiveReviewStars().length"), inventory.length);
});
console.log(`PASS ${passed} pending-only interaction checks`);
