import "./style.css";
import { createLocalId, createStableImageId } from "./utils/id";
import { isModelLoaded, loadAndVerifyModels, runLocalOcr } from "./ocr";
import { networkSummary } from "./network";
import { deleteRecord, fromBackup, latestRecord, saveRecord, toBackup } from "./storage";
import type { BackupRecord, RawOcrResult, StoredOcrRecord, Timings } from "./types";
import { drawExperienceOverlay, drawStructuredOverlay } from "./structured/debug-overlay";
import { runStructuredExperience } from "./structured/experience-pipeline";
import { runStructuredMain } from "./structured/main-pipeline";
import { runStructuredSupport } from "./structured/support-pipeline";
import type { StructuredExperienceOutput, StructuredMainOutput, StructuredSupportOutput } from "./structured/types";
import { browserVisionWorkerClient } from "./structured/browser-vision-worker-client";
import type { BrowserImageAnalysisV1, OrdinaryStarOccurrenceV1 } from "./structured/contracts";
import { analyzeBrowserBatchWithResult, type BrowserAnalysisResultV1, type ConfirmedOverlapPairV1 } from "./structured/batch-orchestration";
import { BrowserOcrRuntime } from "./ocr/browser-ocr-runtime";
import { describePhase2ADatabase, runPhase2APersistenceSmoke, runPhase2BProtectionSmoke, runPhaseBPostprocessSmoke } from "./business/diagnostics";
import { browserCatalog } from "./business/browser-catalog";
import { buildReconcileDraft, commitReconciledAnalysis, type ReconcileDraftV1, type ReconcileResolutionV1, type ReconcileSourceImageInput } from "./business/reconcile";
import { closeDatabase, getWorkspace, listImagesForAccount, openDatabase } from "./business/persistence/repository";

// Diagnostic-only harness for local Browser smoke. product.html never imports
// this module, and the object owns no Workspace/IndexedDB state.
Object.assign(window, { __yuanstarBrowserOcrRuntime: new BrowserOcrRuntime() });

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少页面元素 #${id}`);
  return element as T;
}

const imageInput = byId<HTMLInputElement>("image-input");
const loadModelsButton = byId<HTMLButtonElement>("load-models");
const runOcrButton = byId<HTMLButtonElement>("run-ocr");
const saveButton = byId<HTMLButtonElement>("save-record");
const canvas = byId<HTMLCanvasElement>("preview");
const stage = byId<HTMLElement>("stage");
const imageMeta = byId<HTMLElement>("image-meta");
const modelOutput = byId<HTMLElement>("model-output");
const ocrOutput = byId<HTMLElement>("ocr-output");
const timingsOutput = byId<HTMLElement>("timings-output");
const environmentOutput = byId<HTMLElement>("environment-output");
const storageStatus = byId<HTMLElement>("storage-status");
const networkOutput = byId<HTMLElement>("network-output");
const runtimeInput = byId<HTMLInputElement>("runtime-image-input");
const runtimeRunButton = byId<HTMLButtonElement>("run-runtime-image");
const runtimeStage = byId<HTMLElement>("runtime-stage");
const runtimeMeta = byId<HTMLElement>("runtime-meta");
const runtimeJson = byId<HTMLElement>("runtime-json");
const workerDiagnosticsOutput = byId<HTMLElement>("worker-diagnostics");
const disposeWorkerButton = byId<HTMLButtonElement>("dispose-worker-runtime");
const inventoryInspectorMeta = byId<HTMLElement>("inventory-inspector-meta");
const inventoryInspectorPreview = byId<HTMLCanvasElement>("inventory-inspector-preview");
const inventoryInspectorJson = byId<HTMLElement>("inventory-inspector-json");
const batchInput = byId<HTMLInputElement>("batch-image-input");
const batchConfirmedPool = byId<HTMLSelectElement>("batch-confirmed-pool");
const batchRunButton = byId<HTMLButtonElement>("run-batch-analysis");
const batchCancelButton = byId<HTMLButtonElement>("cancel-batch-analysis");
const batchPairsInput = byId<HTMLTextAreaElement>("batch-overlap-pairs");
const batchMeta = byId<HTMLElement>("batch-meta");
const batchStage = byId<HTMLElement>("batch-stage");
const batchJson = byId<HTMLElement>("batch-json");
const overlapRelationFilter = byId<HTMLSelectElement>("overlap-relation-filter");
const overlapRelationTable = byId<HTMLTableSectionElement>("overlap-relation-table");
const structuredInput = byId<HTMLInputElement>("structured-image-input");
const structuredRunButton = byId<HTMLButtonElement>("run-structured-main");
const structuredStage = byId<HTMLElement>("structured-stage");
const structuredMeta = byId<HTMLElement>("structured-meta");
const structuredCanvas = byId<HTMLCanvasElement>("structured-preview");
const structuredProfile = byId<HTMLElement>("structured-profile");
const structuredJson = byId<HTMLElement>("structured-json");
const structuredTimings = byId<HTMLElement>("structured-timings");
const structuredTable = byId<HTMLTableSectionElement>("structured-table");
const supportInput = byId<HTMLInputElement>("support-image-input");
const supportRunButton = byId<HTMLButtonElement>("run-structured-support");
const supportStage = byId<HTMLElement>("support-stage");
const supportMeta = byId<HTMLElement>("support-meta");
const supportCanvas = byId<HTMLCanvasElement>("support-preview");
const supportProfile = byId<HTMLElement>("support-profile");
const supportJson = byId<HTMLElement>("support-json");
const supportTimings = byId<HTMLElement>("support-timings");
const supportTable = byId<HTMLTableSectionElement>("support-table");
const experienceInput = byId<HTMLInputElement>("experience-image-input");
const experienceRunButton = byId<HTMLButtonElement>("run-structured-experience");
const experienceStage = byId<HTMLElement>("experience-stage");
const experienceMeta = byId<HTMLElement>("experience-meta");
const experienceCanvas = byId<HTMLCanvasElement>("experience-preview");
const experienceProfile = byId<HTMLElement>("experience-profile");
const experienceJson = byId<HTMLElement>("experience-json");
const experienceTimings = byId<HTMLElement>("experience-timings");
const experienceTable = byId<HTMLTableSectionElement>("experience-table");
const phase2aDiagnostics = byId<HTMLElement>("phase2a-diagnostics");
const phase2aSmokeButton = byId<HTMLButtonElement>("run-phase2a-smoke");
const phase2bDiagnostics = byId<HTMLElement>("phase2b-diagnostics");
const buildReconcileDraftButton = byId<HTMLButtonElement>("build-reconcile-draft");
const commitReconcileDraftButton = byId<HTMLButtonElement>("commit-reconcile-draft");
const phase2bProtectionSmokeButton = byId<HTMLButtonElement>("run-phase2b-protection-smoke");
const phaseBPostprocessDiagnostics = byId<HTMLElement>("phaseb-postprocess-diagnostics");
const phaseBPostprocessSmokeButton = byId<HTMLButtonElement>("run-phaseb-postprocess-smoke");

