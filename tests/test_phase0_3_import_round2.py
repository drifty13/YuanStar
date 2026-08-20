from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace

import pytest

from yuanstar.app import run_import_transaction
from yuanstar.catalog import load_catalog
from yuanstar.domain import DetectedStarItem, GameVersion, InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState
from yuanstar.vision.contracts import AnalysisResult, ImportFailure
from yuanstar.vision.image_metadata import image_input_from_upload
from yuanstar.vision.ocr_engine import LocalRapidOcr


def png(width: int = 8, height: int = 8) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + width.to_bytes(4, "big") + height.to_bytes(4, "big")


async def immediate_io_bound(function, *args):
    return function(*args)


class SuccessfulPipeline:
    def analyze(self, images, batch, pairs, progress=None):
        if progress:
            progress(SimpleNamespace(stage="完成", total_images=len(images), completed_images=len(images), current_filename=None, error_count=0, engine_initializations=1, detail=None))
        return AnalysisResult(
            executed=True,
            message="ok",
            import_batch=batch.model_copy(update={"ocr_executed": True, "note": "local test"}),
            items=[DetectedStarItem(
                card_id="new-card", source_image=images[0].id, source_position="r1c1", page_type="main",
                recognized_name="天府", recognized_level=1, recognized_quality=Quality.ORANGE,
                final_name="天府", final_level=1, final_quality=Quality.ORANGE, is_complete_card=True,
            )],
        )


class FailingPipeline:
    def analyze(self, images, batch, pairs, progress=None):
        raise RuntimeError("local OCR failed")


def prepared_state() -> SessionState:
    state = SessionState(load_catalog())
    state.add_row(InventorySummaryRow(kind=StarKind.MAIN, name="天府", quality=Quality.PURPLE, level=2, quantity=3))
    image = image_input_from_upload("one.png", png(), "image/png")
    state.add_uploaded_image(image)
    state.suggest_image_pool(image.id, "main")
    state.set_image_pool(image.id, "main")
    return state


def test_import_transaction_applies_only_after_success() -> None:
    state = prepared_state()
    batch = state.start_import(GameVersion.RU_YUAN, "1", "250")

    result, accepted = asyncio.run(run_import_transaction(state, SuccessfulPipeline(), batch, {"main": [], "support": []}, io_bound=immediate_io_bound))

    assert result.executed
    assert accepted == 1
    assert [(row.name, row.quality, row.level, row.quantity) for row in state.rows] == [("天府", Quality.ORANGE, 1, 1)]
    assert state.import_batch is not None and state.import_batch.ocr_executed


def test_import_transaction_failure_preserves_old_session_and_inputs() -> None:
    state = prepared_state()
    before = state.snapshot()
    batch = state.start_import(GameVersion.RU_YUAN, "1", "250")

    outcome = asyncio.run(run_import_transaction(state, FailingPipeline(), batch, {"main": [], "support": []}, io_bound=immediate_io_bound))

    assert isinstance(outcome, ImportFailure)
    assert outcome.message == "local OCR failed"
    assert state.snapshot() == before
    assert len(state.uploaded_images) == 1


def test_reconfirming_same_pool_preserves_pairs_but_moving_one_image_only_removes_its_pairs() -> None:
    state = SessionState(load_catalog())
    first = image_input_from_upload("first.png", png(), "image/png")
    second = image_input_from_upload("second.png", png(), "image/png")
    third = image_input_from_upload("third.png", png(), "image/png")
    for image in (first, second, third):
        state.add_uploaded_image(image)
        state.suggest_image_pool(image.id, "main")
        state.set_image_pool(image.id, "main")
    state.add_overlap_pair("main", first.id, second.id)
    state.add_overlap_pair("main", second.id, third.id)

    state.set_image_pool(first.id, "main")
    assert state.overlap_pairs["main"] == [(first.id, second.id), (second.id, third.id)]
    state.set_image_pool(second.id, "experience")

    assert state.overlap_pairs["main"] == []
    assert state.image_pools[first.id] == "main"
    assert state.image_pools[third.id] == "main"


def test_one_click_confirmation_and_experience_reconfirmation_keep_independent_pairs() -> None:
    state = SessionState(load_catalog())
    images = [image_input_from_upload(f"image-{index}.png", png(), "image/png") for index in range(5)]
    for image, pool in zip(images, ("main", "main", "support", "support", "experience"), strict=True):
        state.add_uploaded_image(image)
        state.suggest_image_pool(image.id, pool)
    confirmed, failures = state.confirm_all_image_pools()
    assert (confirmed, failures) == (5, [])
    state.add_overlap_pair("main", images[0].id, images[1].id)
    state.add_overlap_pair("support", images[2].id, images[3].id)

    state.set_image_pool(images[4].id, "experience")
    reconfirmed, failures = state.confirm_all_image_pools()

    assert (reconfirmed, failures) == (0, [])
    assert state.overlap_pairs == {
        "main": [(images[0].id, images[1].id)],
        "support": [(images[2].id, images[3].id)],
    }


def test_local_ocr_engine_is_initialized_once_per_process(monkeypatch) -> None:
    class FakeRapidOcr:
        def __call__(self, image, use_det=True):
            return []

    previous_engine = LocalRapidOcr._shared_engine
    previous_count = LocalRapidOcr._initialization_count
    LocalRapidOcr._shared_engine = None
    LocalRapidOcr._initialization_count = 0
    monkeypatch.setitem(sys.modules, "rapidocr", SimpleNamespace(RapidOCR=FakeRapidOcr))
    try:
        first = LocalRapidOcr()
        second = LocalRapidOcr()
        assert first._get_engine() is second._get_engine()
        assert LocalRapidOcr.initialization_count() == 1
    finally:
        LocalRapidOcr._shared_engine = previous_engine
        LocalRapidOcr._initialization_count = previous_count
