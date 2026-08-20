from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import yuanstar.app as app
from yuanstar.catalog import load_catalog
from yuanstar.session import SessionState


def png(width: int = 1080, height: int = 1920) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + width.to_bytes(4, "big") + height.to_bytes(4, "big")


class FakeFileUpload:
    def __init__(self, name: str, content: bytes) -> None:
        self.name = name
        self.content_type = "image/png"
        self._content = content

    async def read(self) -> bytes:
        return self._content


def upload_event(name: str, content: bytes | None = None) -> SimpleNamespace:
    return SimpleNamespace(file=FakeFileUpload(name, content or png()))


async def immediate_io_bound(function, *args):
    return function(*args)


class FakePipeline:
    def __init__(self, pools: list[str] | None = None, error: Exception | None = None) -> None:
        self.pools = iter(pools or [])
        self.error = error
        self.images = []

    def classify_pool(self, image):
        self.images.append(image)
        if self.error:
            raise self.error
        return next(self.pools)


def test_nicegui_run_module_cannot_be_overwritten_by_project_start_function() -> None:
    assert hasattr(app.nicegui_run, "io_bound")
    assert app.start_app is not app.nicegui_run
    assert not hasattr(app.start_app, "io_bound")


def test_upload_classifies_then_adds_image_to_candidate_pool() -> None:
    state = SessionState(load_catalog())
    pipeline = FakePipeline(["main"])

    image, pool = asyncio.run(
        app.classify_and_add_uploaded_file(upload_event("main.png"), state, pipeline, io_bound=immediate_io_bound)
    )

    assert pool == "main"
    assert pipeline.images == [image]
    assert state.uploaded_images == [image]
    assert state.image_pools == {image.id: "main"}
    assert state.confirmed_image_pools == set()


def test_three_uploads_remain_independent_and_all_appear_for_confirmation() -> None:
    state = SessionState(load_catalog())
    pipeline = FakePipeline(["main", "support", "experience"])

    images = [
        asyncio.run(app.classify_and_add_uploaded_file(upload_event(name), state, pipeline, io_bound=immediate_io_bound))[0]
        for name in ("main.png", "support.png", "experience.png")
    ]

    assert len(state.uploaded_images) == 3
    assert [state.image_pools[image.id] for image in images] == ["main", "support", "experience"]
    assert len(pipeline.images) == 3


def test_classification_exception_does_not_add_failed_image_or_break_future_upload() -> None:
    state = SessionState(load_catalog())
    failing = FakePipeline(error=RuntimeError("offline OCR unavailable"))

    with pytest.raises(RuntimeError, match="offline OCR unavailable"):
        asyncio.run(app.classify_and_add_uploaded_file(upload_event("broken.png"), state, failing, io_bound=immediate_io_bound))

    assert state.uploaded_images == []
    successful = FakePipeline(["support"])
    image, pool = asyncio.run(
        app.classify_and_add_uploaded_file(upload_event("support.png"), state, successful, io_bound=immediate_io_bound)
    )
    assert pool == "support"
    assert state.uploaded_images == [image]
