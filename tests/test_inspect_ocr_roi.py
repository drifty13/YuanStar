from __future__ import annotations

import csv
from dataclasses import replace
from pathlib import Path

import cv2
import numpy as np

from tools.inspect_ocr_roi import (
    PRODUCTION_ROI,
    RoiParameters,
    clip_box,
    compare_parameters_from_args,
    inspect_image,
    parameters_from_args,
    parse_args,
    roi_boxes,
    roi_boxes_for_card,
)
from yuanstar.vision.card_detector import CircleProposal, _boxes
from yuanstar.vision.models import (
    CardCandidate,
    PageClassification,
    RecognizedStar,
    SingleImageAnalysis,
    ViewportResult,
)


def test_default_parameters_match_production_boxes() -> None:
    proposal = CircleProposal(120, 140, 35)
    _, production_name, production_level = _boxes(proposal)
    assert roi_boxes(120, 140, 35, PRODUCTION_ROI) == (
        production_name,
        production_level,
    )
    args = parse_args(["--image", "sample.png"])
    assert parameters_from_args(args) == PRODUCTION_ROI
    compare = compare_parameters_from_args(
        parse_args(["--image", "sample.png", "--compare-name-height", "0.78"])
    )
    assert compare is not None
    assert compare.name_y_offset == PRODUCTION_ROI.name_y_offset
    assert compare.name_height == 0.78
    card = CardCandidate(
        "card_001",
        0,
        0,
        (83, 105, 73, 71),
        (0.0, 0.0, 1.0, 1.0),
        True,
        0.97,
        (87, 173, 64, 20),
        (120, 107, 37, 20),
    )
    assert roi_boxes_for_card(card, PRODUCTION_ROI) == (
        card.name_box_original,
        card.level_box_original,
    )


def test_cli_override_is_in_memory_and_does_not_modify_production_source() -> None:
    detector_path = Path("src/yuanstar/vision/card_detector.py")
    before = detector_path.read_bytes()
    args = parse_args(
        [
            "--image",
            "sample.png",
            "--name-y-offset",
            "1.02",
            "--name-height",
            "0.78",
        ]
    )
    configured = parameters_from_args(args)
    assert configured.name_y_offset == 1.02
    assert configured.name_height == 0.78
    assert PRODUCTION_ROI == RoiParameters()
    assert detector_path.read_bytes() == before


def test_roi_boundary_clipping_never_exceeds_image() -> None:
    clipped = clip_box((-12, -7, 130, 90), 100, 60)
    assert clipped.actual == (0, 0, 100, 60)
    assert clipped.touches_left and clipped.touches_top
    assert clipped.touches_right and clipped.touches_bottom


class _CanonicalPipeline:
    def __init__(self, analysis: SingleImageAnalysis, image: np.ndarray) -> None:
        self.analysis = analysis
        self.image = image

    def analyze_path(self, _path: Path):
        return self.analysis, self.image


class _WebPipeline:
    def __init__(self, analysis: SingleImageAnalysis, image: np.ndarray) -> None:
        self.canonical_pipeline = _CanonicalPipeline(analysis, image)


def test_writes_overlay_crops_and_csv(tmp_path: Path) -> None:
    image = np.full((220, 200, 3), 80, dtype=np.uint8)
    card_box, name_box, level_box = _boxes(CircleProposal(100, 100, 35))
    card = CardCandidate(
        "card_001",
        0,
        0,
        card_box,
        (0.0, 0.0, 1.0, 1.0),
        True,
        0.97,
        name_box,
        level_box,
    )
    star = RecognizedStar(
        "card_001",
        "main",
        "天府",
        "天府",
        0.9,
        "60级",
        60,
        0.9,
        0.9,
        False,
    )
    analysis = SingleImageAnalysis(
        "sample",
        ViewportResult((200, 220), (0, 0, 200, 220), "test", 1.0),
        PageClassification("main", 1.0),
        [card],
        [star],
    )
    source = tmp_path / "sample.png"
    assert cv2.imwrite(str(source), image)

    destination = inspect_image(
        source,
        tmp_path / "output",
        replace(PRODUCTION_ROI, name_y_offset=1.02),
        replace(PRODUCTION_ROI, name_y_offset=1.02, name_height=0.78),
        pipeline=_WebPipeline(analysis, image),
    )

    basename = "r01_c01_card_001.png"
    assert (destination / "roi_overlay.png").is_file()
    assert (destination / "roi_overlay_compare.png").is_file()
    assert (destination / "name_crops" / basename).is_file()
    assert (destination / "level_crops" / basename).is_file()
    assert (destination / "name_crops_compare" / basename).is_file()
    with (destination / "roi_report.csv").open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    assert rows[0]["raw_name_text"] == "天府"
    assert rows[0]["raw_level_text"] == "60级"
    assert rows[0]["name_actual_w"] == rows[0]["name_w"]
