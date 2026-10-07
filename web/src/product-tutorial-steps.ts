export type TutorialMode = "recognition" | "bag";
export interface TutorialStep {
  id: string; title: string; target: string; body?: string; paragraphs?: string[];
  relatedTargets?: string; exampleAction?: "screenshots" | "overlap" | "review-info"; exampleLabel?: string;
  scroll?: "preserve"; mobileAvoidTarget?: boolean;
}

// Adapted from the frozen tutorial feature, with standalone wording and targets.
export const recognitionTutorialSteps: readonly TutorialStep[] = [
  { id: "upload", title: "导入截图", body: "手动上传星石背包的原始截图。\n不要裁剪、拼接或涂改，并保留完整上下界面。", target: ".file-picker-panel", exampleAction: "screenshots", exampleLabel: "查看截图示例" },
  { id: "classify", title: "检查分类", body: "系统会推荐主星、辅星、经验星曜分类。\n如果分错了，电脑端可拖到正确的池里，手机端可长按移动。", target: ".import-pools" },
  { id: "confirm", title: "确认分类", body: "可以逐池点击「确认本池」，也可以使用下方的「一键确认全部分类」。", target: "[data-confirm-pool]", relatedTargets: "[data-confirm-pool], [data-confirm-all-pools]" },
  { id: "overlap", title: "重复行标记", body: "主星或辅星的多张截图有同一整行星石时，补充前图、后图的重叠关系。\n没有重复就直接跳过，经验星曜不需要标记。", target: ".overlap-grid", exampleAction: "overlap", exampleLabel: "查看重叠示例" },
  { id: "start", title: "开始识别", body: "完成前面的检查后，点击「开始识别」。", target: "[data-start-ocr]" },
  { id: "progress", title: "查看识别进度", body: "这里会显示初始化、当前图片、识别进度，以及完成或错误信息。第一次加载识别模型可能较慢。\n完成后会进入背包整理，再核对识别结果。", target: "#import-progress-panel" },
];

export const bagTutorialSteps: readonly TutorialStep[] = [
  { id: "review", title: "检查识别结果", body: "识别完成后，可以在这里回看识别结果。\n发现名称、等级或其他内容不对时，可以查看原图并修正。", target: ".ocr-review", exampleAction: "review-info", exampleLabel: "查看核对说明" },
  { id: "bags", title: "认识两个背包", body: "当前背包是现在拥有的星石，计划背包是对应的养成计划。\n点击任一背包，都会选中同一颗星石的对应内容。", target: ".inventory-grid" },
  { id: "find", title: "找到想看的星石", body: "可以按大类、品质和名称筛选，也可以切换逐颗明细 / 名称汇总和排序方式。\n在视图「名称汇总」里，双击某组星石的名称，可以展开查看这一组的详情。", target: ".review-toolbar" },
  { id: "edit", title: "编辑或新增星石", paragraphs: ["选中一行后，下方会载入它。\n直接修改名称、等级或品质，会编辑当前这颗星石。", "要新增时，先在编辑区填好内容，再点「新增当前行」，原来的星石会保留。\n如果不改内容直接新增，相当于复制当前行。\n删除则使用「删除当前行」。"], target: ".current-editor", relatedTargets: "#current-rows .is-selected, #current-rows .is-counterpart" },
  { id: "plan", title: "设置养成目标", body: "选中一颗星石后，可以在这里设置计划等级。\n计划等级高于当前等级时，这颗星石就是待养成。开启「仅看待养成」，可以只看还没有达到计划等级的星石。", target: ".plan-editor", relatedTargets: ".pending-only-toggle" },
  { id: "experience", title: "看看还需要多少经验星曜", body: "经验星曜库存区域记录当前持有数量。\n需求区域会显示当前选中星石、当前有效计划范围的需求，以及扣除库存后还缺多少。", target: ".experience-section" },
  { id: "history", title: "撤回、重做和近期存档", body: "箭头可以撤回 / 重做最近操作，电脑端也可以使用 Ctrl + Z / Ctrl + Y。\n时钟里可以查看最近 3 个恢复点。", target: ".review-workspace-tools", scroll: "preserve", mobileAvoidTarget: true },
];

