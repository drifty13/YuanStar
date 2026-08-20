import * as XLSX from "xlsx";

export const EXPERIENCE_RULES_ASSET = "/reference/YuanStar_Phase0_6A_经验星曜规则与逐级数据.xlsx";

const CONFIG_SHEET = "Codex配置";
const INTERVAL_SHEET = "升级经验区间";
const DETAIL_SHEET = "逐级经验明细";

export class ExperienceRuleLoadError extends Error {
  constructor(message: string) { super(message); this.name = "ExperienceRuleLoadError"; }
}

export class ExperienceCalculationError extends Error {
  constructor(message: string) { super(message); this.name = "ExperienceCalculationError"; }
}

export type ExperienceRules = Readonly<{
  maxLevel: number;
  levelExperience: Readonly<Record<number, number>>;
  whiteExperience: number;
  purpleExperience: number;
  orangeExperience: number;
  roundExperienceTo: number;
  stage624PurpleYield: number;
  stage624StaminaCost: number;
}>;

export type InstanceExperiencePlan = Readonly<{ starInstanceId: string; currentLevel: number; targetLevel: number }>;
export type PurpleWhiteRequirement = Readonly<{ experience: number; purple: number; white: number }>;
export type ExperiencePlanSummary = Readonly<{
  plannedInstanceCount: number;
  required: PurpleWhiteRequirement;
  remaining: PurpleWhiteRequirement | null;
  warnings: readonly string[];
}>;

function fail(message: string): never { throw new ExperienceRuleLoadError(message); }
function worksheet(workbook: XLSX.WorkBook, name: string): XLSX.WorkSheet {
  const sheet = workbook.Sheets[name];
  if (!sheet) fail(`缺少“${name}”工作表`);
  return sheet;
}
function rows(sheet: XLSX.WorkSheet): unknown[][] { return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true }); }
function headerIndexes(sheet: XLSX.WorkSheet, expected: readonly string[], name: string): { row: number; indexes: Record<string, number> } {
  const values = rows(sheet);
  for (let row = 0; row < values.length; row += 1) {
    const cells = values[row] ?? [];
    const headers = cells.map((value) => value == null ? "" : String(value).trim());
    if (!headers.some(Boolean) || !expected.some((label) => headers.includes(label))) continue;
    const missing = expected.find((label) => !headers.includes(label));
    if (missing) fail(`“${name}”工作表表头错误：缺少“${missing}”列`);
    return { row, indexes: Object.fromEntries(expected.map((label) => [label, headers.indexOf(label)])) };
  }
  fail(`“${name}”工作表表头错误`);
}
function cell(cells: unknown[], index: number): unknown { return cells[index] ?? null; }
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) fail(`${label}不是有效正整数`);
  return value as number;
}
function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) fail(`${label}不是有效整数`);
  return value as number;
}
function configValues(sheet: XLSX.WorkSheet): Record<string, unknown> {
  const { row, indexes } = headerIndexes(sheet, ["配置键", "值"], CONFIG_SHEET);
  const values: Record<string, unknown> = {};
  rows(sheet).slice(row + 1).forEach((cells) => {
    const key = cell(cells, indexes["配置键"]!);
    if (key != null && String(key).trim()) values[String(key).trim()] = cell(cells, indexes["值"]!);
  });
  return values;
}
function requiredConfig(config: Record<string, unknown>, key: string): unknown {
  if (!(key in config)) fail(`“${CONFIG_SHEET}”缺少配置项“${key}”`);
  return config[key];
}
function expandLevelExperience(sheet: XLSX.WorkSheet, maxLevel: number): Record<number, number> {
  const labels = ["当前等级起", "当前等级止", "经验条规则", "首级经验", "递增步长"] as const;
  const { row, indexes } = headerIndexes(sheet, labels, INTERVAL_SHEET);
  const levelExperience: Record<number, number> = {};
  rows(sheet).slice(row + 1).forEach((cells) => {
    const rawStart = cell(cells, indexes["当前等级起"]!);
    if (rawStart == null) return;
    const start = positiveInteger(rawStart, "当前等级起");
    const end = positiveInteger(cell(cells, indexes["当前等级止"]!), "当前等级止");
    if (end < start) fail(`等级区间${start}—${end}无效`);
    const rule = String(cell(cells, indexes["经验条规则"]!) ?? "").trim();
    if (rule !== "等差递增" && rule !== "固定值") fail(`等级区间${start}—${end}的经验条规则无效`);
    const first = positiveInteger(cell(cells, indexes["首级经验"]!), "首级经验");
    const step = integer(cell(cells, indexes["递增步长"]!), "递增步长");
    if (rule === "等差递增" && step < 0) fail(`等级区间${start}—${end}的递增步长不能为负数`);
    for (let level = start; level <= end; level += 1) {
      if (level in levelExperience) fail(`等级数据区间重叠：${level}级`);
      levelExperience[level] = positiveInteger(rule === "等差递增" ? first + (level - start) * step : first, `${level}级经验`);
    }
  });
  for (let level = 1; level <= maxLevel; level += 1) if (!(level in levelExperience)) fail(`等级数据缺少${level}级`);
  const extra = Object.keys(levelExperience).map(Number).find((level) => level > maxLevel);
  if (extra != null) fail(`等级数据超出最高等级：${extra}级`);
  return levelExperience;
}
function validateDetailCache(sheet: XLSX.WorkSheet | undefined, levelExperience: Record<number, number>): void {
  if (!sheet) return;
  const { row, indexes } = headerIndexes(sheet, ["当前等级", "当前等级经验条上限"], DETAIL_SHEET);
  rows(sheet).slice(row + 1).forEach((cells) => {
    const level = cell(cells, indexes["当前等级"]!);
    const value = cell(cells, indexes["当前等级经验条上限"]!);
    if (Number.isInteger(level) && Number.isInteger(value) && levelExperience[level as number] != null && levelExperience[level as number] !== value) {
      fail(`“${DETAIL_SHEET}”与区间规则不一致：${level}级`);
    }
  });
}

