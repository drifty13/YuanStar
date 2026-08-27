import { DISPLAY_LOCALE_STORAGE_KEY, displayText, displayTooltipText, isDisplayAttribute, readDisplayLocale, saveDisplayLocale } from "../src/display-locale.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const stored = new Map<string, string>();
const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) };

expect(readDisplayLocale(storage) === "zh-Hans", "display locale defaults to Simplified Chinese");
saveDisplayLocale("zh-Hant", storage);
expect(stored.get(DISPLAY_LOCALE_STORAGE_KEY) === "zh-Hant" && readDisplayLocale(storage) === "zh-Hant", "display locale persists independently through storage");
expect(displayText("导入识别 数据", "zh-Hant") === "導入識別 數據", "known Simplified UI text converts to Traditional Chinese");
expect(displayText("天钺 阴煞 禄存", "zh-Hant") === "天鉞 陰煞 祿存", "canonical star labels convert only for display");
const ocrCanonical = "天钺";
displayText(ocrCanonical, "zh-Hant");
expect(ocrCanonical === "天钺", "display locale returns a rendered copy and cannot mutate the OCR canonical value");
expect(displayTooltipText("攻击加成", "zh-Hant") === "攻擊加成", "root-external tooltip text follows the display locale without changing catalog data");
expect(isDisplayAttribute("placeholder") && isDisplayAttribute("title") && isDisplayAttribute("aria-label"), "visible attributes are selected for conversion");
expect(!isDisplayAttribute("value") && !isDisplayAttribute("data-star-id") && !isDisplayAttribute("id"), "machine attributes and input values are never conversion targets");

console.log("Display locale state, conversion boundary, and machine-value guards passed");
