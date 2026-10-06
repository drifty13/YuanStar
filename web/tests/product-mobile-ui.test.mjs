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
    browserCatalog: { normalize: (name) => name, entry: (name) => name === "天府" ? { name, kind: "主星" } : null },
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

for (const surface of ["thumbnail", "caption"]) {
  const h = harness(); h.run("bindImportControls()");
  const child = new Element(); child.parent = h.cards[0];
  // Both descendants bubble to the existing whole-card drag surface.
  h.cards[0].fire("touchstart", { target: child, touches: [touch()] });
  h.activateHold();
  assert.ok(h.cards[0].classes.has("is-touch-dragging"), surface);
  assert.ok(h.cards[0].fire("touchmove", { touches: [touch(50, 80)] }).prevented);
  h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), [["image-main", "辅星"]]);
  assert.ok(!h.cards[0].classes.has("is-touch-dragging"));
  assert.ok(h.cards[0].fire("click").stopped, "drag does not also open preview");
}
{
  const h = harness(); h.run("bindImportControls()");
  h.cards[0].fire("touchstart", { touches: [touch()] });
  assert.ok(!h.cards[0].fire("touchmove", { touches: [touch(20, 60)] }).prevented, "ordinary swipe can scroll");
  h.activateHold(); h.cards[0].fire("touchend", { changedTouches: [touch(20, 60)] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), []); assert.equal(h.timers.size, 0);
  assert.ok(!h.cards[0].fire("click").stopped, "ordinary tap keeps preview");
  const deleteButton = new Element(); deleteButton.closest = () => deleteButton;
  h.cards[0].fire("touchstart", { target: deleteButton, touches: [touch()] });
  assert.equal(h.timers.size, 0, "delete never activates drag");
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.activateHold();
  h.cards[0].fire("touchcancel"); assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), []);
  assert.ok(!h.cards[0].classes.has("is-touch-dragging"));
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.run("cancelImportTouchDrag()");
  assert.equal(h.timers.size, 0, "rerender/dispose cancels activation timer");
  h.run("isOcrLocked = () => true"); h.cards[0].fire("touchstart", { touches: [touch()] });
  assert.equal(h.timers.size, 0, "locked OCR cannot drag");
}
{
  const h = harness(); h.run("bindImportControls()");
  const transfer = { setData: (_, value) => { transfer.id = value; }, getData: () => transfer.id };
  h.cards[0].fire("dragstart", { dataTransfer: transfer });
  h.pools[2].fire("drop", { dataTransfer: transfer });
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), [["image-main", "经验星曜"]], "desktop native DnD still moves");
  h.run('importImages[0].objectUrl = "blob:thumbnail"; importImages[0].filename = "image.png"');
  assert.match(h.run('importPoolTemplate("主星")'), /<img draggable="false"/, "image does not start a separate URL drag");
}

{
  const h = harness(); h.run("bindImportControls()");
  h.cards[0].fire("touchstart", { touches: [touch()] });
  h.cards[0].fire("touchend", { changedTouches: [touch()] });
  h.activateHold(); assert.equal(h.moves.length, 0, "release before hold does not move");
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.activateHold();
  h.cards[0].fire("pointercancel");
  assert.ok(!h.cards[0].classes.has("is-touch-dragging"));
  h.cards[0].fire("touchend", { changedTouches: [touch()] }); assert.equal(h.moves.length, 0);
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.activateHold();
  h.run("isOcrLocked = () => true");
  h.cards[0].fire("touchmove", { touches: [touch(80, 90)] });
  h.cards[0].fire("touchend", { changedTouches: [touch(80, 90)] }); assert.equal(h.moves.length, 0);
}
console.log("PASS touch hold, scroll, tap, delete, cancel, OCR lock and desktop DnD");
