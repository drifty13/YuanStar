import type { BrowserBatchAnalysisV1 } from "../structured/batch-orchestration.js";
import type { BrowserImageAnalysisV1 } from "../structured/contracts.js";
import { cleanName, parseLevel, resolveLevel, type NameResolution } from "../structured/star-postprocess.js";
import type { OcrCandidate } from "../structured/types.js";

export const OCR_PERF_DIAGNOSTICS_KEY = "__yuanstarOcrPerfDiagnostics" as const;

export interface OcrVariantDiagnostics {
  roiCount: number;
  variantCount: number;
  recognitionCalls: number;
  variantDistribution: Record<string, number>;
}

export interface OcrPerfImageDiagnostics {
  fileName: string;
  inventoryRecognitionMs: number;
  name: OcrVariantDiagnostics;
  level: OcrVariantDiagnostics;
  experienceCount: OcrVariantDiagnostics;
  typeRecognitionMs?: number;
  quantityRecognitionMs?: number;
  variantAudit?: OcrVariantAuditImage;
}

type NameResolver = (candidates: OcrCandidate[]) => NameResolution;

export interface VariantCandidateAudit {
  variant: string;
  rawText: string;
  confidence: number;
}

export interface NameVariantAuditRecord {
  imageId: string;
  fileName: string;
  pageType: "main" | "support";
  row: number;
  column: number;
  cardId: string;
  variants: VariantCandidateAudit[];
  v1: NameResolution & { accepted: boolean };
  v12: NameResolution & { accepted: boolean };
  official: NameResolution & { accepted: boolean; pipelineDirectName: string | null; pipelineEffectiveName: string | null; matchesPipelineDirect: boolean };
  v1MatchesFinal: boolean;
  v12MatchesFinal: boolean;
  v1WouldBeWrong: boolean;
  v12WouldBeWrong: boolean;
  v3ChangesFinalDecision: boolean;
  features: {
    exactCanonicalMatch: boolean;
    aliasMatch: boolean;
    fuzzyOrRepairMatch: boolean;
    onlyOneLegalCanonicalAcrossVariants: boolean;
    variantsConflict: boolean;
    pageType: "main" | "support";
    rawTextLength: number;
    confidenceBucket: string;
    resolverReasons: string[];
  };
}

export interface LevelVariantAuditRecord {
  imageId: string;
  fileName: string;
  pageType: "main" | "support";
  row: number;
  column: number;
  cardId: string;
  variants: VariantCandidateAudit[];
  v1: ReturnType<typeof resolveLevel>;
  v12: ReturnType<typeof resolveLevel>;
  official: ReturnType<typeof resolveLevel> & { pipelineDirectLevel: number | null; pipelineEffectiveLevel: number | null; matchesPipelineDirect: boolean };
  v1MatchesFinal: boolean;
  v12MatchesFinal: boolean;
  v1WouldBeWrong: boolean;
  v12WouldBeWrong: boolean;
  v3ChangesFinalDecision: boolean;
  features: {
    pureNumeric: boolean;
    legalOneToSixty: boolean;
    rawTextLength: number;
    repair: boolean;
    variantsConflict: boolean;
    pageType: "main" | "support";
    confidenceBucket: string;
  };
}

export interface OcrVariantAuditImage {
  name: NameVariantAuditRecord[];
  level: LevelVariantAuditRecord[];
}

type InstrumentedAnalysis = BrowserImageAnalysisV1 & {
  [OCR_PERF_DIAGNOSTICS_KEY]?: OcrPerfImageDiagnostics;
};

