import { customSelectPosition, nextSelectOption } from "../src/product-custom-select.js";
function equal(a: unknown, b: unknown): void { if (JSON.stringify(a) !== JSON.stringify(b)) throw Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`); }
function ok(value: unknown, label: string): void { if (!value) throw Error(label); }
const enabled = [true, false, true, true, false];
equal(nextSelectOption(enabled, 0, "ArrowDown"), 2); equal(nextSelectOption(enabled, 2, "ArrowUp"), 0);
equal(nextSelectOption(enabled, 2, "Home"), 0); equal(nextSelectOption(enabled, 0, "End"), 3);
equal(nextSelectOption(enabled, 3, "ArrowDown"), 3); equal(nextSelectOption(enabled, 0, "ArrowUp"), 0);
equal(nextSelectOption([false, false], 0, "Home"), -1);
equal(nextSelectOption([false, true], -1, "ArrowDown"), 1);
for (const width of [320, 360, 390, 430, 768, 1440]) for (const top of [15, 260, 550]) {
  const view = { left: 0, top: 0, width, height: 600 }, trigger = { left: width - 130, top, bottom: top + 32, width: 120 };
  const panel = customSelectPosition(trigger, view, 1000, 1000);
  ok(panel.left >= 8 && panel.left + panel.width <= width - 8, `horizontal ${width}/${top}`);
  ok(panel.top >= 8 && panel.top + panel.height <= 592, `vertical ${width}/${top}`);
  ok(panel.width >= trigger.width && panel.height <= 280, "width matches trigger and height capped");
}
equal(customSelectPosition({ left: 40, top: 100, bottom: 132, width: 120 }, { left: 0, top: 0, width: 390, height: 844 }, 120, 200).placement, "bottom");
equal(customSelectPosition({ left: 40, top: 740, bottom: 772, width: 120 }, { left: 0, top: 0, width: 390, height: 844 }, 120, 200).placement, "top");
const offset = customSelectPosition({ left: 15, top: 300, bottom: 332, width: 100 }, { left: 10, top: 48, width: 300, height: 360 }, 500, 600);
ok(offset.left >= 18 && offset.left + offset.width <= 302 && offset.top >= 56 && offset.top + offset.height <= 400, "short offset visual viewport");
const keyboard = customSelectPosition({ left: 15, top: 330, bottom: 362, width: 100 }, { left: 0, top: 48, width: 390, height: 180 }, 200, 600);
ok(keyboard.top >= 56 && keyboard.top + keyboard.height <= 220, "covered trigger cannot make a short visual viewport overflow");
console.log("PASS custom select positioning, visual viewport clamps, enabled navigation and boundaries");
