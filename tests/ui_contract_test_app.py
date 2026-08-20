from nicegui import ui

from test_phase0_3_ui_contract_rebuild import fixture_state
from yuanstar.app import create_app


STATE = fixture_state()


def root() -> None:
    create_app(state=STATE, pipeline=object())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8093, show=False, reload=False)