let currentFile: File | undefined;
let currentBitmap: ImageBitmap | undefined;
let currentResult: RawOcrResult | undefined;
let currentTimings: Timings | undefined;
let currentRecordId: string | undefined;
let runtimeFile: File | undefined;
let batchFiles: File[] = [];
let activeBatchController: AbortController | undefined;
let latestBatchResult: BrowserAnalysisResultV1 | undefined;
let latestBatchSourceImages: ReconcileSourceImageInput[] = [];
let latestReconcileDraft: ReconcileDraftV1 | undefined;
const phase2bDiagnosticAccountId = "phase2b-real-smoke";
let structuredFile: File | undefined;
let structuredBitmap: ImageBitmap | undefined;
let structuredOutput: StructuredMainOutput | undefined;
let supportFile: File | undefined;
let supportBitmap: ImageBitmap | undefined;
let supportOutput: StructuredSupportOutput | undefined;
let experienceFile: File | undefined;
let experienceBitmap: ImageBitmap | undefined;
let experienceOutput: StructuredExperienceOutput | undefined;

function setStage(message: string): void {
  stage.textContent = message;
}

function draw(bitmap: ImageBitmap, result?: RawOcrResult): void {
  const maxWidth = Math.min(900, Math.max(320, document.documentElement.clientWidth - 48));
  const scale = Math.min(1, maxWidth / bitmap.width);
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建预览 Canvas");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (!result) return;
  context.strokeStyle = "#ffcc00";
  context.fillStyle = "#10131a";
  context.font = "14px sans-serif";
  context.lineWidth = 2;
  result.lines.forEach((line, index) => {
    const { x, y, width, height } = line.box;
    context.strokeRect(x * scale, y * scale, width * scale, height * scale);
    context.fillText(`${index + 1}. ${line.text}`, x * scale, Math.max(14, y * scale - 3));
  });
}

function updateButtons(): void {
  runOcrButton.disabled = !currentFile;
  saveButton.disabled = !currentFile || !currentResult || !currentTimings;
  structuredRunButton.disabled = !structuredFile;
  supportRunButton.disabled = !supportFile;
  experienceRunButton.disabled = !experienceFile;
  runtimeRunButton.disabled = !runtimeFile || browserVisionWorkerClient.state !== "ready";
  batchRunButton.disabled = !batchFiles.length || browserVisionWorkerClient.state !== "ready" || activeBatchController != null;
  batchCancelButton.disabled = activeBatchController == null;
  disposeWorkerButton.disabled = browserVisionWorkerClient.state !== "ready";
}

function refreshWorkerDiagnostics(): void {
  workerDiagnosticsOutput.textContent = JSON.stringify(browserVisionWorkerClient.diagnostics, null, 2);
}

async function ensureLegacyOcr(): Promise<void> {
  if (!isModelLoaded()) await loadAndVerifyModels({});
}

function overlayOptions() {
  return {
    content: byId<HTMLInputElement>("overlay-content").checked,
    cards: byId<HTMLInputElement>("overlay-cards").checked,
    names: byId<HTMLInputElement>("overlay-names").checked,
    levels: byId<HTMLInputElement>("overlay-levels").checked,
    labels: byId<HTMLInputElement>("overlay-labels").checked,
  };
}

function refreshStructuredOverlay(): void {
  if (structuredBitmap && structuredOutput) drawStructuredOverlay(structuredCanvas, structuredBitmap, structuredOutput, overlayOptions());
}

function supportOverlayOptions() {
  return {
    content: byId<HTMLInputElement>("support-overlay-content").checked,
    cards: byId<HTMLInputElement>("support-overlay-cards").checked,
    names: byId<HTMLInputElement>("support-overlay-names").checked,
    levels: byId<HTMLInputElement>("support-overlay-levels").checked,
    labels: byId<HTMLInputElement>("support-overlay-labels").checked,
  };
}

function refreshSupportOverlay(): void {
  if (supportBitmap && supportOutput) drawStructuredOverlay(supportCanvas, supportBitmap, supportOutput, supportOverlayOptions());
}

function experienceOverlayOptions() {
  return {
    content: byId<HTMLInputElement>("experience-overlay-content").checked,
    icons: byId<HTMLInputElement>("experience-overlay-icons").checked,
    counts: byId<HTMLInputElement>("experience-overlay-counts").checked,
    labels: byId<HTMLInputElement>("experience-overlay-labels").checked,
  };
}

function refreshExperienceOverlay(): void {
  if (experienceBitmap && experienceOutput) drawExperienceOverlay(experienceCanvas, experienceBitmap, experienceOutput, experienceOverlayOptions());
}

