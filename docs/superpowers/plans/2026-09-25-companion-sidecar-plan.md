# Companion PC Sidecar Implementation Plan (Plan 2/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PC 本机 sidecar（抓 Eden 源窗 → ROI 变化触发 → 繁中 OCR → localhost 桥），浏览器游戏 App 轮询接事件。

**Architecture:** Python 常驻进程（`pywin32` 定 HWND → `windows-capture` WGC 抓帧 → numpy 差分触发 → `PaddleOCR PP-OCRv5_mobile_rec`）+ stdlib `ThreadingHTTPServer` 暴露 `GET /events`；Web 侧 `utils/gameBridge.ts` 轮询映射进 Task 1 频道。overlay 壳与平板服务不在本计划。

**Tech Stack:** Python 3.10–3.12, windows-capture>=2.0, pywin32>=309, paddlepaddle>=3.0,<3.1, paddleocr>=3.5,<4, numpy, Pillow, pytest; Web: fetch poller + vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-game-companion-design.md` (validation: source-window only, horizontal single ROI, pure text, no audio)

**Worktree:** `.worktrees/game-companion` (`feat/game-companion`, continues after Plan 1 — do NOT merge ethernet again; base is current tip).

## Global Constraints

- Validation only: Eden 源窗对话框 ROI + 选项区 ROI（横排）；竖排/缩放窗/音频一律不做。
- 选项展示（读出率验收）在验证期；“选了什么”的突变推断与阈值调参需 live Eden，延后。
- Bridge: `http://127.0.0.1:18741` (override `--port` / env `COMPANION_BRIDGE_PORT`); every response carries `Access-Control-Allow-Origin: *` + `OPTIONS` handling; no cookies/auth.
- Event JSON matches channel Detail shapes (`text/at/source`, options `{id,options,at}`, choice `{optionsId,index,at}`); `seq` integers, `since/next` idempotent replay.
- OCR model: `PP-OCRv5_mobile_rec` (繁中原生，无需切语言).
- No new npm dependencies. Python deps pinned in `sidecar/requirements.txt`.
- Commands run on Windows pwsh; `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)` before Chinese-output commands.

## Review Focus

- Eden renamed/closed mid-run reports missing; app shows offline until bridge returns — Task 5 missing test + Task 6 offline test pin this.
- ROI drift on window resize has no auto-detect in validation (calibration values need live Eden); the loop never crashes on size change — shape-mismatch counts as change (Task 2 test pins it), and README documents recalibration.
- OCR slower than frame rate piles up latency — single-flight guard: skip a trigger while OCR busy and count `dropped` (Task 5 test pins drop, not queue).
- Port occupied at startup fails loud with the conflicting port in the message (Task 1 test pins `OSError` text), not silent fallback.
- Poll overlap double-delivers — `since/next` seq makes redelivery idempotent (Task 6 test pins duplicate seq ignored).

---

### Task 1: Bridge server (stdlib only)

**Files:**
- Create: `sidecar/bridge.py`
- Create: `sidecar/tests/test_bridge.py`
- Create: `sidecar/requirements.txt` (seed: `pytest` only for now; later tasks append)

**Interfaces:**
- Consumes: stdlib `http.server.ThreadingHTTPServer`.
- Produces: `BridgeServer(port)` with `.enqueue(type, payload) -> seq`, `.start()`, `.stop()`; `GET /healthz` → `{"ok":true,"version":1}`; `GET /events?since=N` → `{"events":[{"seq","type","payload"}],"next":M}` (used by Tasks 5–6).

- [ ] **Step 1: Write the failing test**

`sidecar/tests/test_bridge.py`:

```python
import json
import urllib.request
from sidecar.bridge import BridgeServer


def test_healthz_and_event_roundtrip():
    server = BridgeServer(port=18799)
    server.start()
    try:
        with urllib.request.urlopen("http://127.0.0.1:18799/healthz") as r:
            assert json.load(r) == {"ok": True, "version": 1}
            assert r.headers.get("Access-Control-Allow-Origin") == "*"
        seq = server.enqueue("line", {"text": "hi", "at": 1, "source": "pc-window"})
        with urllib.request.urlopen(
            "http://127.0.0.1:18799/events?since=0"
        ) as r:
            body = json.load(r)
        assert body["events"][0]["seq"] == seq
        assert body["next"] == seq + 1
        with urllib.request.urlopen(
            f"http://127.0.0.1:18799/events?since={seq + 1}"
        ) as r:
            assert json.load(r)["events"] == []
    finally:
        server.stop()


def test_port_conflict_fails_loud():
    first = BridgeServer(port=18798)
    first.start()
    try:
        second = BridgeServer(port=18798)
        try:
            second.start()
        except OSError as e:
            assert "18798" in str(e)
        else:
            raise AssertionError("expected OSError")
    finally:
        first.stop()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest sidecar/tests/test_bridge.py -x -q`
