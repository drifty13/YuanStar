import { displayText, type DisplayLocale } from "./display-locale.js";
import {
  bagReviewInfo, bagTutorialSteps, recognitionTutorialExamples, recognitionTutorialSteps,
  clampTutorialLift, clipTutorialRect, createBagTutorialGate, markTutorialSeen, resolveTutorialTargets,
  shouldAutoStartTutorial, shouldRevealTutorialTarget, tutorialCardPosition, tutorialElementRect,
  tutorialModeForTab, tutorialSeen, tutorialSheetBounds, tutorialStepIndex, tutorialStorageKey,
  type TutorialMode, type TutorialRect, type TutorialSafeArea, type TutorialStep, type TutorialViewport,
} from "./product-tutorial-steps.js";

export interface TutorialContext {
  tab: "import" | "review"; account: string | null; locale: DisplayLocale; ready: boolean; hasEvidence: boolean;
}
interface TutorialOptions { root: HTMLElement; context: () => TutorialContext }

/** An explanatory DOM layer: its only writes are tutorial UI and tutorial seen keys. */
export class ProductTutorial {
  private overlay: HTMLElement | null = null;
  private card: HTMLElement | null = null;
  private viewer: HTMLElement | null = null;
  private mode: TutorialMode = "recognition";
  private index = 0;
  private owner: string | null = null;
  private locale: DisplayLocale = "zh-Hans";
  private frame = 0;
  private settleFrame = 0;
  private resizeTimer = 0;
  private navigation = 0;
  private lift = 0;
  private hintShown = false;
  private showHint = false;
  private drag: { pointer: number; y: number; lift: number; handle: HTMLElement } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private observed: Element[] = [];
  private highlighted: HTMLElement[] = [];
  private example: TutorialStep["exampleAction"] | null = null;
  private exampleIndex = 0;
  private focusBefore: Element | null = null;
  private viewerFocus: Element | null = null;
  private gate = createBagTutorialGate();
  private eligible = false;
  private gateOwner: string | null = null;

  constructor(private readonly options: TutorialOptions) {}
  get isOpen(): boolean { return this.overlay !== null; }
  private get steps(): readonly TutorialStep[] { return this.mode === "bag" ? bagTutorialSteps : recognitionTutorialSteps; }
  private get step(): TutorialStep { return this.steps[this.index]!; }
  private text(value: string): string {
    return displayText(value, this.locale).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
  }
  observeWorkspace(account: string, provenNew: boolean): void {
    this.gateOwner = account;
    this.eligible = this.gate.loaded(account, !provenNew);
  }
  ocrCompleted(account: string): void { this.gate.ocrCompleted(account); }

  contextChanged(): void {
    const context = this.options.context();
    if (this.isOpen) {
      if (this.owner !== context.account || this.mode !== tutorialModeForTab(context.tab)) { this.close(); return; }
      if (this.locale !== context.locale) {
        this.locale = context.locale;
        this.renderCard();
        if (this.example) this.renderViewer();
      }
      this.schedule();
      return;
    }
    const eligible = this.gateOwner === context.account && this.eligible;
    const recognition = shouldAutoStartTutorial({ ready: context.ready, importing: context.tab === "import", seen: tutorialSeen(tutorialStorageKey(context.account)), hasHistory: eligible ? false : true });
    const bag = context.account !== null && this.gate.shouldStart(context.account, { reviewing: context.tab === "review", ready: context.ready, seen: tutorialSeen(tutorialStorageKey(context.account, "bag")), hasEvidence: context.hasEvidence });
    if (recognition || bag) this.open();
  }

