from __future__ import annotations

import json
from pathlib import Path
import socket
import subprocess
import time

import pytest
import requests
from websockets.sync.client import connect

from yuanstar.app import inventory_viewport_alignment_script


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


@pytest.mark.skipif(not BROWSER_PATH.exists(), reason="A Chromium browser is required for the DOM viewport regression")
def test_alignment_script_copies_scrolltop_once_and_clamps_in_real_dom(tmp_path: Path) -> None:
    debug_port = free_port()
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
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_for(f"http://127.0.0.1:{debug_port}/json")
        target = requests.get(f"http://127.0.0.1:{debug_port}/json", timeout=3).json()[0]
        ws_url = target["webSocketDebuggerUrl"]
        try:
            evaluate(ws_url, """
            document.body.innerHTML = `
              <div class="current-inventory-table"><div class="q-table__middle" style="height:100px;overflow:auto"><div style="height:1000px"></div></div></div>
              <div class="planned-inventory-table"><div class="q-table__middle" style="height:100px;overflow:auto"><div style="height:500px"></div></div></div>`;
            """)
        except (AssertionError, TimeoutError) as error:
            pytest.skip(f"headless Chromium renderer unavailable in this sandbox: {error}")
        evaluate(ws_url, "document.querySelector('.current-inventory-table .q-table__middle').scrollTop = 250")
        evaluate(ws_url, inventory_viewport_alignment_script(".current-inventory-table", ".planned-inventory-table"))
        time.sleep(.15)
        aligned_from_left = evaluate(ws_url, """
        (() => {
          const left = document.querySelector('.current-inventory-table .q-table__middle');
          const right = document.querySelector('.planned-inventory-table .q-table__middle');
          return {left: left.scrollTop, right: right.scrollTop};
        })()
        """)
        assert abs(aligned_from_left["left"] - aligned_from_left["right"]) <= 1

        independent = evaluate(ws_url, """
        (() => {
          const left = document.querySelector('.current-inventory-table .q-table__middle');
          const right = document.querySelector('.planned-inventory-table .q-table__middle');
          const before = left.scrollTop;
          right.scrollTop = 40;
          return {before, after: left.scrollTop};
        })()
        """)
        assert independent["before"] == independent["after"]

        evaluate(ws_url, "document.querySelector('.planned-inventory-table .q-table__middle').scrollTop = 220")
        evaluate(ws_url, inventory_viewport_alignment_script(".planned-inventory-table", ".current-inventory-table"))
        time.sleep(.15)
        aligned_from_right = evaluate(ws_url, """
        (() => {
          const left = document.querySelector('.current-inventory-table .q-table__middle');
          const right = document.querySelector('.planned-inventory-table .q-table__middle');
          return {left: left.scrollTop, right: right.scrollTop};
        })()
        """)
        assert abs(aligned_from_right["left"] - aligned_from_right["right"]) <= 1

        evaluate(ws_url, "document.querySelector('.current-inventory-table .q-table__middle').scrollTop = 900")
        evaluate(ws_url, inventory_viewport_alignment_script(".current-inventory-table", ".planned-inventory-table"))
        time.sleep(.15)
        assert evaluate(ws_url, "document.querySelector('.planned-inventory-table .q-table__middle').scrollTop") == 400
    finally:
        browser.terminate()
        browser.wait(timeout=5)