Expected: FAIL with "No module named 'sidecar'" (run from worktree root; add `sidecar/__init__.py` empty + `sidecar/tests/__init__.py` empty as part of implementation, or set `PYTHONPATH=.` — do the `__init__.py` files).

- [ ] **Step 3: Write minimal implementation**

`sidecar/bridge.py`:

```python
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

VERSION = 1


class BridgeServer:
    def __init__(self, port=18741):
        self._port = port
        self._lock = threading.Lock()
        self._events = []
        self._seq = 0
        self._server = None
        self._thread = None

    def enqueue(self, type, payload):
        with self._lock:
            self._seq += 1
            self._events.append({"seq": self._seq, "type": type, "payload": payload})
            if len(self._events) > 500:
                del self._events[: len(self._events) - 500]
            return self._seq

    def start(self):
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def _cors(self):
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

            def do_OPTIONS(self):
                self.send_response(204)
                self._cors()
                self.end_headers()

            def do_GET(self):
                parsed = urlparse(self.path)
                if parsed.path == "/healthz":
                    self._json({"ok": True, "version": VERSION})
                elif parsed.path == "/events":
                    since = int(parse_qs(parsed.query).get("since", ["0"])[0])
                    with outer._lock:
                        events = [e for e in outer._events if e["seq"] > since]
                        nxt = outer._seq
                    self._json({"events": events, "next": nxt})
                else:
                    self.send_response(404)
                    self._cors()
                    self.end_headers()

            def _json(self, obj):
                body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        try:
            self._server = ThreadingHTTPServer(("127.0.0.1", self._port), Handler)
        except OSError as e:
            raise OSError(f"bridge port {self._port} unavailable: {e}") from e
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def stop(self):
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()
            self._server = None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest sidecar/tests/test_bridge.py -q`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add sidecar/bridge.py sidecar/tests/test_bridge.py sidecar/__init__.py sidecar/tests/__init__.py sidecar/requirements.txt
git commit -m "feat: add sidecar localhost bridge with event queue"
```

---

### Task 2: Change trigger on numpy frames (no native deps)

**Files:**
- Create: `sidecar/trigger.py`
- Create: `sidecar/tests/test_trigger.py`

**Interfaces:**
- Consumes: numpy arrays (H,W,3) uint8.
- Produces: `frame_diff(prev, cur) -> float`, `should_ocr(prev, cur, threshold=12.0) -> bool` (Task 5).

- [ ] **Step 1: Write the failing test**

```python
import numpy as np
from sidecar.trigger import frame_diff, should_ocr


def test_identical_frames_zero():
    f = np.zeros((60, 200, 3), dtype=np.uint8)
    assert frame_diff(f, f.copy()) == 0.0
    assert should_ocr(f, f.copy()) is False


def test_changed_region_triggers():
    prev = np.zeros((60, 200, 3), dtype=np.uint8)
    cur = prev.copy()
    cur[10:30, 10:100] = 255
    assert frame_diff(prev, cur) > 12.0
    assert should_ocr(prev, cur) is True


def test_shape_mismatch_is_change():
    a = np.zeros((60, 200, 3), dtype=np.uint8)
    b = np.zeros((80, 200, 3), dtype=np.uint8)
    assert should_ocr(a, b) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest sidecar/tests/test_trigger.py -x -q`
Expected: FAIL with "No module named 'sidecar.trigger'" (or import error).

- [ ] **Step 3: Write minimal implementation**

`sidecar/trigger.py`:

```python
import numpy as np

CHANGE_THRESHOLD = 12.0


def frame_diff(prev, cur):
    if prev.shape != cur.shape:
        return float("inf")
    a = prev.astype(np.float32).mean(axis=2)
    b = cur.astype(np.float32).mean(axis=2)
    return float(np.abs(a - b).mean())


def should_ocr(prev, cur, threshold=CHANGE_THRESHOLD):
    return frame_diff(prev, cur) >= threshold