export interface TutorialExample { title: string; src: string; caption?: string }
export const recognitionTutorialExamples: Record<"screenshots" | "overlap", readonly TutorialExample[]> = {
  screenshots: [
    { title: "主星截图示例", src: "/tutorial/star/recognition-main-example.jpg" },
    { title: "辅星截图示例", src: "/tutorial/star/recognition-support-example.jpg" },
    { title: "经验星曜截图示例", src: "/tutorial/star/recognition-exp-example.jpg" },
  ],
  overlap: [{ title: "重叠示例", src: "/tutorial/star/recognition-overlap-example.jpg", caption: "紫色框部分是两张截图中重复出现的同一整行。选择前一张和后一张后，添加关系即可。" }],
};
export const bagReviewInfo = {
  title: "怎么看识别结果",
  intro: "每张截图都会保留对应的识别结果。\n一般只需要处理看起来有问题的内容，不用把所有结果重新确认一遍。",
  sections: [
    { title: "查看整页", body: "点击「整页」查看完整原始截图，确认这条结果在截图里的位置和上下文。" },
    { title: "查看全部候选", body: "展开当前图片识别出的全部候选，方便检查漏识或误识。" },
    { title: "保留", body: "将当前候选保留为有效结果。\n正常识别并已经保留的结果，一般不需要再点这个按钮。\n如果有星石被误归到「忽略」，可以用「保留」恢复。" },
    { title: "忽略", body: "这条内容不需要进入背包时，可以忽略。" },
    { title: "修改", body: "名称、等级、品质等识别有误时，可以手动修改。\n编辑时可点「取消」退出，或点「确认」保存。确认修改后会立即写回当前背包。" },
  ],
};

export function tutorialModeForTab(tab: "import" | "review"): TutorialMode { return tab === "import" ? "recognition" : "bag"; }
export function tutorialEntryLabel(tab: "import" | "review"): string { return tab === "import" ? "查看导入识别教程" : "查看背包整理教程"; }
export function tutorialStepIndex(index: number, delta: number, length = 6): number { return Math.max(0, Math.min(length - 1, index + delta)); }

type TutorialStorage = Pick<Storage, "getItem" | "setItem"> | null;
const sessionSeen = new Set<string>();
function safeStorage(): TutorialStorage { try { return globalThis.localStorage; } catch { return null; } }
export function tutorialStorageKey(account: string | null | undefined, mode: TutorialMode = "recognition"): string {
  return `yuanstar:tutorial:${mode}:v1:${account == null || account === "" ? "guest" : encodeURIComponent(account)}`;
}
export function tutorialSeen(key: string, storage: TutorialStorage = safeStorage()): boolean {
  try { return sessionSeen.has(key) || storage?.getItem(key) === "seen"; } catch { return sessionSeen.has(key); }
}
export function markTutorialSeen(key: string, storage: TutorialStorage = safeStorage()): void {
  sessionSeen.add(key);
  try { storage?.setItem(key, "seen"); } catch { /* A blocked storage never blocks the tutorial. */ }
}
export function shouldAutoStartTutorial(input: { ready: boolean; importing: boolean; seen: boolean; hasHistory: boolean | undefined }): boolean {
  return input.ready && input.importing && !input.seen && input.hasHistory === false;
}

// Eligibility is observed once, before OCR writes new history. Unknown is historical.
export function createBagTutorialGate() {
  let owner = "", eligible = false, observed = false, completed = false;
  return {
    loaded(key: string, hasHistory: boolean | undefined): boolean {
      if (key !== owner) { owner = key; eligible = false; observed = false; completed = false; }
      if (!observed) { eligible = hasHistory === false; observed = true; }
      return eligible;
    },
    ocrCompleted(key: string): void { if (owner === key && eligible) completed = true; },
    shouldStart(key: string, input: { reviewing: boolean; ready: boolean; seen: boolean; hasEvidence: boolean }): boolean {
      return owner === key && eligible && completed && input.reviewing && input.ready && !input.seen && input.hasEvidence;
    },
    reset(): void { owner = ""; eligible = false; observed = false; completed = false; },
  };
}