function renderStructured(output: StructuredMainOutput): void {
  const complete = output.candidates.filter((card) => card.completeness === "complete").length;
  const partial = output.candidates.length - complete;
  const review = output.results.filter((item) => item.status === "needs_review").length;
  structuredProfile.textContent = JSON.stringify({ ...output.profile, candidateCount: output.candidates.length, completeCount: complete, partialCount: partial, needsReviewCount: review }, null, 2);
  structuredJson.textContent = JSON.stringify(output, null, 2);
  structuredTimings.textContent = JSON.stringify(output.timings, null, 2);
  structuredTable.replaceChildren();
  output.results.forEach((item) => {
    const row = document.createElement("tr");
    [`r${item.rowIndex + 1}c${item.columnIndex + 1}`, item.nameNormalized ?? (item.nameRaw || "—"), item.level == null ? (item.levelRaw || "—") : String(item.level), item.status, item.reasons.join("；") || "—"].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    structuredTable.append(row);
  });
}

function renderSupport(output: StructuredSupportOutput): void {
  const complete = output.candidates.filter((card) => card.completeness === "complete").length;
  const partial = output.candidates.length - complete;
  const review = output.results.filter((item) => item.status === "needs_review").length;
  supportProfile.textContent = JSON.stringify({ ...output.profile, candidateCount: output.candidates.length, completeCount: complete, partialCount: partial, needsReviewCount: review }, null, 2);
  supportJson.textContent = JSON.stringify(output, null, 2);
  supportTimings.textContent = JSON.stringify(output.timings, null, 2);
  supportTable.replaceChildren();
  output.results.forEach((item) => {
    const row = document.createElement("tr");
    [`r${item.rowIndex + 1}c${item.columnIndex + 1}`, item.nameNormalized ?? (item.nameRaw || "—"), item.level == null ? (item.levelRaw || "—") : String(item.level), item.status, item.reasons.join("；") || "—"].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    supportTable.append(row);
  });
}

function clearStructuredResult(message: string): void {
  structuredBitmap?.close();
  structuredBitmap = undefined;
  structuredOutput = undefined;
  structuredCanvas.width = 0;
  structuredCanvas.height = 0;
  structuredProfile.textContent = message;
  structuredJson.textContent = message;
  structuredTimings.textContent = message;
  structuredTable.replaceChildren();
}

function renderExperience(output: StructuredExperienceOutput): void {
  const complete = output.candidates.filter((item) => item.completeness === "complete").length;
  const partial = output.candidates.length - complete;
  const review = output.results.filter((item) => item.status === "needs_review").length;
  experienceProfile.textContent = JSON.stringify({ ...output.profile, page: output.page, candidateCount: output.candidates.length, completeCount: complete, partialCount: partial, needsReviewCount: review, aggregate: output.aggregate }, null, 2);
  experienceJson.textContent = JSON.stringify(output, null, 2);
  experienceTimings.textContent = JSON.stringify(output.timings, null, 2);
  experienceTable.replaceChildren();
  output.results.forEach((item) => {
    const row = document.createElement("tr");
    [`#${item.index + 1}`, item.canonicalName ?? item.kind ?? "—", item.count == null ? (item.countRaw || "数量未知") : String(item.count), item.status, item.reasons.join("；") || "—"].forEach((value) => {
      const cell = document.createElement("td"); cell.textContent = value; row.append(cell);
    });
    experienceTable.append(row);
  });
}

function clearSupportResult(message: string): void {
  supportBitmap?.close();
  supportBitmap = undefined;
  supportOutput = undefined;
  supportCanvas.width = 0;
  supportCanvas.height = 0;
  supportProfile.textContent = message;
  supportJson.textContent = message;
  supportTimings.textContent = message;
  supportTable.replaceChildren();
}

function clearExperienceResult(message: string): void {
  experienceBitmap?.close();
  experienceBitmap = undefined;
  experienceOutput = undefined;
  experienceCanvas.width = 0;
  experienceCanvas.height = 0;
  experienceProfile.textContent = message;
  experienceJson.textContent = message;
  experienceTimings.textContent = message;
  experienceTable.replaceChildren();
}

function clearMemory(): void {
  currentBitmap?.close();
  currentFile = undefined;
  currentBitmap = undefined;
  currentResult = undefined;
  currentTimings = undefined;
  currentRecordId = undefined;
  imageInput.value = "";
  canvas.width = 0;
  canvas.height = 0;
  imageMeta.textContent = "页面内存已清空；IndexedDB 未改变";
  ocrOutput.textContent = "页面内存已清空";
  timingsOutput.textContent = "页面内存已清空";
  runtimeFile = undefined;
  runtimeInput.value = "";
  runtimeMeta.textContent = "统一识别页面内存已清空";
  runtimeJson.textContent = "页面内存已清空";
  runtimeStage.textContent = "页面内存已清空";
  setStage("页面内存已清空");
  updateButtons();
}

function clearRuntimeResult(message: string): void {
  runtimeJson.textContent = message;
  inventoryInspectorMeta.textContent = message;
  inventoryInspectorJson.textContent = message;
  inventoryInspectorPreview.width = 0;
  inventoryInspectorPreview.height = 0;
}

function acceptRuntimeImage(file: File): void {
  runtimeFile = file;
  clearRuntimeResult("等待运行本次统一识别");
  runtimeMeta.textContent = `${file.name} · ${file.size} bytes`;
  runtimeStage.textContent = "统一识别图片已在浏览器本地选择";
  updateButtons();
}

function acceptBatchImages(files: File[], mode: "replace" | "append" = "replace"): void {
  batchFiles = mode === "append" ? [...batchFiles, ...files] : files;
  batchJson.textContent = "尚未运行";
  batchStage.textContent = batchFiles.length ? "等待运行浏览器本地批次分析" : "等待选择图片并加载模型";
  batchMeta.textContent = batchFiles.length ? `已选择 ${batchFiles.length} 张图片；运行后显示可用于确认 pair 的 sourceImageId。` : "尚未选择批次图片";
  updateButtons();
}

