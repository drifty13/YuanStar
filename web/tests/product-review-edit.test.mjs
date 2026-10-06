import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Exercise the real page renderers and handlers. Browser geometry remains a separate check.
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempBase = resolve(web, ".tmp");
mkdirSync(tempBase, { recursive: true });
const output = mkdtempSync(resolve(tempBase, "mobile-ui-test-"));
process.on("exit", () => {
  assert.ok(output.startsWith(tempBase + sep));
  rmSync(output, { recursive: true, force: true });
});
const source = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8")
  .replace(/^import[\s\S]*?;\r?\n/gm, "").replace(/^export type \{[^\n]+;\r?\n/gm, "")
  .replace(/const rootElement[\s\S]*?const storedTab/, "let root; const displayLocaleAdapter = { apply() {} }; const storedTab")
  .replace(/\nbindGlobalPaste\(\);[\s\S]*$/, "");
const pageInput = resolve(output, "product-page.ts");
writeFileSync(pageInput, source, "utf8");
const compile = spawnSync(process.execPath, [resolve(web, "node_modules/typescript/bin/tsc"),
  "--ignoreConfig", "--noCheck", "--noResolve", "--target", "ES2022", "--module", "ESNext",
  "--outDir", resolve(output, "page"), pageInput], { cwd: web, stdio: "inherit" });
assert.equal(compile.status, 0, "fresh page function compilation");
const code = readFileSync(resolve(output, "page/product-page.js"), "utf8").replace(/^export /gm, "");

class Element {
  constructor(dataset = {}) {
    this.dataset = dataset;
    this.handlers = new Map();
    this.classes = new Set();
    this.classList = { add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name),
      toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
  }
  addEventListener(type, callback) { this.handlers.set(type, callback); }
  fire(type, props = {}) {
    const event = { target: this, touches: [], changedTouches: [], preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
    this.handlers.get(type)?.(event);
    return event;
  }
  closest(selector) { return selector === "[data-delete-image]" ? null : this.parent ?? this; }
}
function harness() {
  const cards = [new Element({ importImage: "image-main" })];
  const pools = [new Element({ importPool: "主星" }), new Element({ importPool: "辅星" }), new Element({ importPool: "经验星曜" })];
  let target = pools[1];
  const nodes = new Map();
  const root = { querySelector: () => null, querySelectorAll: (selector) =>
    selector === "[data-import-image]" ? cards : selector === "[data-import-pool]" ? pools :
      selector === ".is-drag-target" ? pools.filter((p) => p.classes.has("is-drag-target")) : nodes.get(selector) ?? [] };
  const timers = new Map(), moves = [], saved = [];
  let timerId = 0;
  const context = vm.createContext({ console, Element, HTMLSelectElement: class {},
    ProductWorkspaceController: class {}, ProductOcrImportCoordinator: class {}, ProductImportDraftController: class {},
    createDisplayLocaleAdapter: () => ({ apply() {} }), window: { localStorage: { getItem: () => null } },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id),
    document: { elementFromPoint: () => target },
    __root: root, __moves: moves, __saved: saved,
    productReviewCandidateActions: () => ["view_source", "keep", "ignore", "edit"], productReviewKeepActionLabel: () => "保留",
    sortProductImportImagesForDisplay: (images) => images,
    browserCatalog: { namesForKind: () => ["天府"], normalize: (name) => name, entry: (name) => name === "天府" ? { name, kind: "主星" } : null },
  });
  vm.runInContext(code, context);
  const run = (script) => vm.runInContext(script, context);
  run(`root = __root; isOcrLocked = () => false; renderPage = () => {}; renderReview = () => {};
    bindReviewRows = () => {}; reviewCropTemplate = () => ""; showToast = () => {}; showDuplicateInvalidationToast = () => {};
    importImages = [{ sourceImageId: "image-main", pool: "主星", classificationStatus: "ready" }];
    moveImportImage = (id, pool) => __moves.push([id, pool]);
    runReviewWorkspaceMutation = (id, mutation, after) => {
      mutation({ editOccurrence: (occurrenceId, fields) => __saved.push({ occurrenceId, fields }) }); after(false); renderReview();
    };`);
  const activateHold = () => { for (const [id, callback] of timers) { timers.delete(id); callback(); } };
  return { run, cards, pools, nodes, timers, moves, saved, activateHold, target: (pool) => { target = pool; } };
}
const touch = (x = 20, y = 30) => ({ identifier: 1, clientX: x, clientY: y });

{
  const h = harness();
  h.run(`testCandidate = { occurrenceId: "ordinary", sourceImageId: "image-main", kind: "clean", row: 0, column: 0, name: "天府", level: 1, quality: "橙" };
    pendingOcrReview = { draft: {}, resolution: {}, evidence: {} };`);
  const card = new Element({ reviewOccurrence: "ordinary" });
  const open = new Element(), keep = new Element(), ignore = new Element(), source = new Element({ reviewSource: "image-main" }), cancel = new Element(), confirm = new Element();
  for (const button of [open, cancel, confirm, keep, ignore, source]) button.parent = card;
  card.querySelector = (selector) => ({ value: selector.includes("name") ? "天府" : selector.includes("level") ? "30" : "紫" });
  h.nodes.set("[data-open-ordinary-edit]", [open]); h.nodes.set("[data-cancel-ordinary-edit]", [cancel]); h.nodes.set("[data-confirm-ordinary-edit]", [confirm]);
  h.nodes.set("[data-keep-review-candidate]", [keep]); h.nodes.set("[data-ignore-review-candidate]", [ignore]); h.nodes.set("[data-review-source]", [source]);
  h.run("openReviewSourceImage = () => { throw new Error('outer source action during edit') }; bindReviewControls()");
  const markup = () => h.run("reviewCandidateCardTemplate(testCandidate)");
  assert.match(markup(), /candidate-action-row/);
  const actions = markup().match(/<div class="candidate-action-row">([\s\S]*?)<\/div>/)[1];
  assert.deepEqual([...actions.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map(match => match[1]), ["整页", "保留", "忽略", "修改"], "ordinary card shows four concise actions in order");
  open.fire("click");
  assert.doesNotMatch(markup(), /candidate-action-row/);
  assert.match(markup(), /data-cancel-ordinary-edit/);
  assert.match(markup(), /data-confirm-ordinary-edit/);
  assert.match(markup(), /data-cancel-ordinary-edit[^>]*>取消<\/button>[\s\S]*data-confirm-ordinary-edit[^>]*>确认<\/button>/, "cancel comes before confirm, matching left/right layout and keyboard order");
  assert.doesNotMatch(markup(), /确认修改/);
  assert.doesNotMatch(markup(), /data-review-source|data-keep-review-candidate|data-ignore-review-candidate|data-open-ordinary-edit/);
  keep.fire("click"); ignore.fire("click"); source.fire("click");
  assert.equal(h.saved.length, 0);
  cancel.fire("click"); assert.match(markup(), /candidate-action-row/); assert.deepEqual(h.saved, []);
  open.fire("click"); confirm.fire("click"); assert.match(markup(), /candidate-action-row/);
  assert.deepEqual(JSON.parse(JSON.stringify(h.saved)), [{ occurrenceId: "ordinary", fields: { name: "天府", level: 30, quality: "紫" } }]);
  open.fire("click"); card.querySelector = () => ({ value: "" }); confirm.fire("click");
  assert.doesNotMatch(markup(), /candidate-action-row/, "invalid confirmation stays editing");
  assert.equal(card.dataset.reviewOccurrence, "ordinary", "occurrence identity remains stable");
  assert.ok(h.run("invalidReviewOccurrences.has('ordinary')"), "invalid values retain error feedback");
  assert.equal(h.saved.length, 1, "invalid editor values are not saved");
}

console.log("PASS review edit: cancel, confirm, validation, outer action guards and occurrence identity");
