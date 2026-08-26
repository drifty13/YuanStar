export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenshotProfile {
  profileId: "phone_portrait_v1" | "phone_9_16_v1" | "tablet_portrait_v1" | "unknown_portrait_fallback";
  deviceKind: "phone" | "tablet" | "unknown";
  imageWidth: number;
  imageHeight: number;
  viewport: Rect;
  contentBounds: Rect;
  columnCount: number;
  confidence: number;
  evidence: string[];
}

export interface CircleProposal {
  centerX: number;
  centerY: number;
  radius: number;
  score: number;
  source: "canvas_ring" | "fixture";
}

export type Completeness = "complete" | "partial_top" | "partial_bottom" | "invalid";

export interface CardCandidate {
  cardId: string;
  rowIndex: number;
  columnIndex: number;
  cardRect: Rect;
  discRect: Rect;
  circle: CircleProposal;
  nameRect: Rect;
  levelRect: Rect;
  completeness: Completeness;
  evidence: string[];
}

export interface OcrCandidate {
  text: string;
  confidence: number;
  variant: string;
}

export interface MainStarResult {
  instanceId: string;
  cardId?: string;
  rowIndex: number;
  columnIndex: number;
  nameRaw: string;
  nameNormalized: string | null;
  levelRaw: string;
  level: number | null;
  nameConfidence: number;
  levelConfidence: number;
  status: "accepted" | "needs_review" | "excluded_partial";
  reasons: string[];
  ocrCandidates: { name: OcrCandidate[]; level: OcrCandidate[] };
  sourceRects: { card: Rect; name: Rect; level: Rect };
  directName?: string | null;
  effectiveName?: string | null;
  nameSource?: string;
  directLevel?: number | null;
  effectiveLevel?: number | null;
  levelSource?: string;
  levelProvenance?: string[];
  quality?: "橙" | "紫" | "蓝" | "绿" | "白" | null;
  qualitySource?: string;
  qualityConfidence?: number;
  qualityWarnings?: string[];
  equippedState?: "not_evaluated" | "equipped" | "unequipped" | "unknown";
  equippedSource?: string;
  equippedConfidence?: number;
  equippedWarnings?: string[];
  inferenceProvenance?: string[];
  reviewRequired?: boolean;
}

export interface StructuredTimings {
  decodeMs: number;
  profileContentBoundsMs: number;
  gridCompletenessMs: number;
  roiCropMs: number;
  nameRecognitionMs: number;
  levelRecognitionMs: number;
  postprocessMs: number;
  totalMs: number;
  peakCandidateCount: number;
  qualityRecognitionMs?: number;
  equippedRecognitionMs?: number;
  tabOcrMs?: number;
  ocrSessionCreationCount?: number;
  ocrRecognitionCallCount?: number;
}

export interface StructuredMainOutput {
  profile: ScreenshotProfile;
  candidates: CardCandidate[];
  results: MainStarResult[];
  timings: StructuredTimings;
  equippedClassifierCalls?: number;
}

export type SupportStarResult = MainStarResult;
export type StructuredSupportOutput = StructuredMainOutput;

export type ExperienceKind = "orange" | "purple" | "white";
export type ExperienceCanonicalName = "橙星曜" | "紫星曜" | "白星曜";

export interface ExperienceCandidate {
  itemId: string;
  index: number;
  iconRect: Rect;
  countRect: Rect;
  circle: CircleProposal;
  completeness: Completeness;
  evidence: string[];
}

export interface ExperienceResult {
  instanceId: string;
  index: number;
  canonicalName: ExperienceCanonicalName | null;
  kind: ExperienceKind | null;
  kindHue?: number | null;
  kindConfidence: number;
  countRaw: string;
  count: number | null;
  countConfidence: number;
  status: "accepted" | "needs_review" | "excluded_partial";
  reasons: string[];
  ocrCandidates: OcrCandidate[];
  sourceRects: { icon: Rect; count: Rect };
  occurrenceId?: string;
}

export interface ExperienceTimings {
  decodeMs: number;
  profileContentBoundsMs: number;
  geometryCompletenessMs: number;
  roiCropMs: number;
  typeRecognitionMs: number;
  quantityRecognitionMs: number;
  postprocessMs: number;
  totalMs: number;
  peakCandidateCount: number;
  tabOcrMs?: number;
  ocrSessionCreationCount?: number;
  ocrRecognitionCallCount?: number;
}

export interface StructuredExperienceOutput {
  profile: ScreenshotProfile;
  page: { pageType: "experience" | "unknown"; confidence: number; evidence: string[] };
  candidates: ExperienceCandidate[];
  results: ExperienceResult[];
  aggregate: {
    orangeCount: number | null;
    purpleCount: number | null;
    whiteCount: number | null;
    complete: boolean;
    warnings: string[];
  };
  timings: ExperienceTimings;
}