async function loadBlob(blob: Blob, name: string, result?: RawOcrResult, timings?: Timings, id?: string): Promise<void> {
  currentBitmap?.close();
  currentBitmap = await createImageBitmap(blob);
  currentFile = new File([blob], name, { type: blob.type, lastModified: Date.now() });
  currentResult = result;
  currentTimings = timings;
  currentRecordId = id;
  imageMeta.textContent = `${name} · ${currentBitmap.width} × ${currentBitmap.height} · ${blob.size} bytes`;
  ocrOutput.textContent = result ? JSON.stringify(result, null, 2) : "等待运行";
  timingsOutput.textContent = timings ? JSON.stringify(timings, null, 2) : "等待运行";
  draw(currentBitmap, result);
  updateButtons();
}

function refreshNetwork(): void {
  const entries = networkSummary();
  networkOutput.textContent = JSON.stringify({
    requestCount: entries.length,
    externalRequestCount: entries.filter((entry) => !entry.allowed).length,
    containsUserDataCount: entries.filter((entry) => entry.contains_user_data).length,
    requests: entries,
  }, null, 2);
}

async function renderInventoryInspector(file: File, analysis: BrowserImageAnalysisV1, sourceOrder = 1): Promise<void> {
  const observation = analysis.inventoryHeader;
  inventoryInspectorMeta.textContent = `sourceOrder ${sourceOrder} · ${file.name} · ROI ${observation.roi.width} × ${observation.roi.height}`;
  inventoryInspectorJson.textContent = JSON.stringify({
    tokens: observation.tokens,
    normalizedText: observation.tokens.map((token) => token.normalizedText).join(""),
    currentCount: observation.currentCount,
    capacity: observation.capacity,
  }, null, 2);
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(2, Math.max(1, 520 / Math.max(1, observation.roi.width)));
    inventoryInspectorPreview.width = Math.max(1, Math.round(observation.roi.width * scale));
    inventoryInspectorPreview.height = Math.max(1, Math.round(observation.roi.height * scale));
    const context = inventoryInspectorPreview.getContext("2d");
    if (!context) throw new Error("无法创建 inventory inspector Canvas");
    context.drawImage(bitmap, observation.roi.x, observation.roi.y, observation.roi.width, observation.roi.height, 0, 0, inventoryInspectorPreview.width, inventoryInspectorPreview.height);
    context.strokeStyle = "#ffcc00";
    context.fillStyle = "#10131a";
    context.font = "12px sans-serif";
    context.lineWidth = 2;
    observation.tokens.forEach((token, index) => {
      const x = (token.rect.x - observation.roi.x) * scale;
      const y = (token.rect.y - observation.roi.y) * scale;
      context.strokeRect(x, y, token.rect.width * scale, token.rect.height * scale);
      context.fillText(`${index + 1}: ${token.normalizedText}`, x, Math.max(12, y - 3));
    });
  } finally {
    bitmap.close();
  }
}

function appendInspectorCell(row: HTMLTableRowElement, value: string): void {
  const element = document.createElement("td");
  element.textContent = value;
  row.append(element);
}

function renderOverlapInspector(result: BrowserAnalysisResultV1 | undefined): void {
  overlapRelationTable.replaceChildren();
  if (!result) return;
  const occurrences = new Map(result.occurrences.filter((item) => item.kind === "ordinary").map((item) => [item.occurrenceId, item]));
  const filter = overlapRelationFilter.value;
  result.overlap.relations.filter((relation) => filter === "all" || relation.status === filter).forEach((relation) => {
    const left = relation.leftOccurrenceId ? occurrences.get(relation.leftOccurrenceId) : undefined;
    const right = relation.rightOccurrenceId ? occurrences.get(relation.rightOccurrenceId) : undefined;
    const leftOccurrence = left?.kind === "ordinary" ? left.occurrence as OrdinaryStarOccurrenceV1 : undefined;
    const rightOccurrence = right?.kind === "ordinary" ? right.occurrence as OrdinaryStarOccurrenceV1 : undefined;
    const row = document.createElement("tr");
    appendInspectorCell(row, `${relation.pairId}\n${relation.status}`);
    appendInspectorCell(row, leftOccurrence ? `source ${left?.sourceOrder} r${leftOccurrence.row + 1}c${leftOccurrence.column + 1}\n${leftOccurrence.occurrenceId}` : "—");
    appendInspectorCell(row, rightOccurrence ? `source ${right?.sourceOrder} r${rightOccurrence.row + 1}c${rightOccurrence.column + 1}\n${rightOccurrence.occurrenceId}` : "—");
    appendInspectorCell(row, leftOccurrence && rightOccurrence ? `${leftOccurrence.effectiveName ?? "—"}/${rightOccurrence.effectiveName ?? "—"}\n${leftOccurrence.effectiveLevel ?? "—"}/${rightOccurrence.effectiveLevel ?? "—"}\n${leftOccurrence.quality ?? "—"}/${rightOccurrence.quality ?? "—"}` : "—");
    appendInspectorCell(row, leftOccurrence && rightOccurrence ? JSON.stringify({ similarity: relation.evidence.visualSimilarity, left: leftOccurrence.visualEvidence, right: rightOccurrence.visualEvidence }) : String(relation.evidence.visualSimilarity));
    appendInspectorCell(row, relation.evidence.detail);
    overlapRelationTable.append(row);
  });
}

