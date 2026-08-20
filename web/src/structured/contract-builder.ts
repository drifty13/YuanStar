import type {
  AnalysisTimingsV1,
  BrowserImageAnalysisV1,
  PageClassificationV1,
  ProvenanceSource,
} from "./contracts.js";
import type {
  ExperienceResult,
  MainStarResult,
  ScreenshotProfile,
  StructuredExperienceOutput,
  StructuredMainOutput,
} from "./types.js";
import { equippedRectForCard } from "./hierarchical-postprocess.js";
import { qualityRectForCard } from "./quality-postprocess.js";
import { observeInventoryHeader } from "./inventory-header.js";

function source(value: string | undefined): ProvenanceSource {
  if (value === "direct_ocr" || value === "visual_background" || value === "relative_anchor_colour_entropy"
    || value === "hierarchical_sort_inference" || value === "hierarchical_sort_sandwich_inference" || value === "manual_review") return value;
  return "unknown";
}

function firstWarning(values: string[] | undefined, prefixes: readonly string[]): string | null {
  return values?.find((value) => prefixes.some((prefix) => value === prefix || value.startsWith(prefix))) ?? null;
}

function profileAndBounds(profile: ScreenshotProfile, experience: boolean) {
  return {
    profile,
    contentBounds: profile.contentBounds,
    contentBoundsSource: experience ? "experience_search_bounds" : profile.evidence.filter((item) => item.startsWith("content_")).join(";") || "profile_content_bounds",
    warnings: profile.evidence.filter((item) => item.includes("rejected") || item.includes("unknown")),
  };
}

function ordinaryTimings(output: StructuredMainOutput): AnalysisTimingsV1 {
  return {
    decodeMs: output.timings.decodeMs,
    profileContentBoundsMs: output.timings.profileContentBoundsMs,
    geometryCompletenessMs: output.timings.gridCompletenessMs,
    roiCropMs: output.timings.roiCropMs,
    nameRecognitionMs: output.timings.nameRecognitionMs,
    levelRecognitionMs: output.timings.levelRecognitionMs,
    qualityRecognitionMs: output.timings.qualityRecognitionMs ?? 0,
    equippedRecognitionMs: output.timings.equippedRecognitionMs ?? 0,
    tabOcrMs: output.timings.tabOcrMs ?? 0,
    postprocessMs: output.timings.postprocessMs,
    totalMs: output.timings.totalMs,
    peakCandidateCount: output.timings.peakCandidateCount,
    ocrSessionCreationCount: output.timings.ocrSessionCreationCount ?? 0,
    ocrRecognitionCallCount: output.timings.ocrRecognitionCallCount ?? 0,
  };
}

function experienceTimings(output: StructuredExperienceOutput): AnalysisTimingsV1 {
  return {
    decodeMs: output.timings.decodeMs,
    profileContentBoundsMs: output.timings.profileContentBoundsMs,
    geometryCompletenessMs: output.timings.geometryCompletenessMs,
    roiCropMs: output.timings.roiCropMs,
    nameRecognitionMs: 0,
    levelRecognitionMs: 0,
    qualityRecognitionMs: 0,
    equippedRecognitionMs: 0,
    tabOcrMs: output.timings.tabOcrMs ?? 0,
    postprocessMs: output.timings.postprocessMs,
    totalMs: output.timings.totalMs,
    peakCandidateCount: output.timings.peakCandidateCount,
    ocrSessionCreationCount: output.timings.ocrSessionCreationCount ?? 0,
    ocrRecognitionCallCount: output.timings.ocrRecognitionCallCount ?? 0,
  };
}

