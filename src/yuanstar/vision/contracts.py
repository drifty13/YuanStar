from __future__ import annotations

from dataclasses import dataclass, field
from traceback import format_exc
from typing import Callable, Protocol
from uuid import uuid4

from ..domain import DetectedStarItem, ImportBatch


@dataclass(frozen=True)
class ImageInput:
    filename: str
    width: int | None = None
    height: int | None = None
    size_bytes: int = 0
    content_type: str | None = None
    content: bytes = field(default=b"", repr=False, compare=False)
    id: str = field(default_factory=lambda: uuid4().hex)
    missing: bool = False


@dataclass(frozen=True)
class AnalysisResult:
    executed: bool
    message: str
    items: list[DetectedStarItem] = field(default_factory=list)
    import_batch: ImportBatch | None = None
    image_pools: dict[str, str] = field(default_factory=dict)
    image_audit: dict[str, dict[str, object]] = field(default_factory=dict)
    overlap_groups: list[list[str]] = field(default_factory=list)
    overlap_audit: list[dict[str, object]] = field(default_factory=list)
    bag_resolution: dict[str, object] = field(default_factory=dict)
    experience_resolution: dict[str, dict[str, object]] = field(default_factory=dict)
    engine_initializations: int = 0


@dataclass(frozen=True)
class ImportProgressEvent:
    """Pure progress data emitted by a background import worker."""

    stage: str
    total_images: int
    completed_images: int = 0
    current_image_index: int | None = None
    current_filename: str | None = None
    error_count: int = 0
    engine_initializations: int = 0
    detail: str | None = None


ImportProgressCallback = Callable[[ImportProgressEvent], None]


@dataclass(frozen=True)
class ImportFailure:
    """Pure failure data returned from an import task; UI owns presentation."""

    stage: str
    error_type: str
    message: str
    traceback: str

    @classmethod
    def from_exception(cls, stage: str, error: Exception) -> "ImportFailure":
        return cls(stage=stage, error_type=type(error).__name__, message=str(error), traceback=format_exc())


class VisionPipeline(Protocol):
    def analyze(self, images: list[ImageInput], batch: ImportBatch) -> AnalysisResult: ...
