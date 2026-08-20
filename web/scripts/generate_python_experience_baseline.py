from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from time import perf_counter


PROJECT_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from yuanstar.vision.offline_pipeline import OfflineSingleImagePipeline  # noqa: E402


def parse_case(value: str) -> tuple[str, Path]:
    alias, separator, raw_path = value.partition("=")
    if not separator or not alias or not raw_path:
        raise argparse.ArgumentTypeError("case must use alias=path")
    return alias, Path(raw_path)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate ignored local Python experience-star baselines")
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
        result = analysis.experience
        if result is None:
            raise RuntimeError(f"{alias}: Python production pipeline did not classify an experience page")
        evidence = []
        for kind, item in result.evidence.items():
            evidence.append({
                "kind": kind,
                "icon_box": item.get("icon_box"),
                "count_box": item.get("count_box"),
                "raw_texts": item.get("raw_texts", []),
            })
        payload["cases"][alias] = {
            "image_size": [image.shape[1], image.shape[0]],
            "profile_id": analysis.viewport.profile_id,
            "viewport": analysis.viewport.viewport_box,
            "content_bounds": analysis.content_bounds,
            "page_type": analysis.page.page_type,
            "page_confidence": analysis.page.confidence,
            "page_evidence": analysis.page.evidence,
            "items": evidence,
            "orange_count": result.orange_count,
            "purple_count": result.purple_count,
            "white_count": result.white_count,
            "orange_confidence": result.orange_confidence,
            "purple_confidence": result.purple_confidence,
            "white_confidence": result.white_confidence,
            "complete": result.complete,
            "warnings": result.warnings,
            "elapsed_ms": round((perf_counter() - started) * 1000, 2),
        }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = {
        alias: {
            "item_count": len(case["items"]),
            "counts": [case["orange_count"], case["purple_count"], case["white_count"]],
            "complete": case["complete"],
            "elapsed_ms": case["elapsed_ms"],
        }
        for alias, case in payload["cases"].items()
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
