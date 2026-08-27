import OpenCC from "opencc-js";

export type DisplayLocale = "zh-Hans" | "zh-Hant";

export const DISPLAY_LOCALE_STORAGE_KEY = "yuanstar.display.locale";

export interface DisplayLocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const toTraditional = OpenCC.Converter({ from: "cn", to: "tw" });
const displayAttributes = ["placeholder", "title", "aria-label"] as const;

export function normalizeDisplayLocale(value: string | null | undefined): DisplayLocale {
  return value === "zh-Hant" ? "zh-Hant" : "zh-Hans";
}

export function readDisplayLocale(storage: Pick<DisplayLocaleStorage, "getItem"> | null | undefined): DisplayLocale {
  try { return normalizeDisplayLocale(storage?.getItem(DISPLAY_LOCALE_STORAGE_KEY)); }
  catch { return "zh-Hans"; }
}

export function saveDisplayLocale(locale: DisplayLocale, storage: Pick<DisplayLocaleStorage, "setItem"> | null | undefined): void {
  try { storage?.setItem(DISPLAY_LOCALE_STORAGE_KEY, locale); }
  catch { /* Display preference persistence must never block the product. */ }
}

export function displayText(text: string, locale: DisplayLocale): string {
  return locale === "zh-Hant" ? toTraditional(text) : text;
}

/** Keeps root-external, catalog-derived tooltip text on the display-only locale boundary. */
export function displayTooltipText(text: string, locale: DisplayLocale): string {
  return displayText(text, locale);
}

export function isDisplayAttribute(name: string): name is (typeof displayAttributes)[number] {
  return (displayAttributes as readonly string[]).includes(name);
}

function isIgnored(node: Node | null): boolean {
  for (let element = node instanceof Element ? node : node?.parentElement; element; element = element.parentElement) {
    if (element.hasAttribute("data-display-locale-ignore")) return true;
    if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable)) return true;
  }
  return false;
}

function ignoresAttributes(element: Element): boolean {
  return element.hasAttribute("data-display-locale-ignore")
    || element.hasAttribute("data-display-locale-ignore-attributes")
    || element instanceof HTMLTextAreaElement
    || (element instanceof HTMLElement && element.isContentEditable);
}

export interface DisplayLocaleAdapter {
  readonly locale: DisplayLocale;
  start(): void;
  apply(): void;
  setLocale(locale: DisplayLocale): void;
  toggle(): void;
  stop(): void;
}

export function createDisplayLocaleAdapter(root: HTMLElement, options: {
  storage?: DisplayLocaleStorage | null;
  onChange?: (locale: DisplayLocale) => void;
} = {}): DisplayLocaleAdapter {
  const storage = options.storage ?? (typeof window === "undefined" ? null : window.localStorage);
  const originalText = new WeakMap<Text, string>();
  const originalAttributes = new WeakMap<Element, Map<string, string>>();
  let locale = readDisplayLocale(storage);
  let observer: MutationObserver | null = null;

  const applyText = (text: Text): void => {
    if (isIgnored(text)) return;
    const source = originalText.get(text) ?? text.data;
    if (!originalText.has(text)) originalText.set(text, source);
    const next = displayText(source, locale);
    if (text.data !== next) text.data = next;
  };
  const applyAttributes = (element: Element): void => {
    if (ignoresAttributes(element)) return;
    let originals = originalAttributes.get(element);
    for (const name of displayAttributes) {
      const current = element.getAttribute(name);
      if (current == null) continue;
      if (!originals) { originals = new Map(); originalAttributes.set(element, originals); }
      const source = originals.get(name) ?? current;
      if (!originals.has(name)) originals.set(name, source);
      const next = displayText(source, locale);
      if (current !== next) element.setAttribute(name, next);
    }
  };
  const applyNode = (node: Node): void => {
    if (node instanceof Text) { applyText(node); return; }
    if (!(node instanceof Element)) return;
    applyAttributes(node);
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) { applyText(text as Text); text = walker.nextNode(); }
    node.querySelectorAll("*").forEach(applyAttributes);
  };
  const apply = (): void => applyNode(root);

  return {
    get locale() { return locale; },
    start() {
      if (observer) return;
      apply();
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "characterData") applyText(mutation.target as Text);
          else if (mutation.type === "attributes") applyAttributes(mutation.target as Element);
          else mutation.addedNodes.forEach(applyNode);
        }
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...displayAttributes] });
    },
    apply,
    setLocale(nextLocale) {
      const normalized = normalizeDisplayLocale(nextLocale);
      if (locale === normalized) return;
      locale = normalized;
      saveDisplayLocale(locale, storage);
      apply();
      options.onChange?.(locale);
    },
    toggle() { this.setLocale(locale === "zh-Hans" ? "zh-Hant" : "zh-Hans"); },
    stop() { observer?.disconnect(); observer = null; },
  };
}