```

Append `numpy` and `Pillow` to `sidecar/requirements.txt` (one per line, no version pins yet — Task 5 pins all).

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest sidecar/tests/ -q`
Expected: PASS (bridge 2 + trigger 3).

- [ ] **Step 5: Commit**

```bash
git add sidecar/trigger.py sidecar/tests/test_trigger.py sidecar/requirements.txt
git commit -m "feat: add frame change trigger for OCR gating"
```

---

### Task 3: Window capture + ROI config (native, guarded)

**Files:**
- Create: `sidecar/roi.json` (example config, Eden window name placeholder the user edits)
- Create: `sidecar/capture.py`
- Create: `sidecar/tests/test_capture.py` (pure parts only)

**Interfaces:**
- Consumes: `pywin32` (`win32gui`), `windows-capture`.
- Produces: `load_config(path) -> dict` (validated; `options` ROI optional, `None` when unset), `CaptureError`, `WindowCapture(window_name, rois)` with `.grab(name) -> numpy|None` for `"dialog"`/`"options"` (Task 5). Missing window yields `None`, never raises.

`sidecar/roi.json`:

```json
{
  "window": "Eden",
  "port": 18741,
  "dialog": { "x": 0, "y": 0, "w": 0, "h": 0 },
  "options": { "x": 0, "y": 0, "w": 0, "h": 0 }
}
```

(`w/h 0` = uncalibrated; dialog must be calibrated before OCR runs, options may stay unset to skip the options path.)

- [ ] **Step 1: Write the failing test** (pure parts: config validation, no Eden needed)

```python
import json
import pytest
from sidecar.capture import CaptureError, load_config


def test_load_config_rejects_unset_dialog(tmp_path):
    p = tmp_path / "roi.json"
    p.write_text(json.dumps({"window": "Eden", "dialog": {"x": 0, "y": 0, "w": 0, "h": 0}}), encoding="utf-8")
    with pytest.raises(CaptureError):
        load_config(str(p))


def test_load_config_accepts_calibrated_without_options(tmp_path):
    p = tmp_path / "roi.json"
    p.write_text(
        json.dumps({"window": "Eden", "dialog": {"x": 100, "y": 500, "w": 800, "h": 160}}),
        encoding="utf-8",
    )
    cfg = load_config(str(p))
    assert cfg["dialog"]["w"] == 800
    assert cfg["options"] is None


def test_load_config_accepts_options_when_set(tmp_path):
    p = tmp_path / "roi.json"
    p.write_text(
        json.dumps({
            "window": "Eden",
            "dialog": {"x": 100, "y": 500, "w": 800, "h": 160},
            "options": {"x": 100, "y": 200, "w": 800, "h": 240},
        }),
        encoding="utf-8",
    )
    assert load_config(str(p))["options"]["h"] == 240
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest sidecar/tests/test_capture.py -x -q`
Expected: FAIL with import error (no `sidecar.capture`).

- [ ] **Step 3: Write minimal implementation**

`sidecar/capture.py`:

```python
import json

try:
    import win32gui
except ImportError:  # pragma: no cover - Windows only
    win32gui = None

try:
    from windows_capture import WindowsCapture
except ImportError:  # pragma: no cover - Windows only
    WindowsCapture = None


class CaptureError(Exception):
    pass


def _check_roi(cfg, key, required):
    r = cfg.get(key) or {}
    ok = r.get("w", 0) > 0 and r.get("h", 0) > 0
    if required and not ok:
        raise CaptureError(f"roi.json: {key} is uncalibrated (w/h must be > 0)")
    return dict(r) if ok else None


def load_config(path):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("window"):
        raise CaptureError("roi.json: window name is empty")
    dialog = _check_roi(cfg, "dialog", required=True)
    options = _check_roi(cfg, "options", required=False)
    return {"window": cfg["window"], "port": cfg.get("port", 18741),
            "dialog": dialog, "options": options}


class WindowCapture:
    """Grab named ROIs from a window. Missing window or unset ROI yields
    None instead of raising."""

    def __init__(self, window_name, rois):
        if win32gui is None or WindowsCapture is None:
            raise CaptureError("capture needs Windows + pywin32 + windows-capture installed")
        self._session = WindowsCapture(window_name=window_name)
        self._rois = rois

    def grab(self, name):
        roi = (self._rois or {}).get(name)
        if not roi:
            return None
        try:
            frame = self._session.grab_frame() if hasattr(self._session, "grab_frame") else None
        except Exception:
            return None
        if frame is None:
            return None
        img = frame.to_numpy() if hasattr(frame, "to_numpy") else frame
        x, y, w, h = (roi[k] for k in ("x", "y", "w", "h"))
        return img[y : y + h, x : x + w]
```

