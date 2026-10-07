import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../src/product.ts", import.meta.url), "utf8");
const adapter = readFileSync(new URL("../src/product-custom-select.ts", import.meta.url), "utf8");
const templates = [...source.matchAll(/<select\b([^>]*)>/g)].map(match => match[1]);
assert.equal(templates.length, 12, "all select template sites inventoried; overlap renders both pools");
const expected = ["data-current-account", "data-account-game-version", "data-overlap-before", "data-overlap-after", 'id="kind-filter"', 'id="quality-filter"', 'id="sort-filter"', 'data-current-field="kind"', 'data-current-field="name"', 'data-current-field="quality"', "data-review-edit-name", "data-review-edit-quality"];
for (const selector of expected) assert.equal(templates.filter(tag => tag.includes(selector)).length, 1, selector);
assert.match(source, /\["主星", "辅星"\]/);
assert.match(adapter, /querySelectorAll<HTMLSelectElement>\("select"\)/, "enhancement covers arbitrary selects, not an ID allowlist");
assert.match(source, /function syncProductSelects\(\): void \{\s*productSelects\?\.prepare\(\);\s*displayLocaleAdapter\.apply\(\);\s*productSelects\?\.enhance\(\);/);
for (const name of ["renderPage", "renderReview"]) {
  const section = source.slice(source.indexOf(`function ${name}(`), source.indexOf("\nfunction ", source.indexOf(`function ${name}(`) + 1));
  assert.match(section, /productSelects\?\.disposeAll\(\)/); assert.match(section, /syncProductSelects\(\)/);
}
assert.match(source, /nameSelect\.innerHTML = nameOptions\(draft\.kind, draft\.name\); nameSelect\.value = draft\.name; syncProductSelects\(\);/);
assert.match(source, /button class="review-sort-locked" id="sort-filter"/);
assert.match(adapter, /new Event\("change", \{ bubbles: true \}\)/);
assert.doesNotMatch(adapter, /workspaceController|currentEditDraft|switchProductAccount|commitCurrentEditor|MaaYuan|CaptureBatch|embedded|cloud/);
console.log("PASS complete 14-instance inventory, generic enhancement, render/dynamic sync, locked sort and business boundary");
