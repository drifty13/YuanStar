import { browserCatalog } from "./business/browser-catalog.js";
import { createEmptyWorkspace, type GameVersion, type Quality, type StarKind, type WorkspaceStateV1 } from "./business/model.js";
import { WorkspaceSession, defaultStarInstanceId, type StarInstanceIdFactory } from "./business/session.js";
import * as XLSX from "xlsx";

export const DATA_EXPORT_SCHEMA_VERSION = 1 as const;

export interface YuanStarDataExportV1 {
  schemaVersion: typeof DATA_EXPORT_SCHEMA_VERSION;
  exportedAt: string;
  gameVersion: GameVersion;
  accountDisplayName: string;
  bag: { currentCount: number | null; capacity: number | null };
  experience: { orange: number | null; purple: number | null; white: number | null };
  inventory: Array<{ kind: StarKind; name: string; quality: Quality; currentLevel: number; targetLevel: number }>;
}

export type DataImportPreview = {
  format: "json" | "xlsx";
  fileName: string;
  inventoryCount: number;
  plannedCount: number;
  bag: YuanStarDataExportV1["bag"];
  experience: YuanStarDataExportV1["experience"];
  workspace: WorkspaceStateV1;
};

const qualities = new Set<Quality>(["橙", "紫", "蓝", "绿", "白"]);
const kinds = new Set<StarKind>(["主星", "辅星"]);

function inputError(message: string): never { throw new Error(`导入文件无效：${message}`); }
function asObject(value: unknown, label: string): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) inputError(`${label} 必须是对象`); return value as Record<string, unknown>; }
function asNullableInteger(value: unknown, label: string, min = 0, max?: number): number | null {
  if (value == null || value === "") return null;
  if (!Number.isInteger(value) || (value as number) < min || (max != null && (value as number) > max)) inputError(`${label} 必须是${max == null ? `不小于 ${min}` : `${min}–${max}`}的整数或空值`);
  return value as number;
}

function asGameVersion(value: unknown, label: string): GameVersion { if (value !== "如鸢" && value !== "代号鸢") inputError(`${label} 仅支持“如鸢”或“代号鸢”`); return value; }
function asText(value: unknown, label: string): string { if (typeof value !== "string" || !value.trim()) inputError(`${label} 不能为空`); return value.trim(); }

export function createUserExport(workspace: WorkspaceStateV1, accountDisplayName: string, exportedAt = new Date().toISOString()): YuanStarDataExportV1 {
  return {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportedAt,
    gameVersion: workspace.gameVersion,
    accountDisplayName,
    bag: { currentCount: workspace.bag.currentCount, capacity: workspace.bag.capacity },
    experience: { orange: workspace.experience.orange, purple: workspace.experience.purple, white: workspace.experience.white },
    inventory: workspace.inventory.map((item) => ({ kind: item.kind, name: item.name, quality: item.quality, currentLevel: item.level, targetLevel: workspace.planTargets[item.starInstanceId] ?? item.level })),
  };
}

export function safeExportFilename(accountDisplayName: string, extension: "json" | "xlsx", date = new Date()): string {
  const safeAccount = accountDisplayName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 48) || "account";
  const stamp = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  return `YuanStar_${safeAccount}_${stamp}.${extension}`;
}

export function parseJsonExport(text: string): YuanStarDataExportV1 {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { inputError("JSON 无法解析"); }
  const root = asObject(raw, "根对象");
  if (root.schemaVersion !== DATA_EXPORT_SCHEMA_VERSION) inputError("schemaVersion 必须为 1");
  const bag = asObject(root.bag, "bag");
  const experience = asObject(root.experience, "experience");
  if (!Array.isArray(root.inventory)) inputError("inventory 必须是数组");
  const inventory = root.inventory.map((rawItem, index) => {
    const item = asObject(rawItem, `inventory[${index}]`);
    const kind = asText(item.kind, `inventory[${index}].kind`) as StarKind;
    const name = asText(item.name, `inventory[${index}].name`);
    const quality = asText(item.quality, `inventory[${index}].quality`) as Quality;
    const currentLevel = asNullableInteger(item.currentLevel, `inventory[${index}].currentLevel`, 1, 60);
    const targetLevel = asNullableInteger(item.targetLevel, `inventory[${index}].targetLevel`, 1, 60);
    if (!kinds.has(kind) || !browserCatalog.isNameForKind(name, kind)) inputError(`inventory[${index}] 的大类或标准名称不在目录中`);
    if (!qualities.has(quality) || currentLevel == null || targetLevel == null || targetLevel < currentLevel) inputError(`inventory[${index}] 的品质或等级不合法`);
    return { kind, name, quality, currentLevel, targetLevel };
  });
  return {
    schemaVersion: DATA_EXPORT_SCHEMA_VERSION,
    exportedAt: asText(root.exportedAt, "exportedAt"),
    gameVersion: asGameVersion(root.gameVersion, "gameVersion"),
    accountDisplayName: asText(root.accountDisplayName, "accountDisplayName"),
    bag: { currentCount: asNullableInteger(bag.currentCount, "bag.currentCount"), capacity: asNullableInteger(bag.capacity, "bag.capacity", 1) },
    experience: { orange: asNullableInteger(experience.orange, "experience.orange"), purple: asNullableInteger(experience.purple, "experience.purple"), white: asNullableInteger(experience.white, "experience.white") },
    inventory,
  };
}

