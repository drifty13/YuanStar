import type { ModelCompatibility } from "../types.js";
import type {
  CardCandidate,
  ExperienceResult,
  MainStarResult,
  ScreenshotProfile,
  StructuredExperienceOutput,
  StructuredMainOutput,
  StructuredSupportOutput,
} from "./types.js";

export const BROWSER_IMAGE_ANALYSIS_SCHEMA_VERSION = "1.0" as const;

export type PageType = "main" | "support" | "experience" | "unknown";
export type Quality = "橙" | "紫" | "蓝" | "绿" | "白";
export type EquippedState = "not_evaluated" | "equipped" | "unequipped" | "unknown";
export type ProvenanceSource =
  | "direct_ocr"
  | "visual_background"
  | "relative_anchor_colour_entropy"
  | "hierarchical_sort_inference"
  | "hierarchical_sort_sandwich_inference"
  | "manual_review"
  | "unknown";

export interface BrowserImageInput {
  imageId: string;
  file: File;
}

export interface VisionAssetConfig {
  modelRoot?: string;
}

export interface ModelManifest {
  schemaVersion: typeof BROWSER_IMAGE_ANALYSIS_SCHEMA_VERSION;
  models: ModelCompatibility[];
}

export interface ConfirmedImagePool {
  imageId: string;
  pageType: Exclude<PageType, "unknown">;
}

export interface PageEvidence {
  source: "visual" | "tab_ocr" | "confirmed_pool" | "expected_page_type";
  value: string;
  confidence: number;
  rect?: Rect;
}

export interface PageClassificationV1 {
  pageType: PageType;
  visualEvidence: PageEvidence[];
  tabOcrEvidence: Array<{ text: string; confidence: number; variant?: string }>;
  confidence: number;
  warning: string | null;
  reviewRequired: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ProfileAndBoundsEvidence {
  profile: ScreenshotProfile;
  contentBounds: Rect | null;
  contentBoundsSource: string;
  warnings: string[];
}

export interface RawOcrCandidates {
  name: Array<{ text: string; confidence: number; variant: string }>;
  level: Array<{ text: string; confidence: number; variant: string }>;
}

/** Direct OCR evidence retained for fields that are not star-card attributes. */
export interface OcrEvidenceV1 {
  source: "direct_ocr";
  rect: Rect;
  rawText: string;
  normalizedText: string;
  confidence: number;
  variant: string;
}

export type NumericFieldStatusV1 = "confirmed" | "not_present" | "unreadable" | "ambiguous" | "invalid";

export interface NumericFieldObservationV1 {
  value: number | null;
  status: NumericFieldStatusV1;
  confidence: number | null;
  rawText: string | null;
  normalizedText: string | null;
  evidence: OcrEvidenceV1[];
  reviewReasonCodes: string[];
}

/** One direct OCR token detected inside the inventory ROI. Runtime-only diagnostics may display it. */
export interface InventoryOcrTokenV1 {
  rawText: string;
  normalizedText: string;
  confidence: number;
  rect: Rect;
  variant: string;
}

/** Per-image observation of the lower-right inventory header, never inferred from occurrences. */
export interface InventoryHeaderObservationV1 {
  roi: Rect;
  tokens: InventoryOcrTokenV1[];
  currentCount: NumericFieldObservationV1;
  capacity: NumericFieldObservationV1;
}

/**
 * Non-reconstructable card visual evidence used only to reject overlap matches.
 * It is a browser port of the established Python pHash and hue-histogram gate.
 */
export interface CardVisualEvidenceV1 {
  algorithm: "phash_hue_v1";
  iconBits: string;
  nameBits: string;
  levelBits: string;
  hueHistogram: number[];
}

export interface OrdinaryStarOccurrenceV1 {
  occurrenceId: string;
  row: number;
  column: number;
  completeness: "complete" | "partial_top" | "partial_bottom" | "invalid";
  sourceRect: {
    card: Rect;
    name: Rect;
    level: Rect;
    quality: Rect;
    equipped: Rect;
  };
  directName: string | null;
  effectiveName: string | null;
  nameSource: ProvenanceSource;
  nameConfidence: number;
  nameWarning: string | null;
  directLevel: number | null;
  effectiveLevel: number | null;
  levelSource: ProvenanceSource;
  levelConfidence: number;
  levelWarning: string | null;
  quality: Quality | null;
  qualitySource: ProvenanceSource;
  qualityConfidence: number;
  qualityWarning: string | null;
  equippedState: EquippedState;
  equippedSource: ProvenanceSource;
  equippedConfidence: number;
  equippedWarning: string | null;
  rawOcrCandidates: RawOcrCandidates;
  visualEvidence: CardVisualEvidenceV1 | null;
  inferenceProvenance: string[];
  warnings: string[];
  reviewRequired: boolean;
}

export interface ExperienceOccurrenceV1 {
  occurrenceId: string;
  ordinal: number;
  canonicalType: "orange" | "purple" | "white" | null;
  canonicalName: "橙星曜" | "紫星曜" | "白星曜" | null;
  quantity: number | null;
  quantityUnknown: boolean;
  directEvidence: {
    kindHue: number | null;
    kindConfidence: number;
    countConfidence: number;
    rawOcrCandidates: Array<{ text: string; confidence: number; variant: string }>;
  };
  sourceRect: { icon: Rect; count: Rect };
  completeness: "complete" | "partial_top" | "partial_bottom" | "invalid";
  warnings: string[];
  reviewRequired: boolean;
}

export interface ExperienceAggregateV1 {
  orangeCount: number | null;
  purpleCount: number | null;
  whiteCount: number | null;
  complete: boolean;
  warnings: string[];
}

export interface AnalysisTimingsV1 {
  decodeMs: number;
  profileContentBoundsMs: number;
  geometryCompletenessMs: number;
  roiCropMs: number;
  nameRecognitionMs: number;
  levelRecognitionMs: number;
  qualityRecognitionMs: number;
  equippedRecognitionMs: number;
  tabOcrMs: number;
  postprocessMs: number;
  totalMs: number;
  peakCandidateCount: number;
  ocrSessionCreationCount: number;
  ocrRecognitionCallCount: number;
}

export interface BrowserImageAnalysisV1 {
  schemaVersion: typeof BROWSER_IMAGE_ANALYSIS_SCHEMA_VERSION;
  imageId: string;
  pageClassification: PageClassificationV1;
  profileAndBounds: ProfileAndBoundsEvidence;
  occurrences: OrdinaryStarOccurrenceV1[];
  experienceOccurrences: ExperienceOccurrenceV1[];
  experienceAggregate: ExperienceAggregateV1 | null;
  inventoryHeader: InventoryHeaderObservationV1;
  warnings: string[];
  timings: AnalysisTimingsV1;
}

export interface BrowserVisionEngine {
  initialize(config: VisionAssetConfig): Promise<ModelManifest>;
  classifyImage(
    input: BrowserImageInput,
    options?: { confirmedPool?: ConfirmedImagePool },
  ): Promise<PageClassificationV1>;
  analyzeImage(
    input: BrowserImageInput,
    options?: {
      confirmedPool?: ConfirmedImagePool;
      expectedPageType?: PageType;
      /** Runtime-only diagnostics; never persisted or included in product data. */
      variantAudit?: boolean;
    },
  ): Promise<BrowserImageAnalysisV1>;
  dispose(): Promise<void>;
}

export type LegacyStructuredOutput = StructuredMainOutput | StructuredSupportOutput | StructuredExperienceOutput;
export type LegacyOrdinaryResult = MainStarResult;
export type LegacyExperienceResult = ExperienceResult;
export type LegacyCard = CardCandidate;
