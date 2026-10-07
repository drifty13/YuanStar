export interface SelectViewport { left: number; top: number; width: number; height: number }
export interface SelectBounds { left: number; top: number; bottom: number; width: number }
export function customSelectPosition(trigger: SelectBounds, view: SelectViewport, desiredWidth: number, desiredHeight: number) {
  const margin = 8, gap = 4;
  const width = Math.min(Math.max(trigger.width, desiredWidth), Math.max(0, view.width - margin * 2));
  const below = Math.max(0, view.top + view.height - trigger.bottom - gap - margin);
  const above = Math.max(0, trigger.top - view.top - gap - margin);
  const upward = below < Math.min(280, desiredHeight) && above > below;
  const height = Math.min(280, desiredHeight, upward ? above : below, Math.max(0, view.height - margin * 2));
  const left = Math.max(view.left + margin, Math.min(trigger.left, view.left + view.width - margin - width));
  const top = Math.max(view.top + margin, Math.min(upward ? trigger.top - gap - height : trigger.bottom + gap, view.top + view.height - margin - height));
  return { left, top, width, height, placement: upward ? "top" : "bottom" };
}

export function nextSelectOption(enabled: readonly boolean[], current: number, key: string): number {
  const indexes = enabled.flatMap((value, index) => value ? [index] : []);
  if (!indexes.length) return -1;
  if (key === "Home") return indexes[0]!;
  if (key === "End") return indexes.at(-1)!;
  if (key === "ArrowUp") return [...indexes].reverse().find(index => index < current) ?? indexes[0]!;
  return indexes.find(index => index > current) ?? indexes.at(-1)!;
}

interface EnhancedSelect {
  select: HTMLSelectElement; wrapper: HTMLDivElement; trigger: HTMLButtonElement; caption: HTMLSpanElement;
  observer: MutationObserver; cleanup: () => void;
}
interface OpenSelect { state: EnhancedSelect; panel: HTMLDivElement; active: number; observer: MutationObserver }

/** Presentation adapter. Native value/options/events remain the business interface. */
export class ProductCustomSelects {
  private states = new Map<HTMLSelectElement, EnhancedSelect>();
  private opened: OpenSelect | null = null;
  private serial = 0;
  private readonly idPrefix = `product-select-${++selectAdapterSerial}`;
  constructor(private readonly root: HTMLElement) {}

