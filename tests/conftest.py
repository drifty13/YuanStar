import pytest


pytest_plugins = ["nicegui.testing.user_plugin"]


def pytest_configure(config):
    config.addinivalue_line("markers", "anyio: run an async test with AnyIO")


@pytest.fixture
def anyio_backend():
    return "asyncio"
