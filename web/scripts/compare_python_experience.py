from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".tmp" / "python_experience_baseline"
CASES = {
    "phone_experience_case_01": "browser_phone_experience_case_01.json",
    "tablet_experience_case_01": "browser_tablet_experience_case_01.json",
}
CANONICAL = {"orange": "橙星曜", "purple": "紫星曜", "white": "白星曜"}


def rect_values(rect: object) -> list[int]:
    if isinstance(rect, dict):
        return [int(rect[key]) for key in ("x", "y", "width", "height")]
    return [int(value) for value in rect]


def main() -> int:
    python = json.loads((BASE / "baseline.json").read_text(encoding="utf-8"))["cases"]
    report: dict[str, object] = {"cases": {}, "summary": {}}
    all_item_counts_match = True
    all_orders_match = True
    all_fields_match = True
    maximum_roi_delta = 0
    for alias, browser_name in CASES.items():
        expected = python[alias]
        browser = json.loads((BASE / browser_name).read_text(encoding="utf-8"))
        expected_items = expected["items"]
        browser_items = [item for item in browser["results"] if item["status"] != "excluded_partial"]
        item_count_match = len(expected_items) == len(browser_items)
        expected_order = [item["kind"] for item in expected_items]
        browser_order = [item["kind"] for item in browser_items]
        order_match = expected_order == browser_order
        all_item_counts_match &= item_count_match
        all_orders_match &= order_match
        differences = []
        roi_deltas: list[int] = []
        for index, expected_item in enumerate(expected_items):
            if index >= len(browser_items):
                differences.append({"index": index, "kind": "missing_browser_item"})
                all_fields_match = False
                continue
            item = browser_items[index]
            icon_delta = max(abs(left - right) for left, right in zip(rect_values(item["sourceRects"]["icon"]), rect_values(expected_item["icon_box"]), strict=True))
            count_delta = max(abs(left - right) for left, right in zip(rect_values(item["sourceRects"]["count"]), rect_values(expected_item["count_box"]), strict=True))
            roi_deltas.extend((icon_delta, count_delta))
            expected_count = int(expected_item["raw_texts"][0]) if expected_item["raw_texts"] else None
            fields_match = item["canonicalName"] == CANONICAL[expected_item["kind"]] and item["count"] == expected_count
            all_fields_match &= fields_match
            if not fields_match or max(icon_delta, count_delta) > 18:
                differences.append({
                    "index": index,
                    "python_kind": expected_item["kind"], "browser_kind": item["kind"],
                    "python_count": expected_count, "browser_count": item["count"],
                    "icon_roi_max_delta_px": icon_delta, "count_roi_max_delta_px": count_delta,
                })
        maximum_roi_delta = max(maximum_roi_delta, max(roi_deltas, default=0))
        aggregate_match = (
            browser["aggregate"]["orangeCount"] == expected["orange_count"]
            and browser["aggregate"]["purpleCount"] == expected["purple_count"]
            and browser["aggregate"]["whiteCount"] == expected["white_count"]
            and browser["aggregate"]["complete"] == expected["complete"]
        )
        all_fields_match &= aggregate_match
        report["cases"][alias] = {
            "python_items": len(expected_items),
            "browser_items": len(browser_items),
            "item_count_match": item_count_match,
            "order_match": order_match,
            "aggregate_match": aggregate_match,
            "python_counts": [expected["orange_count"], expected["purple_count"], expected["white_count"]],
            "browser_counts": [browser["aggregate"]["orangeCount"], browser["aggregate"]["purpleCount"], browser["aggregate"]["whiteCount"]],
            "browser_needs_review": sum(item["status"] == "needs_review" for item in browser["results"]),
            "browser_partial": sum(item["status"] == "excluded_partial" for item in browser["results"]),
            "roi_max_delta_px": max(roi_deltas, default=0),
            "timings": browser["timings"],
            "differences": differences,
        }
    report["summary"] = {
        "all_item_counts_match": all_item_counts_match,
        "all_orders_match": all_orders_match,
        "all_fields_and_aggregates_match": all_fields_match,
        "roi_max_delta_px": maximum_roi_delta,
    }
    (BASE / "parity.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