/** Parse and validate the single authoritative Phase 0.6 workbook in browser memory. */
export function loadExperienceRulesWorkbook(data: ArrayBuffer): ExperienceRules {
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(data, { type: "array", raw: true }); }
  catch (error) { fail(`无法读取经验星曜规则文件：${error instanceof Error ? error.message : String(error)}`); }
  const config = configValues(worksheet(workbook!, CONFIG_SHEET));
  const maxLevel = positiveInteger(requiredConfig(config, "max_level"), "最高等级");
  // This is a v1 behavior contract, not a configurable numeric rule.
  if (maxLevel !== 60) fail("最高等级必须为60");
  const whiteExperience = positiveInteger(requiredConfig(config, "white_exp"), "白星曜经验值");
  const purpleExperience = positiveInteger(requiredConfig(config, "purple_exp"), "紫星曜经验值");
  const orangeExperience = positiveInteger(requiredConfig(config, "orange_exp"), "橙星曜经验值");
  const roundExperienceTo = positiveInteger(requiredConfig(config, "round_exp_to"), "经验取整粒度");
  const stage624PurpleYield = positiveInteger(requiredConfig(config, "stage_6_24_purple_yield"), "6-24紫星曜产出");
  const stage624StaminaCost = positiveInteger(requiredConfig(config, "stage_6_24_stamina_cost"), "6-24体力");
  if (purpleExperience % whiteExperience) fail("紫星曜经验值必须是白星曜经验值的整数倍");
  if (orangeExperience % whiteExperience) fail("橙星曜经验值必须是白星曜经验值的整数倍");
  if (roundExperienceTo % whiteExperience) fail("经验取整粒度必须是白星曜经验值的整数倍");
  // These are v1 behavior contracts, not configurable numeric rules.
  if (requiredConfig(config, "include_orange_in_owned_exp") !== true) fail("橙星曜必须计入当前库存经验");
  if (integer(requiredConfig(config, "assume_current_bar_progress"), "当前经验条进度") !== 0) fail("当前经验条进度必须为0");
  if (requiredConfig(config, "include_breakthrough_materials") !== false) fail("突破材料必须不纳入经验计算");
  const levelExperience = expandLevelExperience(worksheet(workbook!, INTERVAL_SHEET), maxLevel);
  validateDetailCache(workbook!.Sheets[DETAIL_SHEET], levelExperience);
  return Object.freeze({ maxLevel, levelExperience: Object.freeze(levelExperience), whiteExperience, purpleExperience, orangeExperience, roundExperienceTo, stage624PurpleYield, stage624StaminaCost });
}

