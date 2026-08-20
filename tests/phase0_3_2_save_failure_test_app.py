from pathlib import Path

from nicegui import ui

from test_phase0_3_ui_contract_rebuild import fixture_state
from yuanstar.app import create_app
from yuanstar.persistence import WorkspaceStore


class FailingStore(WorkspaceStore):
    def __init__(self) -> None:
        super().__init__(Path("unused"))

    def save(self, state):
        raise OSError("测试磁盘写入失败")


def root() -> None:
    create_app(state=fixture_state(), pipeline=object(), workspace_store=FailingStore())  # type: ignore[arg-type]


ui.run(root, host="127.0.0.1", port=8097, show=False, reload=False)
