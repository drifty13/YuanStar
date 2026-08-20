from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / ".tmp" / "python_support_baseline"
CASES = {
    "phone_support_full_case_01": "browser_phone_support_full_case_01.json",
    "phone_support_tail_case_01": "browser_phone_support_tail_case_01.json",
    "tablet_support_case_01": "browser_tablet_support_case_01.json",
}


def rect_values(rect: object) -> list[int]:
    if isinstance(rect, dict):
        return [int(rect[key]) for key in ("x", "y", "width", "height")]
    return [int(value) for value in rect]


def main() -> int:
    python = json.loads((BASE / "baseline.json").read_text(encoding="utf-8"))["cases"]
    report: dict[str, object] = {"cases": {}, "summary": {}}
    field_matches = 0
    field_total = 0
    all_count_match = True
    all_order_match = True
    for alias, browser_name in CASES.items():
        expected = python[alias]
        browser = json.loads((BASE / browser_name).read_text(encoding="utf-8"))
        expected_cards = {(item["row_index"], item["column_index"]): item for item in expected["cards"] if item["is_complete"]}
        browser_candidates = {(item["rowIndex"], item["columnIndex"]): item for item in browser["candidates"] if item["completeness"] == "complete"}
        browser_results = {(item["rowIndex"], item["columnIndex"]): item for item in browser["results"] if item["status"] != "excluded_partial"}
        positions_match = list(expected_cards) == list(browser_candidates)
        count_match = len(expected_cards) == len(browser_candidates)
        all_count_match &= count_match
        all_order_match &= positions_match
        details = []
        roi_max_deltas: list[int] = []
        case_field_matches = 0
        case_field_total = 0
        for position, expected_card in expected_cards.items():
            candidate = browser_candidates.get(position)
            result = browser_results.get(position)
            if candidate is None or result is None:
                details.append({"position": position, "kind": "missing_browser_card"})
                continue
            deltas: dict[str, int] = {}
            for browser_key, python_key in (("cardRect", "card_rect"), ("nameRect", "name_rect"), ("levelRect", "level_rect")):
                left = rect_values(candidate[browser_key])
                right = rect_values(expected_card[python_key])
                deltas[browser_key] = max(abs(a - b) for a, b in zip(left, right, strict=True))
                roi_max_deltas.append(deltas[browser_key])
            name_match = result["nameNormalized"] == expected_card["name"]
            level_match = result["level"] == expected_card["level"]
            case_field_matches += int(name_match) + int(level_match)
            case_field_total += 2
            if not name_match or not level_match or max(deltas.values()) > 18:
                details.append({
                    "position": position,
                    "python_name": expected_card["name"], "browser_name": result["nameNormalized"],
                    "python_level": expected_card["level"], "browser_level": result["level"],
                    "roi_max_delta_px": deltas,
                })
        field_matches += case_field_matches
        field_total += case_field_total
        report["cases"][alias] = {
            "python_complete": len(expected_cards),
            "browser_complete": len(browser_candidates),
            "count_match": count_match,
            "row_column_order_match": positions_match,
            "python_partial": expected["partial_count"],
            "browser_partial": sum(item["completeness"] != "complete" for item in browser["candidates"]),
            "field_matches": case_field_matches,
            "field_total": case_field_total,
            "field_match_rate": round(case_field_matches / case_field_total, 4) if case_field_total else 0,
            "roi_max_delta_px": max(roi_max_deltas, default=0),
            "timings": browser["timings"],
            "differences": details,
        }
    report["summary"] = {
        "all_complete_counts_match": all_count_match,
        "all_row_column_orders_match": all_order_match,
        "field_matches": field_matches,
        "field_total": field_total,
        "field_match_rate": round(field_matches / field_total, 4) if field_total else 0,
    }
    (BASE / "parity.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