export interface OcrPerfReport {
  wallClockMs: number;
  imageCount: number;
  pageTypeCounts: Record<string, number>;
  timingTotals: Record<string, number>;
  timingPercentages: Record<string, number>;
  ocrCalls: Record<string, number>;
  perImage: Array<Record<string, unknown>>;
  topBottlenecks: Array<{ timing: string; totalMs: number }>;
  timingsMayOverlap: true;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

function emptyVariants(): OcrVariantDiagnostics {
  return { roiCount: 0, variantCount: 0, recognitionCalls: 0, variantDistribution: {} };
}

function copyVariants(value: OcrVariantDiagnostics | undefined): OcrVariantDiagnostics {
  return value ? {
    roiCount: value.roiCount,
    variantCount: value.variantCount,
    recognitionCalls: value.recognitionCalls,
    variantDistribution: { ...value.variantDistribution },
  } : emptyVariants();
}

export function variantsFromCandidateLengths(lengths: number[]): OcrVariantDiagnostics {
  const variantDistribution: Record<string, number> = {};
  for (const length of lengths) variantDistribution[String(length)] = (variantDistribution[String(length)] ?? 0) + 1;
  const variantCount = lengths.reduce((total, length) => total + length, 0);
  return { roiCount: lengths.length, variantCount, recognitionCalls: variantCount, variantDistribution };
}

export function attachOcrPerfImageDiagnostics(
  analysis: BrowserImageAnalysisV1,
  diagnostics: OcrPerfImageDiagnostics,
  transportable = false,
): BrowserImageAnalysisV1 {
  Object.defineProperty(analysis, OCR_PERF_DIAGNOSTICS_KEY, {
    value: diagnostics,
    enumerable: transportable,
    configurable: true,
  });
  return analysis;
}

export function readOcrPerfImageDiagnostics(analysis: BrowserImageAnalysisV1): OcrPerfImageDiagnostics | undefined {
  return (analysis as InstrumentedAnalysis)[OCR_PERF_DIAGNOSTICS_KEY];
}

export function isOcrPerfDiagnosticsEnabled(search = typeof location === "undefined" ? "" : location.search): boolean {
  return new URLSearchParams(search).get("ocrPerf") === "1";
}

export function isOcrVariantAuditEnabled(search = typeof location === "undefined" ? "" : location.search): boolean {
  const params = new URLSearchParams(search);
  return params.get("ocrPerf") === "1" && params.get("ocrVariantAudit") === "1";
}

/** Audit always forces full variants; its Console output additionally requires ocrPerf=1. */
export function isOcrVariantAuditRequested(search = typeof location === "undefined" ? "" : location.search): boolean {
  return new URLSearchParams(search).get("ocrVariantAudit") === "1";
}

function resolvedName(resolution: NameResolution): NameResolution & { accepted: boolean } {
  return { ...resolution, accepted: resolution.normalized != null };
}

function sameName(left: string | null, right: string | null): boolean { return left === right; }
function sameLevel(left: number | null, right: number | null): boolean { return left === right; }
function confidenceBucket(confidence: number): string {
  if (confidence >= 0.95) return "0.95-1.00";
  if (confidence >= 0.9) return "0.90-0.949";
  if (confidence >= 0.8) return "0.80-0.899";
  return "below-0.80";
}

export function createNameVariantAuditRecord(input: {
  imageId: string;
  fileName: string;
  pageType: "main" | "support";
  row: number;
  column: number;
  cardId: string;
  candidates: OcrCandidate[];
  resolveName: NameResolver;
  pipelineDirectName: string | null;
  pipelineEffectiveName: string | null;
}): NameVariantAuditRecord {
  const variants = input.candidates.map((candidate) => ({ variant: candidate.variant, rawText: candidate.text, confidence: candidate.confidence }));
  const v1 = resolvedName(input.resolveName(input.candidates.slice(0, 1)));
  const v12 = resolvedName(input.resolveName(input.candidates.slice(0, 2)));
  const all = resolvedName(input.resolveName(input.candidates));
  const individual = input.candidates.map((candidate) => input.resolveName([candidate]).normalized);
  const legalCanonical = new Set(individual.filter((value): value is string => value != null));
  const cleaned = cleanName(input.candidates[0]?.text ?? "");
  return {
    imageId: input.imageId, fileName: input.fileName, pageType: input.pageType, row: input.row, column: input.column, cardId: input.cardId, variants,
    v1,
    v12,
    official: {
      ...all,
      pipelineDirectName: input.pipelineDirectName,
      pipelineEffectiveName: input.pipelineEffectiveName,
      matchesPipelineDirect: sameName(all.normalized, input.pipelineDirectName),
    },
    v1MatchesFinal: sameName(v1.normalized, all.normalized),
    v12MatchesFinal: sameName(v12.normalized, all.normalized),
    v1WouldBeWrong: !sameName(v1.normalized, all.normalized),
    v12WouldBeWrong: !sameName(v12.normalized, all.normalized),
    v3ChangesFinalDecision: !sameName(v12.normalized, all.normalized),
    features: {
      exactCanonicalMatch: v1.normalized != null && cleaned === v1.normalized,
      aliasMatch: v1.normalized != null && cleaned !== v1.normalized,
      fuzzyOrRepairMatch: v1.normalized != null && input.candidates[0]?.text !== cleaned,
      onlyOneLegalCanonicalAcrossVariants: legalCanonical.size === 1,
      variantsConflict: legalCanonical.size > 1,
      pageType: input.pageType,
      rawTextLength: (input.candidates[0]?.text ?? "").length,
      confidenceBucket: confidenceBucket(input.candidates[0]?.confidence ?? 0),
      resolverReasons: [...v1.reasons],
    },
  };
}

export function createLevelVariantAuditRecord(input: {
  imageId: string;
  fileName: string;
  pageType: "main" | "support";
  row: number;
  column: number;
  cardId: string;
  candidates: OcrCandidate[];
  pipelineDirectLevel: number | null;
  pipelineEffectiveLevel: number | null;
}): LevelVariantAuditRecord {
  const variants = input.candidates.map((candidate) => ({ variant: candidate.variant, rawText: candidate.text, confidence: candidate.confidence }));
  const v1 = resolveLevel(input.candidates.slice(0, 1));
  const v12 = resolveLevel(input.candidates.slice(0, 2));
  const all = resolveLevel(input.candidates);
  const parsed = input.candidates.map((candidate) => parseLevel(candidate.text));
  const values = new Set(parsed.filter((value): value is number => value != null));
  const raw = input.candidates[0]?.text ?? "";
  return {
    imageId: input.imageId, fileName: input.fileName, pageType: input.pageType, row: input.row, column: input.column, cardId: input.cardId, variants,
    v1,
    v12,
    official: { ...all, pipelineDirectLevel: input.pipelineDirectLevel, pipelineEffectiveLevel: input.pipelineEffectiveLevel, matchesPipelineDirect: sameLevel(all.level, input.pipelineDirectLevel) },
    v1MatchesFinal: sameLevel(v1.level, all.level),
    v12MatchesFinal: sameLevel(v12.level, all.level),
    v1WouldBeWrong: !sameLevel(v1.level, all.level),
    v12WouldBeWrong: !sameLevel(v12.level, all.level),
    v3ChangesFinalDecision: !sameLevel(v12.level, all.level),
    features: {
      pureNumeric: /^\d+$/u.test(raw),
      legalOneToSixty: parseLevel(raw) != null,
      rawTextLength: raw.length,
      repair: raw !== raw.replace(/[Oo]/gu, "0"),
      variantsConflict: values.size > 1,
      pageType: input.pageType,
      confidenceBucket: confidenceBucket(input.candidates[0]?.confidence ?? 0),
    },
  };
}

type StrategyEstimate = { estimated: true; fullRecognitionCalls: number; estimatedRecognitionCalls: number; estimatedCallReduction: number; estimatedCallReductionPercent: number };

export interface OcrVariantAuditReport {
  name: {
    roiCount: number;
    v1MatchesFinal: number;
    v12MatchesFinal: number;
    v3ChangesFinal: number;
    v1Mismatches: NameVariantAuditRecord[];
    v12Mismatches: NameVariantAuditRecord[];
    featureBuckets: Record<string, { roiCount: number; v1Mismatches: number; v12Mismatches: number }>;
    records: NameVariantAuditRecord[];
  };
  level: {
    roiCount: number;
    v1MatchesFinal: number;
    v12MatchesFinal: number;
    v3ChangesFinal: number;
    v1Mismatches: LevelVariantAuditRecord[];
    v12Mismatches: LevelVariantAuditRecord[];
    featureBuckets: Record<string, { roiCount: number; v1Mismatches: number; v12Mismatches: number }>;
    records: LevelVariantAuditRecord[];
  };
  estimatedStrategies: {
    name: Record<"allV1" | "v1SafeElseAll" | "v1SafeThenV12Stable", StrategyEstimate>;
    level: Record<"allV1" | "v1SafeElseAll" | "v1SafeThenV12Stable", StrategyEstimate>;
    combined: Record<"allV1" | "v1SafeElseAll" | "v1SafeThenV12Stable", StrategyEstimate>;
  };
  estimatedNotBenchmarked: true;
}

function bucketRecords<T extends { v1WouldBeWrong: boolean; v12WouldBeWrong: boolean }>(records: T[], key: (record: T) => string): Record<string, { roiCount: number; v1Mismatches: number; v12Mismatches: number }> {
  const buckets: Record<string, { roiCount: number; v1Mismatches: number; v12Mismatches: number }> = {};
  for (const record of records) {
    const item = buckets[key(record)] ?? { roiCount: 0, v1Mismatches: 0, v12Mismatches: 0 };
    item.roiCount += 1;
    if (record.v1WouldBeWrong) item.v1Mismatches += 1;
    if (record.v12WouldBeWrong) item.v12Mismatches += 1;
    buckets[key(record)] = item;
  }
  return buckets;
}

function estimateStrategy<T extends { variants: VariantCandidateAudit[] }>(records: T[], estimateCalls: (record: T) => number): StrategyEstimate {
  const fullRecognitionCalls = records.reduce((total, record) => total + record.variants.length, 0);
  const estimatedRecognitionCalls = records.reduce((total, record) => total + estimateCalls(record), 0);
  const estimatedCallReduction = fullRecognitionCalls - estimatedRecognitionCalls;
  return {
    estimated: true,
    fullRecognitionCalls,
    estimatedRecognitionCalls,
    estimatedCallReduction,
    estimatedCallReductionPercent: fullRecognitionCalls ? round(estimatedCallReduction / fullRecognitionCalls * 100) : 0,
  };
}

function combineEstimates(name: StrategyEstimate, level: StrategyEstimate): StrategyEstimate {
  const fullRecognitionCalls = name.fullRecognitionCalls + level.fullRecognitionCalls;
  const estimatedRecognitionCalls = name.estimatedRecognitionCalls + level.estimatedRecognitionCalls;
  const estimatedCallReduction = fullRecognitionCalls - estimatedRecognitionCalls;
  return { estimated: true, fullRecognitionCalls, estimatedRecognitionCalls, estimatedCallReduction, estimatedCallReductionPercent: fullRecognitionCalls ? round(estimatedCallReduction / fullRecognitionCalls * 100) : 0 };
}

function nameV1Safe(record: NameVariantAuditRecord): boolean {
  return record.v1.accepted && record.features.exactCanonicalMatch && !record.features.fuzzyOrRepairMatch && record.v1.reasons.length === 0;
}

function nameV12Stable(record: NameVariantAuditRecord): boolean {
  return record.v12.accepted && record.v1.normalized === record.v12.normalized && record.v1.reasons.length === 0 && record.v12.reasons.length === 0;
}

function levelV1Safe(record: LevelVariantAuditRecord): boolean {
  return record.v1.level != null && record.features.pureNumeric && record.features.legalOneToSixty && !record.features.repair && record.v1.reasons.length === 0;
}

function levelV12Stable(record: LevelVariantAuditRecord): boolean {
  return record.v12.level != null && record.v1.level === record.v12.level && record.v1.reasons.length === 0 && record.v12.reasons.length === 0;
}

function strategySet<T extends { variants: VariantCandidateAudit[] }>(records: T[], v1Safe: (record: T) => boolean, v12Stable: (record: T) => boolean): Record<"allV1" | "v1SafeElseAll" | "v1SafeThenV12Stable", StrategyEstimate> {
  return {
    allV1: estimateStrategy(records, (record) => Math.min(1, record.variants.length)),
    v1SafeElseAll: estimateStrategy(records, (record) => v1Safe(record) ? Math.min(1, record.variants.length) : record.variants.length),
    v1SafeThenV12Stable: estimateStrategy(records, (record) => v1Safe(record) ? Math.min(1, record.variants.length) : v12Stable(record) ? Math.min(2, record.variants.length) : record.variants.length),
  };
}

export function createOcrVariantAuditReport(batch: BrowserBatchAnalysisV1): OcrVariantAuditReport {
  const nameRecords: NameVariantAuditRecord[] = [];
  const levelRecords: LevelVariantAuditRecord[] = [];
  for (const image of batch.images) {
    if (!image.analysis) continue;
    const audit = readOcrPerfImageDiagnostics(image.analysis)?.variantAudit;
    if (!audit) continue;
    nameRecords.push(...audit.name);
    levelRecords.push(...audit.level);
  }
  const nameStrategies = strategySet(nameRecords, nameV1Safe, nameV12Stable);
  const levelStrategies = strategySet(levelRecords, levelV1Safe, levelV12Stable);
  return {
    name: {
      roiCount: nameRecords.length,
      v1MatchesFinal: nameRecords.filter((record) => record.v1MatchesFinal).length,
      v12MatchesFinal: nameRecords.filter((record) => record.v12MatchesFinal).length,
      v3ChangesFinal: nameRecords.filter((record) => record.v3ChangesFinalDecision).length,
      v1Mismatches: nameRecords.filter((record) => record.v1WouldBeWrong),
      v12Mismatches: nameRecords.filter((record) => record.v12WouldBeWrong),
      featureBuckets: bucketRecords(nameRecords, (record) => JSON.stringify(record.features)),
      records: nameRecords,
    },
    level: {
      roiCount: levelRecords.length,
      v1MatchesFinal: levelRecords.filter((record) => record.v1MatchesFinal).length,
      v12MatchesFinal: levelRecords.filter((record) => record.v12MatchesFinal).length,
      v3ChangesFinal: levelRecords.filter((record) => record.v3ChangesFinalDecision).length,
      v1Mismatches: levelRecords.filter((record) => record.v1WouldBeWrong),
      v12Mismatches: levelRecords.filter((record) => record.v12WouldBeWrong),
      featureBuckets: bucketRecords(levelRecords, (record) => JSON.stringify(record.features)),
      records: levelRecords,
    },
    estimatedStrategies: {
      name: nameStrategies,
      level: levelStrategies,
      combined: {
        allV1: combineEstimates(nameStrategies.allV1, levelStrategies.allV1),
        v1SafeElseAll: combineEstimates(nameStrategies.v1SafeElseAll, levelStrategies.v1SafeElseAll),
        v1SafeThenV12Stable: combineEstimates(nameStrategies.v1SafeThenV12Stable, levelStrategies.v1SafeThenV12Stable),
      },
    },
    estimatedNotBenchmarked: true,
  };
}

export function logOcrVariantAuditReport(report: OcrVariantAuditReport, output: Pick<Console, "group" | "groupEnd" | "log" | "table"> = console): void {
  output.group("[YuanStar OCR VARIANT AUDIT]");
  output.log("NAME");
  output.table([{ "ROI total": report.name.roiCount, "v1 matches final": report.name.v1MatchesFinal, "v1+v2 matches final": report.name.v12MatchesFinal, "v3 actually changes final": report.name.v3ChangesFinal, "v1 wrong vs final": report.name.v1Mismatches.length, "v1+v2 wrong vs final": report.name.v12Mismatches.length }]);
  output.log("LEVEL");
  output.table([{ "ROI total": report.level.roiCount, "v1 matches final": report.level.v1MatchesFinal, "v1+v2 matches final": report.level.v12MatchesFinal, "v3 actually changes final": report.level.v3ChangesFinal, "v1 wrong vs final": report.level.v1Mismatches.length, "v1+v2 wrong vs final": report.level.v12Mismatches.length }]);
  output.log("Feature buckets:");
  output.table({ name: report.name.featureBuckets, level: report.level.featureBuckets });
  output.log("Estimated, not benchmarked call savings:");
  output.table(report.estimatedStrategies.combined);
  output.log("[YuanStar OCR VARIANT AUDIT JSON]", JSON.stringify(report, null, 2));
  output.groupEnd();
}

export function emitOcrVariantAuditReportIfEnabled(
  report: OcrVariantAuditReport,
  search?: string,
  output?: Pick<Console, "group" | "groupEnd" | "log" | "table">,
): boolean {
  if (!isOcrVariantAuditEnabled(search)) return false;
  logOcrVariantAuditReport(report, output);
  return true;
}

export function createOcrPerfReport(batch: BrowserBatchAnalysisV1, wallClockMs: number): OcrPerfReport {
  const timingTotals: Record<string, number> = {
    decodeMs: 0,
    profileContentBoundsMs: 0,
    geometryCompletenessMs: 0,
    roiCropMs: 0,
    nameRecognitionMs: 0,
    levelRecognitionMs: 0,
    qualityRecognitionMs: 0,
    equippedRecognitionMs: 0,
    tabOcrMs: 0,
    postprocessMs: 0,
    inventoryRecognitionMs: 0,
    typeRecognitionMs: 0,
    quantityRecognitionMs: 0,
  };
  const ocrCalls: Record<string, number> = {
    totalRecognitionCalls: 0,
    totalSessionCreationCount: 0,
    nameRoiCount: 0,
    nameVariantCount: 0,
    nameRecognitionCalls: 0,
    levelRoiCount: 0,
    levelVariantCount: 0,
    levelRecognitionCalls: 0,
    experienceCountRoiCount: 0,
    experienceCountVariantCount: 0,
    experienceCountRecognitionCalls: 0,
  };
  const pageTypeCounts: Record<string, number> = {};
  const perImage: Array<Record<string, unknown>> = [];
  const aggregateVariantDistribution = (prefix: "name" | "level" | "experienceCount", variants: OcrVariantDiagnostics): void => {
    for (const [count, images] of Object.entries(variants.variantDistribution)) {
      const key = `${prefix}VariantDistribution_${count}`;
      ocrCalls[key] = (ocrCalls[key] ?? 0) + images;
    }
  };

  for (const image of batch.images) {
    if (!image.analysis) continue;
    const { analysis } = image;
    const diagnostics = readOcrPerfImageDiagnostics(analysis);
    const name = copyVariants(diagnostics?.name);
    const level = copyVariants(diagnostics?.level);
    const experienceCount = copyVariants(diagnostics?.experienceCount);
    const pageType = analysis.pageClassification.pageType;
    pageTypeCounts[pageType] = (pageTypeCounts[pageType] ?? 0) + 1;
    const imageTimings = {
      decodeMs: analysis.timings.decodeMs,
      profileContentBoundsMs: analysis.timings.profileContentBoundsMs,
      geometryCompletenessMs: analysis.timings.geometryCompletenessMs,
      roiCropMs: analysis.timings.roiCropMs,
      nameRecognitionMs: analysis.timings.nameRecognitionMs,
      levelRecognitionMs: analysis.timings.levelRecognitionMs,
      qualityRecognitionMs: analysis.timings.qualityRecognitionMs,
      equippedRecognitionMs: analysis.timings.equippedRecognitionMs,
      tabOcrMs: analysis.timings.tabOcrMs,
      postprocessMs: analysis.timings.postprocessMs,
      totalMs: analysis.timings.totalMs,
      inventoryRecognitionMs: diagnostics?.inventoryRecognitionMs ?? 0,
      ...(diagnostics?.typeRecognitionMs === undefined ? {} : { typeRecognitionMs: diagnostics.typeRecognitionMs }),
      ...(diagnostics?.quantityRecognitionMs === undefined ? {} : { quantityRecognitionMs: diagnostics.quantityRecognitionMs }),
    };
    for (const [key, value] of Object.entries(imageTimings)) if (key !== "totalMs") timingTotals[key] = (timingTotals[key] ?? 0) + value;
    ocrCalls.totalRecognitionCalls = (ocrCalls.totalRecognitionCalls ?? 0) + analysis.timings.ocrRecognitionCallCount;
    ocrCalls.totalSessionCreationCount = (ocrCalls.totalSessionCreationCount ?? 0) + analysis.timings.ocrSessionCreationCount;
    for (const [prefix, variants] of [["name", name], ["level", level], ["experienceCount", experienceCount]] as const) {
      ocrCalls[`${prefix}RoiCount`] = (ocrCalls[`${prefix}RoiCount`] ?? 0) + variants.roiCount;
      ocrCalls[`${prefix}VariantCount`] = (ocrCalls[`${prefix}VariantCount`] ?? 0) + variants.variantCount;
      ocrCalls[`${prefix}RecognitionCalls`] = (ocrCalls[`${prefix}RecognitionCalls`] ?? 0) + variants.recognitionCalls;
      aggregateVariantDistribution(prefix, variants);
    }
    perImage.push({
      imageId: analysis.imageId,
      fileName: diagnostics?.fileName ?? analysis.imageId,
      pageType,
      timings: imageTimings,
      ocrSessionCreationCount: analysis.timings.ocrSessionCreationCount,
      ocrRecognitionCallCount: analysis.timings.ocrRecognitionCallCount,
      variantStats: { name, level, experienceCount },
    });
  }

  const roundedWallClockMs = round(wallClockMs);
  const timingPercentages = Object.fromEntries(Object.entries(timingTotals).map(([key, value]) => [key, roundedWallClockMs ? round(value / roundedWallClockMs * 100) : 0]));
  const topBottlenecks = Object.entries(timingTotals)
    .map(([timing, totalMs]) => ({ timing, totalMs: round(totalMs) }))
    .sort((left, right) => right.totalMs - left.totalMs || left.timing.localeCompare(right.timing))
    .slice(0, 3);
  return {
    wallClockMs: roundedWallClockMs,
    imageCount: perImage.length,
    pageTypeCounts,
    timingTotals: Object.fromEntries(Object.entries(timingTotals).map(([key, value]) => [key, round(value)])),
    timingPercentages,
    ocrCalls,
    perImage,
    topBottlenecks,
    timingsMayOverlap: true,
  };
}

export function logOcrPerfReport(report: OcrPerfReport, output: Pick<Console, "group" | "groupEnd" | "log" | "table"> = console): void {
  output.group("[YuanStar OCR PERF]");
  output.log("wallClockMs:", report.wallClockMs);
  output.log("images:", report.imageCount, report.pageTypeCounts);
  output.log("Timing totals:");
  output.table(report.timingTotals);
  output.log("OCR calls:");
  output.table(report.ocrCalls);
  output.log("Top bottlenecks:");
  output.table(report.topBottlenecks);
  output.log("[YuanStar OCR PERF JSON]", JSON.stringify(report, null, 2));
  output.groupEnd();
}

export function emitOcrPerfReportIfEnabled(
  report: OcrPerfReport,
  search?: string,
  output?: Pick<Console, "group" | "groupEnd" | "log" | "table">,
): boolean {
  if (!isOcrPerfDiagnosticsEnabled(search)) return false;
  logOcrPerfReport(report, output);
  return true;
}