/** Builds a replacement workspace from user-facing data only. OCR evidence and old IDs never cross this boundary. */
export function buildImportedWorkspace(data: YuanStarDataExportV1, accountId: string, currentGameVersion: GameVersion, createId: StarInstanceIdFactory = defaultStarInstanceId): WorkspaceStateV1 {
  const session = new WorkspaceSession(createEmptyWorkspace(accountId, currentGameVersion), browserCatalog, createId);
  data.inventory.forEach((item, sourceOrder) => {
    const id = session.addInstance({ kind: item.kind, name: item.name, quality: item.quality, level: item.currentLevel, equippedState: "not_evaluated", provenance: { sourceOrder, audit: { imported: true } }, manualStatus: "manual" });
    if (item.targetLevel !== item.currentLevel) session.setPlanTarget(id, item.targetLevel);
  });
  session.setBagValues(data.bag.currentCount, data.bag.capacity);
  session.setExperienceQuantities(data.experience);
  return session.state;
}

export function previewJsonImport(fileName: string, text: string, accountId: string, currentGameVersion: GameVersion, createId?: StarInstanceIdFactory): DataImportPreview {
  const data = parseJsonExport(text);
  const workspace = buildImportedWorkspace(data, accountId, currentGameVersion, createId);
  return { format: "json", fileName, inventoryCount: data.inventory.length, plannedCount: data.inventory.filter((item) => item.targetLevel !== item.currentLevel).length, bag: data.bag, experience: data.experience, workspace };
}

const starHeaders = ["游戏版本", "游戏账号名称", "大类", "星石名称", "品质", "当前等级", "计划等级", "数量"] as const;
const experienceHeaders = ["类型", "数量"] as const;
const accountHeaders = ["字段", "值"] as const;

type ExportAggregate = YuanStarDataExportV1["inventory"][number] & { quantity: number };
function aggregateInventory(inventory: YuanStarDataExportV1["inventory"]): ExportAggregate[] {
  const aggregate = new Map<string, ExportAggregate>();
  inventory.forEach((item) => {
    const key = [item.kind, item.name, item.quality, item.currentLevel, item.targetLevel].join("\u0000");
    const existing = aggregate.get(key);
    if (existing) existing.quantity += 1;
    else aggregate.set(key, { ...item, quantity: 1 });
  });
  return [...aggregate.values()];
}

export function createXlsxExport(data: YuanStarDataExportV1): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const stars: unknown[][] = [[...starHeaders], ...aggregateInventory(data.inventory).map((item) => [data.gameVersion, data.accountDisplayName, item.kind, item.name, item.quality, item.currentLevel, item.targetLevel, item.quantity])];
  const starSheet = XLSX.utils.aoa_to_sheet(stars);
  starSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  starSheet["!cols"] = [12, 18, 9, 14, 8, 10, 10, 8].map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, starSheet, "星石");
  const experienceSheet = XLSX.utils.aoa_to_sheet([[...experienceHeaders], ["橙星曜", data.experience.orange], ["紫星曜", data.experience.purple], ["白星曜", data.experience.white]]);
  experienceSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, experienceSheet, "经验星曜");
  const accountSheet = XLSX.utils.aoa_to_sheet([[...accountHeaders], ["游戏版本", data.gameVersion], ["游戏账号名称", data.accountDisplayName], ["背包数量", data.bag.currentCount], ["背包容量", data.bag.capacity]]);
  accountSheet["!freeze"] = { xSplit: 0, ySplit: 1 };
  XLSX.utils.book_append_sheet(workbook, accountSheet, "账号信息");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