function ordinaryOccurrence(output: StructuredMainOutput, result: MainStarResult, imageId: string) {
  const card = output.candidates.find((candidate) => candidate.rowIndex === result.rowIndex && candidate.columnIndex === result.columnIndex);
  if (!card) return null;
  const directName = result.directName !== undefined ? result.directName : (result.nameSource === "hierarchical_sort_sandwich_inference" ? null : result.nameNormalized);
  const directLevel = result.directLevel !== undefined ? result.directLevel : (result.levelSource === "hierarchical_sort_inference" ? null : result.level);
  const effectiveName = result.effectiveName !== undefined ? result.effectiveName : result.nameNormalized;
  const effectiveLevel = result.effectiveLevel !== undefined ? result.effectiveLevel : result.level;
  const qualityWarnings = result.qualityWarnings ?? [];
  const equippedWarnings = result.equippedWarnings ?? [];
  const warnings = [...result.reasons, ...qualityWarnings, ...equippedWarnings];
  return {
    occurrenceId: result.instanceId || `legacy-${imageId}-${result.rowIndex}-${result.columnIndex}`,
    row: result.rowIndex,
    column: result.columnIndex,
    completeness: card.completeness,
    sourceRect: {
      card: card.cardRect,
      name: card.nameRect,
      level: card.levelRect,
      quality: qualityRectForCard(card),
      equipped: equippedRectForCard(card),
    },
    directName,
    effectiveName,
    nameSource: source(result.nameSource ?? (directName == null ? "unknown" : "direct_ocr")),
    nameConfidence: result.nameConfidence,
    nameWarning: firstWarning(result.reasons, ["name_"]),
    directLevel,
    effectiveLevel,
    levelSource: source(result.levelSource ?? (directLevel == null ? "unknown" : "direct_ocr")),
    levelConfidence: result.levelConfidence,
    levelWarning: firstWarning(result.reasons, ["level_", "hierarchical_level_"]),
    quality: result.quality ?? null,
    qualitySource: source(result.qualitySource),
    qualityConfidence: result.qualityConfidence ?? 0,
    qualityWarning: qualityWarnings[0] ?? null,
    equippedState: result.equippedState ?? "not_evaluated",
    equippedSource: source(result.equippedSource),
    equippedConfidence: result.equippedConfidence ?? 0,
    equippedWarning: equippedWarnings[0] ?? null,
    rawOcrCandidates: result.ocrCandidates,
    visualEvidence: null,
    inferenceProvenance: [...(result.levelProvenance ?? []), ...(result.inferenceProvenance ?? [])],
    warnings,
    reviewRequired: result.reviewRequired ?? (result.status !== "accepted" || result.quality == null),
  };
}

function experienceOccurrence(result: ExperienceResult, completeness: "complete" | "partial_top" | "partial_bottom" | "invalid") {
  const kind = result.kind;
  return {
    occurrenceId: result.occurrenceId ?? result.instanceId,
    ordinal: result.index,
    canonicalType: kind,
    canonicalName: result.canonicalName,
    quantity: result.count,
    quantityUnknown: result.count == null,
    directEvidence: {
      kindHue: result.kindHue ?? null,
      kindConfidence: result.kindConfidence,
      countConfidence: result.countConfidence,
      rawOcrCandidates: result.ocrCandidates,
    },
    sourceRect: result.sourceRects,
    completeness,
    warnings: [...result.reasons],
    reviewRequired: result.status !== "accepted",
  };
}

export function buildBrowserImageAnalysis(
  imageId: string,
  pageClassification: PageClassificationV1,
  output: StructuredMainOutput | StructuredExperienceOutput,
  pageType: "main" | "support" | "experience",
): BrowserImageAnalysisV1 {
  const isExperience = pageType === "experience";
  if (isExperience) {
    const experience = output as StructuredExperienceOutput;
    const warnings = [...pageClassification.warning ? [pageClassification.warning] : [], ...experience.aggregate.warnings];
    return {
      schemaVersion: "1.0",
      imageId,
      pageClassification,
      profileAndBounds: profileAndBounds(experience.profile, true),
      occurrences: [],
      experienceOccurrences: experience.results.map((result) => experienceOccurrence(
        result,
        experience.candidates.find((candidate) => candidate.index === result.index)?.completeness ?? "complete",
      )),
      experienceAggregate: experience.aggregate,
      inventoryHeader: observeInventoryHeader(experience.profile, []),
      warnings,
      timings: experienceTimings(experience),
    };
  }
  const ordinary = output as StructuredMainOutput;
  const occurrences = ordinary.results.map((result) => ordinaryOccurrence(ordinary, result, imageId)).filter((item): item is NonNullable<typeof item> => item != null);
  return {
    schemaVersion: "1.0",
    imageId,
    pageClassification,
    profileAndBounds: profileAndBounds(ordinary.profile, false),
    occurrences,
    experienceOccurrences: [],
    experienceAggregate: null,
    inventoryHeader: observeInventoryHeader(ordinary.profile, []),
    warnings: [...pageClassification.warning ? [pageClassification.warning] : [], ...occurrences.flatMap((item) => item.warnings)],
    timings: ordinaryTimings(ordinary),
  };
}
