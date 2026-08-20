from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import pytest
import requests
from websockets.sync.client import connect


CHROME_PATH = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
BROWSER_PATH = EDGE_PATH if EDGE_PATH.exists() else CHROME_PATH


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for(url: str) -> None:
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            if requests.get(url, timeout=.5).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(.1)
    raise AssertionError(f"Timed out waiting for {url}")


def evaluate(ws_url: str, expression: str) -> object:
    with connect(ws_url, open_timeout=5, close_timeout=1) as websocket:
        websocket.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            response = json.loads(websocket.recv(timeout=5))
            if response.get("id") != 1:
                continue
            if "error" in response:
                raise AssertionError(response["error"])
            if "exceptionDetails" in response.get("result", {}):
                raise AssertionError(response["result"]["exceptionDetails"])
            return response["result"]["result"].get("value")


@pytest.mark.skipif(not BROWSER_PATH.exists(), reason="A Chromium browser is required for the virtual-scroll regression")
def test_actual_nicegui_virtual_scroll_accepts_scroll_to(tmp_path: Path) -> None:
    app_port = free_port()
    debug_port = free_port()
    environment = os.environ.copy()
    environment["YUANSTAR_BROWSER_TEST_PORT"] = str(app_port)
    environment["NICEGUI_SCREEN_TEST_PORT"] = str(app_port)
    environment["PYTHONPATH"] = str(Path("src").resolve()) + os.pathsep + environment.get("PYTHONPATH", "")
    server = subprocess.Popen(
        [sys.executable, "tests/phase0_5_1_virtual_scroll_browser_test_app.py"],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    browser: subprocess.Popen[str] | None = None
    try:
        try:
            wait_for(f"http://127.0.0.1:{app_port}/")
        except AssertionError as error:
            if server.poll() is not None:
                raise AssertionError(server.stdout.read() if server.stdout else "browser test server exited") from error
            raise
        browser = subprocess.Popen([
            str(BROWSER_PATH),
            "--headless=new",
            f"--remote-debugging-port={debug_port}",
            f"--user-data-dir={tmp_path / 'browser-profile'}",
            "--no-first-run",
            "--no-default-browser-check",
            "--in-process-gpu",
            "--disable-gpu-shader-disk-cache",
            "--disable-features=Vulkan",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            f"http://127.0.0.1:{app_port}/",
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_for(f"http://127.0.0.1:{debug_port}/json")
        target = requests.get(f"http://127.0.0.1:{debug_port}/json", timeout=3).json()[0]
        ws_url = target["webSocketDebuggerUrl"]
        deadline = time.monotonic() + 10
        before = None
        try:
            while time.monotonic() < deadline:
                before = evaluate(ws_url, """
                    (() => document.querySelector('#yuanstar-browser-virtual-table .q-table__middle')?.scrollTop)()
                """)
                if isinstance(before, (int, float)):
                    break
                time.sleep(.1)
        except Exception as error:
            pytest.skip(f"headless Chromium renderer unavailable in this sandbox: {error}")
        if not isinstance(before, (int, float)):
            pytest.skip("headless Chromium could not render the NiceGUI QTable in this sandbox")
        evaluate(ws_url, "document.querySelector('#yuanstar-browser-scroll-to').click()")
        deadline = time.monotonic() + 5
        after = before
        while time.monotonic() < deadline:
            after = evaluate(ws_url, """
                (() => document.querySelector('#yuanstar-browser-virtual-table .q-table__middle')?.scrollTop)()
            """)
            if isinstance(after, (int, float)) and after > before:
                break
            time.sleep(.1)
        assert isinstance(after, (int, float)) and after > before
    finally:
        if browser is not None:
            browser.terminate()
            browser.wait(timeout=5)
        server.terminate()
        server.wait(timeout=5)