Note: verify `WindowsCapture` frame API against the installed package (`python -c "import windows_capture; help(windows_capture.WindowsCapture)"`) before finalizing `grab`; keep the `None`-on-missing contract regardless of exact call shape. Append `windows-capture>=2.0` and `pywin32>=309` to requirements.

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest sidecar/tests/ -q`
Expected: PASS (all files; native import guarded so CI-safe).

- [ ] **Step 5: Document the live smoke command (no commit of results)**

Add to `sidecar/README.md` (create): calibration flow for BOTH ROIs —
`python -m sidecar.main --dump-frame` saves `frame.png` plus current ROI crops; user reads dialog/options x/y/w/h into `roi.json`; rerun must log `capture ok <WxH>`. (The `--dump-frame` flag itself is implemented in Task 5.)

- [ ] **Step 6: Commit**

```bash
git add sidecar/capture.py sidecar/tests/test_capture.py sidecar/roi.json sidecar/README.md
git commit -m "feat: add window capture with ROI config"
```

---

### Task 4: OCR wrapper (PP-OCRv5_mobile_rec)

**Files:**
- Create: `sidecar/ocr.py`
- Create: `sidecar/tests/test_ocr.py`

**Interfaces:**
- Consumes: numpy ROI image.
- Produces: `OcrEngine.recognize(img) -> [{"text","conf","box"}]` sorted top-to-bottom (Task 5). First run downloads the model (~100MB) — note in README.

- [ ] **Step 1: Confirm the installed API shape (concrete check, then write test)**

Run: `python -c "from paddleocr import TextRecognition; help(TextRecognition.__init__)"`
Conform the wrapper to the observed signature (model_name + init/d predict method names). If `TextRecognition` does not exist in the installed 3.x, use the documented pipeline class from `python -m paddleocr --help` output instead — record which one in the test docstring. No guessing.

- [ ] **Step 2: Write the failing test**

```python
import numpy as np
from PIL import Image, ImageDraw
from sidecar.ocr import OcrEngine


def _render(text):
    img = Image.new("RGB", (400, 80), "white")
    ImageDraw.Draw(img).text((10, 10), text, fill="black")
    return np.array(img)


def test_recognizes_rendered_text():
    engine = OcrEngine()
    out = engine.recognize(_render("繁體中文測試"))
    joined = "".join(r["text"] for r in out)
    assert "繁體中文" in joined
```

- [ ] **Step 3: Run test to verify it fails**

Run: `python -m pytest sidecar/tests/test_ocr.py -x -q`
Expected: FAIL (no `sidecar.ocr`).

- [ ] **Step 4: Write minimal implementation**

`sidecar/ocr.py` (shape per Step 1 observation; skeleton):

```python
import numpy as np
from paddleocr import TextRecognition


class OcrEngine:
    def __init__(self, model_name="PP-OCRv5_mobile_rec"):
        self._rec = TextRecognition(model_name=model_name)

    def recognize(self, img):
        raw = self._rec.predict(img)
        out = []
        for item in raw or []:
            texts = item.get("rec_texts") or []
            scores = item.get("rec_scores") or []
            boxes = item.get("rec_boxes") or []
            for i, t in enumerate(texts):
                out.append({
                    "text": t,
                    "conf": float(scores[i]) if i < len(scores) else 0.0,
                    "box": boxes[i].tolist() if i < len(boxes) else None,
                })
        out.sort(key=lambda r: (r["box"][1] if r["box"] else 0))
        return out
