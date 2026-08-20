from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Literal


Box = tuple[int, int, int, int]
NormalizedBox = tuple[float, float, float, float]
PageType = Literal["main", "support", "experience", "unknown"]


@dataclass(frozen=True)
class ViewportResult:
    original_size: tuple[int, int]
    viewport_box: Box
    profile_id: str | None
    confidence: float
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class PageClassification:
    page_type: PageType
    confidence: float
    evidence: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class CardCandidate:
    card_id: str
    row_index: int
    column_index: int
    box_original: Box
    box_normalized: NormalizedBox
    is_complete: bool
    completeness_confidence: float
    name_box_original: Box | None = None
    level_box_original: Box | None = None
    circle_original: tuple[int, int, int] | None = None


@dataclass(frozen=True)
class RecognizedStar:
    card_id: str
    page_type: str
    raw_name_text: str | None
    canonical_name: str | None
    name_confidence: float
    raw_level_text: str | None
    level: int | None
    level_confidence: float
    overall_confidence: float
    review_required: bool
    warnings: list[str] = field(default_factory=list)
    name_source: str = "direct_ocr"
    # The direct OCR snapshot is intentionally immutable evidence.  Later
    # conservative inferences must never be fed back as new OCR evidence.
    direct_level: int | None = None
    level_source: str = "direct_ocr"
    level_provenance: list[str] = field(default_factory=list)
    raw_quality_evidence: str | None = None
    quality: str | None = None
    quality_confidence: float = 0.0
    quality_source: str = "unknown"
    quality_warnings: list[str] = field(default_factory=list)
    equipped_state: str = "not_evaluated"
    equipped_confidence: float = 0.0
    equipped_source: str = "unknown"
    equipped_warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ExperienceStoneResult:
    orange_count: int | None
    purple_count: int | None
    white_count: int | None
    orange_confidence: float = 0.0
    purple_confidence: float = 0.0
    white_confidence: float = 0.0
    complete: bool = False
    warnings: list[str] = field(default_factory=list)
    evidence: dict[str, dict[str, object]] = field(default_factory=dict)


@dataclass(frozen=True)
class BagCountResult:
    current: int | None
    capacity: int | None
    confidence: float = 0.0
    candidates: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SingleImageAnalysis:
    image_id: str
    viewport: ViewportResult
    page: PageClassification
    cards: list[CardCandidate]
    stars: list[RecognizedStar]
    warnings: list[str] = field(default_factory=list)
    experience: ExperienceStoneResult | None = None
    bag: BagCountResult | None = None
    equipped_classifier_calls: int = 0
    content_bounds: tuple[int, int] | None = None

    def as_dict(self) -> dict[str, object]:
        return asdict(self)
