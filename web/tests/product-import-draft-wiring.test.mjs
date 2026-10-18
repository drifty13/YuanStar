import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// Execute the page's actual functions with controlled storage/classifier boundaries.
// The controller/repository tests separately exercise real persistence implementations.
const source = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8");
function pageFunction(name, input = source) {
  const start = input.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  const rest = input.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  return rest.slice(0, end < 0 ? undefined : end + 1);
}
const functions = ["addImportFiles", "classifyAddedImages", "retryImportDraftSave", "ensureImportDraftSaved",
  "importDraftSaveMessage", "importDraftPersistenceTemplate", "reportImportDraftError"].map((name) => pageFunction(name)).join("\n");
const temporary = new URL("../.tmp/import-draft-wiring/", import.meta.url);
mkdirSync(temporary, { recursive: true });
const typescript = new URL("functions.ts", temporary);
writeFileSync(typescript, functions, "utf8");
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)),
  "--ignoreConfig", "--target", "ES2022", "--module", "ESNext", "--noCheck", "--outDir", fileURLToPath(temporary), fileURLToPath(typescript)], { stdio: "inherit" });
const javascript = readFileSync(new URL("functions.js", temporary), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const failFirst of [false, true]) {
  let finishSave;
  let classifyCalls = 0;
  let metadataCalls = 0;
  let saveCalls = 0;
  let failure = null;
  const pendingSave = new Promise((resolve, reject) => { finishSave = failFirst ? () => reject(new DOMException("original private details", "DataCloneError")) : resolve; });
  const images = [1, 2, 3].map((id) => ({ sourceImageId: `image-${id}`, classificationStatus: "classifying", file: { id } }));
  const context = vm.createContext({
    workspaceContext: { account: { accountId: "A" } }, importDraftReadyAccountId: "A",
    importDraftGeneration: 0, mountGeneration: 0, importDraftTransitioning: false,
    importImages: [], overlapRelations: [], activeTab: "import", ocrUi: {},
    isOcrLocked: () => false, isCurrentMountGeneration: (generation) => generation === context.mountGeneration,
    renderPage: () => {}, prepareProductOcrForImages: () => {}, html: (value) => value,
    importNotice: (message, error = false) => { context.ocrUi.message = error ? "" : message; context.ocrUi.error = error ? message : ""; },
    findImportImage: (id) => context.importImages.find((image) => image.sourceImageId === id),
    createProductImportImages: () => images,
    applyProductImportClassification: (current, id) => current.map((image) => image.sourceImageId === id ? { ...image, classificationStatus: "suggested" } : image),
    applyProductImportClassificationFailure: () => { throw new Error("unexpected classification failure"); },
    ocrCoordinator: { classify: async () => { classifyCalls++; return { pageType: "support" }; } },
    importDraftController: {
      generation: 0, createImages: () => images,
      isCurrent: (account, generation) => account === context.workspaceContext.account.accountId && generation === context.importDraftController.generation,
      get persistenceFailure() { return failure; },
      save: async (current, pairs, additions) => {
        assert.equal(current.length, 3); assert.equal(additions.length, 3);
        if (++saveCalls === 1) {
          try { await pendingSave; } catch (error) { failure = { name: error.name }; throw error; }
        }
        failure = null;
      },
      saveMetadata: async () => { assert.equal(failure, null); metadataCalls++; },
      flush: async () => { if (failure) throw new Error("original failure"); },
    },
  });
  vm.runInContext(javascript, context);
  const adding = context.addImportFiles([]);
  assert.equal(classifyCalls, 0, "three-image classification must wait for durable save");
  assert.equal(context.importDraftTransitioning, true);
  finishSave();
  await adding; await tick();
  if (failFirst) {
    assert.equal(classifyCalls, 0); assert.equal(metadataCalls, 0);
    assert.equal(await context.ensureImportDraftSaved(), false, "OCR must reject an unsaved draft");
    await context.addImportFiles([]);
    assert.equal(saveCalls, 1, "new files wait until the unsaved draft is recovered");
    const markup = context.importDraftPersistenceTemplate();
    assert.match(markup, /role="alert"/); assert.match(markup, /data-retry-import-draft/);
    assert.doesNotMatch(markup, /original private details|DataCloneError|metadata/);
    await context.retryImportDraftSave(); await tick();
    assert.equal(context.importDraftPersistenceTemplate(), "");
  }
  assert.equal(classifyCalls, 3); assert.equal(metadataCalls, 3);
  assert.equal(await context.ensureImportDraftSaved(), true);
  assert.equal(context.importDraftTransitioning, false);
}

