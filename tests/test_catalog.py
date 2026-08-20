from openpyxl import Workbook

from yuanstar.catalog import load_catalog
from yuanstar.domain import StarKind


def test_catalog_has_confirmed_counts_and_no_unofficial_name() -> None:
    catalog = load_catalog()
    assert len(catalog.by_kind(StarKind.MAIN)) == 14
    assert len(catalog.by_kind(StarKind.SUPPORT)) == 24
    assert len(catalog.by_kind(StarKind.EXPERIENCE)) == 2
    assert "双抗" not in [entry.name for entry in catalog.entries]


def test_aliases_normalize_to_confirmed_values() -> None:
    catalog = load_catalog()
    assert catalog.normalize("紫薇") == "紫微"
    assert catalog.normalize("紫星耀") == "紫星曜"
    assert catalog.normalize("星耀") == "星曜"


def test_catalog_loads_reference_descriptions_with_aliases_and_newlines() -> None:
    catalog = load_catalog()

    assert catalog.description("天府") == "百分比攻击力"
    assert catalog.description("武曲") == "白值攻击力\n百分比生命值"
    assert catalog.description("紫微") == "百分比生命值\n白值生命值"
    assert catalog.description("紫薇") == "百分比生命值\n白值生命值"


def test_catalog_uses_only_description_column_and_ignores_blank_descriptions(tmp_path) -> None:
    reference_path = tmp_path / "reference.xlsx"
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "表格视图"
    sheet.append(["星石名称", "星石描述", "属性加成"])
    sheet.append(["天府", "第一行\n第二行", "不得作为说明"])
    sheet.append(["武曲", "", "不得作为说明"])
    sheet.append(["紫薇", "别名说明", "不得作为说明"])
    workbook.save(reference_path)
    workbook.close()

    catalog = load_catalog(reference_path=reference_path)

    assert catalog.description("天府") == "第一行\n第二行"
    assert catalog.description("武曲") is None
    assert catalog.description("紫微") == "别名说明"
