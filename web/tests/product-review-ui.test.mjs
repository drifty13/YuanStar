import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const web = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(web, ".tmp", "test", "review-ui");
const compilation = spawnSync(process.execPath, [join(web, "node_modules/typescript/bin/tsc"),
  "--ignoreConfig", "--noCheck", "--noResolve", "--target", "ES2022", "--module", "ES2022",
  "--outDir", output, "src/product.ts", "src/product-summary-view.ts"], { cwd: web, encoding: "utf8" });
assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);
const source = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8");
const executable = readFileSync(join(output, "product.js"), "utf8");
const names = [
  "selectedStar", "captureReviewNavigation", "restoreReviewNavigation", "captureReviewUi",
  "recordReviewUiMutation", "nameSearchTerms", "hasActiveReviewFilter", "filteredStars",
  "panelRows", "summaryGroups", "summaryPanelRows", "reviewRows", "reviewCountLabel",
  "reviewTemplate", "bindReviewRows", "selectSummaryGroup", "cancelQueuedSummarySelection",
  "queueSummarySelection", "recordReviewNavigationMutation", "drillDownSummaryGroup", "toggleReviewView",
];
// Execute the shipped functions; keep storage, OCR and page startup outside this focused UI harness.
const functions = names.map((name) => {
  const start = executable.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing production function ${name}`);
  const firstNewline = executable.indexOf("\n", start);
  const end = executable.slice(start, firstNewline).trimEnd().endsWith("}")
    ? firstNewline : executable.indexOf("\n}", firstNewline) + 2;
  assert.ok(end > start, `missing production function body ${name}`);
  return executable.slice(start, end);
}).join("\n");
const inventory = [
  { starInstanceId: "tianfu-orange", kind: "主星", name: "天府", quality: "橙", level: 20, targetLevel: 60 },
  { starInstanceId: "tianfu-purple", kind: "主星", name: "天府", quality: "紫", level: 30, targetLevel: 55 },
  { starInstanceId: "wuqu", kind: "主星", name: "武曲", quality: "橙", level: 40, targetLevel: 50 },
  { starInstanceId: "support-tianfu", kind: "辅星", name: "天府", quality: "蓝", level: 10, targetLevel: 10 },
];
const timers = new Map();
let nextTimer = 0;
const row = { dataset: { pane: "current", summaryGroupKey: "主星|天府" }, listeners: {},
  addEventListener(name, handler) { this.listeners[name] = handler; }, querySelector() { return null; } };
const context = createContext({
  exports: {}, viewMode: "detail", kindFilter: "全部", qualityFilter: "全部", nameFilter: "", appliedNameFilter: "",
  sortFilter: "level", preFilterSortFilter: null, reviewFilterWasActive: false, summarySelectedGroupKey: null,
  drillDownOrigin: null, selectedId: inventory[0].starInstanceId, selectedPane: "current", summaryClickTimer: null,
  pendingOcrReview: null, completedReviewOccurrences: new Set(), reviewUiUndo: [], reviewUiRedo: [],
  currentEditDraft: null, planEditDraft: null, reviewError: "", reviewSaveState: "saved", ocrListExpanded: false,
  experienceDraft: { orange: "0", purple: "0", white: "0" },
  workspaceContext: { record: { revision: 7, snapshot: { gameVersion: "CN", bag: { currentCount: 4, capacity: 100 },
    experience: {}, importReview: { imagePools: {} } } }, account: { displayName: "UI fixture" } },
  displayStars: () => inventory, browserCatalog: { orderIndex: (name) => ["天府", "武曲"].indexOf(name) },
  qualityPriority: { 橙: 0, 紫: 1, 蓝: 2, 绿: 3, 白: 4 }, kindPriority: { 主星: 0, 辅星: 1 },
  html: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
  inventoryGroupKey: (star) => `${star.kind}|${star.name}|${star.quality}|${star.level}`,
  starDescription: () => "", qualityMark: (value) => value, nameOptions: () => "",
  saveStateLabel: () => "已保存", experienceNeedsTemplate: () => "", summaryExperienceNeedsTemplate: () => "",
  pendingOcrReviewTemplate: () => "", bindStarDescriptionTooltips: () => {}, summaryRowFor: () => null,
  root: { querySelectorAll: () => [row], querySelector: () => null },
  window: { setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } },
});
const execute = (code) => runInContext(code, context);
execute(readFileSync(join(output, "product-summary-view.js"), "utf8").replace(/^export /gm, ""));
execute(functions);
context.renderReview = () => { context.rendered = execute("reviewTemplate()"); };
const render = () => execute("reviewTemplate()");
const section = (html, expression) => { const match = html.match(expression); assert.ok(match, "rendered section exists"); return match[1]; };
const toolbar = (html) => section(html, /<section class="review-toolbar"[^>]*>([\s\S]*?)<\/section>/);
const facts = (html) => section(toolbar(html), /<dl class="inventory-facts">([\s\S]*?)<\/dl>/);
const rows = (html, pane) => section(html, new RegExp(`<tbody id="${pane}-rows">([\\s\\S]*?)<\\/tbody>`));
const rowKeys = (html) => [...html.matchAll(/data-summary-group-key="([^"]+)"/g)].map((match) => match[1]);

let html = render();
assert.match(facts(html), /id="view-mode-toggle"[^>]*>逐颗明细<\/button>/, "full detail label is rendered in inventory facts");
assert.match(facts(html), /<select id="sort-filter">/, "detail retains normal sorting in inventory facts");
assert.deepEqual([...facts(html).matchAll(/<dt>(.*?)<\/dt>/g)].map((match) => match[1]), ["视图", "排序", "背包数量", "背包容量", "保存状态"]);
const filters = section(toolbar(html), /<div class="filter-strip">([\s\S]*?)<\/div>/);
assert.ok(!/id="(?:view-mode-toggle|sort-filter)"/.test(filters), "view and sort are outside the filter strip");
assert.match(filters, /标准名称搜索/);
assert.match(filters, /id="apply-filter"/);
assert.match(filters, /id="clear-filter"/);

execute("toggleReviewView()");
html = context.rendered;
assert.match(facts(html), /id="view-mode-toggle"[^>]*>名称汇总<\/button>/);
assert.ok(!/id="view-mode-toggle"[^>]*>(明细|汇总)<\/button>/.test(html));
assert.match(facts(html), /id="sort-filter" type="button" aria-disabled="true">名称排序/);
assert.ok(!facts(html).includes('<select id="sort-filter">'));
assert.equal(context.sortFilter, "level", "summary lock preserves the prior detail sort");
assert.match(html, /3 组 · 4 颗/);
assert.deepEqual(rowKeys(rows(html, "current")), ["主星|天府", "主星|武曲", "辅星|天府"]);
assert.deepEqual(rowKeys(rows(html, "plan")), rowKeys(rows(html, "current")));
assert.match(rows(html, "current"), /本组共 2 颗/);
assert.match(rows(html, "plan"), /本组共 2 颗/);

execute("bindReviewRows()");
row.listeners.click();
assert.equal(timers.size, 1, "single click queues selection");
for (const [id, callback] of timers) { timers.delete(id); callback(); }
assert.equal(context.summarySelectedGroupKey, "主星|天府");
for (const pane of ["current", "plan"]) assert.match(rows(context.rendered, pane), /summary-row is-selected[^>]*data-summary-group-key="主星\|天府"/);

// Keep a multi-name filter, selection and a distinct unsubmitted input in the return snapshot.
Object.assign(context, { nameFilter: "未应用", appliedNameFilter: "天府 武曲", kindFilter: "主星",
  reviewFilterWasActive: true, preFilterSortFilter: "target" });
const origin = JSON.stringify(execute("captureReviewNavigation()"));
row.listeners.click();
row.listeners.dblclick();
assert.equal(timers.size, 0, "double-click cancels the delayed selection");
assert.equal(context.viewMode, "detail");
assert.equal(context.nameFilter, "天府");
assert.equal(context.appliedNameFilter, "天府");
assert.deepEqual(Array.from(execute("filteredStars().map(star => star.starInstanceId)")), ["tianfu-purple", "tianfu-orange"]);
for (const pane of ["current", "plan"]) {
  assert.equal((rows(context.rendered, pane).match(/data-star-id=/g) ?? []).length, 2);
  assert.ok(!rows(context.rendered, pane).includes('data-star-id="wuqu"'));
}
execute("toggleReviewView()");
assert.equal(JSON.stringify(execute("captureReviewNavigation()")), origin, "return restores every summary navigation field");
assert.equal(context.drillDownOrigin, null);
assert.equal(context.workspaceContext.record.revision, 7, "navigation does not mutate the workspace");
assert.ok(context.reviewUiUndo.every((entry) => !entry.workspaceMutation), "navigation history stays UI-only");
execute("toggleReviewView()");
assert.equal(context.sortFilter, "level", "normal detail sort survives a summary round trip");
assert.match(facts(context.rendered), /<select id="sort-filter">/);

// Standalone boundary is a supplementary static guard; UI behavior above executes production functions.
for (const token of ["onSummaryChange", "onCaptureCommitted", "onCaptureOcrCommitted", "CaptureBatch", "YuanStarMountOptions", "product-standalone", "hostBridge", "cloudSync"]) {
  assert.ok(!source.includes(token), `standalone source must not import ${token}`);
}
assert.ok(!readFileSync(new URL("../src/product.css", import.meta.url), "utf8").includes("yuanstar-embedded"));
console.log("product review UI: toolbar, labels, counts, paired selection, double-click, snapshot return and standalone boundary passed");