// A completed save must never start an old draft's classifier after invalidation.
for (const invalidation of ["clear", "account"]) {
  let complete;
  let classifications = 0;
  const context = vm.createContext({
    workspaceContext: { account: { accountId: "A" } }, importDraftReadyAccountId: "A",
    mountGeneration: 0, importDraftGeneration: 0, importDraftTransitioning: false, importImages: [], overlapRelations: [], ocrUi: {},
    isOcrLocked: () => false, isCurrentMountGeneration: (generation) => generation === context.mountGeneration, renderPage: () => {}, prepareProductOcrForImages: () => {},
    createProductImportImages: () => [{ sourceImageId: "stale" }],
    classifyAddedImages: () => { classifications++; }, reportImportDraftError: () => { throw new Error("stale error"); },
    importDraftController: { generation: 0, createImages: () => [{ sourceImageId: "stale" }],
      isCurrent: (account, epoch) => account === context.workspaceContext.account.accountId && epoch === context.importDraftController.generation,
      save: () => new Promise((resolve) => { complete = resolve; }) },
  });
  vm.runInContext(pageFunction("addImportFiles", javascript), context);
  const adding = context.addImportFiles([]);
  if (invalidation === "clear") { context.importDraftGeneration++; context.importDraftController.generation++; }
  else context.workspaceContext.account.accountId = "B";
  complete(); await adding;
  assert.equal(classifications, 0);
}

const request = pageFunction("requestStartOcr"), begin = pageFunction("beginOcrRun");
assert.match(request, /await ensureImportDraftSaved\(\)/);
assert.match(begin, /await ensureImportDraftSaved\(\)/);
assert.match(source, /\[data-retry-import-draft\].*addEventListener\("click".*retryImportDraftSave/);
console.log("PASS actual page functions: three-image save ordering, failure, retry, OCR gate and stale draft/account invalidation");

// Resolve a classifier after clear/account switch: no stale UI or metadata may survive.
for (const invalidation of ["clear", "account"]) {
  let finishClassification;
  let writes = 0, updates = 0, notices = 0;
  const context = vm.createContext({
    workspaceContext: { account: { accountId: "A" } }, importDraftGeneration: 0, mountGeneration: 0,
    importImages: [{ sourceImageId: "late-image" }], overlapRelations: [], activeTab: "import",
    isCurrentMountGeneration: (generation) => generation === context.mountGeneration,
    findImportImage: () => context.importImages[0], renderPage: () => {},
    ocrCoordinator: { classify: () => new Promise((resolve) => { finishClassification = resolve; }) },
    applyProductImportClassification: () => { updates++; return context.importImages; },
    applyProductImportClassificationFailure: () => { throw new Error("unexpected failure"); },
    importNotice: () => { notices++; }, reportImportDraftError: () => { notices++; },
    importDraftController: { generation: 0,
      isCurrent: (account, epoch) => account === context.workspaceContext.account.accountId && epoch === context.importDraftController.generation,
      saveMetadata: async () => { writes++; } },
  });
  vm.runInContext(pageFunction("classifyAddedImages", javascript), context);
  const classifying = context.classifyAddedImages(context.importImages);
  if (invalidation === "clear") { context.importDraftGeneration++; context.importDraftController.generation++; }
  else context.workspaceContext.account.accountId = "B";
  finishClassification({ pageType: "support" }); await classifying;
  assert.equal(writes, 0); assert.equal(updates, 0); assert.equal(notices, 0);
}
console.log("PASS in-flight classification invalidation on clear and account switch");

// Retry invalidates a classifier already in flight before the failed append/save.
{
  let finishOldClassification;
  let calls = 0, metadataWrites = 0;
  const images = [1, 2, 3].map((id) => ({ sourceImageId: `retry-${id}`, classificationStatus: "classifying" }));
  const context = vm.createContext({
    workspaceContext: { account: { accountId: "A" } }, importDraftReadyAccountId: "A",
    importDraftGeneration: 0, mountGeneration: 0, importDraftTransitioning: false,
    importImages: images, overlapRelations: [], activeTab: "import", ocrUi: {},
    isOcrLocked: () => false, isCurrentMountGeneration: (generation) => generation === context.mountGeneration,
    renderPage: () => {}, html: (value) => value,
    importNotice: () => {}, reportImportDraftError: () => { throw new Error("unexpected persistence failure"); },
    findImportImage: (id) => context.importImages.find((item) => item.sourceImageId === id),
    applyProductImportClassification: (current, id) => current.map((item) => item.sourceImageId === id ? { ...item, classificationStatus: "suggested" } : item),
    applyProductImportClassificationFailure: () => { throw new Error("unexpected classifier failure"); },
    ocrCoordinator: { classify: () => ++calls === 1 ? new Promise((resolve) => { finishOldClassification = resolve; }) : Promise.resolve({ pageType: "support" }) },
    importDraftController: { generation: 0,
      isCurrent: (account, epoch) => account === "A" && epoch === 0,
      save: async (current, pairs, blobs) => { assert.equal(current.length, 3); assert.equal(blobs.length, 3); },
      saveMetadata: async () => { metadataWrites++; } },
  });
  vm.runInContext(javascript, context);
  const oldRun = context.classifyAddedImages(images);
  await context.retryImportDraftSave(); await tick();
  assert.equal(metadataWrites, 3);
  finishOldClassification({ pageType: "main" }); await oldRun;
  assert.equal(metadataWrites, 3, "late pre-retry classifier must not write metadata or overwrite current suggestions");
  assert.equal(calls, 4, "retry resumes exactly three current images after the one invalidated old request");
}
console.log("PASS retry invalidates pre-failure in-flight classification");
