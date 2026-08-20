import type { EquippedState, Quality, ProvenanceSource } from "./contracts.js";
import type { CardCandidate, MainStarResult, Rect } from "./types.js";

const QUALITY_RANK: Record<Quality, number> = { 橙: 5, 紫: 4, 蓝: 3, 绿: 2, 白: 1 };
const EQUIPPED_MIN_RELIABLE_CONFIDENCE = 0.72;
const STALE_WARNINGS = new Set([
  "level_order_conflict",
  "hierarchical_level_order_conflict",
  "level_inferred_by_sort_order",
  "level_inferred_by_hierarchical_order",
  "name_inferred_by_sort_sandwich",
]);

export const EQUIPPED_ROI = {
  xOffset: -0.065,
  yOffset: 0,
  width: 0.37,
  height: 0.36,
} as const;

export interface EquippedRecognition {
  state: EquippedState;
  confidence: number;
  source: ProvenanceSource;
  warnings: string[];
}

function addWarning(warnings: string[], warning: string): string[] {
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}

export function equippedRectForCard(card: CardCandidate): Rect {
  const { x, y, width, height } = card.cardRect;
  return {
    x: x + width * EQUIPPED_ROI.xOffset,
    y: y + height * EQUIPPED_ROI.yOffset,
    width: Math.max(1, width * EQUIPPED_ROI.width),
    height: Math.max(1, height * EQUIPPED_ROI.height),
  };
}

function cropBounds(image: ImageData, rect: Rect): { left: number; top: number; width: number; height: number } {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  return {
    left,
    top,
    width: Math.max(0, Math.min(image.width - left, Math.ceil(rect.width))),
    height: Math.max(0, Math.min(image.height - top, Math.ceil(rect.height))),
  };
}

function grayscale(red: number, green: number, blue: number): number {
  return (red * 299 + green * 587 + blue * 114) / 1000;
}

function quantizedEntropy(image: ImageData, bounds: ReturnType<typeof cropBounds>): { entropy: number; saturation: number; texture: number } {
  const counts = new Map<number, number>();
  const gray = new Float32Array(bounds.width * bounds.height);
  let saturated = 0;
  for (let y = 0; y < bounds.height; y += 1) {
    for (let x = 0; x < bounds.width; x += 1) {
      const at = ((bounds.top + y) * image.width + bounds.left + x) * 4;
      const red = image.data[at] ?? 0;
      const green = image.data[at + 1] ?? 0;
      const blue = image.data[at + 2] ?? 0;
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      if (maximum > 0 && ((maximum - minimum) / maximum) * 255 >= 48) saturated += 1;
      const key = ((red >> 5) << 8) | ((green >> 5) << 4) | (blue >> 5);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      gray[y * bounds.width + x] = grayscale(red, green, blue);
    }
  }
  const total = Math.max(1, bounds.width * bounds.height);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / total;
    entropy -= probability * Math.log2(probability);
  }
  let textureSum = 0;
  let textureCount = 0;
  for (let y = 1; y < bounds.height - 1; y += 1) {
    for (let x = 1; x < bounds.width - 1; x += 1) {
      const at = y * bounds.width + x;
      const laplacian = Math.abs(
        (gray[at - 1] ?? 0) + (gray[at + 1] ?? 0) + (gray[at - bounds.width] ?? 0) + (gray[at + bounds.width] ?? 0) - 4 * (gray[at] ?? 0),
      );
      textureSum += laplacian;
      textureCount += 1;
    }
  }
  return { entropy, saturation: saturated / total, texture: textureCount ? textureSum / textureCount : 0 };
}

/** Browser equivalent of Python classify_equipped_roi's avatar/lock evidence. */
export function classifyEquippedPixels(image: ImageData, rect: Rect): EquippedRecognition {
  const bounds = cropBounds(image, rect);
  if (!bounds.width || !bounds.height || Math.min(bounds.width, bounds.height) < 8) {
    return { state: "unknown", confidence: 0, source: "unknown", warnings: ["equipped_roi_missing"] };
  }
  const { entropy, saturation, texture } = quantizedEntropy(image, bounds);
  if (entropy >= 4.05) {
    return {
      state: "equipped",
      confidence: Math.min(0.94, 0.62 + (entropy - 4.05) * 0.18 + Math.min(texture, 80) / 500),
      source: "relative_anchor_colour_entropy",
      warnings: [],
    };
  }
  if (entropy <= 3.95) {
    const confidence = Math.min(0.92, 0.62 + (3.95 - entropy) * 0.12 + saturation * 0.08);
    if (confidence < EQUIPPED_MIN_RELIABLE_CONFIDENCE) {
      return { state: "unknown", confidence: 0.45, source: "relative_anchor_colour_entropy", warnings: ["equipped_unequipped_low_confidence"] };
    }
    return { state: "unequipped", confidence, source: "relative_anchor_colour_entropy", warnings: [] };
  }
  return { state: "unknown", confidence: 0.45, source: "relative_anchor_colour_entropy", warnings: ["equipped_colour_entropy_conflict"] };
}