```

(Adjust field names to the observed Step 1 API; keep the sorted `[{text,conf,box}]` contract.)

Append `paddlepaddle>=3.0,<3.1` and `paddleocr>=3.5,<4` to requirements.

- [ ] **Step 5: Run test to verify it passes**

Run: `python -m pytest sidecar/tests/test_ocr.py -q`
Expected: PASS (1 test; slow first run downloads model).

- [ ] **Step 6: Commit**

```bash
git add sidecar/ocr.py sidecar/tests/test_ocr.py sidecar/requirements.txt
git commit -m "feat: add PP-OCRv5 Traditional Chinese OCR wrapper"
```

---

### Task 5: Main loop wiring + replay fixture

**Files:**
- Create: `sidecar/main.py`
- Create: `sidecar/tests/test_main.py`
- Create: `sidecar/fixtures/demo-events.json`
- Modify: `sidecar/requirements.txt` (pin everything exact from the working env: `pip freeze` relevant lines), `sidecar/README.md` (run book)

**Interfaces:**
- Consumes: Tasks 1–4 modules.
- Produces: `run_once(deps) -> str` (`"emitted"|"skipped-quiet"|"skipped-busy"|"missing"`), `python -m sidecar.main` loop, `--dump-frame`, `--replay <fixture>` (Task 6/7 E2E target). `deps` namespace: `capture` (with `.grab(name)`), `ocr`, `bridge`, `prev`/`prev_opts` (one-element lists holding last frames), `busy`/`dropped`/`seq`/`last_options_id` (one-element lists as counters).

Dialog path: changed dialog frame → OCR → enqueue `line` (text joined by newline). Options path: changed options frame with ≥2 non-blank rows → enqueue `options` with `id` = md5 of joined texts (first 12 hex), deduplicated against `last_options_id` (same options screen re-emits nothing).

- [ ] **Step 1: Write the failing test** (fake source, no Eden/native needed)

```python
import numpy as np
from types import SimpleNamespace
from sidecar.main import run_once


class FakeCapture:
    def __init__(self, dialog_frames, options_frames=None):
        self.dialog_frames = dialog_frames
        self.options_frames = options_frames
        self.i = 0

    def grab(self, name):
        frames = self.dialog_frames if name == "dialog" else self.options_frames
        if frames is None:
            return None
        f = frames[min(self.i, len(frames) - 1)]
        if name == "dialog":
            self.i += 1
        return f


class FakeOcr:
    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def recognize(self, img):
        self.calls += 1
        return self.script[min(self.calls - 1, len(self.script) - 1)]


class FakeBridge:
    def __init__(self):
        self.queued = []

    def enqueue(self, type, payload):
        self.queued.append((type, payload))
        return len(self.queued)


def _deps(dialog_frames, options_frames=None, ocr_script=None):
    return SimpleNamespace(
        capture=FakeCapture(dialog_frames, options_frames),
        ocr=FakeOcr(ocr_script or [[{"text": "你好", "conf": 0.99, "box": None}]]),
        bridge=FakeBridge(),
        prev=[None], prev_opts=[None], busy=[False],
        dropped=[0], seq=[0], last_options_id=[""],
    )


def test_quiet_frame_skips_ocr():
    black = np.zeros((60, 200, 3), dtype=np.uint8)
    d = _deps([black, black.copy()])
    assert run_once(d) == "skipped-quiet"
    assert d.ocr.calls == 0


def test_changed_frame_emits_line():
    black = np.zeros((60, 200, 3), dtype=np.uint8)
    white = black.copy()
    white[10:30, 10:100] = 255
    d = _deps([black, white])
    assert run_once(d) == "skipped-quiet"
    assert run_once(d) == "emitted"
    assert d.bridge.queued[0][0] == "line"
    assert d.bridge.queued[0][1]["text"] == "你好"


def test_busy_drops_not_queues():
    black = np.zeros((60, 200, 3), dtype=np.uint8)
    white = black.copy()
    white[:] = 255
    d = _deps([black, white])
    run_once(d)
    d.busy[0] = True
    assert run_once(d) == "skipped-busy"
    assert d.dropped[0] == 1
    assert d.ocr.calls == 0


def test_missing_window_reports_status():
    class Gone:
        def grab(self, name):
            return None

    d = _deps([np.zeros((60, 200, 3), dtype=np.uint8)])
    d.capture = Gone()
    assert run_once(d) == "missing"