async function acceptImage(file: File): Promise<void> {
  try {
    await loadBlob(file, file.name);
    setStage("图片已在浏览器本地解码");
  } catch (error) {
    setStage(`图片读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function acceptStructuredImage(file: File): void {
  structuredFile = file;
  clearStructuredResult("等待运行本次主星截图");
  structuredMeta.textContent = `${file.name} · ${file.size} bytes`;
  structuredStage.textContent = "主星截图已在浏览器本地选择";
  updateButtons();
}

function acceptSupportImage(file: File): void {
  supportFile = file;
  clearSupportResult("等待运行本次辅星截图");
  supportMeta.textContent = `${file.name} · ${file.size} bytes`;
  supportStage.textContent = "辅星截图已在浏览器本地选择";
  updateButtons();
}

function acceptExperienceImage(file: File): void {
  experienceFile = file;
  clearExperienceResult("等待运行本次经验星曜截图");
  experienceMeta.textContent = `${file.name} · ${file.size} bytes`;
  experienceStage.textContent = "经验星曜截图已在浏览器本地选择";
  updateButtons();
}

imageInput.addEventListener("change", async () => {
  const file = imageInput.files?.[0];
  if (file) await acceptImage(file);
});

structuredInput.addEventListener("change", () => {
  const file = structuredInput.files?.[0];
  if (!file) return;
  acceptStructuredImage(file);
});

supportInput.addEventListener("change", () => {
  const file = supportInput.files?.[0];
  if (!file) return;
  acceptSupportImage(file);
});

experienceInput.addEventListener("change", () => {
  const file = experienceInput.files?.[0];
  if (!file) return;
  acceptExperienceImage(file);
});

runtimeInput.addEventListener("change", () => {
  const file = runtimeInput.files?.[0];
  if (!file) return;
  acceptRuntimeImage(file);
});

structuredRunButton.addEventListener("click", async () => {
  if (!structuredFile) return;
  structuredRunButton.disabled = true;
  clearStructuredResult("本次主星识别正在运行");
  structuredStage.textContent = "正在执行内容区、四列网格、整卡、ROI 与本地识别";
  try {
    await ensureLegacyOcr();
    const result = await runStructuredMain(structuredFile, { imageId: await createStableImageId(structuredFile) });
    structuredBitmap?.close();
    structuredBitmap = result.bitmap;
    structuredOutput = result.output;
    renderStructured(result.output);
    refreshStructuredOverlay();
    const complete = result.output.candidates.filter((card) => card.completeness === "complete").length;
    const partial = result.output.candidates.length - complete;
    structuredStage.textContent = `结构化主星识别完成：${complete} 张完整卡，${partial} 张残片`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clearStructuredResult(`本次主星识别失败：${message}`);
    structuredStage.textContent = `结构化主星识别失败：${message}`;
  } finally {
    updateButtons();
    refreshNetwork();
  }
});

supportRunButton.addEventListener("click", async () => {
  if (!supportFile) return;
  supportRunButton.disabled = true;
  clearSupportResult("本次辅星识别正在运行");
  supportStage.textContent = "正在执行辅星内容区、四列网格、整卡、ROI 与本地识别";
  try {
    await ensureLegacyOcr();
    const result = await runStructuredSupport(supportFile, { imageId: await createStableImageId(supportFile) });
    supportBitmap = result.bitmap;
    supportOutput = result.output;
    renderSupport(result.output);
    refreshSupportOverlay();
    const complete = result.output.candidates.filter((card) => card.completeness === "complete").length;
    const partial = result.output.candidates.length - complete;
    supportStage.textContent = `结构化辅星识别完成：${complete} 张完整卡，${partial} 张残片`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clearSupportResult(`本次辅星识别失败：${message}`);
    supportStage.textContent = `结构化辅星识别失败：${message}`;
  } finally {
    updateButtons();
    refreshNetwork();
  }
});

experienceRunButton.addEventListener("click", async () => {
  if (!experienceFile) return;
  experienceRunButton.disabled = true;
  clearExperienceResult("本次经验星曜识别正在运行");
  experienceStage.textContent = "正在执行经验星曜页面证据、条目定位、类型与数量本地识别";
  try {
    await ensureLegacyOcr();
    const result = await runStructuredExperience(experienceFile, { imageId: await createStableImageId(experienceFile) });
    experienceBitmap = result.bitmap;
    experienceOutput = result.output;
    renderExperience(result.output);
    refreshExperienceOverlay();
    const complete = result.output.candidates.filter((item) => item.completeness === "complete").length;
    const partial = result.output.candidates.length - complete;
    const unknown = result.output.results.filter((item) => item.status === "needs_review").length;
    experienceStage.textContent = `结构化经验星曜识别完成：${complete} 个完整条目，${partial} 个残片，${unknown} 个数量或类型待复核`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    clearExperienceResult(`本次经验星曜识别失败：${message}`);
    experienceStage.textContent = `结构化经验星曜识别失败：${message}`;
  } finally {
    updateButtons();
    refreshNetwork();
  }
});

for (const id of ["overlay-content", "overlay-cards", "overlay-names", "overlay-levels", "overlay-labels"]) {
  byId<HTMLInputElement>(id).addEventListener("change", refreshStructuredOverlay);
}

for (const id of ["support-overlay-content", "support-overlay-cards", "support-overlay-names", "support-overlay-levels", "support-overlay-labels"]) {
  byId<HTMLInputElement>(id).addEventListener("change", refreshSupportOverlay);
}

for (const id of ["experience-overlay-content", "experience-overlay-icons", "experience-overlay-counts", "experience-overlay-labels"]) {
  byId<HTMLInputElement>(id).addEventListener("change", refreshExperienceOverlay);
}

window.addEventListener("paste", async (event) => {
  const image = [...event.clipboardData?.files ?? []].find((file) => file.type.startsWith("image/"));
  if (image) {
    event.preventDefault();
    const safeName = image.name || "clipboard-image.png";
    const localImage = new File([image], safeName, { type: image.type, lastModified: Date.now() });
    await acceptImage(localImage);
    acceptRuntimeImage(localImage);
    acceptBatchImages([localImage], "append");
    acceptStructuredImage(localImage);
    acceptSupportImage(localImage);
    acceptExperienceImage(localImage);
    return;
  }
  const text = event.clipboardData?.getData("application/json") || event.clipboardData?.getData("text/plain");
  if (!text?.trim().startsWith("{")) return;
  event.preventDefault();
  try {
    const record = await fromBackup(JSON.parse(text) as BackupRecord);
    await saveRecord(record);
    await loadBlob(record.image_blob, record.image_name, record.raw_ocr_result, record.timings, record.id);
    storageStatus.textContent = `备份粘贴导入成功：${record.id}`;
  } catch (error) {
    storageStatus.textContent = `备份粘贴导入失败：${error instanceof Error ? error.message : String(error)}`;
  }
});

loadModelsButton.addEventListener("click", async () => {
  loadModelsButton.disabled = true;
  setStage("正在从当前本地站点加载并首跑三个 ONNX 模型");
  try {
    const manifest = await browserVisionWorkerClient.initialize({});
    const result = manifest.models;
    modelOutput.textContent = JSON.stringify({
      totalBytes: result.reduce((sum, item) => sum + item.bytes, 0),
      models: result,
    }, null, 2);
    setStage("Dedicated Worker 已加载三个模型并完成首跑");
  } catch (error) {
    modelOutput.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    setStage("模型兼容性失败");
  } finally {
    loadModelsButton.disabled = false;
    refreshWorkerDiagnostics();
    updateButtons();
    refreshNetwork();
  }
});

runtimeRunButton.addEventListener("click", async () => {
  if (!runtimeFile) return;
  runtimeRunButton.disabled = true;
  clearRuntimeResult("本次统一识别正在运行");
  runtimeStage.textContent = "正在执行页面路由、品质、佩戴与单图 contract 分析";
  try {
    const imageId = await createStableImageId(runtimeFile);
    const analysis: BrowserImageAnalysisV1 = await browserVisionWorkerClient.analyzeImage({ imageId, file: runtimeFile });
    runtimeJson.textContent = JSON.stringify(analysis, null, 2);
    await renderInventoryInspector(runtimeFile, analysis);
    runtimeStage.textContent = `统一识别完成：${analysis.pageClassification.pageType}，${analysis.occurrences.length} 张普通 occurrence，${analysis.experienceOccurrences.length} 个经验 occurrence`;
  } catch (error) {
    clearRuntimeResult(`本次统一识别失败：${error instanceof Error ? error.message : String(error)}`);
    runtimeStage.textContent = `统一识别失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    refreshWorkerDiagnostics();
    updateButtons();
    refreshNetwork();
  }
});

