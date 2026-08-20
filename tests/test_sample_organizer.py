from __future__ import annotations

import csv
import os
from pathlib import Path

import pytest

from tools import organize_samples


def png(width: int = 1080, height: int = 1920) -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + width.to_bytes(4, "big") + height.to_bytes(4, "big")


def jpeg(width: int = 1600, height: int = 2560) -> bytes:
    return b"\xff\xd8\xff\xc0\x00\x11\x08" + height.to_bytes(2, "big") + width.to_bytes(2, "big") + b"\x03\x01\x11\x00"


def layout(root: Path) -> Path:
    inbox = root / "samples_private" / "phase0_2" / "inbox"
    inbox.mkdir(parents=True)
    (root / "samples_private" / "phase0_2" / "metadata").mkdir(parents=True)
    return inbox


def rows(root: Path) -> list[dict[str, str]]:
    path = root / "samples_private" / "phase0_2" / "metadata" / "sample_notes.csv"
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def organize(root: Path, **kwargs):
    return organize_samples.organize_batch(root=root, **kwargs)


def base_args() -> dict[str, str]:
    return {"source": "own", "device": "phone", "page": "main", "position": "top", "complete": "yes"}


def test_empty_inbox_is_safe(tmp_path: Path) -> None:
    layout(tmp_path)

    assert organize(tmp_path, **base_args()) == []
    assert not (tmp_path / "samples_private" / "phase0_2" / "metadata" / "sample_notes.csv").exists()


def test_supported_formats_sort_number_and_preserve_bytes(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    files = [("middle10.png", png(), 20), ("first2.jpg", jpeg(), 10), ("last1.JPEG", jpeg(2048, 2732), 30)]
    for name, content, mtime in files:
        path = inbox / name
        path.write_bytes(content)
        os.utime(path, (mtime, mtime))

    organize(tmp_path, **base_args())

    destination = tmp_path / "samples_private" / "phase0_2" / "raw" / "own_phone" / "main"
    names = sorted(path.name for path in destination.iterdir())
    assert names == ["own_phone_main_001.jpg", "own_phone_main_002.png", "own_phone_main_003.jpeg"]
    assert (destination / names[0]).read_bytes() == jpeg()
    assert (destination / names[1]).read_bytes() == png()
    assert (destination / names[2]).read_bytes() == jpeg(2048, 2732)
    assert [row["original_filename"] for row in rows(tmp_path)] == ["first2.jpg", "middle10.png", "last1.JPEG"]
    assert rows(tmp_path)[0]["width"] == "1600"
    assert rows(tmp_path)[0]["is_partial"] == "false"
    assert rows(tmp_path)[0]["is_cropped"] == ""
    assert rows(tmp_path)[0]["is_reencoded"] == ""
    assert len(rows(tmp_path)[0]["sha256"]) == 64
    assert (tmp_path / "samples_private" / "phase0_2" / "metadata" / "sample_notes.csv").read_bytes().startswith(b"\xef\xbb\xbf")


def test_dry_run_does_not_move_or_write_manifest(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    source = inbox / "one.png"
    source.write_bytes(png())

    plans = organize(tmp_path, **base_args(), dry_run=True)

    assert len(plans) == 1
    assert source.exists()
    assert not (tmp_path / "samples_private" / "phase0_2" / "metadata" / "sample_notes.csv").exists()


def test_existing_number_is_not_overwritten_and_start_is_supported(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    destination = tmp_path / "samples_private" / "phase0_2" / "raw" / "own_phone" / "main"
    destination.mkdir(parents=True)
    existing = destination / "own_phone_main_003.png"
    existing.write_bytes(b"existing")
    (inbox / "new.png").write_bytes(png())

    organize(tmp_path, **base_args())

    assert existing.read_bytes() == b"existing"
    assert (destination / "own_phone_main_004.png").read_bytes() == png()
    (inbox / "explicit.jpg").write_bytes(jpeg())
    organize(tmp_path, **base_args(), start=8)
    assert (destination / "own_phone_main_008.jpg").read_bytes() == jpeg()


def test_duplicate_hash_skips_by_default_and_allow_duplicate_moves(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    first = inbox / "first.png"
    first.write_bytes(png())
    organize(tmp_path, **base_args())
    duplicate = inbox / "duplicate.jpg"
    duplicate.write_bytes(png())

    assert organize(tmp_path, **base_args()) == []
    assert duplicate.exists()
    assert len(rows(tmp_path)) == 1
    organize(tmp_path, **base_args(), allow_duplicate=True)
    assert not duplicate.exists()
    assert len(rows(tmp_path)) == 2


def test_moving_failure_rolls_back_and_does_not_write_manifest(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    inbox = layout(tmp_path)
    source = inbox / "one.png"
    source.write_bytes(png())

    def fail_move(*_args, **_kwargs):
        raise OSError("simulated move failure")

    monkeypatch.setattr(organize_samples.shutil, "move", fail_move)
    with pytest.raises(organize_samples.OrganizerError, match="整理失败"):
        organize(tmp_path, **base_args())

    assert source.exists()
    assert not (tmp_path / "samples_private" / "phase0_2" / "metadata" / "sample_notes.csv").exists()


def test_external_and_edge_names_use_requested_metadata(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    (inbox / "external.png").write_bytes(png())
    organize(tmp_path, source="external", device="tablet", page="support", position="unknown", complete="no")
    (inbox / "edge.jpg").write_bytes(jpeg())
    organize(tmp_path, source="edge", device="phone", page="main", position="top", complete="unknown")

    assert (tmp_path / "samples_private" / "phase0_2" / "raw" / "external_partial" / "tablet" / "support" / "external_tablet_support_partial_001.png").exists()
    assert (tmp_path / "samples_private" / "phase0_2" / "raw" / "edge_cases" / "edge_phone_main_001.jpg").exists()
    assert rows(tmp_path)[0]["is_partial"] == "true"


def test_unknown_position_is_omitted_from_own_filename(tmp_path: Path) -> None:
    inbox = layout(tmp_path)
    (inbox / "tablet.png").write_bytes(png())

    plans = organize(tmp_path, source="own", device="tablet", page="main", position="unknown", complete="yes", dry_run=True)

    assert plans[0].destination_path.name == "own_tablet_main_001.png"
