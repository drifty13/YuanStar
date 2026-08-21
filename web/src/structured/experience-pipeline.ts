import { prepareRectVariants, recognizePreparedRectVariants } from "../ocr.js";
import { createOccurrenceId } from "../utils/id.js";
import { buildExperienceCandidates, findExperienceCircles, selectedExperienceTabEvidence } from "./experience-geometry.js";
import { aggregateExperience, classifyExperienceKind, EXPERIENCE_CANONICAL, experienceStatus, resolveExperienceCount } from "./experience-postprocess.js";
import { createScreenshotProfile } from "./profiles.js";
import type { StructuredExperienceOutput } from "./types.js";
import { imageDataForBitmap } from "./image-canvas-runtime.js";

export interface StructuredExperienceOptions {
  imageId?: string;
  /** Reuses routing-owned image state; this pipeline never closes that bitmap. */
  prepared?: {
    bitmap: ImageBitmap;
    imageData: ImageData;
    profile: import("./types.js").ScreenshotProfile;
  };
  pageEvidence?: { selected: boolean; confidence: number; evidence: string[] };
  tabOcrMs?: number;
}

function round(value: number): number { return Math.round(value * 100) / 100; }

export async function runStructuredExperience(file: File, options: StructuredExperienceOptions = {}): Promise<{ bitmap: ImageBitmap; output: StructuredExperienceOutput }> {
  const imageId = options.imageId ?? file.name;
  const totalStart = performance.now();
  const decodeStart = performance.now();
  const prepared = options.prepared;
  const bitmap = prepared?.bitmap ?? await createImageBitmap(file);
  const ownsBitmap = prepared == null;
  let ownershipTransferred = false;
  try {
  const decodedAt = performance.now();
  const imageData = prepared?.imageData ?? imageDataForBitmap(bitmap);
  const baseProfile = prepared?.profile ?? createScreenshotProfile(imageData);
  const pageEvidence = options.pageEvidence ?? selectedExperienceTabEvidence(imageData, baseProfile.viewport);
  const profiledAt = performance.now();
  const geometry = findExperienceCircles(imageData, baseProfile, pageEvidence.selected);
  const profile = { ...baseProfile, contentBounds: geometry.bounds, columnCount: 3 };
  const candidates = buildExperienceCandidates(geometry.row, geometry.bounds);
  const geometrizedAt = performance.now();
  const results: StructuredExperienceOutput["results"] = [];
  let roiCropMs = 0;
  let typeRecognitionMs = 0;
  let quantityRecognitionMs = 0;
  let postprocessMs = 0;
  for (const candidate of candidates) {
    const base = {
      instanceId: createOccurrenceId(imageId, "experience", { ordinal: candidate.index }),
      index: candidate.index,
      sourceRects: { icon: candidate.iconRect, count: candidate.countRect },
    };
    if (candidate.completeness !== "complete") {
      results.push({
        ...base, canonicalName: null, kind: null, kindConfidence: 0, countRaw: "", count: null,
        countConfidence: 0, status: "excluded_partial", reasons: [...candidate.evidence], ocrCandidates: [], occurrenceId: base.instanceId,
      });
      continue;
    }
    const typeStart = performance.now();
    const kind = classifyExperienceKind(imageData, candidate.iconRect);
    typeRecognitionMs += performance.now() - typeStart;
    const cropStart = performance.now();
    const prepared = prepareRectVariants(bitmap, candidate.countRect);
    roiCropMs += performance.now() - cropStart;
    const quantityStart = performance.now();
    const ocrCandidates = await recognizePreparedRectVariants(prepared);
    quantityRecognitionMs += performance.now() - quantityStart;
    const postStart = performance.now();
    const count = resolveExperienceCount(ocrCandidates);
    const status = experienceStatus(candidate.completeness, kind.kind, count.count);
    results.push({
      ...base,
      canonicalName: kind.kind ? EXPERIENCE_CANONICAL[kind.kind] : null,
      kind: kind.kind,
      kindHue: kind.hue,
      kindConfidence: kind.confidence,
      countRaw: count.raw,
      count: count.count,
      countConfidence: count.confidence,
      status,
      reasons: [...(kind.kind ? [] : ["experience_icon_unclassified"]), ...count.reasons],
      ocrCandidates,
      occurrenceId: base.instanceId,
    });
    postprocessMs += performance.now() - postStart;
  }
  const aggregateStart = performance.now();
  const aggregate = aggregateExperience(results, { selectedTab: pageEvidence.selected, viewportCropped: false });
  postprocessMs += performance.now() - aggregateStart;
  const finished = performance.now();
  const result: { bitmap: ImageBitmap; output: StructuredExperienceOutput } = {
    bitmap,
    output: {
      profile,
      page: {
        pageType: pageEvidence.selected ? "experience" : "unknown",
        confidence: pageEvidence.confidence,
        evidence: pageEvidence.evidence,
      },
      candidates,
      results,
      aggregate,
      timings: {
        decodeMs: prepared ? 0 : round(decodedAt - decodeStart),
        profileContentBoundsMs: prepared ? 0 : round(profiledAt - decodedAt),
        geometryCompletenessMs: round(geometrizedAt - profiledAt),
        roiCropMs: round(roiCropMs),
        typeRecognitionMs: round(typeRecognitionMs),
        quantityRecognitionMs: round(quantityRecognitionMs),
        postprocessMs: round(postprocessMs),
        totalMs: round(finished - totalStart),
        peakCandidateCount: geometry.proposals.length,
        tabOcrMs: options.tabOcrMs ?? 0,
      },
    },
  };
  ownershipTransferred = true;
  return result;
  } finally {
    if (!ownershipTransferred && ownsBitmap) bitmap.close();
  }
}
