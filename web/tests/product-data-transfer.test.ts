import { createStarCatalog } from "../src/business/catalog.js";
import { createEmptyWorkspace } from "../src/business/model.js";
import { WorkspaceSession } from "../src/business/session.js";
import { buildImportedWorkspace, createUserExport, createXlsxExport, parseJsonExport, parseXlsxExport, previewJsonImport, previewXlsxImport } from "../src/product-data-transfer.js";
import * as XLSX from "xlsx";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

const catalog = createStarCatalog([{ name: "太阳", kind: "主星", aliases: [], displayGroup: null, usageTags: [], rawEffectText: null, description: null }], {});
const session = new WorkspaceSession(createEmptyWorkspace("export-test", "代号鸢"), catalog, () => "export-star");
const id = session.addInstance({ kind: "主星", name: "太阳", level: 40, quality: "橙", equippedState: "not_evaluated", provenance: { sourceOrder: 0 }, manualStatus: "manual" });
session.setPlanTarget(id, 60); session.setBagValues(4, 10); session.setExperienceQuantities({ orange: 2, purple: 9, white: 16 });
const exported = createUserExport(session.state, "验收账号", "2026-08-12T00:00:00.000Z");
expect(!JSON.stringify(exported).includes("starInstanceId") && exported.schemaVersion === 1, "JSON export must hide internal IDs and carry schema version");
const parsed = parseJsonExport(JSON.stringify(exported));
expect(parsed.inventory[0]?.targetLevel === 60 && parsed.bag.currentCount === 4 && parsed.experience.purple === 9, "JSON export must round trip inventory, plan, bag and experience");
let invalidRejected = false; try { parseJsonExport("{bad json"); } catch { invalidRejected = true; }
expect(invalidRejected, "invalid JSON must be rejected");
let fresh = 0;
const imported = buildImportedWorkspace(parsed, "same-account", "代号鸢", () => `fresh-${++fresh}`);
expect(imported.accountId === "same-account" && imported.inventory[0]?.starInstanceId === "fresh-1" && Object.keys(imported.importReview.occurrences).length === 0, "replacement import must keep account identity and generate fresh manual-only IDs");
const preview = previewJsonImport("data.json", JSON.stringify(exported), "same-account", "代号鸢", (() => { let number = 0; return () => `preview-${++number}`; })());
expect(preview.inventoryCount === exported.inventory.length && preview.workspace.inventory.length === exported.inventory.length, "JSON preview must be a full replacement snapshot");
const xlsx = createXlsxExport({ ...exported, inventory: [...exported.inventory, { ...exported.inventory[0]! }] });
const workbook = XLSX.read(xlsx, { type: "array" });
const rawStars = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["星石"]!, { header: 1, defval: "" });
expect(JSON.stringify(rawStars[0]) === JSON.stringify(["游戏版本", "游戏账号名称", "大类", "星石名称", "品质", "当前等级", "计划等级", "数量"]) && rawStars.length === 2 && rawStars[1]?.[7] === 2, "XLSX must keep frozen export fields and aggregate identical records");
const parsedXlsx = parseXlsxExport(xlsx);
expect(parsedXlsx.inventory.length === exported.inventory.length + 1 && parsedXlsx.experience.purple === 9 && parsedXlsx.bag.capacity === 10, "XLSX must aggregate/export then expand quantity with experience and bag");
const xlsxPreview = previewXlsxImport("data.xlsx", xlsx, "same-account", "代号鸢", (() => { let number = 0; return () => `xlsx-${++number}`; })());
expect(xlsxPreview.workspace.inventory.length === parsedXlsx.inventory.length, "XLSX preview must produce a replacement workspace");
const invalidBook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(invalidBook, XLSX.utils.aoa_to_sheet([["游戏版本", "游戏账号名称", "大类", "星石名称", "品质", "当前等级", "计划等级", "数量"], ["代号鸢", "验收账号", "主星", "不存在", "橙", 1, 60, 1]]), "星石");
let invalidXlsxRejected = false; try { parseXlsxExport(XLSX.write(invalidBook, { type: "array", bookType: "xlsx" }) as ArrayBuffer); } catch { invalidXlsxRejected = true; }
expect(invalidXlsxRejected, "invalid XLSX rows must be rejected with a clear error");
console.log("product data transfer checks passed");