  // Options without an explicit value derive it from their text. Pin it BEFORE display conversion.
  prepare(): void { this.root.querySelectorAll<HTMLSelectElement>("select").forEach(select => this.prepareSelect(select)); }
  private prepareSelect(select: HTMLSelectElement): void {
    Array.from(select.options).forEach(option => { if (!option.hasAttribute("value")) option.value = option.value; });
  }
  enhance(): void {
    for (const [select, state] of this.states) if (!this.root.contains(select)) this.remove(state);
    this.root.querySelectorAll<HTMLSelectElement>("select").forEach(select => {
      if (!this.states.has(select)) this.add(select);
      this.refresh(select);
    });
  }
  refresh(select: HTMLSelectElement): void {
    const state = this.states.get(select);
    if (!state) return;
    if (!this.root.contains(select)) { this.remove(state); return; }
    this.prepareSelect(select);
    const selected = select.selectedOptions[0];
    const caption = selected?.label ?? select.getAttribute("placeholder") ?? "";
    if (state.caption.textContent !== caption) state.caption.textContent = caption;
    if (state.trigger.title !== caption) state.trigger.title = caption;
    const label = this.accessibleName(select, state.wrapper);
    if (state.trigger.getAttribute("aria-label") !== label) state.trigger.setAttribute("aria-label", label);
    state.trigger.disabled = select.matches(":disabled");
    state.trigger.setAttribute("aria-disabled", String(state.trigger.disabled));
    if (this.opened?.state === state) {
      if (state.trigger.disabled) this.close();
      else { this.renderOptions(); this.position(); }
    }
  }
  close(restoreFocus = false): void {
    const opened = this.opened;
    if (!opened) return;
    this.opened = null;
    opened.observer.disconnect(); opened.panel.remove();
    opened.state.wrapper.classList.remove("is-open");
    opened.state.trigger.setAttribute("aria-expanded", "false");
    opened.state.trigger.removeAttribute("aria-activedescendant");
    document.removeEventListener("pointerdown", this.outside, true);
    document.removeEventListener("click", this.outside, true);
    window.removeEventListener("keydown", this.openKey, true);
    window.removeEventListener("scroll", this.externalScroll, true);
    window.removeEventListener("resize", this.closeOnViewport);
    window.visualViewport?.removeEventListener("resize", this.closeOnViewport);
    window.visualViewport?.removeEventListener("scroll", this.closeOnViewport);
    if (restoreFocus && opened.state.trigger.isConnected) opened.state.trigger.focus({ preventScroll: true });
  }
  disposeAll(): void { this.close(); for (const state of [...this.states.values()]) this.remove(state); }
  private accessibleName(select: HTMLSelectElement, wrapper: HTMLElement): string {
    const explicit = select.getAttribute("aria-label");
    if (explicit) return explicit;
    const labelledBy = select.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (text) return text;
    }
    const triggerId = wrapper.querySelector("button")?.id;
    const label = wrapper.closest("label") ?? Array.from(document.querySelectorAll<HTMLLabelElement>("label")).find(item => item.htmlFor === triggerId || (!!select.id && item.htmlFor === select.id));
    if (label) {
      const clone = label.cloneNode(true) as HTMLElement;
      clone.querySelectorAll("select, .product-custom-select").forEach(element => element.remove());
      if (clone.textContent?.trim()) return clone.textContent.trim();
    }
    return wrapper.closest("dd")?.parentElement?.querySelector("dt")?.textContent?.trim() || select.title || select.name || select.id || "选择选项";
  }
  private add(select: HTMLSelectElement): void {
    const wrapper = document.createElement("div"), trigger = document.createElement("button"), caption = document.createElement("span");
    wrapper.className = "product-custom-select";
    trigger.type = "button"; trigger.className = "product-custom-select-trigger"; trigger.id = `${this.idPrefix}-${++this.serial}`;
    trigger.setAttribute("role", "combobox"); trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${trigger.id}-list`);
    // This text is copied from already-converted backing options, not translated twice or cached by the locale adapter.
    trigger.setAttribute("data-display-locale-ignore", "");
    caption.className = "product-custom-select-caption"; trigger.append(caption);
    const labels = Array.from(select.labels ?? []).map(label => ({ label, original: label.getAttribute("for") }));
    const tabIndex = select.getAttribute("tabindex"), ariaHidden = select.getAttribute("aria-hidden");
    select.before(wrapper); wrapper.append(select, trigger);
    select.classList.add("product-custom-select-native"); select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
    labels.forEach(({ label }) => { label.htmlFor = trigger.id; });
    const onClick = () => { if (this.opened?.state.select === select) this.close(); else this.open(select); };
    const onKey = (event: KeyboardEvent) => {
      if (!this.opened && ["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); this.open(select, event.key);
      }
    };
    const onChange = () => this.refresh(select);
    // Preserve existing native blur subscribers (notably account metadata); editor focusout still occurs on the real trigger.
    const onBlur = (event: FocusEvent) => select.dispatchEvent(new FocusEvent("blur", { relatedTarget: event.relatedTarget }));
    const onFocus = () => trigger.focus({ preventScroll: true });
    trigger.addEventListener("click", onClick); trigger.addEventListener("keydown", onKey); trigger.addEventListener("blur", onBlur);
    select.addEventListener("change", onChange); select.addEventListener("focus", onFocus);
    const observer = new MutationObserver(() => this.refresh(select));
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "selected", "value", "label", "aria-label", "title", "placeholder"] });
    const cleanup = () => {
      trigger.removeEventListener("click", onClick); trigger.removeEventListener("keydown", onKey); trigger.removeEventListener("blur", onBlur);
      select.removeEventListener("change", onChange); select.removeEventListener("focus", onFocus); observer.disconnect();
      labels.forEach(({ label, original }) => { if (label.htmlFor === trigger.id) { if (original === null) label.removeAttribute("for"); else label.setAttribute("for", original); } });
      if (tabIndex === null) select.removeAttribute("tabindex"); else select.setAttribute("tabindex", tabIndex);
      if (ariaHidden === null) select.removeAttribute("aria-hidden"); else select.setAttribute("aria-hidden", ariaHidden);
      select.classList.remove("product-custom-select-native"); wrapper.replaceWith(select);
    };
    this.states.set(select, { select, wrapper, trigger, caption, observer, cleanup });
  }
  private remove(state: EnhancedSelect): void {
    if (this.opened?.state === state) this.close();
    this.states.delete(state.select); state.cleanup();
  }
  private enabled(select: HTMLSelectElement): boolean[] {
    return Array.from(select.options).map(option => !option.disabled && !option.closest("optgroup")?.disabled && !option.hidden);
  }
  private open(select: HTMLSelectElement, openingKey?: string): void {
    this.close(); this.refresh(select);
    const state = this.states.get(select);
    if (!state || state.trigger.disabled || !state.trigger.isConnected || this.hasModal()) return;
    const panel = document.createElement("div"); panel.className = "product-custom-select-list"; panel.id = `${state.trigger.id}-list`;
    panel.setAttribute("role", "listbox"); panel.setAttribute("aria-label", state.trigger.getAttribute("aria-label") ?? "");
    const enabled = this.enabled(select);
    const active = enabled[select.selectedIndex] ? select.selectedIndex : nextSelectOption(enabled, -1, openingKey === "ArrowUp" ? "End" : "Home");
    const observer = new MutationObserver(() => {
      if (!this.root.contains(select) || this.hasModal()) this.close();
    });
    this.opened = { state, panel, active, observer };
    panel.addEventListener("mousedown", event => event.preventDefault());
    // Keep editor focus inside its real panel while operating a body portal.
    panel.addEventListener("click", event => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-select-option]") : null;
      if (target) this.choose(Number(target.dataset.selectOption));
    });
    panel.addEventListener("pointermove", event => {
      if (event.pointerType !== "mouse") return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-select-option]") : null;
      const index = Number(target?.dataset.selectOption);
      if (target && this.enabled(select)[index]) this.activate(index, false);
    });
    document.body.append(panel); state.wrapper.classList.add("is-open"); state.trigger.setAttribute("aria-expanded", "true");
    state.trigger.focus({ preventScroll: true }); this.renderOptions(); this.position(); this.scrollActive();
    observer.observe(this.root, { childList: true, subtree: true });
    document.addEventListener("pointerdown", this.outside, true); document.addEventListener("click", this.outside, true);
    window.addEventListener("keydown", this.openKey, true); window.addEventListener("scroll", this.externalScroll, true); window.addEventListener("resize", this.closeOnViewport);
    window.visualViewport?.addEventListener("resize", this.closeOnViewport); window.visualViewport?.addEventListener("scroll", this.closeOnViewport);
  }
  private hasModal(): boolean { return !!this.root.querySelector('[role="dialog"], dialog[open], .image-lightbox'); }
  private choose(index: number): void {
    const opened = this.opened;
    if (!opened || opened.state.select.matches(":disabled") || !this.enabled(opened.state.select)[index]) return;
    const { select, trigger } = opened.state, option = select.options[index];
    if (!option) return;
    const changed = select.selectedIndex !== index;
    this.close(); trigger.focus({ preventScroll: true }); select.selectedIndex = index;
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    this.refresh(select);
  }
  private renderOptions(): void {
    const opened = this.opened;
    if (!opened) return;
    const { select, trigger } = opened.state, enabled = this.enabled(select);
    if (!enabled[opened.active]) opened.active = nextSelectOption(enabled, -1, "Home");
    opened.panel.replaceChildren(...Array.from(select.options).map((option, index) => {
      const item = document.createElement("div"); item.className = "product-custom-select-option";
      item.id = `${trigger.id}-option-${index}`; item.dataset.selectOption = String(index); item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected)); item.setAttribute("aria-disabled", String(!enabled[index]));
      item.hidden = option.hidden; item.textContent = option.label; item.title = option.label;
      item.classList.toggle("is-active", index === opened.active); return item;
    }));
    if (opened.active >= 0) trigger.setAttribute("aria-activedescendant", `${trigger.id}-option-${opened.active}`); else trigger.removeAttribute("aria-activedescendant");
    opened.panel.setAttribute("aria-label", trigger.getAttribute("aria-label") ?? "");
  }
  private activate(index: number, scroll = true): void {
    const opened = this.opened;
    if (!opened || opened.active === index) return;
    opened.active = index;
    opened.panel.querySelectorAll<HTMLElement>("[role=option]").forEach(item => item.classList.toggle("is-active", Number(item.dataset.selectOption) === index));
    opened.state.trigger.setAttribute("aria-activedescendant", `${opened.state.trigger.id}-option-${index}`);
    if (scroll) this.scrollActive();
  }
  private scrollActive(): void { this.opened?.panel.querySelector<HTMLElement>(".is-active")?.scrollIntoView({ block: "nearest" }); }
  private position(): void {
    const opened = this.opened;
    if (!opened) return;
    const view = window.visualViewport, width = Math.min(view?.width ?? window.innerWidth, document.documentElement.clientWidth);
    const viewport = { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width, height: view?.height ?? window.innerHeight };
    const rect = opened.state.trigger.getBoundingClientRect(), style = getComputedStyle(opened.state.trigger);
    opened.panel.style.font = style.font;
    opened.panel.style.maxWidth = `${Math.max(0, width - 16)}px`;
    opened.panel.style.minWidth = `${Math.min(rect.width, Math.max(0, width - 16))}px`;
    const size = customSelectPosition(rect, viewport, opened.panel.scrollWidth, opened.panel.scrollHeight + 2);
    Object.assign(opened.panel.style, { left: `${size.left}px`, top: `${size.top}px`, width: `${size.width}px`, maxHeight: `${size.height}px` });
    opened.panel.dataset.placement = size.placement;
  }
  private outside = (event: Event): void => {
    const target = event.target;
    if (this.opened && target instanceof Node && !this.opened.panel.contains(target) && !this.opened.state.wrapper.contains(target) && !this.opened.state.wrapper.closest("label")?.contains(target)) this.close();
  };
  private externalScroll = (event: Event): void => { if (this.opened && !(event.target instanceof Node && this.opened.panel.contains(event.target))) this.close(); };
  private closeOnViewport = (): void => this.close();
  private openKey = (event: KeyboardEvent): void => {
    const opened = this.opened;
    if (!opened) return;
    if (event.key === "Tab") { this.close(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); this.close(true); return; }
    if (event.target !== opened.state.trigger) return;
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === "Enter" || event.key === " ") this.choose(opened.active);
      else this.activate(nextSelectOption(this.enabled(opened.state.select), opened.active, event.key));
    }
  };
}
let selectAdapterSerial = 0;