export interface TutorialViewport { left: number; top: number; width: number; height: number }
export interface TutorialRect { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface TutorialSafeArea { top?: number; bottom?: number }
export function resolveTutorialTargets(root: ParentNode, step: TutorialStep, viewport: TutorialViewport) {
  const targets = Array.from(root.querySelectorAll<HTMLElement>(step.target)).filter(element => element.getBoundingClientRect().width > 0);
  const primary = targets.find(element => { const rect = element.getBoundingClientRect(); return rect.top >= viewport.top && rect.bottom < viewport.top + viewport.height * .65; }) ?? targets[0] ?? null;
  return { primary, related: step.relatedTargets ? Array.from(root.querySelectorAll<HTMLElement>(step.relatedTargets)) : [] };
}
export function shouldRevealTutorialTarget(step: TutorialStep, rect: TutorialRect | null): boolean { return !!rect && step.scroll !== "preserve"; }
export function tutorialSheetBounds(view: TutorialViewport, windowHeight: number, safe: TutorialSafeArea, avoid: TutorialRect | null = null) {
  const inset = Math.max(12 + (safe.bottom ?? 0), avoid ? view.top + view.height - avoid.top + 12 : 0);
  return { bottom: windowHeight - view.top - view.height + inset, maxHeight: Math.max(0, view.height - inset - 12 - (safe.top ?? 0)) };
}
export function clipTutorialRect(rect: TutorialRect | null | undefined, view: TutorialViewport, padding = 8): TutorialRect | null {
  if (!rect || rect.width <= 0 || rect.height <= 0 || rect.right <= view.left || rect.left >= view.left + view.width || rect.bottom <= view.top || rect.top >= view.top + view.height) return null;
  const left = Math.max(view.left, rect.left - padding), top = Math.max(view.top, rect.top - padding);
  const right = Math.min(view.left + view.width, rect.right + padding), bottom = Math.min(view.top + view.height, rect.bottom + padding);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}
export function tutorialElementRect(element: HTMLElement | null, view: TutorialViewport): TutorialRect | null {
  const rect = clipTutorialRect(element?.getBoundingClientRect(), view);
  const container = element?.closest(".table-scroll");
  if (!rect || !container) return rect;
  const bounds = container.getBoundingClientRect();
  const top = Math.max(rect.top, bounds.top), bottom = Math.min(rect.bottom, bounds.bottom), left = Math.max(rect.left, bounds.left), right = Math.min(rect.right, bounds.right);
  return bottom > top && right > left ? { left, top, right, bottom, width: right - left, height: bottom - top } : null;
}
export function tutorialCardPosition(target: TutorialRect | null, size: { width: number; height: number }, view: TutorialViewport, related: TutorialRect[] = []) {
  const margin = 12, gap = 16, left = view.left + margin, top = view.top + margin, right = view.left + view.width - margin, bottom = view.top + view.height - margin;
  const width = Math.min(size.width, Math.max(0, view.width - margin * 2)), height = Math.min(size.height, Math.max(0, view.height - margin * 2));
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
  let x = right - width, y = bottom - height, placement = "fallback";
  if (target) {
    if (target.right + gap + width <= right) { x = target.right + gap; y = target.top; placement = "right"; }
    else if (target.left - gap - width >= left) { x = target.left - gap - width; y = target.top; placement = "left"; }
    else if (target.bottom + gap + height <= bottom) { x = target.left; y = target.bottom + gap; placement = "bottom"; }
    else if (target.top - gap - height >= top) { x = target.left; y = target.top - gap - height; placement = "top"; }
  }
  x = clamp(x, left, right - width); y = clamp(y, top, bottom - height);
  const overlaps = (candidate: number) => related.some(rect => x < rect.right && x + width > rect.left && candidate < rect.bottom && candidate + height > rect.top);
  if (overlaps(y)) y = related.flatMap(rect => [rect.bottom + gap, rect.top - gap - height]).filter(candidate => candidate >= top && candidate + height <= bottom && !overlaps(candidate)).sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0] ?? y;
  return { left: x, top: y, placement };
}
export function clampTutorialLift(lift: number, viewportHeight: number, cardHeight: number, safe: TutorialSafeArea = {}): number {
  return Math.max(0, Math.min(lift, 140, Math.max(0, viewportHeight - cardHeight - 24 - (safe.top ?? 0) - (safe.bottom ?? 0))));
}
