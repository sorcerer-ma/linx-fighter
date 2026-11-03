#!/usr/bin/env python3
"""最小 MCP 客户端：通过 USB 串口用 JSON-RPC 2.0 驱动设备 HUD。

用法：
  mcp_drive.py info                 # initialize + tools/list
  mcp_drive.py demo                 # 调 self.hud.demo
  mcp_drive.py set <表情> [hp max_hp energy max_energy ult] [cue] [hold_ms]
  mcp_drive.py shots                # 依次设置 8 表情并截屏到 evidence/device_*.png
"""
import json
import os
import sys
import time

import serial

PORT = "/dev/cu.usbmodem2101"
BAUD = 115200
EVIDENCE = os.environ.get("HUD_EVIDENCE", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "hud", "evidence"))


class Mcp:
    def __init__(self, port=PORT):
        self.ser = serial.Serial(port, BAUD, timeout=0.05)
        self.buf = b""
        self.next_id = 1
        self.transcript = []

    def close(self):
        self.ser.close()

    def _readline(self, timeout=3.0):
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.buf += self.ser.read(4096)
            while b"\n" in self.buf:
                line, self.buf = self.buf.split(b"\n", 1)
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                # 旧通道的回复带 @@HUD 前缀，剥掉后按 JSON 解析；纯 ESP_LOG 行会被忽略
                if text.startswith("@@HUD "):
                    text = text[6:]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    continue
        raise TimeoutError("no JSON response in %.1fs" % timeout)

    def request(self, method, params=None, expect=True):
        msg = {"jsonrpc": "2.0", "method": method}
        rid = None
        if expect:
            rid = self.next_id
            self.next_id += 1
            msg["id"] = rid
        if params is not None:
            msg["params"] = params
        self.ser.write((json.dumps(msg) + "\n").encode())
        self.ser.flush()
        self.transcript.append({"tx": msg})
        if not expect:
            return None
        while True:
            resp = self._readline()
            if resp.get("id") == rid:
                self.transcript.append({"rx": resp})
                return resp

    def init(self):
        self.request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "linx-hud-probe", "version": "0.1.0"},
        })
        self.request("notifications/initialized", expect=False)

    def tools(self):
        return self.request("tools/list")["result"]["tools"]

    def call(self, name, arguments=None):
        return self.request("tools/call", {"name": name, "arguments": arguments or {}})

    def text_of(self, resp):
        return resp["result"]["content"][0]["text"]

    def screenshot(self, path):
        import base64
        self.ser.write((json.dumps({"id": 900, "method": "hud.screenshot"}) + "\n").encode())
        self.ser.flush()
        chunks = []
        while True:
            msg = self._readline(5)
            if msg.get("id") != 900:
                continue
            if msg.get("shot") == "end":
                break
            if "error" in msg:
                raise RuntimeError(msg["error"])
            if isinstance(msg.get("shot"), str):
                chunks.append(base64.b64decode(msg["shot"]))
        data = b"".join(chunks)
        from PIL import Image
        img = Image.frombytes("RGB", (320, 240), data, "raw", "BGR;16")
        img.save(path)
        return path


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    m = Mcp()
    m.init()
    cmd = args[0]
    if cmd == "info":
        for tool in m.tools():
            print(tool["name"], "-", tool.get("description", ""))
        print(json.dumps(m.call("self.hud.get_state"), ensure_ascii=False))
    elif cmd == "demo":
        print(json.dumps(m.call("self.hud.demo"), ensure_ascii=False))
    elif cmd == "set":
        expr = args[1]
        nums = [int(x) for x in args[2:7]] if len(args) >= 7 else [10, 10, 2, 5, 1]
        cue = args[7] if len(args) >= 8 else expr
        hold = int(args[8]) if len(args) >= 9 else 0
        resp = m.call("self.hud.set_state", {
            "expression": expr, "hp": nums[0], "max_hp": nums[1],
            "energy": nums[2], "max_energy": nums[3], "ult": nums[4],
            "cue": cue, "hold_ms": hold, "seq": int(time.time()),
        })
        print(json.dumps(resp, ensure_ascii=False))
    elif cmd == "pull":
        # 配置设备向服务端拉取画面：pull http://<mac>:8000/device/mcp [on|off]
        url = args[1] if len(args) >= 2 else ""
        enabled = True
        if len(args) >= 3:
            enabled = args[2] not in ("off", "false", "0")
        resp = m.call("self.hud.pull", {"url": url, "enabled": enabled})
        print(json.dumps(resp, ensure_ascii=False))
    elif cmd == "shots":
        plan = [
            ("neutral", 10, 10, 2, 5, 0),
            ("attack", 10, 10, 2, 5, 0),
            ("hurt", 6, 10, 3, 5, 0),
            ("guard", 6, 10, 4, 5, 0),
            ("dodge", 6, 10, 5, 5, 1),
            ("ultready", 6, 10, 5, 5, 1),
            ("victory", 4, 10, 5, 5, 2),
            ("defeat", 0, 10, 0, 5, 2),
        ]
        import os
        os.makedirs(EVIDENCE, exist_ok=True)
        for i, (expr, hp, max_hp, energy, max_energy, ult) in enumerate(plan):
            m.call("self.hud.set_state", {
                "expression": expr, "hp": hp, "max_hp": max_hp,
                "energy": energy, "max_energy": max_energy, "ult": ult,
                "cue": expr, "hold_ms": 4000, "seq": 100 + i,
            })
            time.sleep(0.9)
            out = m.screenshot("%s/device_%s.png" % (EVIDENCE, expr))
            print("shot", out)
    with open(os.path.join(EVIDENCE, "mcp_transcript.jsonl"), "a") as f:
        for row in m.transcript:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    m.close()


if __name__ == "__main__":
    main()
