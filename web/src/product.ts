import { browserCatalog } from "./business/browser-catalog";
import { WorkspaceDomainError } from "./business/model";
import { automaticReconcileResolution, buildReconcileDraftFromBrowserRuntime, type ReconcileDraftV1, type ReconcileResolutionV1 } from "./business/reconcile";
import { ProductWorkspaceController, WorkspaceRevisionConflictError, type ProductWorkspaceContext } from "./product-workspace";
import {
  ProductOcrImportCoordinator,
  ProductOcrImportError,
  addProductOverlapPair,
  applyProductImportClassification,
  applyProductImportClassificationFailure,
  confirmAllProductImportImages,
  confirmProductImportPool,
  createProductImportImages,
  moveProductImportImage as moveProductImportImageState,
  reconcileSourceImagesFromImport,
  removeProductImportImage as removeProductImportImageState,
  sortProductImportImagesForDisplay,
  validateProductOcrImport,
  type ProductImportImage,
  type ProductImportPool,
  type ProductOcrRunContextV1,
  type ProductOverlapPair,
  type ProductOverlapPool,
} from "./product-ocr-import";
import {
  buildProductReviewEvidence,
  buildProductReviewImageSummaries,
  buildPersistedProductReview,
  getActiveReviewScrollContainer,
  productReviewRowCropRect,
  productReviewRowKey,
  type ProductReviewEvidenceV1,
} from "./product-ocr-review";
import type { Rect } from "./structured/contracts";
import { buildProductReviewCandidates, isProductReviewCandidateComplete, productReviewCandidateActions, productReviewCandidatesForImage, productReviewKeepActionLabel, splitProductReviewImagesForDesktop, type ProductReviewCandidateV1 } from "./product-ocr-preview";
import { createUserExport, createXlsxExport, previewJsonImport, previewXlsxImport, safeExportFilename, type DataImportPreview } from "./product-data-transfer";
import { EXPERIENCE_RULES_ASSET, loadExperienceRulesWorkbook, stage624RunsRequired, summarizeExperiencePlans, type ExperienceRules, type InstanceExperiencePlan, type PurpleWhiteRequirement } from "./experience-rules";
import { buildCurrentInstanceUpdate, hasCurrentInstanceUpdate } from "./product-current-instance-update";
import "./product.css";

type Quality = "橙" | "紫" | "蓝" | "绿" | "白";
type Pool = ProductImportPool;
type Pane = "current" | "plan";
type ProductTab = "import" | "review";

type Star = {
  starInstanceId: string;
  kind: "主星" | "辅星";
  name: string;
  quality: Quality;
  level: number;
  targetLevel: number;
};

type ImportImage = ProductImportImage;
type OverlapPool = ProductOverlapPool;

let stars: Star[] = [];
let experienceRules: ExperienceRules | null = null;
let experienceRulesError = "";
let experienceRulesLoadPromise: Promise<void> | null = null;

const rootElement = document.querySelector<HTMLElement>("#product-root");
if (!rootElement) throw new Error("缺少 product root");
const root: HTMLElement = rootElement;

const storedTab = readStorage<ProductTab>("yuanstar.product.tab");
const storedSelected = readStorage<string>("yuanstar.product.selected");
let activeTab: ProductTab = storedTab === "import" || storedTab === "review" ? storedTab : "review";
let selectedId = typeof storedSelected === "string" ? storedSelected : "";
let selectedPane: Pane = "current";
let kindFilter = "全部";
let qualityFilter = "全部";
let nameFilter = "";
let sortFilter = "catalog";
let reviewIsComposing = false;
let ocrListExpanded = false;
let workspaceContext: ProductWorkspaceContext | null = null;
const workspaceController = new ProductWorkspaceController();
let availableAccounts: Array<ProductWorkspaceContext["account"]> = [];
let reviewSaveState: "loading" | "saved" | "saving" | "failed" | "reloaded" = "loading";
let reviewError = "";
let currentEditDraft: Pick<Star, "kind" | "name" | "level" | "quality"> | null = null;
let planEditDraft: number | null = null;
let dataMenuOpen = false;
let toolDialog: "import" | "restore" | null = null;
let dataImportPreview: DataImportPreview | null = null;
let dataToolError = "";
let restorePointList: Array<{ restorePointId: string; reason: string; createdAt: string; workspaceRevision: number; bagCurrentCount: number | null; bagCapacity: number | null; inventoryCount: number; plannedCount: number }> = [];
let dataMenuOutsideListenerBound = false;
let pasteListenerBound = false;
const importPoolScrollLeft: Record<Pool, number> = { 主星: 0, 辅星: 0, 经验星曜: 0 };
const experienceDraft = { orange: "", purple: "", white: "" };
let importImages: ImportImage[] = [];
let overlapRelations: ProductOverlapPair[] = [];
const ocrCoordinator = new ProductOcrImportCoordinator();
type ProductOcrUiStatus = "idle" | "validating" | "initializing" | "running" | "cancelling" | "cancelled" | "reconciling" | "review_required" | "committing" | "completed" | "failed";
let ocrUi = { status: "idle" as ProductOcrUiStatus, completed: 0, total: 0, sourceImageId: null as string | null, message: "", error: "" };
let ocrConfirmOpen = false;
let deleteAccountConfirmOpen = false;
type ProductReviewSession = { draft: ReconcileDraftV1; resolution: ReconcileResolutionV1; runContext: ProductOcrRunContextV1 | null; evidence: ProductReviewEvidenceV1; persisted: boolean };
let pendingOcrReview: ProductReviewSession | null = null;
const expandedReviewImages = new Set<string>();
const showAllReviewImages = new Set<string>();
const editingReviewOccurrences = new Set<string>();
const completedReviewOccurrences = new Set<string>();
const invalidReviewOccurrences = new Set<string>();
type ReviewUiSnapshot = { resolution: ReconcileResolutionV1; completedOccurrenceIds: string[] };
type ReviewHistoryEntry = { before: ReviewUiSnapshot; after: ReviewUiSnapshot; revisionAfter: number; workspaceMutation: boolean };
const reviewUiUndo: ReviewHistoryEntry[] = [];
const reviewUiRedo: ReviewHistoryEntry[] = [];
const reviewRowCrops = new Map<string, { status: "loading" | "ready" | "failed"; objectUrl?: string }>();
type ImageViewerItem = { id: string; objectUrl: string; filename: string; detail: string };
let imageViewer: { items: ImageViewerItem[]; index: number; zoom: number; revocableUrls: string[] } | null = null;
let toastMessage = "";
let toastTimer: number | null = null;

function readStorage<T>(key: string): T | null {
  try { return JSON.parse(window.localStorage.getItem(key) ?? "null") as T | null; } catch { return null; }
}

function writeStorage(key: string, value: unknown): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* local storage is only an optional UI aid */ }
}

function displayStars(): Star[] {
  return stars;
}

/** The workbook is fetched and parsed once; all later UI updates use only immutable in-memory rules. */
function loadExperienceRules(): Promise<void> {
  if (experienceRulesLoadPromise) return experienceRulesLoadPromise;
  experienceRulesLoadPromise = (async () => {
    try {
      const response = await fetch(EXPERIENCE_RULES_ASSET, { cache: "no-store" });
      if (!response.ok) throw new Error(`规则文件请求失败（${response.status}）`);
      experienceRules = loadExperienceRulesWorkbook(await response.arrayBuffer());
      experienceRulesError = "";
    } catch (error) {
      experienceRules = null;
      experienceRulesError = error instanceof Error ? error.message : "规则文件无法读取";
    }
    if (activeTab === "review" && workspaceContext) renderReview();
  })();
  return experienceRulesLoadPromise;
}

function selectedStar(): Star | null { const displayed = displayStars(); return displayed.find((star) => star.starInstanceId === selectedId) ?? displayed[0] ?? null; }

function applyWorkspaceContext(context: ProductWorkspaceContext): void {
  workspaceContext = context;
  stars = context.record.snapshot.inventory.map((item) => ({ ...item, targetLevel: context.record.snapshot.planTargets[item.starInstanceId] ?? item.level }));
  if (!stars.some((star) => star.starInstanceId === selectedId)) selectedId = stars[0]?.starInstanceId ?? "";
  experienceDraft.orange = context.record.snapshot.experience.orange == null ? "" : String(context.record.snapshot.experience.orange);
  experienceDraft.purple = context.record.snapshot.experience.purple == null ? "" : String(context.record.snapshot.experience.purple);
  experienceDraft.white = context.record.snapshot.experience.white == null ? "" : String(context.record.snapshot.experience.white);
}

function restorePersistedOcrReview(): void {
  if (pendingOcrReview || !workspaceContext) return;
  syncPendingOcrReviewFromWorkspace();
}

/** Workspace is the review truth after every persisted mutation; the UI keeps only presentation state. */
function syncPendingOcrReviewFromWorkspace(options: { runContext?: ProductOcrRunContextV1 | null; evidence?: ProductReviewEvidenceV1; persisted?: boolean } = {}): void {
  if (!workspaceContext) return;
  const restored = buildPersistedProductReview(workspaceContext.record.snapshot);
  if (!restored) { pendingOcrReview = null; return; }
  const prior = pendingOcrReview;
  const evidence = options.evidence ?? prior?.evidence ?? restored.evidence;
  pendingOcrReview = { ...restored, evidence, runContext: options.runContext ?? prior?.runContext ?? null, persisted: options.persisted ?? true };
  buildProductReviewImageSummaries(restored.draft, restored.resolution, evidence).filter((item) => item.displayPriority === 0).forEach((item) => expandedReviewImages.add(item.sourceImageId));
  void preparePendingReviewRowCrops(pendingOcrReview);
}

function reviewRowRectsForEvidence(evidence: ProductReviewEvidenceV1): Record<string, Record<string, Rect>> {
  const result: Record<string, Record<string, Rect>> = {};
  const rows = new Map<string, Set<number>>();
  evidence.occurrences.forEach((occurrence) => rows.set(occurrence.sourceImageId, new Set([...(rows.get(occurrence.sourceImageId) ?? []), occurrence.row])));
  for (const [sourceImageId, sourceRows] of rows) for (const row of sourceRows) {
    const rect = productReviewRowCropRect(evidence, sourceImageId, row);
    if (rect) (result[sourceImageId] ??= {})[String(row)] = rect;
  }
  return result;
}

function saveStateLabel(): string {
  if (reviewSaveState === "loading") return "正在加载工作区";
  if (reviewSaveState === "saving") return "保存中";
  if (reviewSaveState === "failed") return "保存失败";
  if (reviewSaveState === "reloaded") return "已重新加载";
  return "已保存";
}

async function runWorkspaceMutation<T>(mutation: (session: import("./business/session").WorkspaceSession) => T, after?: (result: T) => void, options: { intent?: ReviewScrollIntent; anchorOccurrenceId?: string } = {}): Promise<void> {
  const intent = options.intent ?? "keep";
  const viewport = intent === "top" ? null : captureReviewViewport(options.anchorOccurrenceId);
  if (isOcrLocked()) { reviewError = "识别正在运行，暂时不能修改当前工作区。"; renderReview(intent, viewport); return; }
  reviewSaveState = "saving"; reviewError = ""; renderReview();
  try {
    const committed = await workspaceController.mutate(mutation) as { context: ProductWorkspaceContext; result: T };
    applyWorkspaceContext(committed.context); syncPendingOcrReviewFromWorkspace(); after?.(committed.result); reviewSaveState = "saved";
  } catch (error) {
    if (error instanceof WorkspaceRevisionConflictError) {
      applyWorkspaceContext(await workspaceController.reload()); syncPendingOcrReviewFromWorkspace(); reviewSaveState = "reloaded"; reviewError = "";
    } else {
      reviewSaveState = "failed"; reviewError = error instanceof Error ? error.message : "保存失败，请稍后重试。";
    }
  }
  renderReview(intent, viewport);
}

function captureReviewUi(): ReviewUiSnapshot {
  return { resolution: JSON.parse(JSON.stringify(pendingOcrReview?.resolution ?? {})) as ReconcileResolutionV1, completedOccurrenceIds: [...completedReviewOccurrences].sort() };
}
function restoreReviewUi(snapshot: ReviewUiSnapshot): void {
  if (!pendingOcrReview) return;
  pendingOcrReview.resolution = JSON.parse(JSON.stringify(snapshot.resolution)) as ReconcileResolutionV1;
  completedReviewOccurrences.clear();
  snapshot.completedOccurrenceIds.forEach((id) => completedReviewOccurrences.add(id));
  invalidReviewOccurrences.clear();
  editingReviewOccurrences.clear();
}
function recordReviewUiMutation(before: ReviewUiSnapshot, workspaceMutation = true): void {
  if (!workspaceContext) return;
  reviewUiUndo.push({ before, after: captureReviewUi(), revisionAfter: workspaceContext.record.revision, workspaceMutation });
  reviewUiRedo.length = 0;
}

function reviewHistoryEntry(direction: "undo" | "redo"): ReviewHistoryEntry | null {
  const entries = direction === "undo" ? reviewUiUndo : reviewUiRedo;
  return entries.length > 0 ? entries[entries.length - 1] ?? null : null;
}

function canUseReviewHistory(direction: "undo" | "redo"): boolean {
  const entry = reviewHistoryEntry(direction);
  if (!entry || !workspaceContext) return false;
  if (!entry.workspaceMutation) return true;
  return direction === "undo"
    ? entry.revisionAfter === workspaceContext.record.revision && workspaceController.canUndo
    : workspaceController.canRedo;
}

function runReviewWorkspaceMutation<T>(occurrenceId: string, mutation: (session: import("./business/session").WorkspaceSession) => T, after: (result: T) => void): void {
  const before = captureReviewUi();
  void runWorkspaceMutation(mutation, (result) => { after(result); recordReviewUiMutation(before); }, { anchorOccurrenceId: occurrenceId });
}

const qualityPriority: Record<Quality, number> = { 橙: 0, 紫: 1, 蓝: 2, 绿: 3, 白: 4 };
const kindPriority: Record<Star["kind"], number> = { 主星: 0, 辅星: 1 };

function nameSearchTerms(): string[] { return nameFilter.split(/[\s,，、;；]+/).map((term) => term.trim()).filter(Boolean); }
function hasActiveReviewFilter(): boolean { return kindFilter !== "全部" || qualityFilter !== "全部" || nameSearchTerms().length > 0; }

function filteredStars(): Star[] {
  const terms = nameSearchTerms();
  return displayStars().filter((star) => (
    (kindFilter === "全部" || star.kind === kindFilter)
    && (qualityFilter === "全部" || star.quality === qualityFilter)
    && (terms.length === 0 || terms.some((term) => star.name.includes(term)))
  )).sort((a, b) => {
    const catalogDelta = browserCatalog.orderIndex(a.name) - browserCatalog.orderIndex(b.name);
    const stable = a.starInstanceId.localeCompare(b.starInstanceId);
    if (sortFilter === "level") return (b.level - a.level) || (qualityPriority[a.quality] - qualityPriority[b.quality]) || catalogDelta || stable;
    if (sortFilter === "target") return (b.targetLevel - a.targetLevel) || (qualityPriority[a.quality] - qualityPriority[b.quality]) || catalogDelta || stable;
    const directoryOrder = hasActiveReviewFilter()
      ? catalogDelta || (b.level - a.level)
      : (b.level - a.level) || catalogDelta;
    return (kindPriority[a.kind] - kindPriority[b.kind]) || directoryOrder || (qualityPriority[a.quality] - qualityPriority[b.quality]) || stable;
  });
}

