from yuanstar.domain import InventorySummaryRow, Quality, ReconciliationStatus, StarKind, inventory_total, reconcile


def test_inventory_total_only_counts_main_and_support_stars() -> None:
    rows = [
        InventorySummaryRow(kind=StarKind.MAIN, name="武曲", level=1, quality=Quality.ORANGE, quantity=3),
        InventorySummaryRow(kind=StarKind.SUPPORT, name="文昌", level=2, quality=Quality.PURPLE, quantity=4),
    ]
    assert inventory_total(rows) == 7


def test_mismatch_is_warning_not_a_blocking_error() -> None:
    rows = [InventorySummaryRow(kind=StarKind.MAIN, name="武曲", level=1, quantity=3)]
    result = reconcile(rows, expected_count=5)
    assert result.status == ReconciliationStatus.POSSIBLY_INCOMPLETE
    assert result.warning is not None
    assert result.actual_count == 3
