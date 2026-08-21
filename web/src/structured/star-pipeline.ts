import { getOcrRuntimeMetrics, prepareRectVariants, recognizePreparedRectVariantsWithFallback } from "../ocr.js";
import { createOccurrenceId } from "../utils/id.js";
import { buildCardCandidates, findCircleProposals } from "./main-grid.js";
import { createScreenshotProfile } from "./profiles.js";
import { classifyStarResultStatus, resolveLevel, type NameResolution } from "./star-postprocess.js";
import { applyHierarchicalNameSandwich, applyHierarchicalOrder, recognizeEquippedOnDemand } from "./hierarchical-postprocess.js";
import { recognizeQuality } from "./quality-postprocess.js";
import type { OcrCandidate, StructuredMainOutput } from "./types.js";
import { imageDataForBitmap } from "./image-canvas-runtime.js";
import { canAcceptStrictLevelColorCandidate, canAcceptStrictNameColorCandidate } from "./variant-fallback.js";

type NameResolver = (candidates: OcrCandidate[]) => NameResolution;
type PreparedStructuredImage = {
  bitmap: ImageBitmap;
  imageData: ImageData;
  profile: import("./types.js").ScreenshotProfile;
};
export interface StructuredStarOptions {
  imageId?: string;
  pageType?: "main" | "support";
  /** Reuses routing-owned image state; this pipeline never closes that bitmap. */
  prepared?: PreparedStructuredImage;
  /** Shadow-audit reference mode: preserve the historical full-three recognition path. */
  forceFullVariants?: boolean;
}
function round(value: number): number { return Math.round(value * 100) / 100; }

