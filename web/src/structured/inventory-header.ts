import type {
  InventoryHeaderObservationV1,
  InventoryOcrTokenV1,
  NumericFieldObservationV1,
  OcrEvidenceV1,
  Rect,
} from "./contracts.js";
import type { ScreenshotProfile } from "./types.js";

const COUNT_PATTERN = /([0-9]{1,4})\/([0-9]{1,4})/;
export const INVENTORY_CONFIDENCE_THRESHOLD = .65;

export interface InventoryTokenCandidate {
  text: string;
  confidence: number;
  rect?: Rect;
  variant: string;
}

function clipRect(rect: Rect, bounds: Rect): Rect {
  const x = Math.max(bounds.x, rect.x);
  const y = Math.max(bounds.y, rect.y);
  const right = Math.min(bounds.x + bounds.width, rect.x + rect.width);
  const bottom = Math.min(bounds.y + bounds.height, rect.y + rect.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

/** Focus the lower-right count pill, excluding the neighboring bottom toolbar controls. */
export function inventoryHeaderRoi(profile: ScreenshotProfile): Rect {
  const viewport = profile.viewport;
  return clipRect({
    x: viewport.x + Math.floor(viewport.width * 0.75),
    y: viewport.y + Math.floor(viewport.height * 0.87),
    width: Math.floor(viewport.width * 0.19),
    height: Math.floor(viewport.height * 0.09),
  }, viewport);
}

export function normalizeInventoryText(text: string): string {
  return text.replace(/[Oo]/g, "0").replace(/\s+/g, "");
}

function emptyField(status: NumericFieldObservationV1["status"], reason: string, evidence: OcrEvidenceV1[] = []): NumericFieldObservationV1 {
  const bestEvidence = [...evidence].sort((left, right) => right.confidence - left.confidence || left.variant.localeCompare(right.variant))[0] ?? null;
  return {
    value: null, status, confidence: bestEvidence?.confidence ?? null,
    rawText: bestEvidence?.rawText ?? null, normalizedText: bestEvidence?.normalizedText ?? null,
    evidence, reviewReasonCodes: [reason],
  };
}

function tokenSort(left: InventoryOcrTokenV1, right: InventoryOcrTokenV1): number {
  return left.rect.x - right.rect.x || left.rect.y - right.rect.y || left.variant.localeCompare(right.variant);
}

function horizontallyAdjacent(left: InventoryOcrTokenV1, right: InventoryOcrTokenV1): boolean {
  const leftCenter = left.rect.y + left.rect.height / 2;
  const rightCenter = right.rect.y + right.rect.height / 2;
  const lineTolerance = Math.max(left.rect.height, right.rect.height) * .75;
  const gap = right.rect.x - (left.rect.x + left.rect.width);
  const gapTolerance = Math.max(12, Math.max(left.rect.height, right.rect.height) * 1.5);
  return Math.abs(leftCenter - rightCenter) <= lineTolerance && gap >= -Math.min(left.rect.width, right.rect.width) * .2 && gap <= gapTolerance;
}

function mergedCandidate(tokens: InventoryOcrTokenV1[]): { text: string; confidence: number; rect: Rect; variant: string } {
  const first = tokens[0]!;
  const right = Math.max(...tokens.map((token) => token.rect.x + token.rect.width));
  const bottom = Math.max(...tokens.map((token) => token.rect.y + token.rect.height));
  return {
    text: tokens.map((token) => token.rawText).join(""),
    confidence: Math.min(...tokens.map((token) => token.confidence)),
    rect: { x: first.rect.x, y: Math.min(...tokens.map((token) => token.rect.y)), width: right - first.rect.x, height: bottom - Math.min(...tokens.map((token) => token.rect.y)) },
    variant: "inventory_token_merge",
  };
}

function tokenCandidates(tokens: InventoryOcrTokenV1[]): Array<{ text: string; confidence: number; rect: Rect; variant: string }> {
  const candidates = tokens.map((token) => ({ text: token.rawText, confidence: token.confidence, rect: token.rect, variant: token.variant }));
  const sorted = [...tokens].sort(tokenSort);
  for (let start = 0; start < sorted.length; start += 1) {
    const sequence = [sorted[start]!];
    for (let end = start + 1; end < sorted.length; end += 1) {
      const next = sorted[end]!;
      if (!horizontallyAdjacent(sequence[sequence.length - 1]!, next)) break;
      sequence.push(next);
      candidates.push(mergedCandidate(sequence));
    }
  }
  return candidates;
}

export function observeInventoryHeader(
  profile: ScreenshotProfile,
  candidates: InventoryTokenCandidate[],
): InventoryHeaderObservationV1 {
  const roi = inventoryHeaderRoi(profile);
  const tokens: InventoryOcrTokenV1[] = candidates.map((candidate) => ({
    rawText: candidate.text,
    normalizedText: normalizeInventoryText(candidate.text),
    confidence: candidate.confidence,
    rect: candidate.rect ?? roi,
    variant: candidate.variant,
  })).sort(tokenSort);
  const evidence = tokenCandidates(tokens).map((candidate) => ({
    source: "direct_ocr" as const,
    rect: candidate.rect,
    rawText: candidate.text,
    normalizedText: normalizeInventoryText(candidate.text),
    confidence: candidate.confidence,
    variant: candidate.variant,
  }));
  const matches = evidence.map((item, index) => ({ item, index, match: COUNT_PATTERN.exec(item.normalizedText) }))
    .filter((item): item is { item: OcrEvidenceV1; index: number; match: RegExpExecArray } => item.match != null)
    .sort((left, right) => right.item.confidence - left.item.confidence || left.index - right.index);
  if (!matches.length) {
    const status = evidence.length && evidence.some((item) => item.normalizedText) ? "unreadable" : "not_present";
    return { roi, tokens, currentCount: emptyField(status, status === "unreadable" ? "inventory_current_unreadable" : "inventory_current_not_present", evidence), capacity: emptyField(status, status === "unreadable" ? "inventory_capacity_unreadable" : "inventory_capacity_not_present", evidence) };
  }
  const reliableMatches = matches.filter((candidate) => candidate.item.confidence >= INVENTORY_CONFIDENCE_THRESHOLD);
  if (!reliableMatches.length) {
    return {
      roi,
      tokens,
      currentCount: emptyField("unreadable", "inventory_current_below_confidence_threshold", evidence),
      capacity: emptyField("unreadable", "inventory_capacity_below_confidence_threshold", evidence),
    };
  }
  const selected = reliableMatches[0]!;
  const current = Number(selected.match[1]);
  const capacity = Number(selected.match[2]);
  const conflict = reliableMatches.some((candidate) => Number(candidate.match[1]) !== current || Number(candidate.match[2]) !== capacity);
  const currentInvalid = current > capacity;
  const currentCount: NumericFieldObservationV1 = {
    value: currentInvalid || conflict ? null : current,
    status: currentInvalid ? "invalid" : conflict ? "ambiguous" : "confirmed",
    confidence: selected.item.confidence,
    rawText: selected.item.rawText,
    normalizedText: selected.item.normalizedText,
    evidence,
    reviewReasonCodes: currentInvalid ? ["inventory_current_exceeds_capacity"] : conflict ? ["inventory_header_candidate_conflict"] : [],
  };
  const capacityField: NumericFieldObservationV1 = {
    value: conflict ? null : capacity,
    status: conflict ? "ambiguous" : "confirmed",
    confidence: selected.item.confidence,
    rawText: selected.item.rawText,
    normalizedText: selected.item.normalizedText,
    evidence,
    reviewReasonCodes: conflict ? ["inventory_header_candidate_conflict"] : [],
  };
  return { roi, tokens, currentCount, capacity: capacityField };
}
