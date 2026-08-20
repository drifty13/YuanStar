from __future__ import annotations

import csv
from pathlib import Path

from tools.organize_samples import CSV_FIELDS
from tools.reconcile_sample_metadata import reconcile, reconciliation_rows


def png() -> bytes:
    return b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + (500).to_bytes(4, "big") + (1000).to_bytes(4, "big")


def test_reconciliation_uses_hash_and_filename_semantics_without_touching_images(tmp_path: Path) -> None:
    phase = tmp_path / "samples_private" / "phase0_2"
    image = phase / "raw" / "own_phone" / "main" / "own_phone_main_001.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(png())
    metadata = phase / "metadata" / "sample_notes.csv"
    metadata.parent.mkdir()
    old = {field: "" for field in CSV_FIELDS}
    old.update({"sample_id": "legacy_top_001", "relative_path": "raw/old/path.png", "sha256": __import__("hashlib").sha256(png()).hexdigest(), "scroll_position": "top"})
    with metadata.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS); writer.writeheader(); writer.writerow(old)
    rows, warnings = reconciliation_rows(phase)
    assert not warnings
    assert rows[0]["relative_path"] == "raw/own_phone/main/own_phone_main_001.png"
    assert rows[0]["scroll_position"] == "unknown"
    assert rows[0]["source_group"] == "own"
    before = image.read_bytes()
    _, _, backup = reconcile(phase, dry_run=False)
    assert backup and backup.exists()
    assert image.read_bytes() == before
