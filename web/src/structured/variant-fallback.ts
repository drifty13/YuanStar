import { parseLevel, resolveLevel, type NameResolution } from "./star-postprocess.js";
import type { OcrCandidate } from "./types.js";

type NameResolver = (candidates: OcrCandidate[]) => NameResolution;

export const STRICT_LEVEL_FORMAT = /^(?:[1-9]|[1-5]\d|60)级$/u;

/**
 * Runs the color candidate first. Any non-safe outcome runs every remaining
 * prepared variant in its original order; it never treats v1/v2 agreement as
 * evidence that v3 is unnecessary.
 */
export async function runProgressiveVariantFallback<T, Candidate>(
  variants: T[],
  recognize: (items: T[]) => Promise<Candidate[]>,
  canAcceptFirst: (candidate: Candidate) => boolean,
  forceFullVariants = false,
): Promise<Candidate[]> {
  if (forceFullVariants || variants.length <= 1) return recognize(variants);
  const first = await recognize(variants.slice(0, 1));
  if (first.length === 1 && canAcceptFirst(first[0]!)) return first;
  const remaining = await recognize(variants.slice(1));
  return [...first, ...remaining];
}

/** Strict name gate: trim only; aliases and cleanup-dependent names fall back. */
export function canAcceptStrictNameColorCandidate(candidate: OcrCandidate, resolveName: NameResolver): boolean {
  if (candidate.confidence < 0.95) return false;
  const resolved = resolveName([candidate]);
  const raw = candidate.text.trim();
  return resolved.normalized != null && resolved.reasons.length === 0 && raw === resolved.normalized;
}

/** Strict level gate: accepts only high-confidence, canonical `1级` through `60级` text. */
export function canAcceptStrictLevelColorCandidate(candidate: OcrCandidate): boolean {
  if (candidate.confidence < 0.95) return false;
  const raw = candidate.text.trim();
  if (!STRICT_LEVEL_FORMAT.test(raw)) return false;
  const parsed = parseLevel(raw);
  const resolved = resolveLevel([candidate]);
  return parsed != null && resolved.level === parsed && resolved.reasons.length === 0;
}