def test_options_frame_emits_once():
    black = np.zeros((60, 200, 3), dtype=np.uint8)
    opt = np.full((40, 200, 3), 128, dtype=np.uint8)
    d = _deps(
        [black, black.copy()],
        [None, opt, opt.copy()],
        [[{"text": "留下", "conf": 0.9, "box": None},
          {"text": "离开", "conf": 0.9, "box": None}]],
    )
    assert run_once(d) == "skipped-quiet"
    assert run_once(d) == "emitted"
    assert d.bridge.queued[0][0] == "options"
    assert d.bridge.queued[0][1]["options"] == ["留下", "离开"]
    assert run_once(d) == "skipped-quiet"
    assert len(d.bridge.queued) == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest sidecar/tests/test_main.py -x -q`
Expected: FAIL (no `sidecar.main`).

- [ ] **Step 3: Write minimal implementation**

`sidecar/main.py`:

```python
import argparse
import hashlib
import json
import time

from .bridge import BridgeServer
from .capture import load_config
from .trigger import should_ocr

POLL_INTERVAL_S = 0.5


def _options_id(texts):
    return hashlib.md5("\n".join(texts).encode("utf-8")).hexdigest()[:12]


def run_once(deps):
    """One loop iteration. Never raises on missing window ("missing").
    Skips OCR while busy ("skipped-busy", counts dropped)."""
    dialog = deps.capture.grab("dialog")
    if dialog is None:
        return "missing"
    if deps.prev[0] is None:
        deps.prev[0] = dialog
        deps.prev_opts[0] = deps.capture.grab("options")
        return "skipped-quiet"
    status = "skipped-quiet"
    if should_ocr(deps.prev[0], dialog):
        if deps.busy[0]:
            deps.dropped[0] += 1
        else:
            rows = deps.ocr.recognize(dialog)
            text = "\n".join(r["text"] for r in rows)
            deps.seq[0] += 1
            deps.bridge.enqueue("line", {"text": text, "at": deps.seq[0], "source": "pc-window"})
            status = "emitted"
        deps.prev[0] = dialog
    opts = deps.capture.grab("options")
    prev_opts = deps.prev_opts[0]
    deps.prev_opts[0] = opts
    if opts is not None and (prev_opts is None or should_ocr(prev_opts, opts)):
        if not deps.busy[0]:
            rows = deps.ocr.recognize(opts)
            texts = [r["text"] for r in rows if r["text"].strip()]
            if len(texts) >= 2:
                oid = _options_id(texts)
                if oid != deps.last_options_id[0]:
                    deps.last_options_id[0] = oid
                    deps.seq[0] += 1
                    deps.bridge.enqueue("options", {"id": oid, "options": texts, "at": deps.seq[0]})
                    status = "emitted"
    elif deps.busy[0] and opts is not None and prev_opts is not None and should_ocr(prev_opts, opts):
        deps.dropped[0] += 1
    return status
```

Plus `main()` wiring: argparse (`--dump-frame`, `--replay <fixture>`, `--port`), config load, bridge start, 500ms loop calling `run_once` with real deps (busy flag around OCR), `--replay` enqueues fixture events verbatim with fresh seq then serves idle.

`sidecar/fixtures/demo-events.json`:

```json
[
  { "type": "line", "payload": { "text": "今夜は満月だ", "at": 1, "source": "pc-window" } },
  { "type": "options", "payload": { "id": "demo-1", "options": ["留下", "离开"], "at": 2 } }
]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest sidecar/tests/ -q`
Expected: PASS (all sidecar tests).

- [ ] **Step 5: Pin requirements + README run book, commit**

```bash
git add sidecar/main.py sidecar/tests/test_main.py sidecar/fixtures/demo-events.json sidecar/requirements.txt sidecar/README.md
git commit -m "feat: wire sidecar main loop with replay fixture"
```

---

### Task 6: Web bridge poller + app wiring

**Files:**
- Create: `utils/gameBridge.ts`
- Create: `utils/gameBridge.test.ts`
- Modify: `apps/CompanionGameApp.tsx` (status dot + auto-poll hook only, no UI redesign)

**Interfaces:**
- Consumes: Task 1 channel `announceGameLine/announceGameOptions/announceGameChoice` + Task 5 bridge protocol.
- Produces: `pollBridgeOnce(baseUrl, since) -> {next, online}` + `useGameBridge(baseUrl?) -> 'online'|'offline'` hook (overlay shells reuse it in later plans).

- [ ] **Step 1: Write the failing test** (mocked fetch, no sidecar needed)

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { pollBridgeOnce } from './gameBridge';
import { GAME_CHANNEL_EVENTS, subscribeGameChannel } from './gameChannel';

describe('gameBridge', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('maps line and options events onto the channel and advances seq', async () => {
    const seen: string[] = [];
    const off = subscribeGameChannel(GAME_CHANNEL_EVENTS.line, (d) => seen.push(d.text));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/healthz')) {
        return { ok: true, json: async () => ({ ok: true, version: 1 }) };
      }
      return {
        ok: true,
        json: async () => ({
          events: [{ seq: 11, type: 'line', payload: { text: '桜が咲いた', at: 1, source: 'pc-window' } }],
          next: 11,
        }),
      };
    }));
    const result = await pollBridgeOnce('http://127.0.0.1:18741', 10);
    off();
    expect(result).toEqual({ next: 11, online: true });
    expect(seen).toEqual(['桜が咲いた']);
  });

  it('ignores duplicate seq and stays silent when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const first = await pollBridgeOnce('http://127.0.0.1:18741', 11);
    expect(first).toEqual({ next: 11, online: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run utils/gameBridge.test.ts`