function orderedCompleteCards(cards: CardCandidate[], results: MainStarResult[]): CardCandidate[] {
  const ids = new Set(results.map((result) => result.cardId ?? result.instanceId));
  return [...cards]
    .filter((card) => card.completeness === "complete" && ids.has(card.cardId))
    .sort((left, right) => left.rowIndex - right.rowIndex || left.columnIndex - right.columnIndex);
}

function directLevel(result: MainStarResult): number | null {
  const source = result.levelSource ?? "direct_ocr";
  if (source === "direct_ocr" && result.directLevel != null) return result.directLevel;
  if (source === "manual_review" && result.level != null) return result.level;
  return null;
}

function sameRowAdjacent(left: CardCandidate, right: CardCandidate): boolean {
  return left.rowIndex === right.rowIndex && left.columnIndex + 1 === right.columnIndex;
}

export function equippedBoundaryIndexes(cards: CardCandidate[], results: MainStarResult[]): number[] {
  const byId = new Map(results.map((result) => [result.cardId ?? result.instanceId, result]));
  const ordered = orderedCompleteCards(cards, results);
  const boundaries: number[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const left = byId.get(ordered[index - 1]!.cardId);
    const right = byId.get(ordered[index]!.cardId);
    if (!left || !right) continue;
    const leftQuality = left.quality ? QUALITY_RANK[left.quality] : undefined;
    const rightQuality = right.quality ? QUALITY_RANK[right.quality] : undefined;
    if (leftQuality == null || rightQuality == null) continue;
    const leftLevel = directLevel(left);
    const rightLevel = directLevel(right);
    if (leftQuality < rightQuality || (leftQuality === rightQuality && leftLevel != null && rightLevel != null && leftLevel < rightLevel)) boundaries.push(index);
  }
  return boundaries;
}

export function inferEquippedSandwiches(
  cards: CardCandidate[],
  results: MainStarResult[],
  evidence: Map<string, EquippedRecognition>,
): Map<string, EquippedRecognition> {
  const ordered = orderedCompleteCards(cards, results);
  const snapshot = new Map(evidence);
  const updated = new Map(evidence);
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const left = ordered[index - 1]!;
    const current = ordered[index]!;
    const right = ordered[index + 1]!;
    // Python slides its row-major equipped snapshot across row boundaries.
    const leftState = snapshot.get(left.cardId)?.state ?? "not_evaluated";
    const currentState = snapshot.get(current.cardId)?.state ?? "not_evaluated";
    const rightState = snapshot.get(right.cardId)?.state ?? "not_evaluated";
    if (leftState === "equipped" && currentState === "unknown" && rightState === "equipped") {
      updated.set(current.cardId, {
        state: "equipped",
        confidence: 0.82,
        source: "hierarchical_sort_inference",
        warnings: ["equipped_inferred_by_sandwich"],
      });
    }
  }
  return updated;
}

export function recognizeEquippedOnDemand(
  image: ImageData,
  cards: CardCandidate[],
  results: MainStarResult[],
): { evidence: Map<string, EquippedRecognition>; calls: number } {
  const ordered = orderedCompleteCards(cards, results);
  const boundaries = equippedBoundaryIndexes(cards, results);
  const evidence = new Map<string, EquippedRecognition>();
  let calls = 0;
  const classify = (index: number): void => {
    const card = ordered[index];
    if (!card || evidence.has(card.cardId)) return;
    evidence.set(card.cardId, classifyEquippedPixels(image, equippedRectForCard(card)));
    calls += 1;
  };
  for (const boundary of boundaries) {
    classify(boundary - 1);
    classify(boundary);
  }
  return { evidence: inferEquippedSandwiches(cards, results, evidence), calls };
}

function refreshedStatus(result: MainStarResult): MainStarResult["status"] {
  if (result.status === "excluded_partial") return result.status;
  return result.nameNormalized && result.level != null && result.quality != null && !result.reviewRequired ? "accepted" : "needs_review";
}

