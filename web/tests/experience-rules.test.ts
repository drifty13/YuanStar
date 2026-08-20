import * as XLSX from "xlsx";
// The browser build has no Node typings; this test alone reads the tracked authority file under Node.
// @ts-ignore Node's runtime module is deliberately outside the browser production graph.
import { readFile } from "node:fs/promises";
import {
  ExperienceRuleLoadError,
  feedableExperienceRequired,
  loadExperienceRulesWorkbook,
  ownedExperience,
  rawExperienceRequired,
  requirementAsPurpleWhite,
  stage624Experience,
  stage624RunsRequired,
  summarizeExperiencePlans,
} from "../src/experience-rules.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

const authoritativeBytes = new Uint8Array(await readFile("../resources/reference/YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx")).buffer;
const rules = loadExperienceRulesWorkbook(authoritativeBytes);

function variantWorkbook(mutate: (workbook: XLSX.WorkBook) => void): ArrayBuffer {
  const workbook = XLSX.read(authoritativeBytes, { type: "array", raw: true });
  mutate(workbook);
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}
function setTableValue(workbook: XLSX.WorkBook, sheetName: string, rowLabel: string | number, columnLabel: string, value: number): void {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`missing test sheet ${sheetName}`);
  const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  const headerRow = table.findIndex((row) => row.includes(columnLabel));
  if (headerRow < 0) throw new Error(`missing test column ${columnLabel}`);
  const labelColumn = table[headerRow]!.findIndex((header) => header === "配置键" || header === "当前等级起" || header === "当前等级");
  const valueColumn = table[headerRow]!.indexOf(columnLabel);
  const row = table.findIndex((cells, index) => index > headerRow && cells[labelColumn] === rowLabel);
  if (row < 0 || valueColumn < 0) throw new Error(`missing test row ${rowLabel}`);
  sheet[XLSX.utils.encode_cell({ r: row, c: valueColumn })] = { t: "n", v: value };
}
function setConfig(workbook: XLSX.WorkBook, key: string, value: number): void { setTableValue(workbook, "Codex配置", key, "值", value); }
function loadVariant(mutate: (workbook: XLSX.WorkBook) => void) { return loadExperienceRulesWorkbook(variantWorkbook(mutate)); }
function expectRuleLoadFailure(mutate: (workbook: XLSX.WorkBook) => void, message: string): void {
  let rejected = false;
  try { loadVariant(mutate); }
  catch (error) { rejected = error instanceof ExperienceRuleLoadError; }
  expect(rejected, message);
}

equal([rules.maxLevel, rules.whiteExperience, rules.purpleExperience, rules.orangeExperience, rules.roundExperienceTo, rules.stage624PurpleYield, rules.stage624StaminaCost, stage624Experience(rules)], [60, 100, 500, 1000, 100, 3, 10, 1500], "authoritative workbook must load the confirmed core values and 6-24 configuration");
equal(Object.keys(rules.levelExperience).length, 60, "authoritative workbook must contain every level");
equal(rawExperienceRequired(1, 10, rules), 2700, "normal upgrades must use the official per-level data");
equal(rawExperienceRequired(10, 20, rules), 9550, "cross-interval upgrades must sum every current-level bar");
equal(feedableExperienceRequired(1, 60, rules), 256800, "level 60 plans must round to the smallest feedable unit");
equal(feedableExperienceRequired(60, 60, rules), 0, "equal targets require no experience");
equal(requirementAsPurpleWhite(600, rules), { experience: 600, purple: 1, white: 1 }, "display must prefer purple then use white for the remainder");
equal(ownedExperience(1, 2, 3, rules), 2300, "owned inventory must include orange, purple and white experience");
for (const [experience, runs] of [[0, 0], [1, 1], [1500, 1], [1501, 2], [1600, 2], [3000, 2]] as const) equal(stage624RunsRequired(experience, rules), runs, `6-24 runs must round ${experience} experience correctly`);

const independentlyRounded = summarizeExperiencePlans([
  { starInstanceId: "first", currentLevel: 10, targetLevel: 20 },
  { starInstanceId: "second", currentLevel: 10, targetLevel: 20 },
], rules, { orange: 0, purple: 0, white: 0 });
equal(independentlyRounded.required.experience, 19200, "instances must round separately before aggregation");

const sixTwentyFourSummary = summarizeExperiencePlans([{ starInstanceId: "stage-total", currentLevel: 1, targetLevel: 10 }], rules, { orange: 1, purple: 0, white: 1 });
equal(stage624RunsRequired(sixTwentyFourSummary.required.experience, rules), 2, "the middle column must use total required experience for 6-24 runs");
equal(sixTwentyFourSummary.remaining?.experience, 1600, "the remaining gap must deduct complete owned inventory");
equal(stage624RunsRequired(sixTwentyFourSummary.remaining!.experience, rules), 2, "the right column must use remaining experience for 6-24 runs");
const sufficientSummary = summarizeExperiencePlans([{ starInstanceId: "stage-sufficient", currentLevel: 1, targetLevel: 10 }], rules, { orange: 3, purple: 0, white: 0 });
equal(stage624RunsRequired(sufficientSummary.remaining!.experience, rules), 0, "a sufficient inventory must need zero 6-24 runs");