function selectedExperiencePlan(selected: Star): InstanceExperiencePlan {
  const draftTarget = selected.starInstanceId === selectedId && planEditDraft != null && Number.isInteger(planEditDraft)
    ? Math.min(60, Math.max(selected.level, planEditDraft)) : selected.targetLevel;
  return { starInstanceId: selected.starInstanceId, currentLevel: selected.level, targetLevel: draftTarget };
}
function requirementText(requirement: PurpleWhiteRequirement): string { return `紫星曜 ${requirement.purple} 颗　白星曜 ${requirement.white} 颗`; }
function experienceNeedsTemplate(selected: Star): string {
  const failure = experienceRulesError ? `经验星曜规则加载失败，暂无法计算计划需求。${experienceRulesError ? ` ${experienceRulesError}` : ""}` : "正在加载经验星曜规则…";
  if (!experienceRules) return `<article class="experience-needs"><h3>计划经验星曜需求</h3><dl><div><dt>当前选中行</dt><dd>${html(failure)}</dd><strong></strong></div><div><dt>${hasActiveReviewFilter() ? "完成当前筛选计划所需" : "完成全部计划所需"}</dt><dd>${html(failure)}</dd><strong></strong></div><div><dt>扣除当前背包后仍缺</dt><dd>${html(failure)}</dd><strong></strong></div></dl></article>`;
  const inventory = workspaceContext!.record.snapshot.experience;
  const selectedSummary = summarizeExperiencePlans([selectedExperiencePlan(selected)], experienceRules, inventory);
  const scope = (hasActiveReviewFilter() ? filteredStars() : displayStars()).map(selectedExperiencePlan);
  const summary = summarizeExperiencePlans(scope, experienceRules, inventory);
  const selectedPlan = selectedExperiencePlan(selected);
  const unknownInventory = summary.remaining == null;
  const totalRuns = stage624RunsRequired(summary.required.experience, experienceRules);
  const gapRuns = unknownInventory ? null : stage624RunsRequired(summary.remaining!.experience, experienceRules);
  return `<article class="experience-needs"><h3>计划经验星曜需求</h3><dl><div><dt>当前选中行</dt><dd>${html(`${selected.name} ${selected.level}级 → ${selectedPlan.targetLevel}级`)}</dd><strong>需要 ${requirementText(selectedSummary.required)}</strong></div><div><dt>${hasActiveReviewFilter() ? "完成当前筛选计划所需" : "完成全部计划所需"}</dt><dd>还需6-24 ${totalRuns} 次</dd><strong>${requirementText(summary.required)}</strong></div><div><dt>扣除当前背包后仍缺</dt><dd>${unknownInventory ? "当前经验星曜数量未完整确认，暂无法计算缺口" : `还需6-24 ${gapRuns} 次`}</dd><strong>${unknownInventory ? "" : requirementText(summary.remaining!)}</strong></div></dl></article>`;
}
function refreshExperienceNeeds(): void {
  const selected = selectedStar();
  const existing = root.querySelector<HTMLElement>(".experience-needs");
  if (selected && existing) existing.outerHTML = experienceNeedsTemplate(selected);
}

function qualityMark(quality: Quality): string { return `<span class="quality quality-${quality}">${quality}</span>`; }
function formatRestoreTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
function restoreReasonLabel(reason: string): string {
  return ({ pre_ocr_rebuild: "识别前自动恢复点", import_data_safety: "导入前自动恢复点", restore_safety: "恢复前自动安全点", "导入数据前安全恢复点": "导入前自动恢复点", "手动恢复前安全点": "恢复前自动安全点" } as Record<string, string>)[reason] ?? reason;
}

