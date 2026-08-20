from yuanstar.history import SessionHistory


def test_undo_and_redo_restore_snapshots() -> None:
    history: SessionHistory[dict] = SessionHistory(max_steps=30)
    current = {"rows": ["a"]}
    history.record(current)
    changed = {"rows": ["a", "b"]}
    assert history.undo(changed) == current
    assert history.redo(current) == changed


def test_new_change_clears_redo_stack() -> None:
    history: SessionHistory[dict] = SessionHistory(max_steps=30)
    history.record({"value": 1})
    assert history.undo({"value": 2}) == {"value": 1}
    history.record({"value": 3})
    assert not history.can_redo