export async function runStructuredStar(file: File, resolveName: NameResolver, options: StructuredStarOptions = {}): Promise<{ bitmap: ImageBitmap; output: StructuredMainOutput }> {
  const imageId = options.imageId ?? file.name;
  const pageType = options.pageType ?? "main";
  const totalStart = performance.now();
  const decodeStart = performance.now();
  const prepared = options.prepared;
  const bitmap = prepared?.bitmap ?? await createImageBitmap(file);
  const ownsBitmap = prepared == null;
  let ownershipTransferred = false;
  try {
  const decodedAt = performance.now();
  const imageData = prepared?.imageData ?? imageDataForBitmap(bitmap);
  const profile = prepared?.profile ?? createScreenshotProfile(imageData);
  const profiledAt = performance.now();
  const proposals = findCircleProposals(imageData, profile);
  const candidates = buildCardCandidates(proposals, profile);
  const griddedAt = performance.now();
  const results: StructuredMainOutput["results"] = [];
  let roiCropMs = 0;
  let nameRecognitionMs = 0;
  let levelRecognitionMs = 0;
  let qualityRecognitionMs = 0;
  let postprocessMs = 0;
  for (const card of candidates) {
    const base = {
      instanceId: createOccurrenceId(imageId, pageType, { row: card.rowIndex, column: card.columnIndex }), cardId: card.cardId, rowIndex: card.rowIndex, columnIndex: card.columnIndex,
      sourceRects: { card: card.cardRect, name: card.nameRect, level: card.levelRect },
    };
    if (card.completeness !== "complete") {
      results.push({
        ...base, nameRaw: "", nameNormalized: null, levelRaw: "", level: null, nameConfidence: 0, levelConfidence: 0,
        status: "excluded_partial", reasons: [...card.evidence, card.completeness], ocrCandidates: { name: [], level: [] },
        directName: null, effectiveName: null, nameSource: "unknown", directLevel: null, effectiveLevel: null,
        levelSource: "unknown", levelProvenance: [], quality: null, qualitySource: "unknown", qualityConfidence: 0,
        qualityWarnings: ["quality_incomplete_card", "quality_unknown"], equippedState: "not_evaluated",
        equippedSource: "unknown", equippedConfidence: 0, equippedWarnings: [], inferenceProvenance: [], reviewRequired: true,
      });
      continue;
    }
    const cropStart = performance.now();
    const preparedName = prepareRectVariants(bitmap, card.nameRect);
    const preparedLevel = prepareRectVariants(bitmap, card.levelRect);
    roiCropMs += performance.now() - cropStart;
    const nameStart = performance.now();
    const nameCandidates = await recognizePreparedRectVariantsWithFallback(
      preparedName,
      (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveName),
      options.forceFullVariants === true,
    );
    nameRecognitionMs += performance.now() - nameStart;
    const levelStart = performance.now();
    const levelCandidates = await recognizePreparedRectVariantsWithFallback(
      preparedLevel,
      canAcceptStrictLevelColorCandidate,
      options.forceFullVariants === true,
    );
    levelRecognitionMs += performance.now() - levelStart;
    const postStart = performance.now();
    const name = resolveName(nameCandidates);
    const level = resolveLevel(levelCandidates);
    const qualityStart = performance.now();
    const quality = recognizeQuality(imageData, card);
    const qualityFinished = performance.now();
    qualityRecognitionMs += qualityFinished - qualityStart;
    const reasons = [...name.reasons, ...level.reasons, ...quality.warnings];
    const reviewRequired = name.normalized == null || level.level == null || quality.quality == null;
    results.push({
      ...base, nameRaw: name.raw, nameNormalized: name.normalized, levelRaw: level.raw, level: level.level,
      nameConfidence: name.confidence, levelConfidence: level.confidence,
      status: reviewRequired ? "needs_review" : classifyStarResultStatus(card.completeness, name.normalized, level.level), reasons,
      ocrCandidates: { name: nameCandidates, level: levelCandidates },
      directName: name.normalized, effectiveName: name.normalized, nameSource: "direct_ocr",
      directLevel: level.level, effectiveLevel: level.level, levelSource: "direct_ocr", levelProvenance: [],
      quality: quality.quality, qualitySource: quality.source, qualityConfidence: quality.confidence,
      qualityWarnings: quality.warnings, equippedState: "not_evaluated", equippedSource: "unknown",
      equippedConfidence: 0, equippedWarnings: [], inferenceProvenance: [], reviewRequired,
    });
    const postprocessFinished = performance.now();
    postprocessMs += (postprocessFinished - postStart) - (qualityFinished - qualityStart);
  }
  const equippedStart = performance.now();
  const equipped = recognizeEquippedOnDemand(imageData, candidates, results);
  const equippedRecognitionMs = performance.now() - equippedStart;
  const hierarchicalStart = performance.now();
  let processedResults = applyHierarchicalOrder(candidates, results, equipped.evidence);
  processedResults = applyHierarchicalNameSandwich(candidates, processedResults);
  postprocessMs += performance.now() - hierarchicalStart;
  const finished = performance.now();
  const ocrMetrics = getOcrRuntimeMetrics();
  const result = {
    bitmap,
    output: {
      profile, candidates, results: processedResults, equippedClassifierCalls: equipped.calls,
      timings: {
        decodeMs: prepared ? 0 : round(decodedAt - decodeStart), profileContentBoundsMs: prepared ? 0 : round(profiledAt - decodedAt),
        gridCompletenessMs: round(griddedAt - profiledAt), roiCropMs: round(roiCropMs),
        nameRecognitionMs: round(nameRecognitionMs), levelRecognitionMs: round(levelRecognitionMs),
        postprocessMs: round(postprocessMs), totalMs: round(finished - totalStart), peakCandidateCount: proposals.length,
        qualityRecognitionMs: round(qualityRecognitionMs), equippedRecognitionMs: round(equippedRecognitionMs),
        ocrSessionCreationCount: ocrMetrics.sessionCreationCount, ocrRecognitionCallCount: ocrMetrics.recognitionCallCount,
      },
    },
  };
  ownershipTransferred = true;
  return result;
  } finally {
    if (!ownershipTransferred && ownsBitmap) bitmap.close();
  }
}