function inventoryGroupKey(star: Star): string { return hasActiveReviewFilter() ? `${star.kind}|${star.name}` : `${star.kind}|${star.level}|${star.name}|${star.quality}`; }
function starDescription(name: string): string | null { return browserCatalog.entry(name)?.description ?? null; }
function html(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;"); }
function nameOptions(kind: Star["kind"], selected: string): string {
  const placeholder = selected === "" ? `<option value="" selected>请选择</option>` : "";
  return `${placeholder}${browserCatalog.namesForKind(kind).map((name) => `<option value="${html(name)}" ${name === selected ? "selected" : ""}>${html(name)}</option>`).join("")}`;
}

function isOcrRunning(): boolean { return ocrCoordinator.active != null || ["initializing", "running", "cancelling", "reconciling", "committing"].includes(ocrUi.status); }
function canCancelOcr(): boolean { return ocrCoordinator.active != null && ocrUi.status !== "cancelling"; }
function isOcrLocked(): boolean { return isOcrRunning(); }
function hasClassifyingImportImages(): boolean { return importImages.some((image) => image.classificationStatus === "classifying"); }
function importImageStatusLabel(image: ImportImage): string {
  if (image.classificationStatus === "classifying") return "正在判断";
  if (image.classificationStatus === "failed") return image.poolSource === "manual" ? (image.confirmed ? "已人工调整 · 已确认" : "已人工调整 · 待确认") : image.confirmed ? "已确认" : "分类失败 · 请确认";
  if (image.poolSource === "manual") return image.confirmed ? "已人工调整 · 已确认" : "已人工调整 · 待确认";
  if (image.confirmed) return "已确认";
  return image.classificationReviewRequired ? "分类存疑 · 请确认" : "推荐 · 待确认";
}
function ocrStatusLabel(status = ocrUi.status): string {
  return ({ idle: "等待开始", validating: "正在校验", initializing: "正在初始化识别引擎", running: "正在识别", cancelling: "正在取消", cancelled: "已取消", reconciling: "正在整理识别结果", review_required: "等待人工复核", committing: "正在写入工作区", completed: "完成", failed: "识别失败" } satisfies Record<ProductOcrUiStatus, string>)[status];
}
function importNotice(message: string, error = false): void { ocrUi.message = error ? "" : message; ocrUi.error = error ? message : ""; }
function showToast(message: string): void {
  toastMessage = message;
  if (toastTimer != null) window.clearTimeout(toastTimer);
  renderToast();
  toastTimer = window.setTimeout(() => { toastTimer = null; toastMessage = ""; renderToast(); }, 2600);
}
function showDuplicateInvalidationToast(invalidated: boolean): void {
  if (invalidated) showToast("已取消这组图片原有的重叠关系，请检查当前背包数量。");
}
function toastTemplate(): string { return toastMessage ? `<div class="product-toast" role="status" aria-live="polite">${html(toastMessage)}</div>` : ""; }
function renderToast(): void {
  const existing = root.querySelector(".product-toast");
  if (existing) existing.outerHTML = toastTemplate();
  else if (toastMessage) root.insertAdjacentHTML("beforeend", toastTemplate());
}
function reviewImageName(sourceImageId: string): string {
  return pendingOcrReview?.runContext?.images.find((image) => image.sourceImageId === sourceImageId)?.filename
    ?? (workspaceContext?.record.snapshot.importReview.imageAudit[sourceImageId] as { filename?: unknown } | undefined)?.filename as string | undefined
    ?? sourceImageId;
}
function ordinaryReviewNameOptions(selected: string | null): string {
  return (["主星", "辅星"] as Star["kind"][]).flatMap((kind) => browserCatalog.namesForKind(kind)).map((name) => `<option value="${html(name)}" ${name === selected ? "selected" : ""}>${html(name)}</option>`).join("");
}
function reviewPageTypeLabel(value: string): string { return value === "main" ? "主星" : value === "support" ? "辅星" : value === "experience" ? "经验星曜" : "类型未知"; }
function reviewCropTemplate(sourceImageId: string, row: number, label = "行级图片证据"): string {
  const crop = reviewRowCrops.get(productReviewRowKey(sourceImageId, row));
  if (crop?.status === "ready" && crop.objectUrl) return `<figure class="review-row-crop"><img src="${crop.objectUrl}" alt="${html(label)}" /><figcaption>${html(label)}</figcaption></figure>`;
  if (crop?.status === "loading") return `<div class="review-row-crop is-placeholder">正在生成行级预览…</div>`;
  return `<div class="review-row-crop is-placeholder">无法生成行级预览，请查看整页。</div>`;
}
function reviewCandidateStatus(candidate: ProductReviewCandidateV1): string {
  if (candidate.processed === "ignored") return "已忽略";
  if (candidate.processed === "checked") return "已核对";
  if (candidate.edited) return "已修改";
  if (candidate.kind === "required") return "待审查";
  if (candidate.kind === "duplicate") return candidate.overlapPending ? "重叠待确认" : "重叠重复";
  if (candidate.kind === "fragment") return "已忽略·残片";
  return "已识别";
}
function reviewCandidateCardTemplate(candidate: ProductReviewCandidateV1): string {
  const relationActions = candidate.overlapPending;
  const editing = editingReviewOccurrences.has(candidate.occurrenceId);
  const warning = invalidReviewOccurrences.has(candidate.occurrenceId);
  const editor = editing ? `<div class="pending-inline-editor"><div class="pending-edit-grid"><label>标准名称<select data-review-edit-name>${ordinaryReviewNameOptions(candidate.name)}</select></label><label>等级<input data-review-edit-level type="number" min="1" max="60" value="${candidate.level ?? ""}" /></label><label>品质<select data-review-edit-quality><option value="">请选择</option>${(["橙", "紫", "蓝", "绿", "白"] as Quality[]).map((quality) => `<option ${quality === candidate.quality ? "selected" : ""}>${quality}</option>`).join("")}</select></label></div><div class="pending-editor-actions"><button class="button button-secondary positive-action" data-confirm-ordinary-edit type="button">确认修改</button><button class="button button-tertiary" data-cancel-ordinary-edit type="button">取消</button></div></div>` : "";
  const actionSet = new Set(productReviewCandidateActions(candidate));
  const actions = relationActions
    ? `<button class="button button-secondary positive-action" data-confirm-overlap-duplicate type="button">确认重复</button><button class="button button-tertiary" data-keep-overlap-separate type="button">保持独立</button>`
    : `<button class="button button-secondary" data-keep-review-candidate type="button">${productReviewKeepActionLabel(candidate)}</button><button class="button button-tertiary danger-action" data-ignore-review-candidate type="button">忽略</button><button class="button button-secondary" data-open-ordinary-edit type="button">人工修改</button>`;
  return `<article class="pending-review-item ordinary-review-card kind-${candidate.kind}" data-review-occurrence="${html(candidate.occurrenceId)}" ${candidate.duplicateRowId ? `data-duplicate-row="${html(candidate.duplicateRowId)}"` : ""}><header class="candidate-card-header"><strong>${relationActions ? "重叠行关系待确认" : `第${candidate.row + 1}行第${candidate.column + 1}列`}</strong><span>${reviewCandidateStatus(candidate)}</span><span>${candidate.name ? html(candidate.name) : "未识别"}</span><span>${candidate.level == null ? "未识别" : `${candidate.level}级`}</span><span>${candidate.quality ?? "未识别"}</span></header>${reviewCropTemplate(candidate.sourceImageId, candidate.row)}${editor}<div class="candidate-action-row">${actionSet.has("view_source") ? `<button class="button button-tertiary" data-review-source="${html(candidate.sourceImageId)}" type="button">查看整页</button>` : ""}${actions}</div></article>`;
}
function pendingOcrReviewTemplate(): string {
  const pending = pendingOcrReview;
  if (!pending) {
    const persisted = Object.entries(workspaceContext?.record.snapshot.importReview.imagePools ?? {}).sort(([left], [right]) => left.localeCompare(right));
    return persisted.length ? `<p class="review-detail">当前工作区已保存 ${persisted.length} 张 OCR 来源图。</p><div class="pending-source-list">${persisted.map(([sourceImageId, pool], index) => `<button class="button button-tertiary" data-review-source="${html(sourceImageId)}" type="button">查看来源图 ${index + 1} · ${pool === "main" ? "主星" : pool === "support" ? "辅星" : pool === "experience" ? "经验星曜" : "未分类"}</button>`).join("")}</div>` : `<p class="review-detail">当前工作区暂无待处理的 OCR 人工复核。</p>`;
  }
  const { draft, resolution } = pending;
  const candidates = buildProductReviewCandidates(draft, resolution, pending.evidence, completedReviewOccurrences);
  const summaries = buildProductReviewImageSummaries(draft, resolution, pending.evidence, completedReviewOccurrences);
  const imageSections = summaries.map((summary) => {
    const expanded = expandedReviewImages.has(summary.sourceImageId);
    const showAll = showAllReviewImages.has(summary.sourceImageId);
    const imageCandidates = candidates.filter((candidate) => candidate.sourceImageId === summary.sourceImageId);
    const shownCandidates = productReviewCandidatesForImage(candidates, summary.sourceImageId, showAll);
    const ordinary = shownCandidates.map(reviewCandidateCardTemplate).join("");
    const details = expanded ? `<div class="image-review-body"><div class="image-review-toolbar"><button class="button button-tertiary" data-review-source="${html(summary.sourceImageId)}" type="button">查看整页</button><button class="button button-tertiary" data-show-all-review-image="${html(summary.sourceImageId)}" type="button">${showAll ? "收起全部候选" : "查看全部候选"}</button></div>${ordinary ? `<div class="pending-card-grid">${ordinary}</div>` : `<p class="review-detail">此图没有待处理的候选。</p>`}</div>` : "";
    const checked = !imageCandidates.some((candidate) => candidate.processed == null && candidate.kind !== "clean") && !summary.overlapPendingCount;
    return `<section class="image-review-group${summary.attentionRequired ? " needs-attention" : ""}" data-review-image="${html(summary.sourceImageId)}"><header><div><strong title="${html(reviewImageName(summary.sourceImageId))}">${html(reviewImageName(summary.sourceImageId))}</strong><small>${reviewPageTypeLabel(summary.pageType)} · 候选${summary.candidateCount} · 待审${summary.pendingCount} · 已忽略${summary.excludedCount} · 重叠${summary.overlapDuplicateCount}${checked ? " · 已核对" : ""}</small></div><button class="button button-tertiary" data-toggle-review-image="${html(summary.sourceImageId)}" type="button" aria-expanded="${expanded}">${expanded ? "收起" : "展开"}</button></header>${details}</section>`;
  });
  const desktopColumns = splitProductReviewImagesForDesktop(imageSections);
  const hasActionable = candidates.some((candidate) => candidate.tier === 1);
  return `${hasActionable ? "" : `<p class="review-detail">${pending.persisted ? "已保存识别结果，可再次核对。" : "本轮无待处理项；可查看全部候选再次检查。"}</p>`}<div class="pending-review-scroll pending-review-scroll-desktop"><div class="pending-review-column">${desktopColumns.left.join("")}</div><div class="pending-review-column">${desktopColumns.right.join("")}</div></div><div class="pending-review-scroll pending-review-scroll-mobile">${imageSections.join("")}</div>`;
}

function reviewSourcePreviewTemplate(): string {
  const viewer = imageViewer;
  const preview = viewer?.items[viewer.index];
  if (!viewer || !preview) return "";
  return `<div class="image-lightbox" role="dialog" aria-modal="true" aria-label="图片预览"><button class="lightbox-backdrop" data-close-image-viewer type="button" aria-label="关闭图片预览"></button><article><header><div><strong>${html(preview.filename)}</strong><small>${html(preview.detail)} · ${viewer.index + 1} / ${viewer.items.length}</small></div><div class="lightbox-tools"><button class="button button-tertiary" type="button" data-image-viewer-zoom="out">缩小</button><output aria-live="polite">${viewer.zoom}%</output><button class="button button-tertiary" type="button" data-image-viewer-zoom="in">放大</button><button class="icon-button" data-close-image-viewer type="button" aria-label="关闭图片预览">×</button></div></header><div class="lightbox-image" data-image-viewer-wheel><div class="lightbox-media" style="--preview-zoom: ${viewer.zoom / 100}"><img src="${preview.objectUrl}" alt="${html(preview.filename)}" /></div></div><footer><button class="button button-tertiary" type="button" data-image-viewer-step="previous" ${viewer.index <= 0 ? "disabled" : ""}>上一张</button><button class="button button-tertiary" data-close-image-viewer type="button">关闭</button><button class="button button-tertiary" type="button" data-image-viewer-step="next" ${viewer.index >= viewer.items.length - 1 ? "disabled" : ""}>下一张</button></footer></article></div>`;
}

function panelRows(pane: Pane): string {
  const rows = filteredStars();
  const totals = new Map<string, number>();
  rows.forEach((star) => { const key = inventoryGroupKey(star); totals.set(key, (totals.get(key) ?? 0) + 1); });
  const displayedGroups = new Set<string>();
  return rows.map((star, index) => {
    const selected = star.starInstanceId === selectedId && pane === selectedPane;
    const counterpart = star.starInstanceId === selectedId && pane !== selectedPane;
    const kindDivider = index > 0 && rows[index - 1]?.kind !== star.kind;
    const key = inventoryGroupKey(star);
    const groupCount = displayedGroups.has(key) ? "—" : `本组共 ${totals.get(key)} 颗`;
    displayedGroups.add(key);
    const description = starDescription(star.name);
    return `<tr class="inventory-row${selected ? " is-selected" : ""}${counterpart ? " is-counterpart" : ""}${kindDivider ? " is-kind-divider" : ""}" data-star-id="${star.starInstanceId}" data-pane="${pane}" tabindex="0" aria-selected="${selected}">
      <td class="check-cell"><input type="checkbox" aria-label="选择 ${star.name}" ${selected ? "checked" : ""} /></td>
      <td>${star.kind}</td><td class="name-cell">${description ? `<button class="star-name-tooltip-trigger" type="button" data-star-description-name="${html(star.name)}">${star.name}</button>` : star.name}</td>
      <td>${pane === "current" ? star.level : `<span class="planned-level${star.targetLevel !== star.level ? " is-planned" : ""}">${star.targetLevel}</span>`}</td>
      <td>${qualityMark(star.quality)}</td><td class="quantity-cell">${groupCount}</td>
    </tr>`;
  }).join("");
}

function reviewTemplate(): string {
  const selected = selectedStar();
  if (!workspaceContext) return `<section class="review-page" aria-label="人工核对"><p class="review-overview">${reviewError || "正在加载当前工作区…"}</p></section>`;
  if (!selected) return `<section class="review-page" aria-label="人工核对"><p class="review-overview"><span class="review-overview-count">当前汇总 0 颗。</span>${reviewError ? `<span class="inconsistent-warning">${html(reviewError)}</span>` : ""}</p><section class="inventory-grid" aria-label="当前背包与计划背包"><article class="inventory-panel"><header><h2>当前背包 <span>（0 颗）</span></h2><small>暂无星石</small></header><div class="table-scroll"><table><thead><tr><th></th><th>大类</th><th>标准名称</th><th>等级</th><th>品质</th><th>数量</th></tr></thead><tbody></tbody></table></div></article><article class="inventory-panel"><header><h2>计划背包 <span>（对应 0 颗）</span></h2><small>对应当前背包</small></header><div class="table-scroll"><table><thead><tr><th></th><th>大类</th><th>标准名称</th><th>计划等级</th><th>品质</th><th>数量</th></tr></thead><tbody></tbody></table></div></article></section><section class="ocr-review" aria-labelledby="ocr-review-title"><button class="ocr-summary" id="toggle-ocr-review" type="button" aria-expanded="true"><span><strong id="ocr-review-title">OCR图片人工复核</strong> <em>当前工作区来源与复核</em></span><span class="ocr-toggle-label">收起</span></button><div class="ocr-review-list">${pendingOcrReviewTemplate()}</div></section></section>`;
  if (selected.starInstanceId !== selectedId) selectedId = selected.starInstanceId;
  const planned = selected.targetLevel !== selected.level;
  const currentDraft = currentEditDraft ?? selected;
  const effectivePlanLevel = planEditDraft ?? selected.targetLevel;
  const total = displayStars().length;
  const bagQuantity = workspaceContext.record.snapshot.bag.currentCount;
  const bagCapacity = workspaceContext.record.snapshot.bag.capacity;
  const experienceSourceImageId = pendingOcrReview?.runContext?.images.find((image) => image.pool === "经验星曜")?.sourceImageId ?? Object.entries(workspaceContext.record.snapshot.importReview.imagePools).find(([, pool]) => pool === "experience")?.[0] ?? null;
  const pendingExperienceValue = (color: "orange" | "purple" | "white"): string => experienceDraft[color];
  const experienceReasons = workspaceContext.record.snapshot.experience.evidence && typeof workspaceContext.record.snapshot.experience.evidence === "object" && !Array.isArray(workspaceContext.record.snapshot.experience.evidence) ? (workspaceContext.record.snapshot.experience.evidence as { reviewReasonCodes?: unknown }).reviewReasonCodes : [];
  const experienceWarning = Array.isArray(experienceReasons) && experienceReasons.length ? "部分数量需要确认" : "";
  const bagReasons = workspaceContext.record.snapshot.bag.resolution && typeof workspaceContext.record.snapshot.bag.resolution === "object" && !Array.isArray(workspaceContext.record.snapshot.bag.resolution) ? (workspaceContext.record.snapshot.bag.resolution as { reviewReasonCodes?: unknown }).reviewReasonCodes : [];
  const delta = bagQuantity == null ? null : total - bagQuantity;
  const deltaMessage = delta == null ? "" : delta === 0 ? "，数量一致。" : delta > 0 ? `，多 ${delta} 颗。当前识别比背包数量多 ${delta} 颗，请优先检查重叠关系。` : `，少 ${Math.abs(delta)} 颗。当前识别比背包数量少 ${Math.abs(delta)} 颗，请检查漏识别或残片。`;
  const bagConflictMessage = Array.isArray(bagReasons) && bagReasons.length ? " 背包数量多图不一致，请人工填写。" : "";
  return `<section class="review-page" aria-label="人工核对">
    <p class="review-overview"><span class="review-overview-count">当前汇总 ${total} 颗，背包数量 ${bagQuantity ?? "—"} 颗${delta == null || delta === 0 ? deltaMessage || "。" : "，"}</span>${delta != null && delta !== 0 ? `<span class="inventory-delta-warning">${html(deltaMessage.replace(/^，/, ""))}</span>` : ""}${bagConflictMessage ? `<span class="inconsistent-warning">${html(bagConflictMessage.trim())}</span>` : ""}${reviewError ? `<span class="inconsistent-warning">${html(reviewError)}</span>` : ""}</p>
    <section class="review-toolbar" aria-label="筛选与背包信息">
      <div class="filter-strip">
        <label>大类<select id="kind-filter"><option>全部</option><option>主星</option><option>辅星</option></select></label>
        <label>品质<select id="quality-filter"><option>全部</option><option>橙</option><option>紫</option><option>蓝</option><option>绿</option><option>白</option></select></label>
        <label class="filter-search">标准名称搜索<input id="name-filter" type="search" placeholder="可用空格或逗号分隔" value="${nameFilter}" /></label>
        <label>排序<select id="sort-filter"><option value="catalog">目录顺序</option><option value="level">当前等级</option><option value="target">计划等级</option></select></label>
        <button class="button button-secondary" id="apply-filter" type="button">应用筛选</button><button class="button button-tertiary danger-action" id="clear-filter" type="button">清除筛选</button>
      </div>
      <dl class="inventory-facts"><div><dt>游戏版本</dt><dd>${workspaceContext.record.snapshot.gameVersion}</dd></div><div><dt>账号名称</dt><dd>${html(workspaceContext.account.displayName)}</dd></div><div><dt>当前汇总</dt><dd>${total}颗</dd></div><div class="editable-fact"><dt>背包数量</dt><dd><input id="bag-quantity" type="number" min="0" value="${bagQuantity ?? ""}" aria-label="背包数量" /></dd></div><div class="editable-fact"><dt>背包容量</dt><dd><input id="bag-capacity" type="number" min="0" value="${bagCapacity ?? ""}" aria-label="背包容量" /></dd></div><div><dt>保存状态</dt><dd class="save-state ${reviewSaveState === "failed" ? "warning-value" : ""}">${saveStateLabel()}</dd></div></dl>
    </section>
    <section class="inventory-grid" aria-label="当前背包与计划背包">
      <article class="inventory-panel"><header><h2>当前背包 <span id="current-count">（${filteredStars().length} 颗）</span></h2><small>点击任意行进行核对</small></header><div class="table-scroll" id="current-scroll"><table><thead><tr><th></th><th>大类</th><th>标准名称</th><th>等级</th><th>品质</th><th>数量</th></tr></thead><tbody id="current-rows">${panelRows("current")}</tbody></table></div></article>
      <article class="inventory-panel"><header><h2>计划背包 <span id="plan-count">（对应 ${filteredStars().length} 颗）</span></h2><small>对应行自动同步</small></header><div class="table-scroll" id="plan-scroll"><table><thead><tr><th></th><th>大类</th><th>标准名称</th><th>计划等级</th><th>品质</th><th>数量</th></tr></thead><tbody id="plan-rows">${panelRows("plan")}</tbody></table></div></article>
    </section>
    <section class="edit-section" aria-label="当前背包与计划背包编辑区">
      <article class="edit-panel current-editor" data-edit-panel="current"><header><p class="section-kicker">当前背包编辑</p><h2>${selected.name} <span>${selected.kind} · ${qualityMark(selected.quality)}</span></h2></header><div class="field-grid"><label>大类<select data-current-field="kind">${["主星", "辅星"].map((kind) => `<option ${kind === currentDraft.kind ? "selected" : ""}>${kind}</option>`).join("")}</select></label><label>标准名称<select data-current-field="name">${nameOptions(currentDraft.kind, currentDraft.name)}</select></label><label>当前等级<input data-current-field="level" type="number" min="1" max="60" value="${currentDraft.level}" /></label><label>品质<select data-current-field="quality">${(["橙", "紫", "蓝", "绿", "白"] as Quality[]).map((quality) => `<option ${quality === currentDraft.quality ? "selected" : ""}>${quality}</option>`).join("")}</select></label></div><div class="editor-actions"><button class="button button-secondary positive-action" id="add-current-row" type="button">新增当前行</button><button class="button button-tertiary danger-action" id="delete-current-row" type="button">删除当前行</button></div></article>
      <article class="edit-panel plan-editor" data-edit-panel="plan"><header><p class="section-kicker">计划背包编辑</p><h2>${selected.name} <span>${planned ? `${selected.level}级 → ${selected.targetLevel}级` : "保持当前等级"}</span></h2></header><div class="field-grid plan-field-grid"><label>当前等级<input value="${selected.level}" readonly /></label><label>计划等级<input id="target-level" type="number" min="${selected.level}" max="60" value="${effectivePlanLevel}" /></label><label>计划状态<input value="${effectivePlanLevel === selected.level ? "保持当前" : "已设置计划"}" readonly /></label></div><div class="plan-actions"><div><button class="button button-secondary" id="restore-current" type="button" ${selected.targetLevel === selected.level ? "disabled" : ""}>恢复为当前等级</button><button class="button button-secondary" id="quick-sixty" type="button" ${selected.targetLevel === 60 ? "disabled" : ""}>快捷计划60级</button></div><button class="button button-tertiary danger-action" id="reset-plans" type="button">重置全部计划</button></div></article>
    </section>
    <section class="experience-section" aria-labelledby="experience-title"><header><div><p class="section-kicker">经验星曜</p><h2 id="experience-title">当前经验星曜 / 计划经验星曜需求</h2></div><small>当前库存可编辑；需求按正式规则实时计算</small></header><div class="experience-grid"><article class="experience-editor" data-experience-editor><h3>当前经验星曜${experienceWarning ? ` <span class="experience-inline-warning">${html(experienceWarning)}</span>` : ""}</h3><div class="experience-editor-row"><div class="experience-count"><label>橙星曜数量<input data-experience-field="orange" value="${pendingExperienceValue("orange")}" /></label><label>紫星曜数量<input data-experience-field="purple" value="${pendingExperienceValue("purple")}" /></label><label>白星曜数量<input data-experience-field="white" value="${pendingExperienceValue("white")}" /></label></div><button class="button button-secondary" id="view-experience-source" type="button" ${experienceSourceImageId ? `data-experience-source="${html(experienceSourceImageId)}"` : "disabled"} title="${experienceSourceImageId ? "查看经验星曜原图" : "当前工作区暂无可查看的经验星曜原图"}">查看经验星曜原图</button></div></article>${experienceNeedsTemplate(selected)}</div></section>
    <section class="ocr-review" aria-labelledby="ocr-review-title"><button class="ocr-summary" id="toggle-ocr-review" type="button" aria-expanded="${ocrListExpanded}"><span><strong id="ocr-review-title">OCR图片人工复核</strong> <em>${pendingOcrReview ? pendingOcrReview.persisted ? "已保存识别结果，可再次核对" : "识别后补充检查" : "当前工作区来源与复核"}</em></span><span class="ocr-toggle-label">${ocrListExpanded ? "收起" : "展开"}</span></button><div class="ocr-review-list${ocrListExpanded ? "" : " is-collapsed"}">${pendingOcrReviewTemplate()}</div></section>
  </section>`;
}

function formatBytes(bytes: number): string { return `${(bytes / 1_000_000).toFixed(1)} MB`; }

function findImportImage(id: string): ImportImage | undefined { return importImages.find((image) => image.sourceImageId === id); }

function imageOptions(pool: OverlapPool, selectedId?: string): string {
  return importImages.filter((image) => image.pool === pool).map((image) => `<option value="${image.sourceImageId}" ${image.sourceImageId === selectedId ? "selected" : ""}>${html(image.filename)}</option>`).join("");
}

function importPoolTemplate(pool: Pool): string {
  const images = sortProductImportImagesForDisplay(importImages.filter((image) => image.pool === pool));
  const classificationPending = hasClassifyingImportImages();
  return `<section class="import-pool import-pool-${pool}" data-import-pool="${pool}" aria-label="${pool}池"><header><h2>${pool}池 <span>（${images.length} 张）</span></h2><button class="button button-secondary positive-action" data-confirm-pool="${pool}" type="button" ${isOcrLocked() || classificationPending || !images.length ? "disabled" : ""}>确认本池</button></header><div class="pool-thumbnail-scroll" data-pool-scroll="${pool}">${images.length ? images.map((image) => `<article class="thumbnail-card${image.confirmed ? " is-confirmed" : " is-unconfirmed"}${image.classificationStatus === "classifying" ? " is-classifying" : ""}" draggable="${!isOcrLocked() && image.classificationStatus !== "classifying"}" data-import-image="${image.sourceImageId}" aria-label="${html(image.filename)}"><button class="thumbnail-preview" type="button" data-preview-image="${image.sourceImageId}" aria-label="查看 ${html(image.filename)}"><span class="thumbnail-image"><img src="${image.objectUrl}" alt="${html(image.filename)}" /></span><span class="thumbnail-caption"><em>${importImages.findIndex((candidate) => candidate.sourceImageId === image.sourceImageId) + 1}</em><strong>${html(image.filename)}</strong><small>${html(importImageStatusLabel(image))}</small></span></button><button class="thumbnail-delete danger-action" type="button" data-delete-image="${image.sourceImageId}" aria-label="从${pool}池移除 ${html(image.filename)}" title="移除图片" ${isOcrLocked() ? "disabled" : ""}>×</button></article>`).join("") : `<div class="empty-pool-card"><span>暂无图片</span><small>${pool === "经验星曜" ? "可在此查看经验星曜完整页" : "添加图片后自动推荐分类"}</small></div>`}</div></section>`;
}

function overlapTemplate(pool: OverlapPool): string {
  const images = importImages.filter((image) => image.pool === pool);
  const relations = overlapRelations.filter((relation) => relation.pool === pool && findImportImage(relation.beforeId)?.pool === pool && findImportImage(relation.afterId)?.pool === pool);
  const title = pool === "主星" ? "主星池重叠校验" : "辅星池重叠校验";
  return `<article class="overlap-section"><header><div><p class="section-kicker">${title}</p><h2>当前 ${relations.length} 组；0 组不阻断识别</h2></div></header><div class="overlap-controls"><label>前一张图片<select data-overlap-before="${pool}" ${isOcrLocked() ? "disabled" : ""}>${images.length ? imageOptions(pool, images[0]?.sourceImageId) : "<option>选择前图</option>"}</select></label><span>→</span><label>后一张图片<select data-overlap-after="${pool}" ${isOcrLocked() ? "disabled" : ""}>${images.length ? imageOptions(pool, images[1]?.sourceImageId ?? images[0]?.sourceImageId) : "<option>选择后图</option>"}</select></label><button class="button button-secondary" type="button" data-add-overlap="${pool}" ${images.length < 2 || isOcrLocked() ? "disabled" : ""}>添加关系</button></div><div class="overlap-links">${relations.length ? relations.map((relation) => { const before = findImportImage(relation.beforeId); const after = findImportImage(relation.afterId); return before && after ? `<div class="overlap-link"><span class="overlap-link-name">${html(before.filename)} → ${html(after.filename)}</span><div class="overlap-link-actions"><button class="button button-tertiary" type="button" data-preview-image="${before.sourceImageId}">前图</button><button class="button button-tertiary" type="button" data-preview-image="${after.sourceImageId}">后图</button><button class="button button-tertiary danger-action" type="button" data-remove-overlap="${relation.pairId}" ${isOcrLocked() ? "disabled" : ""}>移除</button></div></div>` : ""; }).join("") : `<p class="overlap-link is-empty">暂未标记${pool}重叠关系。</p>`}</div></article>`;
}

function importTemplate(): string {
  const totalSize = importImages.reduce((total, image) => total + image.size, 0);
  const currentFilename = ocrUi.sourceImageId ? findImportImage(ocrUi.sourceImageId)?.filename ?? ocrUi.sourceImageId : "—";
  const progress = ocrUi.total ? Math.min(100, Math.round((ocrUi.completed / ocrUi.total) * 100)) : 0;
  const startLabel = canCancelOcr() || ocrUi.status === "cancelling" ? "取消识别" : "开始识别";
  const account = workspaceContext?.account ?? null;
  const unloadedAccountLabel = reviewSaveState === "failed" ? "工作区未加载" : "正在加载工作区";
  const accountLabel = account ? `${account.gameVersion} · ${account.displayName}` : unloadedAccountLabel;
  const gameVersionLabel = account?.gameVersion ?? "—";
  const accountNameLabel = account?.displayName ?? "—";
  const accountOptions = (availableAccounts.length ? availableAccounts : account ? [account] : []).map((item) => `<option value="${html(item.accountId)}" ${item.accountId === account?.accountId ? "selected" : ""}>${html(`${item.gameVersion} · ${item.displayName}`)}</option>`).join("");
  return `<section class="import-page" aria-label="导入识别">
    <section class="import-account-requirements"><article class="import-account-panel"><header><p class="section-kicker">当前账号</p><h2>本机工作区账号</h2></header><div class="account-fields"><label>当前账号<select data-current-account aria-label="当前账号" ${isOcrLocked() ? "disabled" : ""}>${accountOptions || `<option>${html(accountLabel)}</option>`}</select></label><label>游戏版本<select data-account-game-version aria-label="游戏版本" ${isOcrLocked() ? "disabled" : ""}>${(["如鸢", "代号鸢"] as const).map((version) => `<option value="${version}" ${version === gameVersionLabel ? "selected" : ""}>${version}</option>`).join("")}</select></label><label>账号名称<input data-account-name value="${html(accountNameLabel)}" ${isOcrLocked() ? "disabled" : ""} /></label></div><div class="account-actions"><button class="button button-secondary positive-action" data-create-account type="button" ${isOcrLocked() ? "disabled" : ""}>新增账号</button><button class="button button-tertiary danger-action" data-delete-current-account type="button" ${isOcrLocked() ? "disabled" : ""}>删除当前账号</button></div></article><article class="screenshot-requirements"><header><p class="section-kicker">截图要求</p><h2>导入前确认</h2></header><ul><li>请上传同一账号、同一设备、同一次背包查看过程中的截图；截图过程中不要分解、升级、获得或消耗星石。</li><li>优先上传清晰、完整的原始截图；主星和辅星尽量减少前后截图重叠。</li><li>每张截图优先保证顶部第一行完整；页面底部半隐没行可以保留，后续可作为残片忽略。</li><li>若两张截图存在重复行，请明确标记前图和后图；主星、辅星通常各 1–2 组。</li><li>经验星石建议上传一张完整清晰页面；若未标记重叠不会阻断识别，但可能导致识别的星石数量偏高。</li></ul></article></section>
    <section class="import-pick-progress"><article class="file-picker-panel"><input id="image-file-input" type="file" accept="image/*" multiple hidden ${isOcrLocked() ? "disabled" : ""}/><button id="file-drop-zone" class="file-drop-zone" type="button" ${isOcrLocked() ? "disabled" : ""}><span class="drop-icon">＋</span><strong>点击选择图片或拖拽图片到这里</strong><small>支持选择、拖拽或 Ctrl+V 粘贴多张本地图片；文件只保留在本机。</small></button><p id="file-summary">已选文件：${importImages.length} 张　·　总大小：${formatBytes(totalSize)}　·　${hasClassifyingImportImages() ? "正在判断图片类型" : importImages.some((image) => !image.confirmed) ? "存在待确认分类" : importImages.length ? "分类均已确认" : "等待添加图片"}</p></article><article class="import-progress" id="import-progress-panel"><header><div><p class="section-kicker">导入任务进度</p><h2>${ocrStatusLabel()}</h2></div></header><dl><div><dt>任务状态</dt><dd>${ocrStatusLabel()}</dd></div><div><dt>当前阶段</dt><dd>${ocrUi.message || ocrStatusLabel()}</dd></div><div><dt>当前文件</dt><dd title="${html(currentFilename)}">${html(currentFilename)}</dd></div></dl><p>当前图片：${ocrUi.completed} / ${ocrUi.total || importImages.length} · 已完成：${ocrUi.completed} · 待处理：${Math.max(0, (ocrUi.total || importImages.length) - ocrUi.completed)} · 错误数：${ocrUi.error ? 1 : 0}</p><div class="progress-track"><span style="width:${progress}%"></span></div>${ocrUi.error ? `<small class="import-error">${html(ocrUi.error)}</small>` : `<small>${html(ocrUi.message || "图片尚未离开本机。")}</small>`}</article></section>
    <section class="import-pools" aria-label="图片分类池">${importPoolTemplate("主星")}${importPoolTemplate("辅星")}${importPoolTemplate("经验星曜")}</section>
    <section class="overlap-grid" aria-label="主星与辅星重叠校验">${overlapTemplate("主星")}${overlapTemplate("辅星")}</section>
    <footer class="import-footer"><div><button class="button button-secondary positive-action" data-confirm-all-pools type="button" ${isOcrLocked() || hasClassifyingImportImages() || !importImages.length ? "disabled" : ""}>一键确认全部分类</button><button class="button button-tertiary danger-action" data-clear-import-images type="button" ${isOcrLocked() || !importImages.length ? "disabled" : ""}>清空待识别图片</button></div><div><button class="button button-secondary" data-open-restore type="button" ${isOcrLocked() ? "disabled" : ""}>恢复快照</button><button class="button button-secondary start-recognition-action" data-start-ocr type="button" ${isOcrRunning() && !canCancelOcr() ? "disabled" : ""}>${startLabel}</button></div></footer>
  </section>`;
}

function ocrConfirmTemplate(): string {
  if (!ocrConfirmOpen) return "";
  return `<div class="data-dialog" role="dialog" aria-modal="true" aria-label="确认开始本机离线识别"><button class="dialog-backdrop" data-cancel-ocr-confirm type="button" aria-label="取消"></button><article><header><div><p class="section-kicker">本机离线 OCR</p><h2>确认开始本机离线识别？</h2></div><button class="icon-button" data-cancel-ocr-confirm type="button" aria-label="取消">×</button></header><p class="dialog-note">这会替换当前工作区中的星石汇总；图片只在本机处理并自动保存。</p><div class="dialog-actions"><button class="button button-tertiary" data-cancel-ocr-confirm type="button">取消</button><button class="button button-secondary positive-action" data-confirm-start-ocr type="button">确认开始</button></div></article></div>`;
}

function deleteAccountConfirmTemplate(): string {
  if (!deleteAccountConfirmOpen || !workspaceContext) return "";
  return `<div class="data-dialog" role="dialog" aria-modal="true" aria-label="删除账号"><button class="dialog-backdrop" data-cancel-delete-account type="button" aria-label="取消"></button><article><header><div><h2>删除账号</h2></div><button class="icon-button" data-cancel-delete-account type="button" aria-label="关闭">×</button></header><p class="dialog-note">确定删除账号「${html(workspaceContext.account.displayName)}」吗？</p><p class="dialog-note">该账号的背包数据将一并删除，此操作无法撤销。</p><div class="dialog-actions"><button class="button button-tertiary" data-cancel-delete-account type="button">取消</button><button class="button button-tertiary danger-action" data-confirm-delete-account type="button">确认删除</button></div></article></div>`;
}

function dataToolsTemplate(): string {
  if (!toolDialog) return "";
  if (toolDialog === "restore") return `<div class="data-dialog" role="dialog" aria-modal="true" aria-label="恢复工作区"><button class="dialog-backdrop" data-close-tool-dialog type="button" aria-label="关闭"></button><article><header><div><p class="section-kicker">恢复工作区</p><h2>最近恢复点</h2></div><button class="icon-button" data-close-tool-dialog type="button" aria-label="关闭">×</button></header><p class="dialog-note">恢复会先创建“恢复前自动安全点”。恢复操作本身不可撤销，当前浏览器会话的撤销历史将清空。</p>${dataToolError ? `<p class="dialog-error">${html(dataToolError)}</p>` : ""}<div class="restore-point-list">${restorePointList.length ? restorePointList.map((point) => `<article><div><strong>${html(restoreReasonLabel(point.reason))}</strong><small>${formatRestoreTime(point.createdAt)} · 工作区版本 ${point.workspaceRevision}</small><small class="restore-point-summary">背包 ${point.bagCurrentCount ?? "—"} / ${point.bagCapacity ?? "—"} · 当前 ${point.inventoryCount} 颗 · 计划 ${point.plannedCount} 颗</small></div><button class="button button-secondary" data-restore-point="${point.restorePointId}" type="button">恢复此点</button></article>`).join("") : "<p class=\"dialog-empty\">暂无恢复点。导入数据或后续恢复前会自动创建安全点。</p>"}</div></article></div>`;
  const preview = dataImportPreview;
  return `<div class="data-dialog" role="dialog" aria-modal="true" aria-label="导入数据"><button class="dialog-backdrop" data-close-tool-dialog type="button" aria-label="关闭"></button><article><header><div><p class="section-kicker">导入数据</p><h2>替换当前账号工作区</h2></div><button class="icon-button" data-close-tool-dialog type="button" aria-label="关闭">×</button></header><p class="dialog-note">仅支持 JSON 或 XLSX，最大 20 MB。确认后会先创建“导入数据前安全恢复点”，再以导入内容完全替换当前账号的背包、计划、经验星曜；不会合并，也不会保留旧 OCR 证据。</p><input id="workspace-data-file" type="file" accept=".json,application/json,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden />${preview ? `<section class="import-preview"><h3>导入预览</h3><dl><div><dt>文件</dt><dd>${html(preview.fileName)} · ${preview.format.toUpperCase()}</dd></div><div><dt>星石</dt><dd>${preview.inventoryCount} 颗，其中 ${preview.plannedCount} 颗有计划等级</dd></div><div><dt>背包</dt><dd>${preview.bag.currentCount ?? "—"} / ${preview.bag.capacity ?? "—"}</dd></div><div><dt>经验星曜</dt><dd>橙 ${preview.experience.orange ?? "—"} · 紫 ${preview.experience.purple ?? "—"} · 白 ${preview.experience.white ?? "—"}</dd></div></dl><div class="dialog-actions"><button class="button button-tertiary" data-select-data-file type="button">重新选择</button><button class="button button-secondary positive-action" data-confirm-data-import type="button">确认替换当前账号数据</button></div></section>` : `<div class="dialog-actions"><button class="button button-secondary positive-action" data-select-data-file type="button">选择 JSON 或 XLSX 文件</button></div>`}${dataToolError ? `<p class="dialog-error">${html(dataToolError)}</p>` : ""}</article></div>`;
}

function workspaceToolsTemplate(): string {
  return `<aside class="review-workspace-tools" aria-label="工作区工具"><button class="tool-button" id="undo-workspace" type="button" aria-label="撤销" title="撤销（Ctrl+Z）" ${canUseReviewHistory("undo") || workspaceController.canUndo ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 7 4 12l5 5M5 12h9a5 5 0 0 1 5 5"/></svg></button><button class="tool-button" id="redo-workspace" type="button" aria-label="重做" title="重做（Ctrl+Y）" ${canUseReviewHistory("redo") || workspaceController.canRedo ? "" : "disabled"}><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 7 5 5-5 5m4-5h-9a5 5 0 0 0-5 5"/></svg></button><button class="tool-button" data-open-restore type="button" aria-label="恢复快照" title="恢复快照"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5M12 8v5l3 2"/></svg></button></aside>`;
}

function shellTemplate(): string {
  const importing = activeTab === "import";
  return `<div class="product-shell"><header class="product-header"><div class="product-title-row"><h1>YuanStar 星石整理</h1></div><div class="product-nav-row"><nav class="product-tabs" aria-label="产品页面"><button class="product-tab${activeTab === "import" ? " is-active" : ""}" data-tab="import" type="button">导入识别</button><button class="product-tab${activeTab === "review" ? " is-active" : ""}" data-tab="review" type="button">人工核对</button></nav><div class="data-menu"><button class="data-menu-trigger" id="data-menu-trigger" aria-expanded="${dataMenuOpen}" aria-haspopup="menu" type="button">数据 <span>▾</span></button>${dataMenuOpen ? `<div class="data-menu-popover" role="menu"><button data-data-action="import" type="button" role="menuitem">导入数据</button><button data-data-action="export-json" type="button" role="menuitem">导出 JSON</button><button data-data-action="export-xlsx" type="button" role="menuitem">导出 XLSX</button></div>` : ""}</div></div></header><main id="page-content">${importing ? importTemplate() : reviewTemplate()}${!importing ? workspaceToolsTemplate() : ""}</main>${reviewSourcePreviewTemplate()}${dataToolsTemplate()}${ocrConfirmTemplate()}${deleteAccountConfirmTemplate()}${toastTemplate()}</div>`;
}

function captureScroll(): Record<Pane, number> {
  return { current: root.querySelector<HTMLElement>("#current-scroll")?.scrollTop ?? 0, plan: root.querySelector<HTMLElement>("#plan-scroll")?.scrollTop ?? 0 };
}

function restoreScroll(values: Record<Pane, number>): void {
  const current = root.querySelector<HTMLElement>("#current-scroll");
  const plan = root.querySelector<HTMLElement>("#plan-scroll");
  if (current) current.scrollTop = values.current;
  if (plan) plan.scrollTop = values.plan;
}

type ReviewScrollIntent = "keep" | "top" | { pane: Pane; sourceScroll: number; relativeTop: number };

type ReviewViewportSnapshot = { pageScrollY: number; reviewScrollTop: number; anchorOccurrenceId: string | null; anchorTop: number | null };

function reviewOccurrenceElement(occurrenceId: string): HTMLElement | null {
  const container = getActiveReviewScrollContainer(root);
  return [...(container?.querySelectorAll<HTMLElement>("[data-review-occurrence]") ?? [])].find((element) => element.dataset.reviewOccurrence === occurrenceId) ?? null;
}

function captureReviewViewport(anchorOccurrenceId?: string): ReviewViewportSnapshot {
  const anchor = anchorOccurrenceId ? reviewOccurrenceElement(anchorOccurrenceId) : null;
  return { pageScrollY: window.scrollY, reviewScrollTop: getActiveReviewScrollContainer(root)?.scrollTop ?? 0, anchorOccurrenceId: anchorOccurrenceId ?? null, anchorTop: anchor?.getBoundingClientRect().top ?? null };
}

function restoreReviewViewport(snapshot: ReviewViewportSnapshot | null): void {
  if (!snapshot) return;
  const reviewScroll = getActiveReviewScrollContainer(root);
  if (reviewScroll) reviewScroll.scrollTop = Math.min(snapshot.reviewScrollTop, Math.max(0, reviewScroll.scrollHeight - reviewScroll.clientHeight));
  window.scrollTo({ top: snapshot.pageScrollY, behavior: "auto" });
  if (snapshot.anchorOccurrenceId && snapshot.anchorTop != null) {
    const anchor = reviewOccurrenceElement(snapshot.anchorOccurrenceId);
    if (anchor) window.scrollBy({ top: anchor.getBoundingClientRect().top - snapshot.anchorTop, behavior: "auto" });
  }
}

function renderReview(intent: ReviewScrollIntent = "keep", viewport: ReviewViewportSnapshot | null = intent === "top" ? null : captureReviewViewport()): void {
  hideStarDescription();
  const content = root.querySelector<HTMLElement>("#page-content");
  if (!content) return;
  const scroll = captureScroll();
  content.innerHTML = `${reviewTemplate()}${workspaceToolsTemplate()}`;
  restoreScroll(scroll);
  bindReviewControls();
  if (intent === "top") requestAnimationFrame(scrollSelectedRowsToTop);
  if (typeof intent === "object") requestAnimationFrame(() => alignCounterpartRow(intent));
  if (intent === "keep") requestAnimationFrame(() => restoreReviewViewport(viewport));
}

function captureImportPoolScroll(): void {
  root.querySelectorAll<HTMLElement>("[data-pool-scroll]").forEach((element) => {
    const pool = importPoolFrom(element.dataset.poolScroll);
    if (pool) importPoolScrollLeft[pool] = element.scrollLeft;
  });
}

function restoreImportPoolScroll(): void {
  root.querySelectorAll<HTMLElement>("[data-pool-scroll]").forEach((element) => {
    const pool = importPoolFrom(element.dataset.poolScroll);
    if (pool) element.scrollLeft = Math.min(importPoolScrollLeft[pool], Math.max(0, element.scrollWidth - element.clientWidth));
  });
}

function renderPage(): void {
  hideStarDescription();
  if (activeTab === "import") captureImportPoolScroll();
  root.innerHTML = shellTemplate();
  bindShellControls();
  if (activeTab === "review") bindReviewControls();
  else { bindImportControls(); requestAnimationFrame(restoreImportPoolScroll); }
}

function setActiveTab(tab: ProductTab): void { hideStarDescription(); if (activeTab === "import") captureImportPoolScroll(); activeTab = tab; writeStorage("yuanstar.product.tab", tab); renderPage(); if (tab === "review" && !workspaceContext) void loadProductWorkspace(); }

function accountInput(): { displayName: string; gameVersion: "如鸢" | "代号鸢" } | null {
  const name = root.querySelector<HTMLInputElement>("[data-account-name]");
  const gameVersion = root.querySelector<HTMLSelectElement>("[data-account-game-version]");
  if (!name || !gameVersion) return null;
  return { displayName: name.value, gameVersion: gameVersion.value === "如鸢" ? "如鸢" : "代号鸢" };
}

function clearAccountScopedTransientState(): void {
  importImages.forEach((image) => URL.revokeObjectURL(image.objectUrl));
  importImages = [];
  overlapRelations = [];
  clearPendingReviewUi();
  pendingOcrReview = null;
  imageViewer?.revocableUrls.forEach((url) => URL.revokeObjectURL(url));
  imageViewer = null;
  selectedId = "";
  currentEditDraft = null;
  planEditDraft = null;
  reviewError = "";
  ocrConfirmOpen = false;
  deleteAccountConfirmOpen = false;
  ocrUi = { status: "idle", completed: 0, total: 0, sourceImageId: null, message: "", error: "" };
}

async function saveCurrentAccountMetadata(render = true): Promise<boolean> {
  const current = workspaceContext;
  const input = accountInput();
  if (!current || !input) return false;
  try {
    applyWorkspaceContext(await workspaceController.updateAccountMetadata(current.account.accountId, input));
    availableAccounts = await workspaceController.listAccounts();
    if (render) renderPage();
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : "账号信息未保存。";
    importNotice(message, true);
    if (error instanceof WorkspaceDomainError && error.code === "account_name_conflict") showToast(message);
    if (render) renderPage();
    return false;
  }
}

async function switchProductAccount(accountId: string): Promise<void> {
  const current = workspaceContext;
  if (!current || accountId === current.account.accountId || isOcrLocked()) { renderPage(); return; }
  if (!await saveCurrentAccountMetadata(false)) { renderPage(); return; }
  try {
    clearAccountScopedTransientState();
    applyWorkspaceContext(await workspaceController.switchAccount(accountId));
    availableAccounts = await workspaceController.listAccounts();
    restorePersistedOcrReview();
    reviewSaveState = "saved";
  } catch (error) {
    importNotice(error instanceof Error ? error.message : "账号切换失败。", true);
  }
  renderPage();
}

async function createProductAccount(): Promise<void> {
  if (isOcrLocked()) { renderPage(); return; }
  try {
    const account = await workspaceController.createDefaultAccount();
    clearAccountScopedTransientState();
    applyWorkspaceContext(await workspaceController.switchAccount(account.accountId));
    availableAccounts = await workspaceController.listAccounts();
    restorePersistedOcrReview();
    reviewSaveState = "saved";
  } catch (error) {
    const message = error instanceof Error ? error.message : "账号未创建。";
    importNotice(message, true);
    if (error instanceof WorkspaceDomainError && error.code === "account_name_conflict") showToast(message);
  }
  renderPage();
}

async function deleteCurrentProductAccount(): Promise<void> {
  const current = workspaceContext;
  if (!current || isOcrLocked()) { renderPage(); return; }
  deleteAccountConfirmOpen = false;
  try {
    clearAccountScopedTransientState();
    const fallback = await workspaceController.deleteAccount(current.account.accountId);
    if (!fallback) throw new Error("删除后未能解析有效账号。");
    applyWorkspaceContext(fallback);
    availableAccounts = await workspaceController.listAccounts();
    restorePersistedOcrReview();
    reviewSaveState = "saved";
  } catch (error) {
    importNotice(error instanceof Error ? error.message : "账号未删除。", true);
  }
  renderPage();
}

function openDeleteAccountConfirm(): void {
  if (!workspaceContext || isOcrLocked()) return;
  deleteAccountConfirmOpen = true;
  renderPage();
}

async function loadProductWorkspace(): Promise<void> {
  reviewSaveState = "loading"; reviewError = ""; renderPage();
  try { applyWorkspaceContext(await workspaceController.load()); availableAccounts = await workspaceController.listAccounts(); restorePersistedOcrReview(); reviewSaveState = "saved"; }
  catch (error) { reviewSaveState = "failed"; reviewError = error instanceof Error ? error.message : "无法打开当前工作区。"; }
  renderPage();
}

function selectStar(id: string, pane: Pane): void {
  const source = root.querySelector<HTMLElement>(`#${pane}-scroll`);
  const row = root.querySelector<HTMLElement>(`[data-star-id="${id}"][data-pane="${pane}"]`);
  const sourceScroll = source?.scrollTop ?? 0;
  const relativeTop = row ? row.offsetTop - sourceScroll : 0;
  selectedId = id;
  selectedPane = pane;
  currentEditDraft = null;
  planEditDraft = null;
  writeStorage("yuanstar.product.selected", id);
  renderReview({ pane, sourceScroll, relativeTop });
}

function alignCounterpartRow(intent: Exclude<ReviewScrollIntent, "keep" | "top">): void {
  const source = root.querySelector<HTMLElement>(`#${intent.pane}-scroll`);
  const counterpartPane: Pane = intent.pane === "current" ? "plan" : "current";
  const counterpart = root.querySelector<HTMLElement>(`[data-star-id="${selectedId}"][data-pane="${counterpartPane}"]`);
  const target = root.querySelector<HTMLElement>(`#${counterpartPane}-scroll`);
  if (source) source.scrollTop = intent.sourceScroll;
  if (target && counterpart) target.scrollTop = Math.max(0, counterpart.offsetTop - intent.relativeTop);
}

function scrollSelectedRowsToTop(): void {
  (["current", "plan"] as Pane[]).forEach((pane) => {
    const container = root.querySelector<HTMLElement>(`#${pane}-scroll`);
    const row = root.querySelector<HTMLElement>(`[data-star-id="${selectedId}"][data-pane="${pane}"]`);
    if (container && row) container.scrollTop = Math.max(0, row.offsetTop - 29);
  });
}

function refreshReviewTables(): void {
  hideStarDescription();
  const currentRows = root.querySelector<HTMLElement>("#current-rows");
  const planRows = root.querySelector<HTMLElement>("#plan-rows");
  const count = filteredStars().length;
  if (currentRows) currentRows.innerHTML = panelRows("current");
  if (planRows) planRows.innerHTML = panelRows("plan");
  const currentCount = root.querySelector<HTMLElement>("#current-count");
  const planCount = root.querySelector<HTMLElement>("#plan-count");
  if (currentCount) currentCount.textContent = `（${count} 颗）`;
  if (planCount) planCount.textContent = `（对应 ${count} 颗）`;
  refreshExperienceNeeds();
  bindReviewRows();
}

function activatePane(pane: Pane): void {
  if (selectedPane === pane) return;
  selectedPane = pane;
  root.querySelectorAll<HTMLElement>(".inventory-row").forEach((row) => {
    const selected = row.dataset.starId === selectedId && row.dataset.pane === pane;
    const counterpart = row.dataset.starId === selectedId && row.dataset.pane !== pane;
    row.classList.toggle("is-selected", selected);
    row.classList.toggle("is-counterpart", counterpart);
    row.setAttribute("aria-selected", String(selected));
    const check = row.querySelector<HTMLInputElement>("input");
    if (check) check.checked = selected;
  });
}

function bindShellControls(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => setActiveTab(button.dataset.tab === "import" ? "import" : "review")));
  root.querySelector<HTMLSelectElement>("[data-current-account]")?.addEventListener("change", (event) => { void switchProductAccount((event.target as HTMLSelectElement).value); });
  const accountName = root.querySelector<HTMLInputElement>("[data-account-name]");
  accountName?.addEventListener("blur", () => { void saveCurrentAccountMetadata(); });
  accountName?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void saveCurrentAccountMetadata(); } });
  root.querySelector<HTMLSelectElement>("[data-account-game-version]")?.addEventListener("blur", () => { void saveCurrentAccountMetadata(); });
  root.querySelector<HTMLButtonElement>("[data-create-account]")?.addEventListener("click", () => { void createProductAccount(); });
  root.querySelector<HTMLButtonElement>("[data-delete-current-account]")?.addEventListener("click", openDeleteAccountConfirm);
  root.querySelectorAll<HTMLButtonElement>("[data-cancel-delete-account]").forEach((button) => button.addEventListener("click", () => { deleteAccountConfirmOpen = false; renderPage(); }));
  root.querySelector<HTMLButtonElement>("[data-confirm-delete-account]")?.addEventListener("click", () => { void deleteCurrentProductAccount(); });
  root.querySelector<HTMLButtonElement>("#data-menu-trigger")?.addEventListener("click", (event) => { event.stopPropagation(); dataMenuOpen = !dataMenuOpen; renderPage(); });
  root.querySelectorAll<HTMLButtonElement>("[data-data-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.dataAction;
    dataMenuOpen = false;
    if (action === "import") {
      if (isOcrLocked()) { dataToolError = "识别正在运行，请稍后再导入数据。"; toolDialog = "import"; renderPage(); return; }
      toolDialog = "import"; dataImportPreview = null; dataToolError = ""; renderPage(); return;
    }
    if (!workspaceContext) return;
    const data = createUserExport(workspaceContext.record.snapshot, workspaceContext.account.displayName);
    renderReview();
    if (action === "export-json") downloadData(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), safeExportFilename(data.accountDisplayName, "json"));
    if (action === "export-xlsx") exportXlsxData(data);
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-close-tool-dialog]").forEach((button) => button.addEventListener("click", () => { toolDialog = null; dataToolError = ""; renderPage(); }));
  root.querySelector<HTMLButtonElement>("[data-select-data-file]")?.addEventListener("click", () => root.querySelector<HTMLInputElement>("#workspace-data-file")?.click());
  root.querySelector<HTMLInputElement>("#workspace-data-file")?.addEventListener("change", () => { const file = root.querySelector<HTMLInputElement>("#workspace-data-file")?.files?.[0]; if (file) void prepareDataImport(file); });
  root.querySelector<HTMLButtonElement>("[data-confirm-data-import]")?.addEventListener("click", () => { void confirmDataImport(); });
  root.querySelectorAll<HTMLButtonElement>("[data-restore-point]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.restorePoint; if (id) void restoreWorkspacePoint(id); }));
  root.querySelectorAll<HTMLButtonElement>("[data-cancel-ocr-confirm]").forEach((button) => button.addEventListener("click", () => { ocrConfirmOpen = false; renderPage(); }));
  root.querySelector<HTMLButtonElement>("[data-confirm-start-ocr]")?.addEventListener("click", () => { void beginOcrRun(); });
  bindImageViewerControls();
  if (!dataMenuOutsideListenerBound) {
    dataMenuOutsideListenerBound = true;
    document.addEventListener("click", (event) => {
      if (dataMenuOpen && !(event.target instanceof Element && event.target.closest(".data-menu"))) { dataMenuOpen = false; renderPage(); }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { if (deleteAccountConfirmOpen) { deleteAccountConfirmOpen = false; renderPage(); } else if (dataMenuOpen) { dataMenuOpen = false; renderPage(); } else if (toolDialog) { toolDialog = null; renderPage(); } return; }
      if (activeTab !== "review" || toolDialog || event.altKey || event.shiftKey || event.isComposing || !event.ctrlKey) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && focused.matches("input, textarea, select, [contenteditable]")) return;
      const direction = event.key.toLowerCase() === "z" ? "undo" : event.key.toLowerCase() === "y" ? "redo" : null;
      if (!direction || (direction === "undo" ? !workspaceController.canUndo : !workspaceController.canRedo)) return;
      event.preventDefault();
      void runWorkspaceHistory(direction);
    });
  }
}