batchInput.addEventListener("change", (event) => {
  acceptBatchImages([...((event.currentTarget as HTMLInputElement).files ?? [])]);
  latestBatchResult = undefined;
  latestBatchSourceImages = [];
  latestReconcileDraft = undefined;
  phase2bDiagnostics.textContent = "尚未建立 reconcile draft";
  commitReconcileDraftButton.disabled = true;
  renderOverlapInspector(undefined);
});

overlapRelationFilter.addEventListener("change", () => renderOverlapInspector(latestBatchResult));

batchRunButton.addEventListener("click", async () => {
  if (!batchFiles.length) return;
  activeBatchController = new AbortController();
  updateButtons();
  batchStage.textContent = "正在按选择顺序执行浏览器本地批次分析";
  try {
    const revisionDb = await openDatabase();
    let baseRevision = 0;
    try { baseRevision = (await getWorkspace(revisionDb, phase2bDiagnosticAccountId))?.revision ?? 0; } finally { closeDatabase(revisionDb); }
    // Development-only task-contract selector; formal UI keeps one effective pool with confirmation state.
    const confirmedPageType: "main" | "support" | null = batchConfirmedPool.value === "main" ? "main" : batchConfirmedPool.value === "support" ? "support" : null;
    const prepared = await Promise.all(batchFiles.map(async (file, index) => {
      const imageId = await createStableImageId(file);
      return {
        sourceImageId: `source-${index + 1}-${imageId}`,
        sourceOrder: index + 1,
        input: { imageId, file },
        ...(confirmedPageType ? { confirmedPool: { imageId, pageType: confirmedPageType } } : {}),
      };
    }));
    const rawPairs = batchPairsInput.value.trim();
    const confirmedOverlapPairs: ConfirmedOverlapPairV1[] = rawPairs ? JSON.parse(rawPairs) as ConfirmedOverlapPairV1[] : [];
    const run = await analyzeBrowserBatchWithResult({
      schemaVersion: "1.0", taskId: `phase2b-batch-${Date.now()}`, accountId: phase2bDiagnosticAccountId, baseRevision,
      images: prepared, confirmedOverlapPairs,
    }, {
      engine: browserVisionWorkerClient,
      signal: activeBatchController.signal,
      onProgress: (progress) => { batchStage.textContent = `${progress.stage}: ${progress.completed}/${progress.total}`; },
    });
    batchMeta.textContent = prepared.map((item) => `${item.sourceOrder}. ${item.sourceImageId}`).join("\n");
    batchJson.textContent = JSON.stringify(run.result, null, 2);
    latestBatchResult = run.result;
    latestBatchSourceImages = prepared.map((item) => ({ sourceImageId: item.sourceImageId, blob: item.input.file, filename: item.input.file.name, mimeType: item.input.file.type || "application/octet-stream", width: null, height: null }));
    latestReconcileDraft = undefined;
    commitReconcileDraftButton.disabled = true;
    renderOverlapInspector(run.result);
    batchStage.textContent = `批次完成：${run.result.task.status}；复核状态：${run.result.review.status}`;
  } catch (error) {
    batchJson.textContent = "批次结果未生成";
    batchStage.textContent = `批次分析失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    activeBatchController = undefined;
    refreshWorkerDiagnostics();
    updateButtons();
    refreshNetwork();
  }
});

function reconcileDiagnosticSummary(draft: ReconcileDraftV1, currentRevision: number, commitStatus: string | null = null): Record<string, unknown> {
  return { taskStatus: latestBatchResult?.task.status ?? null, eligibility: draft.blockReasonCodes.length ? "blocked" : "eligible", rawOrdinaryOccurrenceCount: latestBatchResult?.occurrences.filter((item) => item.kind === "ordinary").length ?? 0, completeOrdinaryOccurrenceCount: draft.candidates.length, excludedPartialCount: draft.excludedOrdinaryOccurrences.length, confirmedDuplicateRelationCount: draft.ordinaryGroups.reduce((total, group) => total + group.duplicateRelationIds.length, 0), physicalStarGroupCount: draft.ordinaryGroups.length, ordinaryReviewItemCount: draft.ordinaryReviewItems.length, overlapReviewItemCount: draft.overlapReviewItems.length, bagDraft: draft.bag, experienceDraft: draft.experience, draftStatus: draft.status, currentWorkspaceRevision: currentRevision, commitStatus, committedStarCount: commitStatus ? "see committed workspace" : null };
}
async function starInstanceIdSetFingerprint(ids: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode([...ids].sort().join("\n")));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}
function acceptedDiagnosticResolution(draft: ReconcileDraftV1): ReconcileResolutionV1 {
  if (draft.experience.reviewReasonCodes.length) throw new Error("diagnostic 不能猜测冲突经验数量；请使用无冲突 batch 重试");
  return { ordinary: Object.fromEntries(draft.ordinaryReviewItems.map((item) => [item.occurrenceId, { action: "accept_suggested" as const }])), overlap: Object.fromEntries(draft.overlapReviewItems.map((item) => [item.rowReviewId, { action: "keep_separate" as const }])) };
}
buildReconcileDraftButton.addEventListener("click", async () => {
  if (!latestBatchResult) { phase2bDiagnostics.textContent = "请先完成 batch analysis"; return; }
  buildReconcileDraftButton.disabled = true;
  try {
    const db = await openDatabase(); let revision = 0;
    try { revision = (await getWorkspace(db, phase2bDiagnosticAccountId))?.revision ?? 0; } finally { closeDatabase(db); }
    latestReconcileDraft = buildReconcileDraft(latestBatchResult, { currentAccountId: phase2bDiagnosticAccountId, currentRevision: revision, activeTaskId: latestBatchResult.task.taskId, catalog: browserCatalog });
    phase2bDiagnostics.textContent = JSON.stringify(reconcileDiagnosticSummary(latestReconcileDraft, revision), null, 2);
    commitReconcileDraftButton.disabled = latestReconcileDraft.status === "blocked";
  } catch (error) { phase2bDiagnostics.textContent = `build reconcile draft 失败：${error instanceof Error ? error.message : String(error)}`; }
  finally { buildReconcileDraftButton.disabled = false; }
});
commitReconcileDraftButton.addEventListener("click", async () => {
  if (!latestReconcileDraft) return;
  commitReconcileDraftButton.disabled = true;
  try {
    const db = await openDatabase();
    try {
      const committed = await commitReconciledAnalysis({ db, draft: latestReconcileDraft, resolution: acceptedDiagnosticResolution(latestReconcileDraft), catalog: browserCatalog, gameVersion: "如鸢", sourceImages: latestBatchSourceImages });
      phase2bDiagnostics.textContent = JSON.stringify({ ...reconcileDiagnosticSummary(latestReconcileDraft, committed.revision, "committed"), committedStarCount: committed.snapshot.inventory.length, committedRevision: committed.revision, starInstanceIdSetFingerprint: await starInstanceIdSetFingerprint(committed.snapshot.inventory.map((item) => item.starInstanceId)) }, null, 2);
    } finally { closeDatabase(db); }
  } catch (error) { phase2bDiagnostics.textContent = `commit reconcile draft 失败：${error instanceof Error ? error.message : String(error)}`; }
});

phase2bProtectionSmokeButton.addEventListener("click", async () => {
  phase2bProtectionSmokeButton.disabled = true;
  try { phase2bDiagnostics.textContent = JSON.stringify(await runPhase2BProtectionSmoke(), null, 2); }
  catch (error) { phase2bDiagnostics.textContent = `Phase 2B protection smoke 失败：${error instanceof Error ? error.message : String(error)}`; }
  finally { phase2bProtectionSmokeButton.disabled = false; }
});

phaseBPostprocessSmokeButton.addEventListener("click", async () => {
  phaseBPostprocessSmokeButton.disabled = true;
  phaseBPostprocessDiagnostics.textContent = "正在运行完全 synthetic 的 Phase B postprocess smoke";
  try { phaseBPostprocessDiagnostics.textContent = JSON.stringify(await runPhaseBPostprocessSmoke(), null, 2); }
  catch (error) { phaseBPostprocessDiagnostics.textContent = `Phase B postprocess smoke 失败：${error instanceof Error ? error.message : String(error)}`; }
  finally { phaseBPostprocessSmokeButton.disabled = false; }
});

batchCancelButton.addEventListener("click", () => {
  activeBatchController?.abort();
  batchStage.textContent = "已请求在当前图片完成后取消；已完成结果会保留";
  updateButtons();
});

disposeWorkerButton.addEventListener("click", async () => {
  disposeWorkerButton.disabled = true;
  try {
    await browserVisionWorkerClient.dispose();
    runtimeStage.textContent = "Dedicated Worker 已释放；可再次加载模型重新初始化";
    batchStage.textContent = "Dedicated Worker 已释放；可再次加载模型重新初始化";
  } finally {
    refreshWorkerDiagnostics();
    updateButtons();
  }
});

runOcrButton.addEventListener("click", async () => {
  if (!currentFile) return;
  runOcrButton.disabled = true;
  setStage("正在浏览器本地预处理与推理");
  try {
    await ensureLegacyOcr();
    const output = await runLocalOcr(currentFile);
    currentBitmap?.close();
    currentBitmap = output.bitmap;
    currentResult = output.result;
    currentTimings = output.timings;
    currentRecordId = createLocalId();
    ocrOutput.textContent = JSON.stringify(output.result, null, 2);
    timingsOutput.textContent = JSON.stringify(output.timings, null, 2);
    draw(output.bitmap, output.result);
    setStage(`本地 OCR 完成：${output.result.lines.length} 条原始结果`);
  } catch (error) {
    setStage(`本地 OCR 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    updateButtons();
    refreshNetwork();
  }
});

