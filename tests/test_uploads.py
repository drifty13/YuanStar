from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from yuanstar.app import accept_uploaded_file
from yuanstar.catalog import load_catalog
from yuanstar.domain import GameVersion, InventorySummaryRow, Quality, StarKind
from yuanstar.session import SessionState
from yuanstar.vision.contracts import ImageInput
from yuanstar.vision.image_metadata import image_input_from_upload


def png(width: int = 1080, height: int = 1920) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + width.to_bytes(4, "big") + height.to_bytes(4, "big")


def jpeg(width: int = 1600, height: int = 2560) -> bytes:
    return b"\xff\xd8\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03\x01\x11\x00"


class FakeFileUpload:
    def __init__(self, name: str, content_type: str, content: bytes) -> None:
        self.name = name
        self.content_type = content_type
        self._content = content
        self.read_calls = 0

    async def read(self) -> bytes:
        self.read_calls += 1
        return self._content

    async def size(self) -> int:
        return len(self._content)


def event(name: str, content_type: str, content: bytes) -> SimpleNamespace:
    return SimpleNamespace(file=FakeFileUpload(name, content_type, content))


@pytest.mark.parametrize(
    ("name", "content_type", "content", "expected"),
    [
        ("one.png", "image/png", png(1080, 1920), (1080, 1920)),
        ("one.jpg", "image/jpeg", jpeg(1600, 2560), (1600, 2560)),
        ("one.jpeg", "image/jpeg", jpeg(2048, 2732), (2048, 2732)),
    ],
)
def test_nicegui3_file_upload_handler_accepts_supported_images(
    name: str, content_type: str, content: bytes, expected: tuple[int, int]
) -> None:
    state = SessionState(load_catalog())
    upload_event = event(name, content_type, content)

    image = asyncio.run(accept_uploaded_file(upload_event, state))

    assert upload_event.file.read_calls == 1
    assert state.uploaded_images == [image]
    assert (image.width, image.height) == expected
    assert image.content == content
    assert image.size_bytes == len(content)
    assert image.content_type == content_type


def test_identical_filenames_are_independent_pending_images() -> None:
    state = SessionState(load_catalog())
    first = asyncio.run(accept_uploaded_file(event("same.png", "image/png", png()), state))
    second = asyncio.run(accept_uploaded_file(event("same.png", "image/png", png(720, 1280)), state))

    assert [image.filename for image in state.uploaded_images] == ["same.png", "same.png"]
    assert first.id != second.id


def test_invalid_upload_does_not_change_pending_images() -> None:
    state = SessionState(load_catalog())
    with pytest.raises(ValueError, match="无法读取图片尺寸"):
        asyncio.run(accept_uploaded_file(event("broken.png", "image/png", b"not an image"), state))
    with pytest.raises(ValueError, match="仅支持"):
        image_input_from_upload("wrong.gif", b"GIF89a", "image/gif")
    assert state.uploaded_images == []


def test_remove_and_clear_pending_images_do_not_change_inventory() -> None:
    state = SessionState(load_catalog())
    row = InventorySummaryRow(kind=StarKind.MAIN, name="天府", quality=Quality.ORANGE, level=1, quantity=2)
    state.add_row(row)
    state.save_bag_info(GameVersion.DAI_HAO_YUAN, "186", "250")
    first = image_input_from_upload("one.png", png(), "image/png")
    second = image_input_from_upload("two.png", png(), "image/png")
    state.add_uploaded_image(first)
    state.add_uploaded_image(second)

    assert state.remove_uploaded_image(first.id)
    assert [image.id for image in state.uploaded_images] == [second.id]
    assert len(state.rows) == 2
    assert all(row.quantity == 1 for row in state.rows)
    assert (state.game_version, state.bag_current_count, state.bag_capacity) == (GameVersion.DAI_HAO_YUAN, 186, 250)
    state.clear_uploaded_images()
    assert state.uploaded_images == []
    assert state.rows == []
    assert (state.game_version, state.bag_current_count, state.bag_capacity) == (
        GameVersion.DAI_HAO_YUAN,
        None,
        None,
    )


def test_no_image_import_preserves_pending_and_history() -> None:
    state = SessionState(load_catalog())
    state.add_row(InventorySummaryRow(kind=StarKind.MAIN, name="天府", quality=Quality.ORANGE, level=1, quantity=1))
    state.history = state.history.__class__(max_steps=30)
    before = state.snapshot()

    with pytest.raises(ValueError, match="请先上传至少一张截图"):
        state.start_import(GameVersion.RU_YUAN, "1", "250")

    assert state.snapshot() == before
    assert not state.history.can_undo


def test_import_batch_counts_all_pending_images_and_keeps_them() -> None:
    state = SessionState(load_catalog())
    state.add_uploaded_image(image_input_from_upload("one.png", png(), "image/png"))
    state.add_uploaded_image(image_input_from_upload("two.jpg", jpeg(), "image/jpeg"))

    batch = state.start_import(GameVersion.RU_YUAN, "2", "250")

    assert batch.image_count == 2
    assert len(state.uploaded_images) == 2


def test_snapshot_keeps_upload_metadata_without_screenshot_bytes() -> None:
    state = SessionState(load_catalog())
    image = ImageInput(filename="private.png", width=1, height=1, size_bytes=3, content=b"abc")
    state.add_uploaded_image(image)

    snapshot = state.snapshot()

    assert "uploaded_images" not in snapshot
    assert snapshot["uploaded_image_metadata"] == [
        {
            "id": image.id,
            "filename": "private.png",
            "width": 1,
            "height": 1,
            "size_bytes": 3,
            "content_type": None,
        }
    ]
