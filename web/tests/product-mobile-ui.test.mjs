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
  const timers = new Map(), timerDelays = [], moves = [], saved = [];
  let timerId = 0;
  const context = vm.createContext({ console, Element, HTMLSelectElement: class {},
    ProductWorkspaceController: class {}, ProductOcrImportCoordinator: class {}, ProductImportDraftController: class {},
    createDisplayLocaleAdapter: () => ({ apply() {} }), window: { localStorage: { getItem: () => null } },
    setTimeout: (callback, delay) => { timerDelays.push(delay); timers.set(++timerId, callback); return timerId; }, clearTimeout: (id) => timers.delete(id),
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
  const activateHold = () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } };
  return { run, cards, pools, nodes, timers, timerDelays, moves, saved, activateHold, target: (pool) => { target = pool; } };
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

{
  const h = harness(); h.run("bindImportControls()");
  h.cards[0].fire("touchstart", { touches: [touch()] });
  assert.equal(h.timerDelays.at(-1), 350, "hold activation delay is 350ms");
  h.cards[0].fire("touchmove", { touches: [touch(28, 30)] });
  assert.equal(h.timers.size, 1, "8px incidental movement retains the hold");
  h.cards[0].fire("touchmove", { touches: [touch(29, 30)] });
  assert.equal(h.timers.size, 0, "movement beyond 8px yields to browser scroll");
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.activateHold();
  h.run("isOcrLocked = () => true");
  h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  assert.equal(h.moves.length, 0, "locking before release prevents the classification action");
}
{
  const h = harness();
  const remove = new Element({ deleteImage: "image-main" });
  const preview = new Element({ previewImage: "image-main" });
  h.nodes.set("[data-delete-image]", [remove]); h.nodes.set("[data-preview-image]", [preview]);
  h.run("bindImportControls()");
  h.run("removeImportImage = id => __moves.push(['delete', id]); setPreviewImage = id => __saved.push(id)");
  h.cards[0].fire("touchstart", { touches: [touch()] }); h.cards[0].fire("touchend", { changedTouches: [touch()] });
  const click = h.cards[0].fire("click"); if (!click.stopped) preview.fire("click");
  assert.deepEqual(h.saved, ["image-main"], "tap invokes the actual preview button handler");
  assert.ok(remove.fire("click").stopped);
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), [["delete", "image-main"]], "actual delete handler remains usable");
}
function clickHarness() {
  const h = harness();
  const preview = new Element({ previewImage: "image-main" });
  const remove = new Element({ deleteImage: "image-main" });
  h.nodes.set("[data-preview-image]", [preview]); h.nodes.set("[data-delete-image]", [remove]);
  h.run("bindImportControls(); removeImportImage = id => __moves.push(['delete', id]); setPreviewImage = id => __saved.push(id)");
  return { ...h, hold() { h.cards[0].fire("touchstart", { touches: [touch()] }); h.activateHold(); },
    click(button = preview) {
      const captured = h.cards[0].fire("click", { target: button });
      if (!captured.stopped) button.fire("click");
      return captured;
    }, remove };
}

function cancelGesture(h, cancellation) {
  if (cancellation === "locked-release" || cancellation === "locked-move") {
    h.run("isOcrLocked = () => true");
    h.cards[0].fire(cancellation === "locked-release" ? "touchend" : "touchmove", { touches: [touch()], changedTouches: [touch()] });
    h.run("isOcrLocked = () => false");
  } else if (cancellation === "missing-pool") {
    h.target(null); h.cards[0].fire("touchend", { changedTouches: [touch()] });
  } else if (cancellation === "multiple-touches") {
    h.cards[0].fire("touchmove", { touches: [touch(), { ...touch(), identifier: 2 }] });
  } else if (cancellation === "dispose") {
    h.run("cancelImportTouchDrag()");
  } else {
    h.cards[0].fire(cancellation);
  }
}
for (const cancellation of ["touchcancel", "pointercancel", "locked-release", "locked-move", "missing-pool", "multiple-touches", "dispose"]) {
  const h = clickHarness(); h.hold(); cancelGesture(h, cancellation);
  assert.equal(h.moves.length, 0, `${cancellation}: cancelled gesture does not move`);
  assert.equal(h.timers.size, 0, `${cancellation}: no pending hold or suppression cleanup`);
  // No new touchstart or timer flush may be needed to unblock the first click.
  assert.ok(!h.click().stopped, `${cancellation}: first preview click immediately works`);
  assert.deepEqual(h.saved, ["image-main"], `${cancellation}: actual preview handler executes`);

  const deleteTest = clickHarness(); deleteTest.hold();
  cancelGesture(deleteTest, cancellation);
  assert.ok(!deleteTest.click(deleteTest.remove).stopped, `${cancellation}: first delete click is not captured`);
  assert.deepEqual(JSON.parse(JSON.stringify(deleteTest.moves)), [["delete", "image-main"]]);
}

for (const rerender of [false, true]) {
  const h = clickHarness();
  if (rerender) h.run("moveImportImage = (id, pool) => { __moves.push([id, pool]); cancelImportTouchDrag(); }");
  h.hold(); h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), [["image-main", "辅星"]]);
  assert.equal(h.timerDelays.at(-1), 0, "successful gesture suppression expires on the next event-loop turn");
  assert.ok(h.click().stopped, "immediate synthetic/captured click remains blocked after successful drag");
  assert.deepEqual(h.saved, [], "synthetic click does not reach preview");
  assert.equal(h.timers.size, 0, "consumed synthetic click cancels cleanup timer");
  assert.ok(!h.click().stopped, "only the gesture's immediate click is consumed");
}

{
  const h = clickHarness(); h.hold();
  h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  h.activateHold(); // Flush the zero-delay cleanup when preventDefault produced no click.
  assert.equal(h.timers.size, 0);
  assert.ok(!h.click().stopped, "without a synthetic click, a later genuine click still previews");
  assert.deepEqual(h.saved, ["image-main"]);
}
{
  const h = clickHarness(); h.hold();
  h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  h.cards[0].fire("touchstart", { touches: [touch()] });
  h.cards[0].fire("touchend", { changedTouches: [touch()] });
  assert.ok(!h.click().stopped, "a new ordinary tap immediately replaces prior gesture suppression");
  assert.deepEqual(h.saved, ["image-main"]);
  assert.equal(h.timers.size, 0);
}
{
  const h = clickHarness(); h.target(h.pools[0]); h.hold();
  h.cards[0].fire("touchend", { changedTouches: [touch()] });
  assert.deepEqual(JSON.parse(JSON.stringify(h.moves)), [["image-main", "主星"]], "same-pool release keeps the existing move call");
  assert.ok(h.click().stopped, "same-pool release without rerender still suppresses synthetic click");
}
{
  const h = clickHarness(); h.hold();
  h.cards[0].fire("touchend", { changedTouches: [touch(50, 80)] });
  h.run("cancelImportTouchDrag()");
  assert.equal(h.timers.size, 0, "disposal clears a pending suppression cleanup timer");
  assert.ok(!h.click().stopped);
}
console.log("PASS touch suppression cancellation, immediate synthetic click, deferred expiry, tap/delete, 350ms/8px thresholds, scroll, OCR lock and desktop DnD");