saveButton.addEventListener("click", async () => {
  if (!currentFile || !currentBitmap || !currentResult || !currentTimings) return;
  const record: StoredOcrRecord = {
    id: currentRecordId ?? createLocalId(),
    created_at: new Date().toISOString(),
    image_name: currentFile.name,
    image_blob: currentFile,
    image_width: currentBitmap.width,
    image_height: currentBitmap.height,
    raw_ocr_result: currentResult,
    timings: currentTimings,
    schema_version: 1,
  };
  await saveRecord(record);
  currentRecordId = record.id;
  storageStatus.textContent = `保存成功：${record.id}`;
});

byId<HTMLButtonElement>("clear-memory").addEventListener("click", clearMemory);

byId<HTMLButtonElement>("restore-record").addEventListener("click", async () => {
  const record = await latestRecord();
  if (!record) {
    storageStatus.textContent = "IndexedDB 中没有记录";
    return;
  }
  await loadBlob(record.image_blob, record.image_name, record.raw_ocr_result, record.timings, record.id);
  storageStatus.textContent = `恢复成功：${record.id}`;
  setStage("已从 IndexedDB 恢复图片与 OCR 结果");
});

byId<HTMLButtonElement>("delete-record").addEventListener("click", async () => {
  await deleteRecord(currentRecordId);
  storageStatus.textContent = currentRecordId ? `已删除记录：${currentRecordId}` : "已清空 IndexedDB";
  currentRecordId = undefined;
});