  open(): void {
    this.close(false);
    const context = this.options.context();
    this.mode = tutorialModeForTab(context.tab); this.owner = context.account; this.locale = context.locale;
    this.index = 0; this.lift = 0; this.focusBefore = document.activeElement;
    markTutorialSeen(tutorialStorageKey(this.owner, this.mode));
    this.showHint = window.innerWidth < 768 && !this.hintShown;
    if (this.showHint) this.hintShown = true;
    this.overlay = document.createElement("div");
    this.overlay.className = "product-tutorial";
    this.overlay.innerHTML = '<div class="product-tutorial-spotlight" aria-hidden="true"></div><section class="product-tutorial-card" role="region" tabindex="-1"></section>';
    document.body.append(this.overlay);
    this.card = this.overlay.querySelector<HTMLElement>(".product-tutorial-card");
    this.renderCard();
    this.resizeObserver = new ResizeObserver(this.schedule);
    this.mutationObserver = new MutationObserver(records => {
      // Outline changes made by this layer are irrelevant; real selection changes are not.
      const withoutOutline = (value: string | null) => (value ?? "").split(/\s+/).filter(item => item !== "product-tutorial-related").join(" ");
      if (records.some(record => record.type !== "attributes" || record.attributeName !== "class" || withoutOutline(record.oldValue) !== withoutOutline((record.target as Element).getAttribute("class")))) this.schedule();
    });
    this.mutationObserver.observe(this.options.root, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ["class", "hidden", "aria-selected"] });
    window.addEventListener("resize", this.onResize);
    window.addEventListener("scroll", this.schedule, true);
    window.visualViewport?.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("scroll", this.schedule);
    document.addEventListener("keydown", this.onKey, true);
    this.reveal();
    this.card?.focus({ preventScroll: true });
  }

  close(restoreFocus = true): void {
    this.navigation++;
    cancelAnimationFrame(this.frame); cancelAnimationFrame(this.settleFrame); clearTimeout(this.resizeTimer);
    this.frame = 0; this.settleFrame = 0; this.resizeTimer = 0;
    this.endDrag();
    this.resizeObserver?.disconnect(); this.mutationObserver?.disconnect();
    this.resizeObserver = null; this.mutationObserver = null; this.observed = [];
    this.highlighted.forEach(element => element.classList.remove("product-tutorial-related")); this.highlighted = [];
    window.removeEventListener("resize", this.onResize); window.removeEventListener("scroll", this.schedule, true);
    window.visualViewport?.removeEventListener("resize", this.onResize); window.visualViewport?.removeEventListener("scroll", this.schedule);
    document.removeEventListener("keydown", this.onKey, true);
    this.viewer?.remove(); this.viewer = null; this.example = null;
    this.overlay?.remove(); this.overlay = null; this.card = null;
    if (restoreFocus && this.focusBefore instanceof HTMLElement && this.focusBefore.isConnected) this.focusBefore.focus({ preventScroll: true });
    this.focusBefore = null; this.viewerFocus = null;
  }
  dispose(): void { this.close(false); this.gate.reset(); this.eligible = false; this.gateOwner = null; }

  navigate(delta: number): void {
    if (!this.isOpen) return;
    const next = tutorialStepIndex(this.index, delta, this.steps.length);
    if (next === this.index) return;
    this.closeViewer(); this.endDrag(); this.index = next; this.lift = 0; this.showHint = false;
    this.renderCard(); this.reveal();
  }
  private renderCard(): void {
    if (!this.card) return;
    this.endDrag();
    const step = this.step, label = this.mode === "bag" ? "使用教程" : "识别教程";
    this.card.setAttribute("aria-label", displayText(label, this.locale));
    this.card.dataset.mode = this.mode; this.card.dataset.step = step.id;
    this.card.innerHTML = `<div class="product-tutorial-handle-row"><button class="product-tutorial-handle" type="button" aria-label="${this.text(`拖动${label}，上下方向键也可移动`)}"><span></span></button></div><header><div aria-live="polite"><span class="product-tutorial-count">${this.index + 1} / ${this.steps.length}</span><h2>${this.text(step.title)}</h2></div><button class="product-tutorial-close" type="button" data-tour-close aria-label="${this.text(`关闭${label}`)}">×</button></header><div class="product-tutorial-details">${(step.paragraphs ?? [step.body ?? ""]).map(paragraph => `<p class="product-tutorial-body">${this.text(paragraph)}</p>`).join("")}${step.exampleAction ? `<button class="product-tutorial-example" type="button" data-tour-example>${this.text(step.exampleLabel ?? "")}</button>` : ""}${this.showHint ? `<p class="product-tutorial-hint">${this.text("本教程卡片可拖动，不挡住操作即可")}</p>` : ""}</div><footer><button data-tour-prev type="button" ${this.index === 0 ? "disabled" : ""}>${this.text("上一步")}</button><button data-tour-next class="product-tutorial-next" type="button">${this.text(this.index === this.steps.length - 1 ? "完成" : "下一步")}</button></footer>`;
    this.card.querySelector("[data-tour-close]")?.addEventListener("click", () => this.close());
    this.card.querySelector("[data-tour-prev]")?.addEventListener("click", () => { this.navigate(-1); this.card?.querySelector<HTMLElement>("[data-tour-prev]")?.focus({ preventScroll: true }); });
    this.card.querySelector("[data-tour-next]")?.addEventListener("click", () => { if (this.index === this.steps.length - 1) this.close(); else { this.navigate(1); this.card?.querySelector<HTMLElement>("[data-tour-next]")?.focus({ preventScroll: true }); } });
    this.card.querySelector("[data-tour-example]")?.addEventListener("click", () => { this.example = step.exampleAction; this.exampleIndex = 0; this.viewerFocus = document.activeElement; this.renderViewer(); });
    const handle = this.card.querySelector<HTMLElement>(".product-tutorial-handle")!;
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault(); this.drag = { pointer: event.pointerId, y: event.clientY, lift: this.lift, handle };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => { if (this.drag?.pointer === event.pointerId) { this.lift = this.drag.lift + this.drag.y - event.clientY; this.update(); } });
    handle.addEventListener("pointerup", () => this.endDrag()); handle.addEventListener("pointercancel", () => this.endDrag());
    handle.addEventListener("lostpointercapture", () => { this.drag = null; });
    handle.addEventListener("keydown", event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); this.lift += event.key === "ArrowUp" ? 32 : -32; this.update(); } });
  }
  private endDrag(): void {
    const drag = this.drag; this.drag = null;
    if (drag?.handle.hasPointerCapture?.(drag.pointer)) drag.handle.releasePointerCapture(drag.pointer);
  }
  private viewport(): TutorialViewport {
    const view = window.visualViewport;
    return { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: Math.min(view?.width ?? window.innerWidth, document.documentElement.clientWidth), height: view?.height ?? window.innerHeight };
  }
  private safeArea(): TutorialSafeArea {
    const style = getComputedStyle(this.card!);
    return { top: parseFloat(style.getPropertyValue("--tutorial-safe-top")) || 0, bottom: parseFloat(style.getPropertyValue("--tutorial-safe-bottom")) || 0 };
  }
  private schedule = (): void => {
    if (!this.isOpen || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  };
  private update(): void {
    if (!this.overlay || !this.card) return;
    const view = this.viewport(), mobile = window.innerWidth < 768;
    this.overlay.classList.toggle("is-mobile", mobile);
    const { primary, related } = resolveTutorialTargets(this.options.root, this.step, view);
    this.highlighted.filter(element => !related.includes(element)).forEach(element => element.classList.remove("product-tutorial-related"));
    related.forEach(element => { if (!element.classList.contains("product-tutorial-related")) element.classList.add("product-tutorial-related"); }); this.highlighted = related;
    const observed: Element[] = [this.options.root, this.card, ...(primary ? [primary] : []), ...related];
    this.observed.filter(element => !observed.includes(element)).forEach(element => this.resizeObserver?.unobserve(element));
    observed.filter(element => !this.observed.includes(element)).forEach(element => this.resizeObserver?.observe(element)); this.observed = observed;
    const rects = [...new Set([primary, ...related])].map(element => tutorialElementRect(element, view)).filter((rect): rect is TutorialRect => rect !== null);
    const spotlight = this.overlay.querySelector<HTMLElement>(".product-tutorial-spotlight")!;
    spotlight.innerHTML = `<svg aria-hidden="true" width="100%" height="100%"><defs><mask id="product-tutorial-mask" maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="white"/>${rects.map(rect => `<rect x="${rect.left}" y="${rect.top}" width="${rect.width}" height="${rect.height}" rx="12" fill="black"/>`).join("")}</mask></defs><rect width="100%" height="100%" fill="rgb(73 59 44 / 48%)" mask="url(#product-tutorial-mask)"/></svg>${rects.map(rect => `<div class="product-tutorial-ring" style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px"></div>`).join("")}`;
    const raw = primary?.getBoundingClientRect() ?? null;
    if (mobile) {
      // A short section at the document end cannot scroll above the sheet. Reserve it just like the bottom tools.
      const avoid = this.step.mobileAvoidTarget || (raw && raw.top > view.top + view.height * .5 && raw.height < view.height * .4);
      const safe = this.safeArea(), bounds = tutorialSheetBounds(view, window.innerHeight, safe, avoid ? clipTutorialRect(raw, view, 0) : null);
      this.card.style.left = `${view.left + 12}px`; this.card.style.width = `${Math.max(0, view.width - 24)}px`; this.card.style.top = "auto";
      this.card.style.maxHeight = `min(62dvh, ${bounds.maxHeight}px)`;
      const extraInset = bounds.bottom - (window.innerHeight - view.top - view.height + 12);
      this.lift = clampTutorialLift(this.lift, view.height, this.card.getBoundingClientRect().height, { top: safe.top, bottom: extraInset });
      this.card.style.bottom = `${bounds.bottom + this.lift}px`; this.card.dataset.placement = "sheet";
    } else {
      this.lift = 0;
      this.card.style.width = `${Math.min(340, Math.max(0, view.width - 24))}px`; this.card.style.bottom = "auto"; this.card.style.maxHeight = `${Math.max(0, view.height - 24)}px`;
      const position = tutorialCardPosition(clipTutorialRect(raw, view, 0), this.card.getBoundingClientRect(), view, related.map(element => tutorialElementRect(element, view)).filter((rect): rect is TutorialRect => rect !== null));
      this.card.style.left = `${position.left}px`; this.card.style.top = `${position.top}px`; this.card.dataset.placement = position.placement;
    }
    if (this.viewer) {
      this.viewer.style.left = `${view.left}px`; this.viewer.style.top = `${view.top}px`;
      this.viewer.style.width = `${view.width}px`; this.viewer.style.height = `${view.height}px`;
    }
  }
  private reveal(): void {
    cancelAnimationFrame(this.settleFrame);
    const token = ++this.navigation, view = this.viewport();
    const { primary } = resolveTutorialTargets(this.options.root, this.step, view);
    const rect = primary?.getBoundingClientRect() ?? null;
    if (shouldRevealTutorialTarget(this.step, rect)) window.scrollTo({ top: Math.max(0, window.scrollY + rect!.top - view.top - Math.max(64, view.height * (window.innerWidth < 768 ? .16 : .1))), behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    let count = 0, stable = 0, last = window.scrollY;
    const settle = () => {
      if (token !== this.navigation || !this.isOpen) return;
      stable = Math.abs(window.scrollY - last) < .5 ? stable + 1 : 0; last = window.scrollY;
      this.update();
      if (++count < 90 && (count < 6 || stable < 4)) this.settleFrame = requestAnimationFrame(settle); else this.settleFrame = 0;
    };
    this.update(); this.settleFrame = requestAnimationFrame(settle);
  }
  private onResize = (): void => {
    this.schedule(); clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      this.resizeTimer = 0;
      if (!this.isOpen || this.example || this.step.scroll === "preserve") return;
      const view = this.viewport(), { primary } = resolveTutorialTargets(this.options.root, this.step, view), rect = primary?.getBoundingClientRect();
      if (rect && (rect.top < view.top + 64 || rect.top > (this.card?.getBoundingClientRect().top ?? view.top + view.height) - 16)) this.reveal();
    }, 160);
  };
  private onKey = (event: KeyboardEvent): void => {
    if (this.example) {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.closeViewer(); }
      else if (event.key === "Tab") {
        const buttons = Array.from(this.viewer?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
        const first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    } else if (event.key === "Escape" && !this.options.root.querySelector('[role="dialog"], dialog[open]')) { event.preventDefault(); event.stopImmediatePropagation(); this.close(); }
  };
  private renderViewer(): void {
    if (!this.overlay || !this.card || !this.example) return;
    if (!this.viewer) {
      this.viewer = document.createElement("div"); this.viewer.className = "product-tutorial-viewer";
      this.overlay.append(this.viewer);
      this.viewer.addEventListener("click", event => { if (event.target === this.viewer) this.closeViewer(); });
    }
    this.card.inert = true;
    const info = this.example === "review-info" ? bagReviewInfo : null;
    const items = this.example === "review-info" ? [] : recognitionTutorialExamples[this.example];
    const item = items[this.exampleIndex];
    this.viewer.innerHTML = `<section class="product-tutorial-example-panel${info ? " is-info" : ""}" role="dialog" aria-modal="true" aria-labelledby="product-tutorial-example-title"><header><h2 id="product-tutorial-example-title">${this.text(info?.title ?? item?.title ?? "")}</h2><button data-example-close type="button" aria-label="${this.text("关闭示例")}">×</button></header>${info ? `<div class="product-tutorial-info"><p>${this.text(info.intro)}</p>${info.sections.map(section => `<section><h3>${this.text(section.title)}</h3><p>${this.text(section.body)}</p></section>`).join("")}</div>` : `<div class="product-tutorial-example-image"><img src="${item?.src}" alt="${this.text(item?.title ?? "")}"/></div>${item?.caption ? `<p class="product-tutorial-caption">${this.text(item.caption)}</p>` : ""}${items.length > 1 ? `<footer><button data-example-prev type="button" ${this.exampleIndex === 0 ? "disabled" : ""}>${this.text("上一张")}</button><span>${this.exampleIndex + 1} / ${items.length}</span><button data-example-next type="button" ${this.exampleIndex === items.length - 1 ? "disabled" : ""}>${this.text("下一张")}</button></footer>` : ""}`}</section>`;
    this.viewer.querySelector("[data-example-close]")?.addEventListener("click", () => this.closeViewer());
    this.viewer.querySelector("[data-example-prev]")?.addEventListener("click", () => { this.exampleIndex = Math.max(0, this.exampleIndex - 1); this.renderViewer(); });
    this.viewer.querySelector("[data-example-next]")?.addEventListener("click", () => { this.exampleIndex = Math.min(items.length - 1, this.exampleIndex + 1); this.renderViewer(); });
    this.viewer.querySelector("img")?.addEventListener("error", event => { const img = event.currentTarget as HTMLElement; const fallback = document.createElement("p"); fallback.textContent = displayText("示例图待补充", this.locale); img.replaceWith(fallback); });
    this.update(); this.viewer.querySelector<HTMLElement>("[data-example-close]")?.focus({ preventScroll: true });
  }
  private closeViewer(): void {
    this.viewer?.remove(); this.viewer = null; this.example = null;
    if (this.card) this.card.inert = false;
    if (this.viewerFocus instanceof HTMLElement && this.viewerFocus.isConnected) this.viewerFocus.focus({ preventScroll: true });
    else this.card?.querySelector<HTMLElement>("[data-tour-example]")?.focus({ preventScroll: true });
    this.viewerFocus = null;
  }
}
