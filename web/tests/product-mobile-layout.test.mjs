import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-contract guard only. Real CSS geometry is checked in Chrome separately.
const css = readFileSync(new URL("../src/product.css", import.meta.url), "utf8");
function media(condition) {
  const token = `@media (${condition}) {`;
  const start = Math.max(css.lastIndexOf(token), css.lastIndexOf(`@media (${condition}),`));
  assert.ok(start >= 0, `missing breakpoint ${condition}`);
  const open = css.indexOf("{", start);
  let depth = 1, end = open + 1;
  while (depth && end < css.length) {
    if (css[end] === "{") depth++;
    if (css[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0, "balanced media block");
  return css.slice(open + 1, end - 1);
}
const compact = media("max-width: 1180px");
const phone = media("max-width: 560px");
assert.match(compact, /\.filter-strip \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(compact, /\.filter-strip \.filter-search \{[^}]*grid-column: 1 \/ -1; grid-row: 2/);
assert.match(compact, /\.inventory-facts \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(compact, /\.inventory-facts > div:last-child \{[^}]*grid-column: 1 \/ -1; display: flex/);
assert.match(compact, /\.current-editor \.field-grid \{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(compact, /\.plan-editor \.plan-field-grid \{[^}]*repeat\(3, minmax\(0, 1fr\)\)/);
assert.match(compact, /\.experience-editor-row \{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
assert.match(compact, /\.pending-review-scroll-desktop \{ grid-template-columns: 1fr;/, "compact source groups leave two cards enough input width");
assert.match(compact, /\.experience-needs dl div:nth-child\(3\) \{[^}]*grid-column: 1 \/ -1/);
assert.match(phone, /\.account-fields > :first-child \{ grid-column: 1 \/ -1/);
assert.match(css, /\.pending-edit-grid \{[^}]*grid-template-columns: minmax\(0, 1\.5fr\) minmax\(0, 1fr\) minmax\(0, 1fr\)/);
assert.match(css, /\.pending-card-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(media("max-width: 768px"), /\.pending-card-grid, \.overlap-review-evidence, \.all-review-cards \{ grid-template-columns: 1fr/);
assert.match(css, /\.inventory-grid th:nth-child\(1\), \.inventory-grid td:nth-child\(1\) \{ width: 12\.5%/);
assert.match(css, /\.inventory-grid th:nth-child\(4\), \.inventory-grid td:nth-child\(4\) \{ width: 20\.8333333%/);
assert.match(css, /\.plan-actions > #reset-plans \{ margin-left: auto/);
assert.match(media("max-width: 840px"), /padding-bottom: calc\(74px \+ env\(safe-area-inset-bottom\)\)/);
assert.match(css, /body \{ min-width: 0;/, "the 320px viewport includes the desktop scrollbar gutter");
assert.ok(!css.includes("yuanstar-embedded"), "standalone has no host selectors");
assert.ok(!/(?:html|body|:root)\s*\{[^}]*overflow-x:\s*hidden/.test(css), "do not mask document overflow");
console.log("PASS mobile CSS contracts and retained public priorities (layout evidence is separate)");