byId<HTMLButtonElement>("export-backup").addEventListener("click", async () => {
  const record = await latestRecord();
  if (!record) {
    storageStatus.textContent = "没有可导出的 IndexedDB 记录";
    return;
  }
  const backup = await toBackup(record);
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `yuanstar-browser-ocr-backup-${record.id}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  storageStatus.textContent = "备份 JSON 已由浏览器下载到本机";
});

byId<HTMLInputElement>("import-backup").addEventListener("change", async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const backup = JSON.parse(await file.text()) as BackupRecord;
  const record = await fromBackup(backup);
  await saveRecord(record);
  await loadBlob(record.image_blob, record.image_name, record.raw_ocr_result, record.timings, record.id);
  storageStatus.textContent = `备份导入成功：${record.id}`;
  input.value = "";
});

byId<HTMLButtonElement>("refresh-network").addEventListener("click", refreshNetwork);

async function refreshPhase2ADiagnostics(): Promise<void> {
  phase2aDiagnostics.textContent = JSON.stringify(await describePhase2ADatabase(), null, 2);
}

async function refreshPersistedPhase2BDiagnostics(): Promise<void> {
  const db = await openDatabase();
  try {
    const workspace = await getWorkspace(db, phase2bDiagnosticAccountId);
    if (!workspace) return;
    const images = await listImagesForAccount(db, phase2bDiagnosticAccountId);
    const ids = workspace.snapshot.inventory.map((item) => item.starInstanceId);
    phase2bDiagnostics.textContent = JSON.stringify({
      taskStatus: "persisted_after_reload",
      currentWorkspaceRevision: workspace.revision,
      committedStarCount: workspace.snapshot.inventory.length,
      uniqueStarInstanceIdCount: new Set(ids).size,
      starInstanceIdSetFingerprint: await starInstanceIdSetFingerprint(ids),
      planTargetCount: Object.keys(workspace.snapshot.planTargets).length,
      currentImageBlobCount: images.length,
      readableImageBlobCount: images.filter((image) => image.blob instanceof Blob && image.blob.size > 0).length,
      confirmedImagePoolCount: workspace.snapshot.importReview.confirmedImagePools.length,
      editableOccurrenceCount: Object.keys(workspace.snapshot.importReview.occurrences ?? {}).length,
    }, null, 2);
  } finally { closeDatabase(db); }
}

phase2aSmokeButton.addEventListener("click", async () => {
  phase2aSmokeButton.disabled = true;
  phase2aDiagnostics.textContent = "正在运行完全 synthetic 的 Phase 2A persistence smoke";
  try { phase2aDiagnostics.textContent = JSON.stringify(await runPhase2APersistenceSmoke(), null, 2); }
  catch (error) { phase2aDiagnostics.textContent = `Phase 2A smoke 失败：${error instanceof Error ? error.message : String(error)}`; }
  finally { phase2aSmokeButton.disabled = false; }
});

window.addEventListener("load", () => setTimeout(() => { refreshNetwork(); refreshWorkerDiagnostics(); void refreshPhase2ADiagnostics(); void refreshPersistedPhase2BDiagnostics(); }, 0));
window.addEventListener("pagehide", () => { void browserVisionWorkerClient.dispose(); });

const browserPerformance = performance as Performance & {
  memory?: { jsHeapSizeLimit: number; totalJSHeapSize: number; usedJSHeapSize: number };
};
const browserNavigator = navigator as Navigator & { deviceMemory?: number };
const memory = browserPerformance.memory;
environmentOutput.textContent = JSON.stringify({
  protocol: location.protocol,
  isSecureContext: window.isSecureContext,
  cryptoRandomUUID: typeof globalThis.crypto?.randomUUID,
  cryptoGetRandomValues: typeof globalThis.crypto?.getRandomValues,
  userAgent: navigator.userAgent,
  platform: navigator.platform,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemoryGiB: browserNavigator.deviceMemory ?? "API 不支持读取",
  performanceMemory: memory ? {
    jsHeapSizeLimit: memory.jsHeapSizeLimit,
    totalJSHeapSize: memory.totalJSHeapSize,
    usedJSHeapSize: memory.usedJSHeapSize,
  } : "API 不支持读取",
}, null, 2);