function validLevel(level: number, rules: ExperienceRules, label: string): void {
  if (!Number.isInteger(level) || level < 1 || level > rules.maxLevel) throw new ExperienceCalculationError(`${label}超出经验规则等级范围：${level}`);
}
export function rawExperienceRequired(currentLevel: number, targetLevel: number, rules: ExperienceRules): number {
  validLevel(currentLevel, rules, "当前等级"); validLevel(targetLevel, rules, "计划等级");
  if (targetLevel <= currentLevel) return 0;
  let total = 0;
  for (let level = currentLevel; level < targetLevel; level += 1) total += rules.levelExperience[level]!;
  return total;
}
export function feedableExperienceRequired(currentLevel: number, targetLevel: number, rules: ExperienceRules): number {
  const raw = rawExperienceRequired(currentLevel, targetLevel, rules);
  return raw === 0 ? 0 : Math.ceil(raw / rules.roundExperienceTo) * rules.roundExperienceTo;
}
export function requirementAsPurpleWhite(experience: number, rules: ExperienceRules): PurpleWhiteRequirement {
  if (!Number.isInteger(experience) || experience < 0) throw new ExperienceCalculationError("经验需求必须为非负整数");
  if (experience % rules.whiteExperience) throw new ExperienceCalculationError("经验需求必须能按白星曜经验单位整除");
  const purple = Math.floor(experience / rules.purpleExperience);
  return Object.freeze({ experience, purple, white: (experience - purple * rules.purpleExperience) / rules.whiteExperience });
}
export function ownedExperience(orange: number, purple: number, white: number, rules: ExperienceRules): number {
  for (const [label, value] of [["橙星曜", orange], ["紫星曜", purple], ["白星曜", white]] as const) {
    if (!Number.isInteger(value) || value < 0) throw new ExperienceCalculationError(`${label}数量必须为非负整数`);
  }
  return orange * rules.orangeExperience + purple * rules.purpleExperience + white * rules.whiteExperience;
}
export function stage624Experience(rules: ExperienceRules): number { return rules.stage624PurpleYield * rules.purpleExperience; }
export function stage624RunsRequired(experience: number, rules: ExperienceRules): number {
  if (!Number.isFinite(experience)) throw new ExperienceCalculationError("6-24经验需求必须是有限数字");
  return experience <= 0 ? 0 : Math.ceil(experience / stage624Experience(rules));
}
export function summarizeExperiencePlans(plans: readonly InstanceExperiencePlan[], rules: ExperienceRules, inventory: Readonly<{ orange: number | null; purple: number | null; white: number | null }>): ExperiencePlanSummary {
  let plannedInstanceCount = 0;
  let requiredExperience = 0;
  const warnings: string[] = [];
  for (const plan of plans) {
    try {
      const required = feedableExperienceRequired(plan.currentLevel, plan.targetLevel, rules);
      if (required > 0) { plannedInstanceCount += 1; requiredExperience += required; }
    } catch { warnings.push(`实例 ${plan.starInstanceId} 的等级超出经验规则范围`); }
  }
  const required = requirementAsPurpleWhite(requiredExperience, rules);
  if (inventory.orange == null || inventory.purple == null || inventory.white == null) return Object.freeze({ plannedInstanceCount, required, remaining: null, warnings: Object.freeze(warnings) });
  try {
    const remaining = requirementAsPurpleWhite(Math.max(0, requiredExperience - ownedExperience(inventory.orange, inventory.purple, inventory.white, rules)), rules);
    return Object.freeze({ plannedInstanceCount, required, remaining, warnings: Object.freeze(warnings) });
  } catch {
    return Object.freeze({ plannedInstanceCount, required, remaining: null, warnings: Object.freeze([...warnings, "当前经验星曜数量无效，暂无法计算缺口"]) });
  }
}