function normalizeHeader(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function findSheet(workbook: XLSX.WorkBook, expected: string): XLSX.WorkSheet | undefined { return workbook.SheetNames.map((name) => workbook.Sheets[name]).find((sheet) => sheet && XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" })[0]?.some((item) => normalizeHeader(item) === expected)); }
function fieldValue(row: Record<string, unknown>, heading: string, rowNumber: number): unknown { if (!(heading in row)) inputError(`第 ${rowNumber} 行缺少“${heading}”列`); return row[heading]; }
function excelNumber(value: unknown, label: string, min = 0, max?: number): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return asNullableInteger(number, label, min, max);
}

export function parseXlsxExport(buffer: ArrayBuffer): YuanStarDataExportV1 {
  let workbook: XLSX.WorkBook;
  try { workbook = XLSX.read(buffer, { type: "array" }); } catch { inputError("XLSX 无法解析"); }
  const starsSheet = findSheet(workbook, "星石名称");
  if (!starsSheet) inputError("未找到包含“星石名称”表头的星石 sheet");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(starsSheet, { defval: "", raw: true });
  let gameVersion: GameVersion | null = null;
  let accountDisplayName = "导入账号";
  const inventory: YuanStarDataExportV1["inventory"] = [];
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const kind = asText(fieldValue(row, "大类", rowNumber), `第 ${rowNumber} 行大类`) as StarKind;
    const name = asText(fieldValue(row, "星石名称", rowNumber), `第 ${rowNumber} 行星石名称`);
    const quality = asText(fieldValue(row, "品质", rowNumber), `第 ${rowNumber} 行品质`) as Quality;
    const currentLevel = excelNumber(fieldValue(row, "当前等级", rowNumber), `第 ${rowNumber} 行当前等级`, 1, 60);
    const targetLevel = excelNumber(fieldValue(row, "计划等级", rowNumber), `第 ${rowNumber} 行计划等级`, 1, 60);
    const quantity = excelNumber(fieldValue(row, "数量", rowNumber), `第 ${rowNumber} 行数量`, 1);
    if (!kinds.has(kind) || !browserCatalog.isNameForKind(name, kind)) inputError(`第 ${rowNumber} 行星石名称或大类不在目录中`);
    if (!qualities.has(quality) || currentLevel == null || targetLevel == null || targetLevel < currentLevel || quantity == null) inputError(`第 ${rowNumber} 行品质、等级或数量不合法`);
    const version = asGameVersion(fieldValue(row, "游戏版本", rowNumber), `第 ${rowNumber} 行游戏版本`);
    if (gameVersion && gameVersion !== version) inputError("星石 sheet 内游戏版本不一致");
    gameVersion = version;
    const display = asText(fieldValue(row, "游戏账号名称", rowNumber), `第 ${rowNumber} 行游戏账号名称`);
    accountDisplayName = display;
    for (let repeat = 0; repeat < quantity; repeat += 1) inventory.push({ kind, name, quality, currentLevel, targetLevel });
  });
  if (!gameVersion) inputError("星石 sheet 至少需要一行有效数据");
  const experience = { orange: null as number | null, purple: null as number | null, white: null as number | null };
  const experienceSheet = findSheet(workbook, "类型");
  if (experienceSheet) XLSX.utils.sheet_to_json<Record<string, unknown>>(experienceSheet, { defval: "", raw: true }).forEach((row, index) => {
    const type = normalizeHeader(row["类型"]); const quantity = excelNumber(row["数量"], `经验星曜第 ${index + 2} 行数量`);
    if (type === "橙星曜") experience.orange = quantity;
    if (type === "紫星曜") experience.purple = quantity;
    if (type === "白星曜") experience.white = quantity;
  });
  const bag = { currentCount: null as number | null, capacity: null as number | null };
  const accountSheet = findSheet(workbook, "字段");
  if (accountSheet) XLSX.utils.sheet_to_json<Record<string, unknown>>(accountSheet, { defval: "", raw: true }).forEach((row) => {
    const field = normalizeHeader(row["字段"]); const value = row["值"];
    if (field === "背包数量") bag.currentCount = excelNumber(value, "账号信息背包数量");
    if (field === "背包容量") bag.capacity = excelNumber(value, "账号信息背包容量", 1);
  });
  return { schemaVersion: DATA_EXPORT_SCHEMA_VERSION, exportedAt: new Date().toISOString(), gameVersion, accountDisplayName, bag, experience, inventory };
}

export function previewXlsxImport(fileName: string, buffer: ArrayBuffer, accountId: string, currentGameVersion: GameVersion, createId?: StarInstanceIdFactory): DataImportPreview {
  const data = parseXlsxExport(buffer);
  const workspace = buildImportedWorkspace(data, accountId, currentGameVersion, createId);
  return { format: "xlsx", fileName, inventoryCount: data.inventory.length, plannedCount: data.inventory.filter((item) => item.targetLevel !== item.currentLevel).length, bag: data.bag, experience: data.experience, workspace };
}