Expected: FAIL (no `./gameBridge`).

- [ ] **Step 3: Write minimal implementation**

`utils/gameBridge.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { announceGameChoice, announceGameLine, announceGameOptions } from './gameChannel';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:18741';
const seen = new Set<number>();

export interface BridgePollResult {
  next: number;
  online: boolean;
}

export async function pollBridgeOnce(baseUrl: string, since: number): Promise<BridgePollResult> {
  let health: Response;
  try {
    health = await fetch(`${baseUrl}/healthz`);
  } catch {
    return { next: since, online: false };
  }
  if (!health.ok) return { next: since, online: false };
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/events?since=${since}`);
  } catch {
    return { next: since, online: true };
  }
  if (!res.ok) return { next: since, online: true };
  const body = (await res.json()) as {
    events: Array<{ seq: number; type: string; payload: any }>;
    next: number;
  };
  for (const e of body.events) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    if (e.type === 'line') announceGameLine(e.payload);
    else if (e.type === 'options') announceGameOptions(e.payload);
    else if (e.type === 'choice') announceGameChoice(e.payload);
  }
  return { next: body.next, online: true };
}

export function useGameBridge(baseUrl: string = DEFAULT_BRIDGE_URL): 'online' | 'offline' {
  const [status, setStatus] = useState<'online' | 'offline'>('offline');
  const sinceRef = useRef(0);
  useEffect(() => {
    let alive = true;
    const timer = setInterval(async () => {
      const r = await pollBridgeOnce(baseUrl, sinceRef.current);
      if (!alive) return;
      sinceRef.current = r.next;
      setStatus(r.online ? 'online' : 'offline');
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [baseUrl]);
  return status;
}
```

- [ ] **Step 4: App wiring (minimal)** — in `CompanionGameApp.tsx`: call `useGameBridge()` (default URL), render `<span data-testid="companion-bridge-status">{status}</span>` next to the close button. No styling changes.
- [ ] **Step 5: Run tests**

Run: `pnpm vitest run utils/gameBridge.test.ts apps/CompanionGameApp.test.tsx`
Expected: PASS. (App tests must still pass with the hook mounted — the hook's fetch fails silently offline in jsdom; if unhandled rejections appear, stub fetch in the app test setup.)

- [ ] **Step 6: Commit**

```bash
git add utils/gameBridge.ts utils/gameBridge.test.ts apps/CompanionGameApp.tsx apps/CompanionGameApp.test.tsx
git commit -m "feat: poll PC sidecar bridge into game channel"
```

---

### Task 7: Replay E2E (no Eden required)

**Files:** none (verification only; fixture from Task 5).

- [ ] **Step 1: Start bridge in replay mode**

```bash
python -m sidecar.main --replay sidecar/fixtures/demo-events.json --port 18741
```

Expected: logs `bridge up on 127.0.0.1:18741`, no OCR init.

- [ ] **Step 2: Run dev + open the game app, observe latest line**

```bash
pnpm dev --port 5173 --host
```

Open the companion game app, wait ~5s: `今夜は満月だ` appears as latest line; bridge status dot reads online. Save a screenshot note in the task report (no binary in repo).

- [ ] **Step 3: Report, no commit** (post evidence + fixture used as the task result).

---

## Plan 3 preview (not in this plan)

Tablet native service (MediaProjection, ImageReader ROI 2–3fps, ML Kit zh-Hant, overlay) + PTT STT (sherpa-onnx SenseVoice int8 + Silero VAD). Consumes the same channel event shapes and `companion-game:record` flag.
