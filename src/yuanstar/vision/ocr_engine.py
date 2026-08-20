from __future__ import annotations

from dataclasses import dataclass
from time import perf_counter
from threading import Lock
from typing import Any

import numpy as np


@dataclass(frozen=True)
class OcrText:
    text: str
    confidence: float


@dataclass(frozen=True)
class PositionedOcrText:
    text: str
    confidence: float
    box: tuple[int, int, int, int]


class LocalRapidOcr:
    """Thin, lazy wrapper; it never sends screenshots to a remote service."""

    _shared_engine: Any | None = None
    _initialization_lock = Lock()
    _initialization_count = 0

    def __init__(self) -> None:
        self._engine: Any | None = None
        self.initialization_seconds: float | None = None

    def _get_engine(self) -> Any:
        if self._engine is None:
            with self._initialization_lock:
                if self._shared_engine is None:
                    from rapidocr import RapidOCR

                    started = perf_counter()
                    self.__class__._shared_engine = RapidOCR()
                    self.__class__._initialization_count += 1
                    self.initialization_seconds = perf_counter() - started
                self._engine = self._shared_engine
        return self._engine

    @classmethod
    def initialization_count(cls) -> int:
        return cls._initialization_count

    @classmethod
    def is_initialized(cls) -> bool:
        return cls._shared_engine is not None

    def recognize(self, image: np.ndarray, *, single_line: bool = False) -> list[OcrText]:
        if image.size == 0:
            return []
        height, width = image.shape[:2]
        if max(width, height) > 960:
            factor = 960 / max(width, height)
            import cv2
            image = cv2.resize(image, (round(width * factor), round(height * factor)), interpolation=cv2.INTER_AREA)
        output = self._get_engine()(image, use_det=not single_line)
        texts = getattr(output, "txts", None)
        scores = getattr(output, "scores", None)
        if texts is not None:
            return [OcrText(str(text), float(scores[index]) if scores is not None and index < len(scores) else 0.0) for index, text in enumerate(texts)]
        # Older RapidOCR variants return a list of [box, text, score] records.
        records = output[0] if isinstance(output, tuple) and output else output
        result: list[OcrText] = []
        for record in records or []:
            if len(record) >= 3:
                result.append(OcrText(str(record[1]), float(record[2])))
        return result

    def recognize_positioned(self, image: np.ndarray) -> list[PositionedOcrText]:
        """Return detected text with coordinates in the caller's image space."""
        if image.size == 0:
            return []
        import cv2

        height, width = image.shape[:2]
        factor = 1.0
        prepared = image
        if max(width, height) > 960:
            factor = 960 / max(width, height)
            prepared = cv2.resize(
                image,
                (round(width * factor), round(height * factor)),
                interpolation=cv2.INTER_AREA,
            )
        output = self._get_engine()(prepared, use_det=True)
        raw_texts = getattr(output, "txts", None)
        raw_scores = getattr(output, "scores", None)
        raw_boxes = getattr(output, "boxes", None)
        texts = list(raw_texts) if raw_texts is not None else []
        scores = list(raw_scores) if raw_scores is not None else []
        boxes = list(raw_boxes) if raw_boxes is not None else []
        positioned: list[PositionedOcrText] = []

        def bounds(points) -> tuple[int, int, int, int]:
            array = np.asarray(points, dtype=np.float32).reshape(-1, 2)
            left = int(np.floor(float(array[:, 0].min()) / factor))
            top = int(np.floor(float(array[:, 1].min()) / factor))
            right = int(np.ceil(float(array[:, 0].max()) / factor))
            bottom = int(np.ceil(float(array[:, 1].max()) / factor))
            return left, top, max(1, right - left), max(1, bottom - top)

        if texts and boxes:
            for index, text in enumerate(texts[: len(boxes)]):
                positioned.append(
                    PositionedOcrText(
                        str(text),
                        float(scores[index]) if index < len(scores) else 0.0,
                        bounds(boxes[index]),
                    )
                )
            return positioned

        records = output[0] if isinstance(output, tuple) and output else output
        for record in records or []:
            if len(record) >= 3:
                positioned.append(
                    PositionedOcrText(
                        str(record[1]),
                        float(record[2]),
                        bounds(record[0]),
                    )
                )
        return positioned

    def recognize_many_single_line(self, images: list[np.ndarray]) -> list[OcrText]:
        """Recognize upright text crops in bounded RapidOCR batches.

        The same classifier and recognizer models used by ``recognize`` are
        retained; only per-crop Python/model-call overhead is removed.
        """
        if not images:
            return []
        import cv2

        prepared: list[np.ndarray] = []
        for image in images:
            if image.size == 0:
                prepared.append(np.zeros((8, 8, 3), dtype=np.uint8))
                continue
            current = image
            height, width = current.shape[:2]
            if max(width, height) > 960:
                factor = 960 / max(width, height)
                current = cv2.resize(
                    current,
                    (round(width * factor), round(height * factor)),
                    interpolation=cv2.INTER_AREA,
                )
            if current.ndim == 2:
                current = cv2.cvtColor(current, cv2.COLOR_GRAY2BGR)
            elif current.shape[2] == 4:
                current = cv2.cvtColor(current, cv2.COLOR_BGRA2BGR)
            prepared.append(current)

        engine = self._get_engine()
        try:
            classified, _ = engine.cls_and_rotate(prepared)
            output = engine.recognize_txt(classified)
            texts = list(getattr(output, "txts", ()) or ())
            scores = list(getattr(output, "scores", ()) or ())
            return [
                OcrText(
                    str(texts[index]) if index < len(texts) else "",
                    float(scores[index]) if index < len(scores) else 0.0,
                )
                for index in range(len(prepared))
            ]
        except Exception:
            # Keep a correctness-first fallback for RapidOCR variants that do
            # not expose the compatible internal batch helpers.
            return [
                next(iter(self.recognize(image, single_line=True)), OcrText("", 0.0))
                for image in images
            ]