function downloadData(blob: Blob, filename: string): void {
  const anchor = document.createElement("a"); anchor.href = URL.createObjectURL(blob); anchor.download = filename; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}

function exportXlsxData(data: ReturnType<typeof createUserExport>): void {
  try { downloadData(new Blob([createXlsxExport(data)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), safeExportFilename(data.accountDisplayName, "xlsx")); }
  catch (error) { dataToolError = error instanceof Error ? `XLSX 导出失败：${error.message}` : "XLSX 导出失败。"; toolDialog = "import"; renderPage(); }
}

async function prepareDataImport(file: File): Promise<void> {
  if (!workspaceContext) return;
  if (file.size > 20 * 1024 * 1024) { dataToolError = "文件超过 20 MB 限制，请先精简后再导入。"; renderPage(); return; }
  try {
    const extension = file.name.split(".").pop()?.toLowerCase();
    dataImportPreview = extension === "json"
      ? previewJsonImport(file.name, await file.text(), workspaceContext.account.accountId, workspaceContext.account.gameVersion)
      : extension === "xlsx"
        ? previewXlsxImport(file.name, await file.arrayBuffer(), workspaceContext.account.accountId, workspaceContext.account.gameVersion)
        : (() => { throw new Error("只支持 .json 或 .xlsx 文件。"); })();
    dataToolError = "";
  } catch (error) { dataImportPreview = null; dataToolError = error instanceof Error ? error.message : "导入文件解析失败。"; }
  renderPage();
}

async function confirmDataImport(): Promise<void> {
  if (!dataImportPreview || isOcrLocked()) { dataToolError = "识别正在运行，当前工作区未替换。"; renderPage(); return; }
  try { applyWorkspaceContext(await workspaceController.replaceWorkspace(dataImportPreview.workspace)); reviewSaveState = "saved"; toolDialog = null; dataImportPreview = null; dataToolError = ""; activeTab = "review"; renderPage(); }
  catch (error) { dataToolError = error instanceof Error ? `导入未完成：${error.message}` : "导入未完成，当前数据保持不变。"; renderPage(); }
}

async function openRestoreDialog(): Promise<void> {
  if (isOcrLocked()) { dataToolError = "识别正在运行，请稍后查看恢复点。"; toolDialog = "restore"; renderPage(); return; }
  toolDialog = "restore"; dataToolError = ""; renderPage();
  try { restorePointList = (await workspaceController.listLatestRestorePoints()).map((point) => ({ restorePointId: point.restorePointId, reason: point.reason, createdAt: point.createdAt, workspaceRevision: point.workspaceRevision, bagCurrentCount: point.snapshot.bag.currentCount, bagCapacity: point.snapshot.bag.capacity, inventoryCount: point.snapshot.inventory.length, plannedCount: Object.keys(point.snapshot.planTargets).length })); }
  catch (error) { dataToolError = error instanceof Error ? error.message : "无法读取恢复点。"; }
  renderPage();
}

async function restoreWorkspacePoint(restorePointId: string): Promise<void> {
  if (isOcrLocked()) { dataToolError = "识别正在运行，当前工作区未恢复。"; renderPage(); return; }
  try { applyWorkspaceContext(await workspaceController.restoreRestorePoint(restorePointId)); reviewSaveState = "saved"; toolDialog = null; dataToolError = ""; renderPage(); }
  catch (error) { dataToolError = error instanceof Error ? `恢复未完成：${error.message}` : "恢复未完成，当前数据保持不变。"; renderPage(); }
}

function bindReviewRows(): void {
  root.querySelectorAll<HTMLTableRowElement>(".inventory-row").forEach((row) => {
    const pane: Pane = row.dataset.pane === "plan" ? "plan" : "current";
    const choose = () => selectStar(row.dataset.starId ?? selectedId, pane);
    row.addEventListener("click", choose);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(); } });
    row.querySelector<HTMLInputElement>("input")?.addEventListener("click", (event) => { event.stopPropagation(); choose(); });
  });
  bindStarDescriptionTooltips();
}

