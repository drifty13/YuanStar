from yuanstar.domain import Quality, display_name


def test_display_name_hides_orange_quality() -> None:
    assert display_name("武曲", Quality.ORANGE) == "武曲"


def test_display_name_shows_non_orange_quality() -> None:
    assert display_name("武曲", Quality.PURPLE) == "武曲（紫）"
