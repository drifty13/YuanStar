import type { ConfirmedImagePool, PageClassificationV1, PageType } from "./contracts.js";

export interface PageRoutingEvidence {
  pageType: PageType;
  confidence: number;
  evidence: string[];
  selected: boolean;
  tabOcrCandidates: Array<{ text: string; confidence: number; variant: string }>;
  warning: string | null;
  reviewRequired: boolean;
  tabOcrMs: number;
}

export interface PageRoutingRun {
  routing: PageRoutingEvidence;
  visualRoutingMs: number;
}

export function confirmedPageRouting(pageType: Exclude<PageType, "unknown">): PageRoutingEvidence {
  return {
    pageType,
    confidence: 1,
    evidence: [`confirmed_pool:${pageType}`],
    selected: true,
    tabOcrCandidates: [],
    warning: null,
    reviewRequired: false,
    tabOcrMs: 0,
  };
}

export function routePage(
  confirmedPageType: Exclude<PageType, "unknown"> | undefined,
  routeAutomatically: () => Promise<PageRoutingRun>,
): Promise<PageRoutingRun> {
  return confirmedPageType
    ? Promise.resolve({ routing: confirmedPageRouting(confirmedPageType), visualRoutingMs: 0 })
    : routeAutomatically();
}

export function toPageClassificationV1(
  routing: PageRoutingEvidence,
  confirmedPool?: { imageId: string; pageType: Exclude<PageType, "unknown"> },
  expectedPageType?: PageType,
): PageClassificationV1 {
  const auto: PageClassificationV1 = {
    pageType: routing.pageType,
    visualEvidence: routing.evidence.map((value) => ({
      source: value.startsWith("confirmed_pool:")
        ? "confirmed_pool" as const
        : value.startsWith("selected_tab_visual:")
          ? "visual" as const
          : "tab_ocr" as const,
      value,
      confidence: routing.confidence,
    })),
    tabOcrEvidence: routing.tabOcrCandidates,
    confidence: routing.confidence,
    warning: routing.warning,
    reviewRequired: routing.reviewRequired,
  };
  return applyPageOverrides(auto, confirmedPool, expectedPageType);
}

export const PAGE_TOKENS: Readonly<Record<Exclude<PageType, "unknown">, readonly string[]>> = {
  main: ["主星"],
  support: ["辅星", "輔星"],
  experience: ["经验星石", "經驗星石", "紫星曜", "白星曜"],
};

export function routeTabOcrCandidates(candidates: readonly { text: string; confidence: number; variant: string }[]): {
  pageType: PageType;
  confidence: number;
  evidence: string[];
  warning: string | null;
} {
  // Python page_classifier.py builds `joined = " ".join(texts)` and increments
  // each page token once when `token in joined`; candidate confidence is not
  // part of the Python score, so this intentionally preserves that rule.
  const texts = candidates.map((candidate) => candidate.text.replaceAll(" ", ""));
  const scores: Record<Exclude<PageType, "unknown">, number> = { main: 0, support: 0, experience: 0 };
  const evidence: string[] = [];
  for (const [page, tokens] of Object.entries(PAGE_TOKENS) as Array<[Exclude<PageType, "unknown">, readonly string[]]>) {
    for (const token of tokens) {
      if (texts.some((text) => text.includes(token))) {
        scores[page] += 1;
        evidence.push(`tab_ocr:${token}`);
      }
    }
  }
  const bestPage = (Object.keys(scores) as Array<Exclude<PageType, "unknown">>).sort((left, right) => scores[right] - scores[left])[0]!;
  if (!scores[bestPage]) return { pageType: "unknown", confidence: 0, evidence, warning: null };
  const ties = (Object.values(scores) as number[]).filter((score) => score === scores[bestPage]).length;
  if (ties > 1) return { pageType: "unknown", confidence: 0.2, evidence: [...evidence, "page_evidence_conflict"], warning: "page_evidence_conflict" };
  return { pageType: bestPage, confidence: bestPage === "experience" ? 0.70 : 0.75, evidence, warning: null };
}

export function applyPageOverrides(
  auto: PageClassificationV1,
  confirmedPool?: ConfirmedImagePool,
  expectedPageType?: PageType,
): PageClassificationV1 {
  if (confirmedPool) {
    const conflict = auto.pageType !== "unknown" && auto.pageType !== confirmedPool.pageType;
    return {
      ...auto,
      pageType: confirmedPool.pageType,
      confidence: conflict ? Math.min(auto.confidence, 0.5) : Math.max(auto.confidence, 0.95),
      visualEvidence: [...auto.visualEvidence, { source: "confirmed_pool", value: `confirmed_pool:${confirmedPool.pageType}`, confidence: 1 }],
      warning: conflict ? "confirmed_pool_conflict" : auto.warning,
      reviewRequired: conflict || auto.reviewRequired,
    };
  }
  if (auto.pageType === "unknown" && expectedPageType && expectedPageType !== "unknown") {
    return {
      ...auto,
      pageType: expectedPageType,
      confidence: 0.2,
      visualEvidence: [...auto.visualEvidence, { source: "expected_page_type", value: `expected_page_type:${expectedPageType}`, confidence: 0.2 }],
      warning: "expected_page_type_used",
      reviewRequired: true,
    };
  }
  return auto;
}
