from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from time import perf_counter


PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from yuanstar.vision.offline_pipeline import OfflineSingleImagePipeline  # noqa: E402
from yuanstar.vision.pipeline import LocalOfflineVisionPipeline  # noqa: E402


def parse_case(value: str) -> tuple[str, Path]:
    alias, separator, raw_path = value.partition("=")
    if not separator or not alias or not raw_path:
        raise argparse.ArgumentTypeError("case must use alias=path")
    return alias, Path(raw_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate ignored local Python main-star baselines")
    parser.add_argument("--case", action="append", required=True, type=parse_case)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    pipeline = OfflineSingleImagePipeline()
    payload: dict[str, object] = {"schema_version": 1, "cases": {}}
    for alias, path in args.case:
        if not path.is_file():
            raise FileNotFoundError(path)
        started = perf_counter()
        analysis, image = pipeline.analyze_path(path)
        excluded = LocalOfflineVisionPipeline._auto_excluded_edge_fragments(
            analysis.cards,
            image.shape[0],
            content_top=analysis.content_bounds[0] if analysis.content_bounds else None,
            content_bottom=analysis.content_bounds[1] if analysis.content_bounds else None,
        )
        stars = {star.card_id: star for star in analysis.stars}
        cards = []
        for card in analysis.cards:
            star = stars.get(card.card_id)
            edge = excluded.get(card.card_id)
            cards.append({
                "card_id": card.card_id,
                "row_index": card.row_index,
                "column_index": card.column_index,
                "card_rect": card.box_original,
                "circle": card.circle_original,
                "name_rect": card.name_box_original,
                "level_rect": card.level_box_original,
                "is_complete": card.is_complete and edge is None,
                "completeness": f"partial_{edge}" if edge else ("complete" if card.is_complete else "incomplete"),
                "name_raw": star.raw_name_text if star else None,
                "name": star.canonical_name if star else None,
                "name_confidence": star.name_confidence if star else 0.0,
                "level_raw": star.raw_level_text if star else None,
                "level": star.level if star else None,
                "level_confidence": star.level_confidence if star else 0.0,
                "review_required": star.review_required if star else not edge,
                "reasons": ([f"auto_excluded_edge_fragment_{edge}"] if edge else (star.warnings if star else ["no_recognized_star_for_candidate"])),
            })
        payload["cases"][alias] = {
            "image_size": [image.shape[1], image.shape[0]],
            "profile_id": analysis.viewport.profile_id,
            "viewport": analysis.viewport.viewport_box,
            "content_bounds": analysis.content_bounds,
            "page_type": analysis.page.page_type,
            "cards": cards,
            "complete_count": sum(item["is_complete"] for item in cards),
            "partial_count": sum(not item["is_complete"] for item in cards),
            "elapsed_ms": round((perf_counter() - started) * 1000, 2),
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({alias: {"complete": case["complete_count"], "partial": case["partial_count"], "elapsed_ms": case["elapsed_ms"]} for alias, case in payload["cases"].items()}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