export function applyHierarchicalOrder(
  cards: CardCandidate[],
  results: MainStarResult[],
  equipped: Map<string, EquippedRecognition>,
): MainStarResult[] {
  const byId = new Map(results.map((result) => [result.cardId ?? result.instanceId, result]));
  const ordered = orderedCompleteCards(cards, results);
  const base = new Map<string, MainStarResult>();
  for (const card of ordered) {
    const result = byId.get(card.cardId)!;
    const state = equipped.get(card.cardId) ?? {
      state: "not_evaluated" as const,
      confidence: 0,
      source: "unknown" as const,
      warnings: [],
    };
    const reasons = result.reasons.filter((reason) => !STALE_WARNINGS.has(reason));
    base.set(card.cardId, {
      ...result,
      reasons,
      equippedState: state.state,
      equippedSource: state.source,
      equippedConfidence: state.confidence,
      equippedWarnings: state.warnings,
      inferenceProvenance: [...(result.inferenceProvenance ?? [])],
      reviewRequired: result.reviewRequired || state.state === "unknown" || result.quality == null,
    });
  }

  const groups: CardCandidate[][] = [];
  for (const card of ordered) {
    const result = base.get(card.cardId)!;
    const previousCard = groups.at(-1)?.at(-1);
    const previous = previousCard ? base.get(previousCard.cardId) : undefined;
    const key = `${result.equippedState}|${result.quality ?? "unknown"}`;
    const previousKey = previous ? `${previous.equippedState}|${previous.quality ?? "unknown"}` : null;
    const uncertain = result.equippedState === "unknown" || result.quality == null;
    if (!groups.length || !previousCard || uncertain || key !== previousKey) groups.push([card]);
    else groups.at(-1)!.push(card);
  }

  const updated = new Map(base);
  for (const group of groups) {
    const direct = new Map(group.map((card) => [card.cardId, directLevel(base.get(card.cardId)!)]));
    for (let index = 0; index < group.length; index += 1) {
      const card = group[index]!;
      const current = base.get(card.cardId)!;
      const value = direct.get(card.cardId) ?? null;
      const left = index ? direct.get(group[index - 1]!.cardId) ?? null : null;
      const right = index + 1 < group.length ? direct.get(group[index + 1]!.cardId) ?? null : null;
      if (current.levelSource === "manual_review") {
        updated.set(card.cardId, { ...current, status: refreshedStatus(current) });
        continue;
      }
      if (value != null && left != null && left < value) {
        updated.set(card.cardId, {
          ...current,
          level: null,
          effectiveLevel: null,
          levelConfidence: 0,
          reviewRequired: true,
          reasons: addWarning(current.reasons, "hierarchical_level_order_conflict"),
          status: "needs_review",
        });
      } else if (value == null && left != null && right != null && left === right) {
        updated.set(card.cardId, {
          ...current,
          level: left,
          effectiveLevel: left,
          levelSource: "hierarchical_sort_inference",
          levelConfidence: Math.min(0.82, current.levelConfidence || 0.82),
          levelProvenance: [...(current.levelProvenance ?? []), `direct_interval:${left}-${right}`],
          inferenceProvenance: [...(current.inferenceProvenance ?? []), "level_inferred_by_hierarchical_order"],
          reviewRequired: current.nameNormalized == null || current.quality == null,
          reasons: addWarning(current.reasons, "level_inferred_by_hierarchical_order"),
          status: refreshedStatus({ ...current, level: left, quality: current.quality, reviewRequired: current.nameNormalized == null || current.quality == null }),
        });
      }
    }
  }
  return results.map((result) => updated.get(result.cardId ?? result.instanceId) ?? result);
}

export function applyHierarchicalNameSandwich(cards: CardCandidate[], results: MainStarResult[]): MainStarResult[] {
  const byId = new Map(results.map((result) => [result.cardId ?? result.instanceId, result]));
  const ordered = orderedCompleteCards(cards, results);
  const updates = new Map<string, MainStarResult>();
  for (let index = 1; index < ordered.length - 1; index += 1) {
    const leftCard = ordered[index - 1]!;
    const currentCard = ordered[index]!;
    const rightCard = ordered[index + 1]!;
    // Python deliberately keeps name sandwiches within a physical row.
    if (!sameRowAdjacent(leftCard, currentCard) || !sameRowAdjacent(currentCard, rightCard)) continue;
    const left = byId.get(leftCard.cardId)!;
    const current = byId.get(currentCard.cardId)!;
    const right = byId.get(rightCard.cardId)!;
    if (current.nameNormalized != null || current.level == null || current.equippedState === "unknown" || current.quality == null) continue;
    if (!left.nameNormalized || left.nameNormalized !== right.nameNormalized) continue;
    if (!(left.equippedState === current.equippedState && current.equippedState === right.equippedState
      && left.quality === current.quality && current.quality === right.quality
      && left.level === current.level && current.level === right.level)) continue;
    if (!((left.nameSource ?? "direct_ocr") === "direct_ocr" || left.nameSource === "manual_review")) continue;
    if (!((right.nameSource ?? "direct_ocr") === "direct_ocr" || right.nameSource === "manual_review")) continue;
    updates.set(current.cardId ?? current.instanceId, {
      ...current,
      nameNormalized: left.nameNormalized,
      effectiveName: left.nameNormalized,
      directName: null,
      nameSource: "hierarchical_sort_sandwich_inference",
      nameConfidence: Math.min(0.82, left.nameConfidence, right.nameConfidence, current.levelConfidence),
      inferenceProvenance: [...(current.inferenceProvenance ?? []), "name_inferred_by_hierarchical_sandwich"],
      reasons: addWarning(current.reasons.filter((reason) => reason !== "name_inferred_by_sort_sandwich"), "name_inferred_by_hierarchical_sandwich"),
      reviewRequired: current.quality == null || current.level == null,
    });
  }
  return results.map((result) => {
    const updated = updates.get(result.cardId ?? result.instanceId);
    return updated ? { ...updated, status: refreshedStatus(updated) } : result;
  });
}
