from __future__ import annotations

from copy import deepcopy
from typing import Generic, TypeVar


T = TypeVar("T")


class SessionHistory(Generic[T]):
    """Small in-memory snapshot history. New changes invalidate redo."""

    def __init__(self, max_steps: int = 30) -> None:
        self.max_steps = max_steps
        self._undo: list[T] = []
        self._redo: list[T] = []

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def record(self, current: T) -> None:
        self._undo.append(deepcopy(current))
        if len(self._undo) > self.max_steps:
            self._undo.pop(0)
        self._redo.clear()

    def undo(self, current: T) -> T | None:
        if not self._undo:
            return None
        self._redo.append(deepcopy(current))
        return deepcopy(self._undo.pop())

    def redo(self, current: T) -> T | None:
        if not self._redo:
            return None
        self._undo.append(deepcopy(current))
        return deepcopy(self._redo.pop())