function tooltipElement(): HTMLElement {
  let tooltip = document.querySelector<HTMLElement>("#star-description-floating-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "star-description-floating-tooltip";
    tooltip.className = "star-description-floating-tooltip";
    tooltip.setAttribute("role", "tooltip");
    tooltip.hidden = true;
    document.body.append(tooltip);
  }
  return tooltip;
}

function showStarDescription(trigger: HTMLElement): void {
  const description = starDescription(trigger.dataset.starDescriptionName ?? "");
  if (!description) return;
  const tooltip = tooltipElement();
  tooltip.textContent = description;
  tooltip.hidden = false;
  const bounds = trigger.getBoundingClientRect();
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, bounds.left + (bounds.width / 2) - (width / 2)))}px`;
  tooltip.style.top = `${Math.max(10, Math.min(window.innerHeight - height - 10, bounds.bottom + 7))}px`;
}

function hideStarDescription(): void { const tooltip = document.querySelector<HTMLElement>("#star-description-floating-tooltip"); if (tooltip) tooltip.hidden = true; }

function bindStarDescriptionTooltips(): void {
  root.querySelectorAll<HTMLElement>("[data-star-description-name]").forEach((trigger) => {
    trigger.addEventListener("mouseenter", () => showStarDescription(trigger));
    trigger.addEventListener("focus", () => showStarDescription(trigger));
    trigger.addEventListener("mouseleave", hideStarDescription);
    trigger.addEventListener("blur", hideStarDescription);
  });
}

function currentDraftForEdit(): Pick<Star, "kind" | "name" | "level" | "quality"> {
  const selected = selectedStar();
  if (!selected) throw new Error("请先选择一颗星石。");
  return currentEditDraft ?? { kind: selected.kind, name: selected.name, level: selected.level, quality: selected.quality };
}

function isOcrBackedStar(star: Star): boolean {
  return Boolean(workspaceContext?.record.snapshot.inventory.find((item) => item.starInstanceId === star.starInstanceId)?.provenance.occurrenceId);
}

function commitCurrentEditor(): void {
  if (!currentEditDraft) return;
  const draft = currentEditDraft;
  if (!draft.name.trim()) { showToast("切换大类后请选择星石名称，当前修改尚未保存。"); return; }
  if (!browserCatalog.isNameForKind(draft.name, draft.kind) || !Number.isInteger(draft.level) || draft.level < 1 || draft.level > 60) return;
  const selected = selectedStar();
  if (!selected) return;
  currentEditDraft = null;
  const update = buildCurrentInstanceUpdate(selected, draft, isOcrBackedStar(selected));
  if (!hasCurrentInstanceUpdate(update)) { renderReview(); return; }
  activatePane("current");
  void runWorkspaceMutation((session) => session.updateInstance(selected.starInstanceId, update));
}

function commitPlanEditor(): void {
  if (planEditDraft === null) return;
  const selected = selectedStar();
  if (!selected) return;
  const target = Math.min(60, Math.max(selected.level, planEditDraft));
  planEditDraft = null;
  activatePane("plan");
  void runWorkspaceMutation((session) => session.setPlanTarget(selected.starInstanceId, target));
}

function bindEditorCompletion(panel: HTMLElement, commit: () => void): void {
  panel.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } });
  panel.addEventListener("focusout", () => requestAnimationFrame(() => { if (!panel.contains(document.activeElement)) commit(); }));
}

function bindReviewControls(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-review-source]").forEach((button) => button.addEventListener("click", () => { const id = button.dataset.reviewSource; if (id) void openReviewSourceImage(id); }));
  root.querySelector<HTMLButtonElement>("[data-experience-source]")?.addEventListener("click", (event) => { const id = (event.currentTarget as HTMLButtonElement).dataset.experienceSource; if (id) void openReviewSourceImage(id); });
  root.querySelectorAll<HTMLButtonElement>("[data-toggle-review-image]").forEach((button) => button.addEventListener("click", () => {
    const sourceImageId = button.dataset.toggleReviewImage; if (!sourceImageId) return;
    if (expandedReviewImages.has(sourceImageId)) expandedReviewImages.delete(sourceImageId); else expandedReviewImages.add(sourceImageId);
    renderReview();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-show-all-review-image]").forEach((button) => button.addEventListener("click", () => {
    const sourceImageId = button.dataset.showAllReviewImage; if (!sourceImageId) return;
    if (showAllReviewImages.has(sourceImageId)) showAllReviewImages.delete(sourceImageId); else showAllReviewImages.add(sourceImageId);
    renderReview();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-open-ordinary-edit]").forEach((button) => button.addEventListener("click", () => {
    const occurrenceId = button.closest<HTMLElement>("[data-review-occurrence]")?.dataset.reviewOccurrence; if (!occurrenceId) return;
    editingReviewOccurrences.add(occurrenceId); renderReview();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-cancel-ordinary-edit]").forEach((button) => button.addEventListener("click", () => {
    const occurrenceId = button.closest<HTMLElement>("[data-review-occurrence]")?.dataset.reviewOccurrence; if (!occurrenceId) return;
    editingReviewOccurrences.delete(occurrenceId); renderReview();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-confirm-ordinary-edit]").forEach((button) => button.addEventListener("click", () => {
    const pending = pendingOcrReview; const item = button.closest<HTMLElement>("[data-review-occurrence]"); const occurrenceId = item?.dataset.reviewOccurrence;
    if (!pending || !item || !occurrenceId) return;
    const name = item.querySelector<HTMLSelectElement>("[data-review-edit-name]")?.value ?? "";
    const level = Number(item.querySelector<HTMLInputElement>("[data-review-edit-level]")?.value);
    const quality = item.querySelector<HTMLSelectElement>("[data-review-edit-quality]")?.value as Quality;
    const catalogEntry = browserCatalog.entry(browserCatalog.normalize(name));
    if (!catalogEntry || catalogEntry.kind === "经验星石" || !Number.isInteger(level) || level < 1 || level > 60 || !["橙", "紫", "蓝", "绿", "白"].includes(quality)) { invalidReviewOccurrences.add(occurrenceId); showToast("请先补全名称、等级和品质。"); renderReview(); return; }
    runReviewWorkspaceMutation(occurrenceId, (session) => session.editOccurrence(occurrenceId, { name: catalogEntry.name, level, quality }), (invalidatedDuplicate) => {
      invalidReviewOccurrences.delete(occurrenceId);
      editingReviewOccurrences.delete(occurrenceId);
      showDuplicateInvalidationToast(invalidatedDuplicate);
    });
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-ignore-review-candidate]").forEach((button) => button.addEventListener("click", () => {
    const pending = pendingOcrReview; const item = button.closest<HTMLElement>("[data-review-occurrence]"); const occurrenceId = item?.dataset.reviewOccurrence;
    if (!pending || !item || !occurrenceId) return;
    runReviewWorkspaceMutation(occurrenceId, (session) => session.resolveOccurrenceReview(occurrenceId, "ignored"), (invalidatedDuplicate) => {
      invalidReviewOccurrences.delete(occurrenceId);
      editingReviewOccurrences.delete(occurrenceId);
      showDuplicateInvalidationToast(invalidatedDuplicate);
    });
  }));
  const resolveOverlap = (button: HTMLButtonElement, resolution: "merge" | "keep_separate"): void => {
    const pending = pendingOcrReview; const item = button.closest<HTMLElement>("[data-review-occurrence]"); const occurrenceId = item?.dataset.reviewOccurrence;
    if (!pending || !item || !occurrenceId) return;
    const candidate = buildProductReviewCandidates(pending.draft, pending.resolution, pending.evidence, new Set()).find((entry) => entry.occurrenceId === occurrenceId);
    if (!candidate?.overlapPending || !candidate.duplicateRowId) return;
    runReviewWorkspaceMutation(occurrenceId, (session) => session.setRowOverlapResolution(candidate.duplicateRowId!, resolution), () => {
      invalidReviewOccurrences.delete(occurrenceId);
      editingReviewOccurrences.delete(occurrenceId);
    });
  };
  root.querySelectorAll<HTMLButtonElement>("[data-confirm-overlap-duplicate]").forEach((button) => button.addEventListener("click", () => resolveOverlap(button, "merge")));
  root.querySelectorAll<HTMLButtonElement>("[data-keep-overlap-separate]").forEach((button) => button.addEventListener("click", () => resolveOverlap(button, "keep_separate")));
  root.querySelectorAll<HTMLButtonElement>("[data-keep-review-candidate]").forEach((button) => button.addEventListener("click", () => {
    const pending = pendingOcrReview; const item = button.closest<HTMLElement>("[data-review-occurrence]"); const occurrenceId = item?.dataset.reviewOccurrence;
    if (!pending || !item || !occurrenceId) return;
    const candidate = buildProductReviewCandidates(pending.draft, pending.resolution, pending.evidence, new Set()).find((entry) => entry.occurrenceId === occurrenceId);
    if (!candidate || !isProductReviewCandidateComplete(candidate, browserCatalog)) {
      editingReviewOccurrences.add(occurrenceId); invalidReviewOccurrences.add(occurrenceId); showToast("请先补全名称、等级和品质。"); renderReview(); return;
    }
    if (candidate.duplicateRowId) {
      runReviewWorkspaceMutation(occurrenceId, (session) => session.setRowOverlapResolution(candidate.duplicateRowId!, "keep_separate"), () => {
        invalidReviewOccurrences.delete(occurrenceId);
        editingReviewOccurrences.delete(occurrenceId);
      });
      return;
    }
    if (candidate.kind === "fragment") {
      runReviewWorkspaceMutation(occurrenceId, (session) => session.resolveOccurrenceReview(occurrenceId, "accepted"), () => {
        invalidReviewOccurrences.delete(occurrenceId);
        editingReviewOccurrences.delete(occurrenceId);
      });
      return;
    }
    runReviewWorkspaceMutation(occurrenceId, (session) => session.resolveOccurrenceReview(occurrenceId, "accepted"), () => {
      invalidReviewOccurrences.delete(occurrenceId);
      editingReviewOccurrences.delete(occurrenceId);
    });
  }));
  const kind = root.querySelector<HTMLSelectElement>("#kind-filter");
  const quality = root.querySelector<HTMLSelectElement>("#quality-filter");
  const name = root.querySelector<HTMLInputElement>("#name-filter");
  const sort = root.querySelector<HTMLSelectElement>("#sort-filter");
  if (kind) { kind.value = kindFilter; kind.addEventListener("change", () => { kindFilter = kind.value; refreshReviewTables(); }); }
  if (quality) { quality.value = qualityFilter; quality.addEventListener("change", () => { qualityFilter = quality.value; refreshReviewTables(); }); }
  if (name) {
    name.addEventListener("compositionstart", () => { reviewIsComposing = true; });
    name.addEventListener("input", () => { nameFilter = name.value; if (!reviewIsComposing) refreshReviewTables(); });
    name.addEventListener("compositionend", () => { reviewIsComposing = false; nameFilter = name.value; refreshReviewTables(); });
  }
  if (sort) { sort.value = sortFilter; sort.addEventListener("change", () => { sortFilter = sort.value; refreshReviewTables(); }); }
  root.querySelector("#apply-filter")?.addEventListener("click", () => refreshReviewTables());
  root.querySelector("#clear-filter")?.addEventListener("click", () => {
    kindFilter = "全部"; qualityFilter = "全部"; nameFilter = ""; sortFilter = "catalog";
    if (kind) kind.value = kindFilter;
    if (quality) quality.value = qualityFilter;
    if (name) name.value = nameFilter;
    if (sort) sort.value = sortFilter;
    refreshReviewTables();
  });
  bindReviewRows();
  let pendingBagSave: string | null = null;
  const saveBag = () => {
    const quantity = root.querySelector<HTMLInputElement>("#bag-quantity")?.value.trim() ?? "";
    const capacity = root.querySelector<HTMLInputElement>("#bag-capacity")?.value.trim() ?? "";
    const toNullable = (value: string) => value === "" ? null : Number(value);
    const currentCount = toNullable(quantity); const maximum = toNullable(capacity);
    if ((currentCount !== null && (!Number.isInteger(currentCount) || currentCount < 0)) || (maximum !== null && (!Number.isInteger(maximum) || maximum < 1))) { reviewSaveState = "failed"; reviewError = "背包数量和容量必须是有效整数。"; renderReview(); return; }
    const persisted = workspaceContext?.record.snapshot.bag;
    if (persisted?.currentCount === currentCount && persisted.capacity === maximum) return;
    const key = `${currentCount ?? ""}/${maximum ?? ""}`;
    if (pendingBagSave === key) return;
    pendingBagSave = key;
    void runWorkspaceMutation((session) => session.setBagValues(currentCount, maximum)).finally(() => { if (pendingBagSave === key) pendingBagSave = null; });
  };
  root.querySelectorAll<HTMLInputElement>("#bag-quantity, #bag-capacity").forEach((field) => {
    field.addEventListener("change", saveBag);
    field.addEventListener("focusout", saveBag);
    field.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); saveBag(); } });
  });
  const currentPanel = root.querySelector<HTMLElement>("[data-edit-panel=\"current\"]");
  currentPanel?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-current-field]").forEach((field) => {
    const update = () => {
      const draft = currentDraftForEdit();
      const name = field.dataset.currentField;
      if (name === "kind") { draft.kind = field.value === "辅星" ? "辅星" : "主星"; draft.name = ""; }
      if (name === "name") draft.name = field.value;
      if (name === "level") draft.level = Number(field.value);
      if (name === "quality") draft.quality = field.value as Quality;
      currentEditDraft = draft;
      activatePane("current");
      if (name === "kind") {
        const nameSelect = currentPanel.querySelector<HTMLSelectElement>("[data-current-field=\"name\"]");
        if (nameSelect) { nameSelect.innerHTML = nameOptions(draft.kind, draft.name); nameSelect.value = draft.name; }
      }
    };
    field.addEventListener(field instanceof HTMLSelectElement ? "change" : "input", update);
  });
  if (currentPanel) bindEditorCompletion(currentPanel, commitCurrentEditor);
  root.querySelector("#add-current-row")?.addEventListener("click", () => {
    const draft = currentDraftForEdit();
    if (!browserCatalog.isNameForKind(draft.name, draft.kind) || !Number.isInteger(draft.level) || draft.level < 1 || draft.level > 60) return;
    currentEditDraft = null;
    activatePane("current");
    void runWorkspaceMutation((session) => session.addInstance({ ...draft, equippedState: "not_evaluated", provenance: { sourceOrder: session.state.inventory.length, audit: { productManual: true } }, manualStatus: "manual" }), (id) => { selectedId = id; });
  });
  root.querySelector("#delete-current-row")?.addEventListener("click", () => {
    activatePane("current");
    const selected = selectedStar(); if (!selected) return;
    currentEditDraft = null;
    void runWorkspaceMutation((session) => session.deleteInstance(selected.starInstanceId));
  });
  const planPanel = root.querySelector<HTMLElement>("[data-edit-panel=\"plan\"]");
  planPanel?.querySelector<HTMLInputElement>("#target-level")?.addEventListener("input", (event) => { planEditDraft = Number((event.target as HTMLInputElement).value); activatePane("plan"); refreshExperienceNeeds(); });
  if (planPanel) bindEditorCompletion(planPanel, commitPlanEditor);
  root.querySelector("#restore-current")?.addEventListener("click", () => { const selected = selectedStar(); if (!selected) return; activatePane("plan"); planEditDraft = null; void runWorkspaceMutation((session) => session.setPlanTarget(selected.starInstanceId, selected.level)); });
  root.querySelector("#quick-sixty")?.addEventListener("click", () => { const selected = selectedStar(); if (!selected) return; activatePane("plan"); planEditDraft = null; void runWorkspaceMutation((session) => session.setPlanTarget(selected.starInstanceId, 60)); });
  root.querySelector("#reset-plans")?.addEventListener("click", () => { activatePane("plan"); planEditDraft = null; void runWorkspaceMutation((session) => session.resetAllPlanTargets()); });
  root.querySelector<HTMLButtonElement>("#undo-workspace")?.addEventListener("click", () => { void runWorkspaceHistory("undo"); });
  root.querySelector<HTMLButtonElement>("#redo-workspace")?.addEventListener("click", () => { void runWorkspaceHistory("redo"); });
  root.querySelectorAll<HTMLButtonElement>("[data-open-restore]").forEach((button) => button.addEventListener("click", () => { void openRestoreDialog(); }));
  root.querySelector("#toggle-ocr-review")?.addEventListener("click", () => { ocrListExpanded = !ocrListExpanded; renderReview(); });
  const experienceEditor = root.querySelector<HTMLElement>("[data-experience-editor]");
  const commitExperienceEditor = () => {
    experienceEditor?.querySelectorAll<HTMLInputElement>("[data-experience-field]").forEach((field) => {
      const key = field.dataset.experienceField as keyof typeof experienceDraft;
      experienceDraft[key] = field.value;
    });
    const values = Object.fromEntries((Object.keys(experienceDraft) as Array<keyof typeof experienceDraft>).map((key) => [key, experienceDraft[key] === "" ? null : Number(experienceDraft[key])])) as Record<keyof typeof experienceDraft, number | null>;
    if (Object.values(values).some((value) => value !== null && (!Number.isInteger(value) || value < 0))) { reviewSaveState = "failed"; reviewError = "经验星曜数量必须是非负整数或留空。"; renderReview(); return; }
    const persisted = workspaceContext?.record.snapshot.experience;
    if (persisted && persisted.orange === values.orange && persisted.purple === values.purple && persisted.white === values.white) return;
    void runWorkspaceMutation((session) => session.setExperienceQuantities(values));
  };
  experienceEditor?.querySelectorAll<HTMLInputElement>("[data-experience-field]").forEach((field) => {
    field.addEventListener("input", () => { const key = field.dataset.experienceField as keyof typeof experienceDraft; experienceDraft[key] = field.value; });
    field.addEventListener("focusout", commitExperienceEditor);
  });
  experienceEditor?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commitExperienceEditor(); } });
}

async function runWorkspaceHistory(direction: "undo" | "redo"): Promise<void> {
  if (isOcrLocked()) { reviewError = "识别正在运行，暂时不能修改当前工作区。"; renderReview(); return; }
  const reviewEntry = reviewHistoryEntry(direction);
  if (reviewEntry && canUseReviewHistory(direction)) {
    reviewSaveState = "saving"; reviewError = ""; renderReview();
    try {
      if (reviewEntry.workspaceMutation) {
        const context = direction === "undo" ? await workspaceController.undo() : await workspaceController.redo();
        if (!context) return;
        applyWorkspaceContext(context);
        syncPendingOcrReviewFromWorkspace();
      }
      if (!reviewEntry.workspaceMutation) restoreReviewUi(direction === "undo" ? reviewEntry.before : reviewEntry.after);
      if (direction === "undo") { reviewUiUndo.pop(); reviewUiRedo.push(reviewEntry); }
      else { reviewUiRedo.pop(); reviewUiUndo.push(reviewEntry); }
      reviewSaveState = "saved";
    } catch (error) {
      reviewSaveState = "failed";
      reviewError = error instanceof Error ? error.message : "历史操作失败，当前数据已重新加载。";
    }
    renderReview();
    return;
  }
  if (direction === "undo" ? !workspaceController.canUndo : !workspaceController.canRedo) return;
  reviewSaveState = "saving"; reviewError = ""; renderReview();
  try {
    const context = direction === "undo" ? await workspaceController.undo() : await workspaceController.redo();
    if (context) { applyWorkspaceContext(context); syncPendingOcrReviewFromWorkspace(); }
    reviewSaveState = "saved";
  } catch (error) {
    reviewSaveState = "failed";
    reviewError = error instanceof Error ? error.message : "历史操作失败，当前数据已重新加载。";
  }
  renderReview();
}

function importPoolFrom(value: string | undefined): Pool | null {
  return value === "主星" || value === "辅星" || value === "经验星曜" ? value : null;
}

function removeImportImage(id: string): void {
  if (isOcrLocked()) { importNotice("识别正在运行，请先完成或取消本次识别。", true); renderPage(); return; }
  const next = removeProductImportImageState(importImages, overlapRelations, id);
  if (!next.removed) return;
  URL.revokeObjectURL(next.removed.objectUrl);
  importImages = next.images;
  overlapRelations = next.pairs;
  if (imageViewer?.items.some((item) => item.id === id)) imageViewer = null;
  renderPage();
}

function moveImportImage(id: string, targetPool: Pool): void {
  if (isOcrLocked()) { importNotice("识别正在运行，请先完成或取消本次识别。", true); renderPage(); return; }
  if (findImportImage(id)?.classificationStatus === "classifying") { importNotice("正在判断图片类型，请稍候。", true); renderPage(); return; }
  const next = moveProductImportImageState(importImages, overlapRelations, id, targetPool);
  importImages = next.images;
  overlapRelations = next.pairs;
  renderPage();
}

async function classifyAddedImages(additions: ImportImage[]): Promise<void> {
  let failed = false;
  for (const addition of additions) {
    if (!findImportImage(addition.sourceImageId)) continue;
    try {
      const classification = await ocrCoordinator.classify(addition);
      importImages = applyProductImportClassification(importImages, addition.sourceImageId, classification);
      if (classification.pageType === "unknown") failed = true;
    } catch {
      failed = true;
      importImages = applyProductImportClassificationFailure(importImages, addition.sourceImageId);
    }
    if (activeTab === "import") renderPage();
  }
  if (failed) importNotice("部分图片分类失败，请人工调整所属池后确认。", true);
  else importNotice("OCR 分类推荐已完成，请确认每张图片的所属池。");
  if (activeTab === "import") renderPage();
}

function addImportFiles(files: Iterable<File>): void {
  if (isOcrLocked()) { importNotice("识别正在运行，请先完成或取消本次识别。", true); renderPage(); return; }
  try {
    const additions = createProductImportImages(files);
    if (!additions.length) return;
    importImages = [...importImages, ...additions];
    ocrUi = { status: "idle", completed: 0, total: importImages.length, sourceImageId: null, message: "正在判断图片类型，请稍候。", error: "" };
    renderPage();
    void classifyAddedImages(additions);
  } catch (error) {
    importNotice(error instanceof Error ? error.message : "图片添加失败。", true);
    renderPage();
  }
}

function clearImportImages(): void {
  if (isOcrLocked()) return;
  importImages.forEach((image) => URL.revokeObjectURL(image.objectUrl));
  importImages = [];
  overlapRelations = [];
  imageViewer = null;
  ocrUi = { status: "idle", completed: 0, total: 0, sourceImageId: null, message: "", error: "" };
  renderPage();
}

function createOcrJobId(): string { return `product-ocr-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`; }

async function requestStartOcr(): Promise<void> {
  if (canCancelOcr()) { ocrUi.status = "cancelling"; ocrUi.message = "正在取消本次识别。"; ocrCoordinator.cancel(); renderPage(); return; }
  if (pendingOcrReview) { clearPendingReviewUi(); pendingOcrReview = null; }
  ocrUi.status = "validating"; ocrUi.error = ""; renderPage();
  try {
    const context = workspaceContext ?? await workspaceController.load();
    applyWorkspaceContext(context);
    const invalid = ocrCoordinator.classificationPending ? "正在判断图片类型，请稍候。" : validateProductOcrImport(importImages, overlapRelations);
    if (invalid) { ocrUi.status = "idle"; importNotice(`！${invalid}`, true); showToast(invalid); renderPage(); return; }
    ocrUi.status = "idle";
    ocrConfirmOpen = true;
    renderPage();
  } catch (error) {
    ocrUi.status = "failed";
    importNotice(error instanceof Error ? error.message : "当前工作区尚未加载。", true);
    renderPage();
  }
}

function updateOcrProgress(event: import("./ocr/browser-analysis-contract").BrowserOcrRuntimeProgressV1): void {
  const status: ProductOcrUiStatus = event.phase === "initializing" ? "initializing" : event.phase === "cancelling" ? "cancelling" : event.phase === "cancelled" ? "cancelled" : "running";
  ocrUi = { ...ocrUi, status, completed: event.completed, total: event.total, sourceImageId: event.sourceImageId, message: ocrStatusLabel(status), error: "" };
  if (activeTab === "import") renderPage();
}

function clearPendingReviewUi(): void {
  for (const crop of reviewRowCrops.values()) if (crop.objectUrl) URL.revokeObjectURL(crop.objectUrl);
  reviewRowCrops.clear();
  expandedReviewImages.clear();
  showAllReviewImages.clear();
  editingReviewOccurrences.clear();
  completedReviewOccurrences.clear();
  invalidReviewOccurrences.clear();
  reviewUiUndo.length = 0;
  reviewUiRedo.length = 0;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("row_crop_failed")), "image/jpeg", .88));
}

async function preparePendingReviewRowCrops(session: NonNullable<typeof pendingOcrReview>): Promise<void> {
  const rowsByImage = new Map<string, Set<number>>();
  const include = (sourceImageId: string, row: number): void => { rowsByImage.set(sourceImageId, new Set([...(rowsByImage.get(sourceImageId) ?? []), row])); };
  session.evidence.occurrences.forEach((item) => include(item.sourceImageId, item.row));
  session.draft.overlapReviewItems.forEach((item) => { include(item.leftSourceImageId, item.leftRow); include(item.rightSourceImageId, item.rightRow); });
  for (const [sourceImageId, rows] of rowsByImage) for (const row of rows) reviewRowCrops.set(productReviewRowKey(sourceImageId, row), { status: "loading" });
  if (activeTab === "review") renderReview();
  await Promise.all([...rowsByImage].map(async ([sourceImageId, rows]) => {
    const source = session.runContext?.images.find((image) => image.sourceImageId === sourceImageId);
    const persisted = source ? null : await workspaceController.getCurrentImage(sourceImageId);
    if (!source && !persisted) { if (pendingOcrReview === session) for (const row of rows) reviewRowCrops.set(productReviewRowKey(sourceImageId, row), { status: "failed" }); return; }
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(source ? source.file : persisted!.blob);
      for (const row of rows) {
        const key = productReviewRowKey(sourceImageId, row);
        const rect = productReviewRowCropRect(session.evidence, sourceImageId, row, { width: bitmap.width, height: bitmap.height });
        if (!rect) { reviewRowCrops.set(key, { status: "failed" }); continue; }
        const canvas = document.createElement("canvas");
        canvas.width = rect.width; canvas.height = rect.height;
        const context = canvas.getContext("2d");
        if (!context) { reviewRowCrops.set(key, { status: "failed" }); continue; }
        context.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
        const objectUrl = URL.createObjectURL(await canvasBlob(canvas));
        if (pendingOcrReview !== session) URL.revokeObjectURL(objectUrl);
        else reviewRowCrops.set(key, { status: "ready", objectUrl });
      }
    } catch {
      if (pendingOcrReview === session) for (const row of rows) reviewRowCrops.set(productReviewRowKey(sourceImageId, row), { status: "failed" });
    } finally { bitmap?.close(); }
  }));
  if (pendingOcrReview === session && activeTab === "review") renderReview();
}

async function commitOcrDraft(draft: ReconcileDraftV1, resolution: ReconcileResolutionV1, runContext: ProductOcrRunContextV1, evidence: ProductReviewEvidenceV1): Promise<void> {
  ocrUi.status = "committing"; ocrUi.message = "正在写入工作区。"; ocrUi.error = ""; renderPage();
  try {
    const committed = await workspaceController.commitOcrReconcile({ sessionAccountId: runContext.accountId, draft, resolution, sourceImages: reconcileSourceImagesFromImport(runContext.images), reviewRowRects: reviewRowRectsForEvidence(evidence) });
    applyWorkspaceContext(committed);
    clearPendingReviewUi();
    syncPendingOcrReviewFromWorkspace({ runContext, evidence, persisted: false });
    reviewSaveState = "saved";
    reviewError = "";
    ocrUi = { status: "completed", completed: runContext.images.length, total: runContext.images.length, sourceImageId: null, message: "识别结果已保存到当前工作区，可在下方补充核对。", error: "" };
    activeTab = "review";
    writeStorage("yuanstar.product.tab", activeTab);
    renderPage();
    requestAnimationFrame(() => root.querySelector(".ocr-review")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  } catch (error) {
    if (error instanceof WorkspaceRevisionConflictError) {
      const current = workspaceController.current;
      if (current) applyWorkspaceContext(current);
      clearPendingReviewUi();
      pendingOcrReview = null;
      activeTab = "import";
      ocrUi.status = "failed";
      importNotice("数据已刷新，本次识别结果未写入，请重新识别。", true);
    } else {
      ocrUi.status = "failed";
      importNotice(error instanceof Error ? `识别结果未应用：${error.message}` : "识别结果未应用，当前工作区保持不变。", true);
    }
    renderPage();
  }
}

async function beginOcrRun(): Promise<void> {
  ocrConfirmOpen = false;
  const current = workspaceContext;
  if (!current) { ocrUi.status = "failed"; importNotice("当前工作区尚未加载。", true); renderPage(); return; }
  const runContext: ProductOcrRunContextV1 = {
    jobId: createOcrJobId(),
    accountId: current.account.accountId,
    gameVersion: current.account.gameVersion,
    baseRevision: current.record.revision,
    images: importImages.map((image) => ({ ...image })),
    overlapPairs: overlapRelations.map((pair) => ({ ...pair })),
  };
  ocrUi = { status: "initializing", completed: 0, total: runContext.images.length, sourceImageId: null, message: "正在初始化识别引擎。", error: "" };
  renderPage();
  requestAnimationFrame(() => root.querySelector("#import-progress-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  try {
    const run = await ocrCoordinator.run(runContext, updateOcrProgress);
    if (run.status === "cancelled") {
      ocrUi.status = "cancelled"; ocrUi.sourceImageId = null; importNotice("已取消本次识别，当前工作区未修改。"); renderPage(); return;
    }
    if (run.status === "failed" || !run.result) {
      ocrUi.status = "failed"; ocrUi.sourceImageId = null; importNotice(`识别失败，当前工作区未修改，可直接重试。${run.error?.message ? ` ${run.error.message}` : ""}`, true); renderPage(); return;
    }
    if (run.status === "partial" || run.result.job.status === "partial") {
      ocrUi.status = "failed"; ocrUi.sourceImageId = null; importNotice("本次识别未完整完成，请重试。", true); renderPage(); return;
    }
    ocrUi.status = "reconciling"; ocrUi.message = "正在整理识别结果。"; ocrUi.sourceImageId = null; renderPage();
    const latest = await workspaceController.readLatestCommitted();
    const draft = buildReconcileDraftFromBrowserRuntime(run.result, {
      runAccountId: runContext.accountId,
      runBaseRevision: runContext.baseRevision,
      currentAccountId: latest.account.accountId,
      currentRevision: latest.record.revision,
      activeJobId: runContext.jobId,
      catalog: browserCatalog,
    });
    if (draft.status === "blocked") {
      const stale = draft.blockReasonCodes.some((code) => ["active_task_mismatch", "account_mismatch", "revision_mismatch"].includes(code));
      if (stale) applyWorkspaceContext(await workspaceController.reload());
      ocrUi.status = "failed";
      importNotice(stale ? "数据已刷新，本次识别结果未写入，请重新识别。" : `识别结果无法应用：${draft.blockReasonCodes.join("、")}`, true);
      renderPage();
      return;
    }
    ocrListExpanded = true;
    await commitOcrDraft(draft, automaticReconcileResolution(draft), runContext, buildProductReviewEvidence(run.result));
  } catch (error) {
    ocrUi.status = "failed";
    importNotice(error instanceof Error ? `识别失败，当前工作区未修改，可直接重试。 ${error.message}` : "识别失败，当前工作区未修改，可直接重试。", true);
    renderPage();
  }
}

function closeImageViewer(): void {
  imageViewer?.revocableUrls.forEach((url) => URL.revokeObjectURL(url));
  imageViewer = null;
  renderImageViewer();
}

function renderImageViewer(): void {
  const existing = root.querySelector(".image-lightbox");
  const template = reviewSourcePreviewTemplate();
  if (existing) existing.outerHTML = template;
  else if (template) root.insertAdjacentHTML("beforeend", template);
  bindImageViewerControls();
}

function bindImageViewerControls(): void {
  root.querySelectorAll<HTMLButtonElement>("[data-close-image-viewer]").forEach((button) => button.addEventListener("click", closeImageViewer));
  root.querySelectorAll<HTMLButtonElement>("[data-image-viewer-zoom]").forEach((button) => button.addEventListener("click", () => {
    if (!imageViewer) return;
    imageViewer.zoom = Math.min(250, Math.max(25, imageViewer.zoom + (button.dataset.imageViewerZoom === "in" ? 10 : -10)));
    renderImageViewer();
  }));
  root.querySelector<HTMLElement>("[data-image-viewer-wheel]")?.addEventListener("wheel", (event) => {
    if (!event.ctrlKey || !imageViewer) return;
    event.preventDefault(); imageViewer.zoom = Math.min(250, Math.max(25, imageViewer.zoom + (event.deltaY < 0 ? 10 : -10)));
    renderImageViewer();
  }, { passive: false });
  root.querySelectorAll<HTMLButtonElement>("[data-image-viewer-step]").forEach((button) => button.addEventListener("click", () => {
    if (!imageViewer) return;
    const delta = button.dataset.imageViewerStep === "next" ? 1 : -1;
    imageViewer.index = Math.min(imageViewer.items.length - 1, Math.max(0, imageViewer.index + delta)); imageViewer.zoom = 100;
    renderImageViewer();
  }));
}

function openImageViewer(items: ImageViewerItem[], sourceImageId: string, revocableUrls: string[] = []): void {
  imageViewer?.revocableUrls.forEach((url) => URL.revokeObjectURL(url));
  imageViewer = { items, index: Math.max(0, items.findIndex((item) => item.id === sourceImageId)), zoom: 100, revocableUrls };
}

async function openReviewSourceImage(sourceImageId: string): Promise<void> {
  try {
    if (pendingOcrReview?.runContext) {
      const items = pendingOcrReview.runContext.images.map((image) => ({ id: image.sourceImageId, objectUrl: image.objectUrl, filename: image.filename, detail: `${image.pool}池 · 本次待复核来源` }));
      if (!items.some((item) => item.id === sourceImageId)) throw new Error("当前复核暂无可查看的来源图。");
      openImageViewer(items, sourceImageId);
    } else {
      const sourceIds = Object.entries(workspaceContext?.record.snapshot.importReview.imageAudit ?? {}).sort(([, left], [, right]) => Number((left as { sourceOrder?: number })?.sourceOrder ?? 0) - Number((right as { sourceOrder?: number })?.sourceOrder ?? 0)).map(([id]) => id);
      const persisted = (await Promise.all(sourceIds.map((id) => workspaceController.getCurrentImage(id)))).filter((item): item is NonNullable<typeof item> => item != null);
      const revocable = persisted.map((image) => URL.createObjectURL(image.blob));
      const items = persisted.map((image, index) => ({ id: image.imageId, objectUrl: revocable[index]!, filename: image.filename, detail: "当前工作区已保存来源" }));
      if (!items.some((item) => item.id === sourceImageId)) { revocable.forEach((url) => URL.revokeObjectURL(url)); throw new Error("当前工作区暂无可查看的来源图。"); }
      openImageViewer(items, sourceImageId, revocable);
    }
    reviewError = "";
  } catch (error) { reviewError = error instanceof Error ? error.message : "无法读取来源图。"; }
  renderImageViewer();
}

function setPreviewImage(id: string): void {
  const preview = findImportImage(id);
  if (!preview) return;
  const items = importImages.filter((image) => image.pool === preview.pool).map((image) => ({
    id: image.sourceImageId,
    objectUrl: image.objectUrl,
    filename: image.filename,
    detail: `${image.pool}池`,
  }));
  openImageViewer(items, id);
  renderImageViewer();
}

function bindImportControls(): void {
  const fileInput = root.querySelector<HTMLInputElement>("#image-file-input");
  const dropZone = root.querySelector<HTMLButtonElement>("#file-drop-zone");
  let draggedImageId: string | null = null;
  root.querySelectorAll<HTMLButtonElement>("[data-open-restore]").forEach((button) => button.addEventListener("click", () => { void openRestoreDialog(); }));
  dropZone?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", () => { if (fileInput.files) addImportFiles(fileInput.files); });
  dropZone?.addEventListener("dragover", (event) => { if (isOcrLocked()) return; event.preventDefault(); dropZone.classList.add("is-dragging"); });
  dropZone?.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  dropZone?.addEventListener("drop", (event) => { event.preventDefault(); dropZone.classList.remove("is-dragging"); addImportFiles(event.dataTransfer?.files ?? []); });
  root.querySelectorAll<HTMLElement>("[data-import-image]").forEach((card) => {
    card.addEventListener("pointerdown", () => { const image = findImportImage(card.dataset.importImage ?? ""); if (!isOcrLocked() && image?.classificationStatus !== "classifying") draggedImageId = card.dataset.importImage ?? null; });
    card.addEventListener("dragstart", (event) => {
      const image = findImportImage(card.dataset.importImage ?? "");
      if (isOcrLocked() || image?.classificationStatus === "classifying") { event.preventDefault(); return; }
      draggedImageId = card.dataset.importImage ?? null;
      if (draggedImageId) event.dataTransfer?.setData("text/plain", draggedImageId);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => root.querySelectorAll(".import-pool").forEach((pool) => pool.classList.remove("is-drag-target")));
  });
  root.querySelectorAll<HTMLElement>("[data-import-pool]").forEach((poolElement) => {
    const targetPool = importPoolFrom(poolElement.dataset.importPool);
    if (!targetPool) return;
    poolElement.addEventListener("dragover", (event) => { event.preventDefault(); poolElement.classList.add("is-drag-target"); });
    poolElement.addEventListener("dragleave", (event) => { if (!poolElement.contains(event.relatedTarget as Node | null)) poolElement.classList.remove("is-drag-target"); });
    poolElement.addEventListener("pointerup", () => {
      const image = draggedImageId ? findImportImage(draggedImageId) : null;
      if (image && image.pool !== targetPool) moveImportImage(image.sourceImageId, targetPool);
      draggedImageId = null;
    });
    poolElement.addEventListener("drop", (event) => {
      event.preventDefault();
      poolElement.classList.remove("is-drag-target");
      moveImportImage(event.dataTransfer?.getData("text/plain") || draggedImageId || "", targetPool);
    });
  });
  root.querySelectorAll<HTMLButtonElement>("[data-delete-image]").forEach((button) => button.addEventListener("click", (event) => { event.stopPropagation(); removeImportImage(button.dataset.deleteImage ?? ""); }));
  root.querySelectorAll<HTMLButtonElement>("[data-preview-image]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.previewImage;
    if (id) setPreviewImage(id);
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-confirm-pool]").forEach((button) => button.addEventListener("click", () => {
    const pool = importPoolFrom(button.dataset.confirmPool);
    if (!pool || isOcrLocked()) return;
    if (hasClassifyingImportImages() || ocrCoordinator.classificationPending) { importNotice("正在判断图片类型，请稍候。", true); renderPage(); return; }
    importImages = confirmProductImportPool(importImages, pool);
    importNotice(`${pool}池分类已确认。`);
    renderPage();
  }));
  root.querySelector<HTMLButtonElement>("[data-confirm-all-pools]")?.addEventListener("click", () => {
    if (isOcrLocked()) return;
    if (hasClassifyingImportImages() || ocrCoordinator.classificationPending) { importNotice("正在判断图片类型，请稍候。", true); renderPage(); return; }
    importImages = confirmAllProductImportImages(importImages);
    importNotice("已确认当前所有图片此刻所在的分类池。");
    renderPage();
  });
  root.querySelector<HTMLButtonElement>("[data-clear-import-images]")?.addEventListener("click", clearImportImages);
  root.querySelectorAll<HTMLButtonElement>("[data-add-overlap]").forEach((button) => button.addEventListener("click", () => {
    const pool = button.dataset.addOverlap === "主星" || button.dataset.addOverlap === "辅星" ? button.dataset.addOverlap : null;
    if (!pool) return;
    const before = root.querySelector<HTMLSelectElement>(`[data-overlap-before="${pool}"]`)?.value;
    const after = root.querySelector<HTMLSelectElement>(`[data-overlap-after="${pool}"]`)?.value;
    if (!before || !after) return;
    try { overlapRelations = addProductOverlapPair(importImages, overlapRelations, pool, before, after); importNotice("已添加重叠关系。"); }
    catch (error) { const message = error instanceof Error ? error.message : "无法添加重叠关系。"; importNotice(`！${message}`, true); showToast(message); }
    renderPage();
  }));
  root.querySelectorAll<HTMLButtonElement>("[data-remove-overlap]").forEach((button) => button.addEventListener("click", () => {
    const pairId = button.dataset.removeOverlap;
    if (!pairId || isOcrLocked()) return;
    overlapRelations = overlapRelations.filter((relation) => relation.pairId !== pairId);
    renderPage();
  }));
  root.querySelector<HTMLButtonElement>("[data-start-ocr]")?.addEventListener("click", () => { void requestStartOcr(); });
}

function bindGlobalPaste(): void {
  if (pasteListenerBound) return;
  pasteListenerBound = true;
  document.addEventListener("paste", (event) => {
    if (activeTab !== "import" || isOcrLocked()) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.matches("input, textarea, [contenteditable], [contenteditable] *")) return;
    const files = [...(event.clipboardData?.items ?? [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter((file): file is File => file != null);
    if (!files.length) return;
    event.preventDefault();
    addImportFiles(files);
  });
}

bindGlobalPaste();
renderPage();
void loadExperienceRules();
void loadProductWorkspace();