const unitVariant = loadVariant((workbook) => {
  setConfig(workbook, "white_exp", 50);
  setConfig(workbook, "purple_exp", 250);
  setConfig(workbook, "orange_exp", 750);
});
equal([unitVariant.whiteExperience, unitVariant.purpleExperience, unitVariant.orangeExperience], [50, 250, 750], "valid experience-unit values must come from the workbook");
equal(ownedExperience(1, 1, 1, unitVariant), 1050, "owned experience must use replacement workbook units");

const roundingVariant = loadVariant((workbook) => setConfig(workbook, "round_exp_to", 300));
equal(roundingVariant.roundExperienceTo, 300, "valid rounding granularity must come from the workbook");
equal(feedableExperienceRequired(1, 2, roundingVariant), 300, "feedable experience must use replacement workbook rounding");
const inventoryRoundingSummary = summarizeExperiencePlans([{ starInstanceId: "rounding-inventory", currentLevel: 1, targetLevel: 2 }], roundingVariant, { orange: 0, purple: 0, white: 1 });
equal(inventoryRoundingSummary.required, { experience: 300, purple: 0, white: 3 }, "a 300 experience plan must be representable with white units");
equal(inventoryRoundingSummary.remaining, { experience: 200, purple: 0, white: 2 }, "inventory deductions may leave a white-unit remainder below the rounding granularity");

const stageVariant = loadVariant((workbook) => {
  setConfig(workbook, "stage_6_24_purple_yield", 2);
  setConfig(workbook, "stage_6_24_stamina_cost", 15);
});
equal([stageVariant.stage624PurpleYield, stageVariant.stage624StaminaCost, stage624Experience(stageVariant)], [2, 15, 1000], "6-24 parameters must come from the workbook");
equal(stage624RunsRequired(2700, stageVariant), 3, "6-24 runs must use replacement workbook yield");

const levelVariant = loadVariant((workbook) => {
  setTableValue(workbook, "升级经验区间", 31, "首级经验", 3600);
  for (let level = 31; level <= 35; level += 1) setTableValue(workbook, "逐级经验明细", level, "当前等级经验条上限", 3600);
});
equal(rawExperienceRequired(31, 32, levelVariant), 3600, "level experience must use replacement workbook rows");

expectRuleLoadFailure((workbook) => setConfig(workbook, "white_exp", 0), "invalid resource-driven numeric values must still fail fast");
expectRuleLoadFailure((workbook) => {
  setConfig(workbook, "white_exp", 120);
  setConfig(workbook, "purple_exp", 500);
}, "purple experience must remain an integer multiple of white experience");
expectRuleLoadFailure((workbook) => setConfig(workbook, "round_exp_to", 250), "rounding granularity must remain an integer multiple of white experience");
expectRuleLoadFailure((workbook) => setConfig(workbook, "max_level", 61), "max_level must remain a protected v1 behavior contract");

const leftSelection = summarizeExperiencePlans([{ starInstanceId: "same-id", currentLevel: 1, targetLevel: 10 }], rules, { orange: null, purple: null, white: null });
const rightSelection = summarizeExperiencePlans([{ starInstanceId: "same-id", currentLevel: 1, targetLevel: 10 }], rules, { orange: null, purple: null, white: null });
equal(leftSelection.required, rightSelection.required, "the same starInstanceId must calculate identically from either table");
expect(leftSelection.remaining == null, "unknown inventory must leave only the gap unavailable");

const accountA = summarizeExperiencePlans([{ starInstanceId: "account-a", currentLevel: 1, targetLevel: 10 }], rules, { orange: 0, purple: 0, white: 0 });
const accountB = summarizeExperiencePlans([{ starInstanceId: "account-b", currentLevel: 1, targetLevel: 1 }], rules, { orange: 20, purple: 20, white: 20 });
expect(accountA.required.experience === 2700 && accountB.required.experience === 0 && accountA.remaining?.experience === 2700 && accountB.remaining?.experience === 0, "account-scoped inputs must not contaminate each other");

const invalid = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(invalid, XLSX.utils.aoa_to_sheet([["配置键", "值"], ["max_level", 60]]), "Codex配置");
let rejected = false;
try { loadExperienceRulesWorkbook(XLSX.write(invalid, { type: "array", bookType: "xlsx" }) as ArrayBuffer); }
catch (error) { rejected = error instanceof ExperienceRuleLoadError; }
expect(rejected, "a malformed workbook must fail as a recoverable rule-load error");

console.log("experience rules checks passed");
