import { MAIN_ALIASES, resolveName as resolveMainName } from "../src/structured/main-postprocess.js";
import { resolveLevel } from "../src/structured/star-postprocess.js";
import {
  canAcceptStrictLevelColorCandidate,
  canAcceptStrictLevelFirstTwoAgreement,
  canAcceptStrictNameColorCandidate,
  runProgressiveVariantFallback,
} from "../src/structured/variant-fallback.js";
import type { OcrCandidate } from "../src/structured/types.js";

function expect(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal<T>(actual: T, expected: T, message: string): void { expect(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }

async function run(
  candidates: OcrCandidate[],
  accept: (candidate: OcrCandidate) => boolean,
  forceFull = false,
  acceptFirstTwo?: (first: OcrCandidate, second: OcrCandidate) => boolean,
): Promise<{ result: OcrCandidate[]; calls: string[]; metrics: { recognitionCalls: number; sessionCreationCount: number } }> {
  const calls: string[] = [];
  const metrics = { recognitionCalls: 0, sessionCreationCount: 1 };
  const result = await runProgressiveVariantFallback(
    candidates,
    async (items) => {
      calls.push(...items.map((item) => item.variant));
      metrics.recognitionCalls += items.length;
      return items;
    },
    accept,
    forceFull,
    acceptFirstTwo,
  );
  return { result, calls, metrics };
}

const nameSafe: OcrCandidate[] = [
  { variant: "color", text: "天府", confidence: 1 },
  { variant: "contrast", text: "天府", confidence: .9 },
  { variant: "otsu", text: "天府", confidence: .9 },
];
const safeNameRun = await run(nameSafe, (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveMainName));
equal(safeNameRun.calls, ["color"], "safe canonical name must execute color only");
equal(resolveMainName(safeNameRun.result).normalized, "天府", "safe name must retain the normal resolver result");
equal(safeNameRun.metrics, { recognitionCalls: 1, sessionCreationCount: 1 }, "safe name metrics must record one recognition call without a new session");

const safeTraditionalNameRun = await run(
  [{ variant: "color", text: "天機", confidence: .96 }, { variant: "contrast", text: "天机", confidence: .9 }, { variant: "otsu", text: "天机", confidence: .9 }],
  (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveMainName, MAIN_ALIASES),
);
equal(safeTraditionalNameRun.calls, ["color"], "exact legitimate Traditional name alias must execute color only");
equal(resolveMainName(safeTraditionalNameRun.result).normalized, "天机", "exact legitimate Traditional alias must retain the canonical name");

for (const text of ["☑天府", "紫薇"] as const) {
  const values = [{ variant: "color", text, confidence: 1 }, { variant: "contrast", text: "天府", confidence: .9 }, { variant: "otsu", text: "天府", confidence: .9 }];
  const fallback = await run(values, (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveMainName));
  equal(fallback.calls, ["color", "contrast", "otsu"], `${text} must fall back to all original name variants`);
}

const dangerousName: OcrCandidate[] = [
  { variant: "color", text: "紫薇", confidence: .93 },
  { variant: "contrast", text: "紫微", confidence: .91 },
  { variant: "otsu", text: "天府", confidence: .99 },
];
const dangerousNameRun = await run(dangerousName, (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveMainName));
equal(dangerousNameRun.calls, ["color", "contrast", "otsu"], "known v1/v2-stable name counterexample must run v3");
equal(resolveMainName(dangerousNameRun.result).normalized, "天府", "known name counterexample must retain the original all-three result");
equal(dangerousNameRun.metrics, { recognitionCalls: 3, sessionCreationCount: 1 }, "name fallback metrics must record three calls without a new session");

for (const text of ["1级", "40级", "60级", "1級", "40級", "60級"] as const) {
  const values: OcrCandidate[] = [{ variant: "color", text, confidence: .96 }, { variant: "contrast", text, confidence: .9 }, { variant: "otsu", text, confidence: .9 }];
  const safe = await run(values, canAcceptStrictLevelColorCandidate);
  equal(safe.calls, ["color"], `${text} must execute color only`);
  equal(resolveLevel(safe.result).level, Number(text.slice(0, -1)), `${text} must retain the direct level`);
}

for (const text of ["4O", "40", "40級x", "61級"] as const) {
  const values: OcrCandidate[] = [{ variant: "color", text, confidence: 1 }, { variant: "contrast", text: "40级", confidence: .9 }, { variant: "otsu", text: "40级", confidence: .9 }];
  const fallback = await run(values, canAcceptStrictLevelColorCandidate);
  equal(fallback.calls, ["color", "contrast", "otsu"], `${text} must fall back to all original level variants`);
}

const dangerousLevel: OcrCandidate[] = [
  { variant: "color", text: "4O", confidence: .32 },
  { variant: "contrast", text: "40", confidence: .31 },
  { variant: "otsu", text: "50", confidence: .99 },
];
const dangerousLevelRun = await run(dangerousLevel, canAcceptStrictLevelColorCandidate);
equal(dangerousLevelRun.calls, ["color", "contrast", "otsu"], "known v1/v2-stable level counterexample must run v3");
equal(resolveLevel(dangerousLevelRun.result).level, 50, "known level counterexample must retain the original all-three result");
equal(dangerousLevelRun.metrics, { recognitionCalls: 3, sessionCreationCount: 1 }, "level fallback metrics must record three calls without a new session");

for (const [firstText, secondText] of [["1級", "1級"], ["40级", "40級"]] as const) {
  const values: OcrCandidate[] = [
    { variant: "color", text: firstText, confidence: .94 },
    { variant: "contrast", text: secondText, confidence: .9 },
    { variant: "otsu", text: "50級", confidence: .99 },
  ];
  const safe = await run(values, canAcceptStrictLevelColorCandidate, false, canAcceptStrictLevelFirstTwoAgreement);
  equal(safe.calls, ["color", "contrast"], `${firstText} + ${secondText} must end after strict v1/v2 agreement`);
  equal(resolveLevel(safe.result).level, Number(firstText.slice(0, -1)), `${firstText} + ${secondText} must retain the agreed level`);
}

for (const [firstText, secondText, label] of [
  ["4O", "40", "O-to-zero repair"],
  ["40級", "50級", "disagreeing levels"],
  ["61級", "61級", "out-of-range level"],
  ["40級x", "40級", "level with appended text"],
] as const) {
  const values: OcrCandidate[] = [
    { variant: "color", text: firstText, confidence: .94 },
    { variant: "contrast", text: secondText, confidence: .9 },
    { variant: "otsu", text: "50級", confidence: .99 },
  ];
  const fallback = await run(values, canAcceptStrictLevelColorCandidate, false, canAcceptStrictLevelFirstTwoAgreement);
  equal(fallback.calls, ["color", "contrast", "otsu"], `${label} must continue to v3`);
}

const auditNameRun = await run(nameSafe, (candidate) => canAcceptStrictNameColorCandidate(candidate, resolveMainName), true);
const auditLevelRun = await run([{ variant: "color", text: "60级", confidence: 1 }, { variant: "contrast", text: "60级", confidence: .9 }, { variant: "otsu", text: "60级", confidence: .9 }], canAcceptStrictLevelColorCandidate, true);
equal(auditNameRun.calls, ["color", "contrast", "otsu"], "audit reference mode must force all name variants");
equal(auditLevelRun.calls, ["color", "contrast", "otsu"], "audit reference mode must force all level variants");
equal(auditNameRun.metrics.recognitionCalls + auditLevelRun.metrics.recognitionCalls, 6, "audit reference mode must retain all six recognition calls for two ROIs");

console.log("progressive variant fallback checks passed");
