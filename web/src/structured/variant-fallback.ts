import { parseLevel, resolveLevel, type NameResolution } from "./star-postprocess.js";
import type { OcrCandidate } from "./types.js";

type NameResolver = (candidates: OcrCandidate[]) => NameResolution;

export const STRICT_LEVEL_FORMAT = /^(?:[1-9]|[1-5]\d|60)[级級]$/u;

/**
 * Runs the color candidate first. A caller may supply a strict v1/v2 gate;
 * without one, any non-safe v1 still runs every remaining prepared variant.
 */
export async function runProgressiveVariantFallback<T, Candidate>(
  variants: T[],
  recognize: (items: T[]) => Promise<Candidate[]>,
  canAcceptFirst: (candidate: Candidate) => boolean,
  forceFullVariants = false,
  canAcceptFirstTwo?: (first: Candidate, second: Candidate) => boolean,
): Promise<Candidate[]> {
  if (forceFullVariants || variants.length <= 1) return recognize(variants);
  const first = await recognize(variants.slice(0, 1));
  if (first.length === 1 && canAcceptFirst(first[0]!)) return first;
  if (!canAcceptFirstTwo || variants.length <= 2) {
    const remaining = await recognize(variants.slice(1));
    return [...first, ...remaining];
  }
  const second = await recognize(variants.slice(1, 2));
  if (first.length === 1 && second.length === 1 && canAcceptFirstTwo(first[0]!, second[0]!)) return [...first, ...second];
  const remaining = await recognize(variants.slice(2));
  return [...first, ...second, ...remaining];
}

/** Strict name gate: trim only; only canonical text or an exact legitimate alias may exit early. */
export function canAcceptStrictNameColorCandidate(
  candidate: OcrCandidate,
  resolveName: NameResolver,
  legitimateAliases: Readonly<Record<string, string>> = {},
): boolean {
  if (candidate.confidence < 0.95) return false;
  const resolved = resolveName([candidate]);
  const raw = candidate.text.trim();
  return resolved.normalized != null
    && resolved.reasons.length === 0
    && (raw === resolved.normalized || legitimateAliases[raw] === resolved.normalized);
}

/** Strict level gate: accepts only high-confidence, canonical `1级`/`1級` through `60级`/`60級` text. */
export function canAcceptStrictLevelColorCandidate(candidate: OcrCandidate): boolean {
  if (candidate.confidence < 0.95) return false;
  const raw = candidate.text.trim();
  if (!STRICT_LEVEL_FORMAT.test(raw)) return false;
  const parsed = parseLevel(raw);
  const resolved = resolveLevel([candidate]);
  return parsed != null && resolved.level === parsed && resolved.reasons.length === 0;
}

/**
 * Strict level v1/v2 agreement gate. It intentionally has no confidence
 * threshold: v1's 0.95 threshold remains the only one-variant exit. Both
 * raw values must independently be legal, unrepaired level text.
 */
export function canAcceptStrictLevelFirstTwoAgreement(first: OcrCandidate, second: OcrCandidate): boolean {
  const firstRaw = first.text.trim();
  const secondRaw = second.text.trim();
  if (!STRICT_LEVEL_FORMAT.test(firstRaw) || !STRICT_LEVEL_FORMAT.test(secondRaw)) return false;
  const firstLevel = parseLevel(firstRaw);
  const secondLevel = parseLevel(secondRaw);
  if (firstLevel == null || secondLevel == null || firstLevel !== secondLevel) return false;
  const resolved = resolveLevel([first, second]);
  return resolved.level === firstLevel && resolved.reasons.length === 0;
}
