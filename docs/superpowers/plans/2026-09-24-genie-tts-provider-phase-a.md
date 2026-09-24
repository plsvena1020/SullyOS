# Genie-TTS Provider 阶段 A（VPS 适配层 + 最小可用链路） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VPS 上给 Genie 加一个带锁与队列的 `/speak` 适配端点，并把它接成 SullyOS 的第 4 个 TTS provider，使 `/v1/tts` 可用。本期不含 UI 与提示词。

**Architecture:** 情绪表、队列、文本分块、WAV 格式知识全部在 VPS 适配层（与 Genie 同进程生命周期）。main-agent 退化为无状态鉴权转发。浏览器只传白名单内的 `emotion` 字符串，不知道参考文件路径。

**Tech Stack:** Python 3.14 + FastAPI + uvicorn（VPS）；TypeScript + React + vitest（仓库）；Cloudflare Pages functions / Vercel serverless（同源中转）。

**Spec:** `docs/superpowers/specs/2026-09-24-genie-tts-provider-design.md`（执行前必读，plan 与 spec 配套）

## Global Constraints

- Genie 服务：`genie-tts.service`，127.0.0.1:9882，`MemoryMax=5G`，`OMP_NUM_THREADS=4`，systemd 已自启
- 适配层新端点：`127.0.0.1:9882/speak`，注册到 `genie_tts.Server.app`（与 `/tts` 同一个 app、同一个 uvicorn 实例）
- 队列上限 **2**：第 3 条并发立即 503，不等待
- 锁等待超时 **5 秒** → 504；**整次合成**（含所有分块）超时 **120 秒** → 504
- 分块：按中文标点无损切分后装箱，目标 60 字、单块上限 120 字、块数上限 20
- 采样率固定 **32000 Hz / 16-bit / mono**，WAV 头 44 字节
- 语言只支持中文（含中英自动 hybrid）。`languageBoost` 非空一律拒绝
- 浏览器侧只用 `readAgentRoutingConfig()` 提供的 `agentUrl` / `agentToken`，**禁止把 VPS 域名或 Token 写进仓库**
- 不改 Caddy；不改 `api/backend-proxy.ts` 与 `functions/_lib/backendProxy.js`
- 不引入新依赖
- commit message 用英文
- 动过含中文文件后跑 `pnpm vitest run utils/mojibakeGuard.test.ts` + U+FFFD 字节扫
- 阶段 A 完成时前端仍只显示三家 provider，这是**预期状态**

## 关键实测事实（执行时不要重新调查，也不要写出会失败的断言）

1. **Genie 合成是不确定的。** 同一句 13 字文本 + 同一参考音频连续跑三次，输出长度分别为 **135680 / 151040 / 120320** 字节（1.88s / 2.36s / 1.88s），SHA-256 全不同。ONNX 图内含采样随机性。
   → **禁止写"两次输出逐字节相同"的断言。** 只能用"时长在合理区间"和"两次 hash 至少一次不同"这类判断。
2. **并发是致命的。** 两条并发 `/tts` 实测：一条 240 秒超时、一条返回 337920 字节（同句正常值约 140000，即 2.4 倍）。根因 `Core/TTSPlayer.py` 全局单例。
   → 回归判据是"两条都 200、都合法 WAV、时长都在合理区间"，不是"和基准逐字节相同"。
3. `/tts` 返回**裸 PCM 无 WAV 头**，但 `content-type` 声明 `audio/wav`。
4. `set_reference_audio` 只写 dict，**不重载 ONNX session**；`load_character` 才重载（约 27 秒）。
5. Genie 2.0.2 的 `Server.py` 与 `Internal.py` 各有一份模块级 `_reference_audios`。**预热必须走 HTTP 自 POST**，直接调 `genie.set_reference_audio()` 会导致预热后 `/tts` 永远 404。
6. `Core/Inference.py:9` 的 `MAX_T2S_LEN=1000` 未被使用；`:95-109` 最多 500 步仍返回 → 超长文本会静默截断，故必须自己分块。
7. `worker/main-agent/src/index.js:61-68` 的 `checkAuth` 读 `env.AMSG_CLIENT_TOKEN`，认 `x-client-token` 头或 `Authorization: Bearer`；**未配置令牌时开发模式全放行**（既有行为，本期不改）。
8. `scripts/build-workers.mjs` 已把 main-agent 列为逐字复制项 → 构建正确性用**源文件与 bundle 的 SHA-256 相等**来验。
9. `utils/agentRouting.ts:16-20` 的 `readAgentRoutingConfig` 只做 `.trim()`，**不剥尾部斜杠** → 拼 URL 必须自己 `replace(/\/+$/, '')`。
10. 仓库 TS 测试的相对 import **不带 `.js` 后缀**（见 `utils/minimaxTts.test.ts:2`）。

## Review Focus

以下是 spec 暗示但没有任务正面测、且最可能伤到真人的输入，每条都挂到拥有该代码的任务：

1. **两条语音请求同时到达** → 两条都出声、都不挂死、时长都合理 → Task 1 Step 9
2. **三条并发** → 第 3 条 503、前 2 条 200 → Task 1 Step 9
3. **未映射情绪（如 `definitely_not_mapped`）** → 200，且响应头 `X-Genie-Resolved-Emotion: calm` → Task 1 Step 9
4. **短句后面跟一大段无标点文本** → 正确切成两块，不该被误判为"块过长" → Task 1 Step 8
5. **空文本 / 纯空白** → 400，不占用队列槽位 → Task 1 Step 9
6. **文本里带 `<语音 emotion="happy">(laughs)…</语音><字幕>…</字幕>`** → 送到 Genie 的只有正文，不含任何标签或动作词 → Task 2 Step 4
7. **`agentUrl` 结尾带 `/`** → 不产生 `//agent/v1/tts` 双斜杠 → Task 2 Step 4
8. **未预热完成时收到请求** → 503 `warming_up`，不是泛化 500 → Task 1 Step 8

---

## File Structure

| 文件 | 职责 |
|---|---|
| `vps-backend/deploy/genie/genie_server.py` | 适配层：`/speak`、锁与队列、readiness、情绪表、分块、WAV 包裹、错误契约。注册到 Genie 的 app |
| `vps-backend/deploy/genie/emotions.json` | 情绪 → `{wav, text}`，7 条 |
| `vps-backend/deploy/genie/install.sh` | 装到 `/opt/genie-tts`、更新 unit、重启、带超时的自检 |
| `vps-backend/deploy/genie/test_speak.py` | 适配层冒烟测试，覆盖 Review Focus 1/2/3/4/5/8 |
| `types.ts` | `TtsProvider` 加 `'genie'`；`voicePrompts` 加 `genie?` |
| `utils/ttsProvider.ts` | provider 归一化与提示词 override 的 genie 分支 |
| `utils/genieTts.ts` | **新建**。浏览器客户端 + 文本清洗器 `cleanTextForTtsGenie` |
| `utils/genieTts.test.ts` | **新建** |
| `utils/ttsRouter.ts` | 7 处分发点；`providerUsesRawVoiceMarkup` 改白名单；`SynthOptions` 加 export |
| `utils/ttsRouter.test.ts` | **新建**（当前不存在） |
| `worker/main-agent/src/index.js` | 加 `ttsProxy`（无状态转发） |
| `worker/main-agent/src/index.test.ts` | 加 `/v1/tts` 测试 |
| `worker/main-agent/worker.bundle.js` | 构建产物，不手改 |
| `vite.config.ts` | 加 `/agent` dev proxy |

---

### Task 1: VPS 适配层 `/speak`

**Files:**
- Create: `vps-backend/deploy/genie/genie_server.py`
- Create: `vps-backend/deploy/genie/emotions.json`
- Create: `vps-backend/deploy/genie/install.sh`
- Create: `vps-backend/deploy/genie/test_speak.py`

**Interfaces:**
- Consumes: `genie_tts`（已装于 `/opt/genie-tts/venv`）；`genie_tts.Server.app` 是 FastAPI 实例，`genie.start_server()` 启动的正是它。
- Produces: `POST 127.0.0.1:9882/speak`，请求 `{"text": string, "emotion": string?}`。
  - 成功：`200`、`content-type: audio/wav`、完整 RIFF 字节、响应头 `X-Genie-Resolved-Emotion: <实际使用的情绪>`
  - 失败：`{"error": "<code>"}`（**顶层就是 error，不包在 detail 里**），code ∈ `warming_up`(503) / `busy`(503) / `lock_timeout`(504) / `synth_timeout`(504) / `empty`(400) / `chunk_too_long`(413) / `too_many_chunks`(413) / `reference_missing`(500) / `synth_failed`(500)
  - 供 Task 3 的 `ttsProxy` 与 Task 4 的 `genieTts.ts` 依赖

- [ ] **Step 1: 写情绪表**

创建 `vps-backend/deploy/genie/emotions.json`：

```json
{
  "calm":      { "wav": "emo-calm.wav",      "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "happy":     { "wav": "emo-happy.wav",     "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "sad":       { "wav": "emo-sad.wav",       "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "angry":     { "wav": "emo-angry.wav",     "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "surprised": { "wav": "emo-surprised.wav", "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "fearful":   { "wav": "emo-fearful.wav",   "text": "今天过得怎么样，想不想听我讲讲今天遇到的事？" },
  "fluent":    { "wav": "emo-fluent.wav",    "text": "下午三点一刻开会，会上的资料我先发你。" }
}
```

- [ ] **Step 2: 写适配层**

创建 `vps-backend/deploy/genie/genie_server.py`。完整内容：

```python
"""Genie-TTS 适配层：在 Genie 的 FastAPI app 上加一个带锁与队列的 /speak 端点。

为什么不直接暴露 Genie 的 /tts：
  1. /tts 返回裸 PCM 却声明 audio/wav，需要补 44 字节 RIFF 头。
  2. Core/TTSPlayer 是全局单例（start_session 清空队列并替换 callback），
     并发进入会互相踩：实测两条并发一条 240 秒超时、另一条返回 2.4 倍长垃圾音频。
  3. /set_reference_audio 写的是模块级 dict，必须与 /tts 在同一把锁内完成。
  4. 长文本需要自己分块；Genie 对超长文本会静默截断。
  5. Genie 后台吞异常且 HTTP 200 已发出，错误无法传播。

预热必须走 HTTP 自 POST：Genie 2.0.2 的 Server.py 与 Internal.py 各有一份
模块级 _reference_audios，函数式 API 写的那份不是 /tts 校验的那份。
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import wave
from io import BytesIO

os.environ.setdefault("GENIE_DATA_DIR", "/opt/genie-tts/GenieData")

import genie_tts as genie  # noqa: E402
from genie_tts.Server import app as genie_app  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402

HOST = os.environ.get("GENIE_HOST", "127.0.0.1")
PORT = int(os.environ.get("GENIE_PORT", "9882"))
CHARACTER = os.environ.get("GENIE_CHARACTER", "ether")
MODEL_DIR = os.environ.get("GENIE_MODEL_DIR", "/opt/genie-tts/onnx/ether")
REFS_DIR = os.environ.get("GENIE_REFS_DIR", "/opt/genie-tts/refs")
LANGUAGE = os.environ.get("GENIE_LANGUAGE", "Chinese")

QUEUE_LIMIT = 2
LOCK_WAIT_TIMEOUT = 5.0
SYNTH_TIMEOUT = 120.0
CHUNK_TARGET_CHARS = 60
CHUNK_MAX_CHARS = 120
CHUNK_MAX_COUNT = 20
SAMPLE_RATE = 32000
BYTES_PER_SAMPLE = 2
CHANNELS = 1

_SYNTH_LOCK = threading.Lock()
_READY = threading.Event()
_PENDING_TASKS = 0
_PENDING_LOCK = threading.Lock()


class SpeakBusy(Exception):
    """队列已满。"""


class LockTimeout(Exception):
    """等锁超时。"""


class SynthesisTimeout(Exception):
    """合成本身超时（含任一分块）。"""


def _load_emotions() -> dict:
    with open(os.path.join(REFS_DIR, "emotions.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolve_emotion(raw: str | None) -> tuple[str, dict]:
    table = _load_emotions()
    if raw is not None and raw in table:
        return raw, table[raw]
    return "calm", table["calm"]


def _wrap_pcm_as_wav(pcm: bytes) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


def _split_text(text: str) -> list[str]:
    """先无损按标点分段，再装箱成不超过 CHUNK_MAX_CHARS 的块。

    分段在前是关键：如果边扫边要求"累计满 60 字才在标点处切"，
    「短句。+ 110 字无标点」会因为前面短句不足 60 字而一直累积，
    最后整块超限被误判为 chunk_too_long。
    """
    text = text.strip()
    if not text:
        raise ValueError("empty")

    parts = re.findall(
        r"[^。！？；!?;\n]*[。！？；!?;\n]|[^。！？；!?;\n]+$", text
    )
    if not parts:
        raise ValueError("empty")

    chunks: list[str] = []
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf.strip():
            chunks.append(buf)
        buf = ""

    for part in parts:
        if len(part) > CHUNK_MAX_CHARS:
            raise ValueError("chunk_too_long")
        if buf and (len(buf) >= CHUNK_TARGET_CHARS or len(buf) + len(part) > CHUNK_MAX_CHARS):
            flush()
        buf += part
    flush()

    if not chunks:
        raise ValueError("empty")
    if len(chunks) > CHUNK_MAX_COUNT:
        raise ValueError("too_many_chunks")
    return chunks


def _genie_post(path: str, payload: dict, timeout: float) -> bytes:
    req = urllib.request.Request(
        f"http://{HOST}:{PORT}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError:
        raise
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise SynthesisTimeout() from exc
        raise
    except TimeoutError as exc:
        raise SynthesisTimeout() from exc


def _synthesize(text: str, emotion: str) -> tuple[bytes, str]:
    resolved, entry = _resolve_emotion(emotion)
    wav_path = os.path.join(REFS_DIR, entry["wav"])
    if not os.path.isfile(wav_path):
        raise FileNotFoundError(wav_path)

    # 整次合成共用一个 deadline：分块最多 20 次，不能变成 20 × 120s。
    deadline = time.monotonic() + SYNTH_TIMEOUT

    def remaining(cap: float) -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise SynthesisTimeout()
        return min(cap, left)

    # 每次都重设参考：去掉跨进程缓存失效点，代价是每次多一次本地 HTTP（<50ms）。
    _genie_post(
        "/set_reference_audio",
        {
            "character_name": CHARACTER,
            "audio_path": wav_path,
            "audio_text": entry["text"],
            "language": LANGUAGE,
        },
        timeout=remaining(30.0),
    )

    pcm = bytearray()
    for chunk in _split_text(text):
        pcm.extend(
            _genie_post(
                "/tts",
                {"character_name": CHARACTER, "text": chunk, "split_sentence": False},
                timeout=remaining(SYNTH_TIMEOUT),
            )
        )
    if not pcm:
        raise RuntimeError("empty pcm")
    return _wrap_pcm_as_wav(bytes(pcm)), resolved


def _acquire_slot() -> bool:
    global _PENDING_TASKS
    with _PENDING_LOCK:
        if _PENDING_TASKS >= QUEUE_LIMIT:
            return False
        _PENDING_TASKS += 1
    return True


def _release_slot() -> None:
    global _PENDING_TASKS
    with _PENDING_LOCK:
        _PENDING_TASKS = max(0, _PENDING_TASKS - 1)


def _speak_with_guard(text: str, emotion: str) -> tuple[bytes, str]:
    if not _acquire_slot():
        raise SpeakBusy()
    try:
        acquired = _SYNTH_LOCK.acquire(timeout=LOCK_WAIT_TIMEOUT)
        if not acquired:
            raise LockTimeout()
        try:
            return _synthesize(text, emotion)
        finally:
            _SYNTH_LOCK.release()
    finally:
        _release_slot()


@genie_app.post("/speak")
def speak_endpoint(payload: dict):
    if not _READY.is_set():
        return JSONResponse(status_code=503, content={"error": "warming_up"})

    text = payload.get("text")
    emotion = payload.get("emotion")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse(status_code=400, content={"error": "empty"})
    if emotion is not None and not isinstance(emotion, str):
        return JSONResponse(status_code=400, content={"error": "bad_emotion"})

    try:
        wav, resolved = _speak_with_guard(text, emotion)
    except SpeakBusy:
        return JSONResponse(status_code=503, content={"error": "busy"})
    except LockTimeout:
        return JSONResponse(status_code=504, content={"error": "lock_timeout"})
    except SynthesisTimeout:
        return JSONResponse(status_code=504, content={"error": "synth_timeout"})
    except ValueError as exc:
        code = str(exc)
        return JSONResponse(status_code=400 if code == "empty" else 413, content={"error": code})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "reference_missing"})
    except Exception:
        return JSONResponse(status_code=500, content={"error": "synth_failed"})

    return Response(
        content=wav,
        media_type="audio/wav",
        headers={"X-Genie-Resolved-Emotion": resolved},
    )


def _warmup() -> None:
    time.sleep(5)
    for attempt in range(1, 6):
        try:
            genie.load_character(
                character_name=CHARACTER, onnx_model_dir=MODEL_DIR, language=LANGUAGE
            )
            _, entry = _resolve_emotion("calm")
            _genie_post(
                "/set_reference_audio",
                {
                    "character_name": CHARACTER,
                    "audio_path": os.path.join(REFS_DIR, entry["wav"]),
                    "audio_text": entry["text"],
                    "language": LANGUAGE,
                },
                timeout=30.0,
            )
            _READY.set()
            print(f"[genie] warmup ok on attempt {attempt}", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[genie] warmup attempt {attempt} failed: {exc}", flush=True)
            time.sleep(10)
    print("[genie] warmup gave up; /speak returns 503 warming_up", flush=True)


if __name__ == "__main__":
    threading.Thread(target=_warmup, daemon=True).start()
    print(f"[genie] serving on {HOST}:{PORT}", flush=True)
    genie.start_server(host=HOST, port=PORT, workers=1)
```

- [ ] **Step 3: 写安装脚本**

创建 `vps-backend/deploy/genie/install.sh`：

```bash
#!/usr/bin/env bash
# 把适配层装到 /opt/genie-tts 并让 systemd 指向它。幂等。
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/opt/genie-tts
UNIT=/etc/systemd/system/genie-tts.service

install -d -m 0755 "$DEST/refs"
install -m 0644 "$SRC_DIR/genie_server.py" "$DEST/genie_server.py"
install -m 0644 "$SRC_DIR/emotions.json"   "$DEST/refs/emotions.json"
install -m 0644 "$SRC_DIR/test_speak.py"   "$DEST/test_speak.py"

grep -q 'genie_server.py' "$UNIT" || {
  echo "ERROR: $UNIT 的 ExecStart 未指向 genie_server.py" >&2
  exit 1
}

systemctl daemon-reload
systemctl restart genie-tts

# 自检：先删旧文件，避免拿上一次的残留假通过；curl 必须带 --max-time，
# 否则适配层挂死时这个循环会永久卡住。
probe=/tmp/genie-install-check.wav
rm -f "$probe"
ready=0
for _ in $(seq 1 30); do
  if curl --max-time 130 -fsS -X POST http://127.0.0.1:9882/speak \
      -H 'content-type: application/json' \
      -d '{"text":"安装自检。","emotion":"calm"}' \
      -o "$probe"; then
    ready=1
    break
  fi
  sleep 10
done

if [ "$ready" -ne 1 ] || [ ! -s "$probe" ]; then
  echo "ERROR: /speak 自检未通过，见 journalctl -u genie-tts" >&2
  exit 1
fi
head -c 4 "$probe" | grep -q 'RIFF' || { echo "ERROR: 返回的不是合法 WAV" >&2; exit 1; }
rm -f "$probe"
echo "OK: /speak 就绪，WAV 头合法"
```

- [ ] **Step 4: 写冒烟测试**

创建 `vps-backend/deploy/genie/test_speak.py`。注意：**Genie 合成不确定，禁止逐字节比较**（见"关键实测事实"第 1 条），判据用时长区间与响应头。

```python
"""适配层冒烟测试。部署后在 VPS 上跑：/opt/genie-tts/venv/bin/python test_speak.py

注意：Genie 的 ONNX 图含采样随机性，同一输入的输出长度/哈希每次都不同。
（实测 13 字文本连跑三次：135680 / 151040 / 120320 字节）
所以只能用时长区间与"至少一次不同"来断言，不能逐字节比较。
"""
import json
import threading
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:9882"
SENTENCE = "你回来啦，今天过得怎么样？"   # 13 字，正常时长约 1.9-2.4s
BYTES_PER_SEC = 32000 * 2               # 32000Hz * 16bit mono


class Result:
    def __init__(self):
        self.status = None
        self.body = b""
        self.emotion = None
        self.error = None


def post(payload, timeout=180):
    req = urllib.request.Request(
        BASE + "/speak",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("X-Genie-Resolved-Emotion")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), None
    except Exception as e:  # 连不上/超时也要变成结果，不能让线程静默死掉
        return None, b"", repr(e)


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail, flush=True)
    return cond


def sane(body, low=1.0, high=3.0):
    """13 字中文的合理时长区间。垃圾音频（约 5.3s）会被这个上限挡住。"""
    if not body.startswith(b"RIFF"):
        return False
    dur = len(body) / BYTES_PER_SEC
    return low <= dur <= high


def run_threaded(payloads):
    """并发执行。每个线程把结果写进自己的 Result，不允许异常逃逸导致 KeyError。"""
    outs = [Result() for _ in payloads]
    barrier = threading.Barrier(len(payloads))

    def worker(payload, out):
        try:
            barrier.wait(timeout=20)
            out.status, out.body, out.emotion = post(payload, timeout=180)
        except Exception as e:
            out.error = repr(e)

    threads = []
    for payload, out in zip(payloads, outs):
        t = threading.Thread(target=worker, args=(payload, out))
        t.start()
        threads.append(t)
    for t in threads:
        t.join(timeout=200)
    return outs


def main():
    ok = True

    # 1 基本成功 + WAV 头 + 时长合理
    st, body, emo = post({"text": SENTENCE, "emotion": "calm"})
    ok &= check("calm_200", st == 200, f"status={st}")
    ok &= check("calm_sane", sane(body), f"dur={len(body)/BYTES_PER_SEC:.2f}s")
    ok &= check("calm_resolved_header", emo == "calm", f"header={emo}")

    # 2 未映射情绪回落 calm（靠响应头判定，不靠音频内容）
    st_foo, _, emo_foo = post({"text": SENTENCE, "emotion": "definitely_not_mapped"})
    ok &= check("unknown_emotion_200", st_foo == 200, f"status={st_foo}")
    ok &= check("unknown_falls_back_to_calm", emo_foo == "calm", f"header={emo_foo}")

    # 3 短句 + 长段无标点：必须切成两块而不是误判超长
    st_mix, body_mix, _ = post(
        {"text": "好的。" + "啊" * 100, "emotion": "calm"}, timeout=180
    )
    ok &= check("mixed_split_ok", st_mix == 200, f"status={st_mix}")
    ok &= check("mixed_not_empty", len(body_mix) > 0, f"len={len(body_mix)}")

    # 4 空文本 / 无标点超长
    st_empty, _, _ = post({"text": "   ", "emotion": "calm"}, timeout=60)
    ok &= check("empty_text_400", st_empty == 400, f"status={st_empty}")
    st_long, _, _ = post({"text": "啊" * 300, "emotion": "calm"}, timeout=60)
    ok &= check("long_unpunctuated_413", st_long == 413, f"status={st_long}")

    # 5 两条并发：都 200、都合法、时长都合理
    outs = run_threaded([{"text": SENTENCE, "emotion": "calm"},
                         {"text": SENTENCE, "emotion": "happy"}])
    for i, o in enumerate(outs):
        ok &= check(f"concurrent_{i}_200", o.status == 200,
                    f"status={o.status} err={o.error}")
        ok &= check(f"concurrent_{i}_sane", sane(o.body),
                    f"dur={len(o.body)/BYTES_PER_SEC:.2f}s")

    # 6 三条并发：第 3 条 503（队列上限 2）
    outs3 = run_threaded([{"text": SENTENCE, "emotion": "calm"},
                          {"text": SENTENCE, "emotion": "happy"},
                          {"text": SENTENCE, "emotion": "sad"}])
    codes = sorted(o.status for o in outs3)
    ok &= check("triple_statuses", codes == [200, 200, 503], f"codes={codes}")

    print("ALL_PASS" if ok else "HAS_FAILURE", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: 提交代码**

```bash
git add vps-backend/deploy/genie/
git commit -m "feat(vps-backend): Genie /speak adapter with lock, queue and WAV framing"
```

- [ ] **Step 6: 部署到 VPS**

在工作树根目录执行（`<你的 VPS IP>` 用交互输入，不写进命令历史）：

```powershell
$env:VPS_HOST = Read-Host 'VPS IP'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
tar -cf - -C vps-backend/deploy/genie . |
  ssh "root@$env:VPS_HOST" `
    "tar -xf - -C /opt/genie-tts && bash /opt/genie-tts/install.sh && /opt/genie-tts/venv/bin/python /opt/genie-tts/test_speak.py"
```

`install.sh` 预期末行 `OK: /speak 就绪，WAV 头合法`，随后 `test_speak.py` 打印 `ALL_PASS`。

若 `install.sh` 报 `ExecStart 未指向 genie_server.py`，先确认 `/etc/systemd/system/genie-tts.service` 含 `ExecStart=/opt/genie-tts/venv/bin/python /opt/genie-tts/genie_server.py`。若自检超时，跑 `ssh root@$env:VPS_HOST "journalctl -u genie-tts -n 50 | grep -v INFO"` 贴出报错，**不要改端口或参数绕过**。

- [ ] **Step 7: 验证 warming_up 契约（Review Focus 8）**

```bash
curl --max-time 10 -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:9882/speak \
  -H 'content-type: application/json' -d '{"text":"x","emotion":"calm"}'
```

预热完成后应为 `200`。若在 `systemctl restart genie-tts` 后 10 秒内立即执行，应为 `503`。两种结果都算通过——只要**不是** 500。

- [ ] **Step 8: 验证分块不误判（Review Focus 4）**

`test_speak.py` 的 `mixed_split_ok PASS` 且 `mixed_not_empty PASS` 即为通过。若 `mixed_split_ok` 是 413，说明 `_split_text` 没改成"先无损分段再装箱"。

- [ ] **Step 9: 跑完整冒烟（Review Focus 1/2/3/5）**

```bash
/opt/genie-tts/venv/bin/python /opt/genie-tts/test_speak.py
```

预期 `ALL_PASS`。重点看 `concurrent_0_200` / `concurrent_1_200` / `triple_statuses`。**任何一个并发用例 FAIL 或卡住就停下**，贴 `journalctl -u genie-tts -n 30`，不要进 Task 2。

- [ ] **Step 10: 验证内存未越界**

```bash
for i in $(seq 1 10); do
  curl --max-time 130 -fsS -X POST http://127.0.0.1:9882/speak \
    -H 'content-type: application/json' \
    -d '{"text":"你回来啦，今天过得怎么样？","emotion":"calm"}' -o /dev/null
done
systemctl show genie-tts -p ActiveState -p NRestarts -p MemoryCurrent -p MemoryPeak
journalctl -u genie-tts --since '10 minutes ago' | grep -iE 'oom|killed' || echo "NO_OOM"
```

预期：`ActiveState=active`、`NRestarts` 不增长、`MemoryPeak` ≤ 5368709120（5G）、输出 `NO_OOM`。**若越界就如实报告，不要通过减少情绪数量来掩盖。**

---

### Task 2: provider 类型、路由与浏览器客户端

**Files:**
- Modify: `types.ts:403`、`types.ts:446-451`
- Modify: `utils/ttsProvider.ts:12-13`、`utils/ttsProvider.ts:59-63`
- Modify: `utils/ttsRouter.ts:28`（加 `export`）、`:31-45`、`:47-62`、`:79-87`、`:90-96`、`:99-104`、`:106-111`、`:114-115`
- Create: `utils/genieTts.ts`、`utils/genieTts.test.ts`、`utils/ttsRouter.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `/speak` 错误契约与响应头。
- Produces:
  - `TtsProvider` 新增 `'genie'`
  - `synthesizeSpeechGenieDetailed(text, char, apiConfig, options?): Promise<TtsResult>`（从 `./genieTts` 导出）
  - `cleanTextForTtsGenie(raw: string): string`（从 `./genieTts` 导出，`ttsRouter` 两个分支共用）

- [ ] **Step 1: 写 `utils/genieTts.test.ts`（先失败）**

创建 `utils/genieTts.test.ts`。注意三点：import **不带 `.js`**；每个用例前必须写 `localStorage`（否则 `readAgentRoutingConfig()` 返回空、客户端会先抛"未配置主代理地址"，fetch 根本不会被调用）。

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { cleanTextForTtsGenie, synthesizeSpeechGenieDetailed } from './genieTts';

const AGENT = 'https://agent.test';

function makeResponse(status: number, body: ArrayBuffer | string, contentType = 'audio/wav') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
  } as unknown as Response;
}

describe('synthesizeSpeechGenieDetailed', () => {
  const apiConfig = { ttsProvider: 'genie' } as any;
  const char = { id: 'c1' } as any;

  beforeEach(() => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: AGENT, agentToken: 'tok' }));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:genie-1', revokeObjectURL: () => {} } as any);
  });
  afterEach(() => {
    localStorage.removeItem('os_api_config');
    vi.unstubAllGlobals();
  });

  it('成功时返回 url 与 blob 两个字段', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, new ArrayBuffer(2048))));
    const res = await synthesizeSpeechGenieDetailed('你好', char, apiConfig, { emotion: 'happy' });
    expect(res.url).toBe('blob:genie-1');
    expect(res.blob).toBeInstanceOf(Blob);
  });

  it('agentUrl 结尾带斜杠时不产生双斜杠', async () => {
    localStorage.setItem('os_api_config', JSON.stringify({ agentUrl: `${AGENT}/`, agentToken: 'tok' }));
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试', char, apiConfig);
    const [url] = fetchMock.mock.calls[0] as any;
    expect(String(url)).toBe(`${AGENT}/agent/v1/tts`);
    expect(String(url)).not.toContain('//agent');
  });

  it('带上 X-Client-Token 鉴权头与 emotion', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed('测试文本', char, apiConfig, { emotion: 'sad' });
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(init.headers['X-Client-Token']).toBe('tok');
    const body = JSON.parse(init.body);
    expect(body.text).toBe('测试文本');
    expect(body.emotion).toBe('sad');
  });

  it('发送前已剥掉语音标签与字幕，只剩正文', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, new ArrayBuffer(2048)));
    vi.stubGlobal('fetch', fetchMock);
    await synthesizeSpeechGenieDetailed(
      '<语音 emotion="happy">(laughs)今天真开心</语音><字幕>今天真开心</字幕>',
      char,
      apiConfig,
    );
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body).text).toBe('今天真开心');
  });

  it('503 busy 抛出可读的中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"busy"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/忙/);
  });

  it('504 抛出超时错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(504, '{"error":"synth_timeout"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/超时/);
  });

  it('413 抛出文本过长错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(413, '{"error":"chunk_too_long"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/过长/);
  });
});

describe('cleanTextForTtsGenie', () => {
  it('只保留 <语音> 块内的正文', () => {
    expect(cleanTextForTtsGenie('你说真的假的？<语音 emotion="surprised">Wait, are you serious?</语音><字幕>等等……你是认真的？</字幕>'))
      .toBe('Wait, are you serious?');
  });

  it('剥掉 MiniMax 停顿标记与动作词', () => {
    expect(cleanTextForTtsGenie('你好<#0.5#>世界')).toBe('你好世界');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/genieTts.test.ts`
Expected: FAIL，报 `Failed to resolve import "./genieTts"`。

- [ ] **Step 3: 建 `utils/genieTts.ts`**

创建 `utils/genieTts.ts`：

```typescript
/**
 * Genie-TTS（VPS 自建，中文克隆）客户端。
 *
 * 走主代理中转 `${agentUrl}/agent/v1/tts` → main-agent → VPS 适配层 → Genie。
 * 适配层已把情绪表、队列、分块与 WAV 包裹做完，这里负责：
 *   1. 剥掉所有 TTS 专属标记（Genie 不支持任何 inline cue）
 *   2. 组请求体（text + emotion）
 *   3. 把错误码翻成人话
 *   4. audio/wav → Blob + Blob URL
 *
 * 与另外三家的差异：没有 API Key、没有 per-char 音色，所以 ttsRouter 里
 * characterHasVoice / canSynthesizeSpeech 对 genie 无条件返回 true。
 */
import type { APIConfig, CharacterProfile } from '../types';
import { cleanTextForTts, cleanVoiceMarkupForDisplay, type TtsResult } from './minimaxTts';
import type { SynthOptions } from './ttsRouter';
import { readAgentRoutingConfig } from './agentRouting';

const ERROR_TEXT: Record<string, string> = {
  warming_up: '语音服务正在准备中，请稍后',
  busy: '语音正忙，稍后再试',
  lock_timeout: '语音排队超时',
  synth_timeout: '语音合成超时',
  synth_failed: '语音合成失败',
  reference_missing: '参考音频缺失',
  chunk_too_long: '这段文字太长，无法朗读',
  too_many_chunks: '这段文字段落太多，无法朗读',
  empty: '没有可朗读的文字',
  genie_unavailable: '语音服务暂时不可用',
};

/** Genie 不理解任何 inline cue：只保留 <语音> 块内的正文，其余全剥。 */
export function cleanTextForTtsGenie(raw: string): string {
  return cleanVoiceMarkupForDisplay(cleanTextForTts(raw))
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function synthesizeSpeechGenieDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  void char;
  void apiConfig;
  const spoken = cleanTextForTtsGenie(text);
  if (!spoken) throw new Error('没有可朗读的文字');

  const { agentUrl, agentToken } = readAgentRoutingConfig();
  if (!agentUrl) throw new Error('未配置主代理地址，无法使用 Genie-TTS');
  // agentRouting 只 trim 不剥尾斜杠，这里自己处理。
  const base = agentUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  // 与适配层的 120 秒整次合成上限对齐，留 15 秒余量。
  const timer = setTimeout(() => controller.abort(), 135_000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${base}/agent/v1/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: spoken, emotion: options?.emotion ?? 'calm' }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(await readErrorText(res));
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 44) throw new Error('语音服务返回了空音频');
    const blob = new Blob([buf], { type: 'audio/wav' });
    return { url: URL.createObjectURL(blob), blob };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new Error('语音合成超时');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorText(res: Response): Promise<string> {
  let code = '';
  try {
    const parsed = JSON.parse(await res.text());
    code = typeof parsed?.error === 'string' ? parsed.error : '';
  } catch {
    code = '';
  }
  return ERROR_TEXT[code] ?? `语音服务返回 ${res.status}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/genieTts.test.ts`
Expected: 9 tests passed。

- [ ] **Step 5: 改 `types.ts`**

`types.ts:403`：

```typescript
export type TtsProvider = 'minimax' | 'fishaudio' | 'elevenlabs' | 'genie';
```

`types.ts:446-451` 的 `voicePrompts` 加 `genie?: string;`。

- [ ] **Step 6: 改 `utils/ttsProvider.ts`

第 12-13 行改为：

```typescript
export const normalizeTtsProvider = (raw: unknown): TtsProvider =>
  raw === 'fishaudio' ? 'fishaudio'
  : raw === 'elevenlabs' ? 'elevenlabs'
  : raw === 'genie' ? 'genie'
  : 'minimax';
```

第 59-63 行的对象字面量加一行 `genie: typeof overrides?.genie === 'string' ? overrides.genie : undefined,`。

- [ ] **Step 7: 改 `utils/ttsRouter.ts`**

第 28 行加 `export`（当前**没有**，Task 2 的 import 依赖它）：

```typescript
export type SynthOptions = { languageBoost?: string; groupId?: string; emotion?: string };
```

第 31-45 行 `assertTtsLanguageSupported` 开头改为（把原第 37 行的 `const provider` 删掉，避免重复声明）：

```typescript
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'genie' && (languageBoost || '').trim()) {
    throw new Error('Genie-TTS 目前只支持中文（含中英混读），请先关闭其他朗读语种');
  }
  if ((languageBoost || '').trim().toLowerCase() !== 'yue') return;
```

第 47-62 行 `synthesizeSpeechDetailed` 在 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') {
    return synthesizeSpeechGenieDetailed(text, char, apiConfig, options);
  }
```

并 import：`import { cleanTextForTtsGenie, synthesizeSpeechGenieDetailed } from './genieTts';`

第 79-87 行 `characterHasVoice` 的 fish 分支前加：

```typescript
  if (provider === 'genie') return true;
```

第 90-96 行 `canSynthesizeSpeech` 的 `if (!characterHasVoice(...)) return false;` 之后加：

```typescript
  if (provider === 'genie') return true;
```

第 99-104 行 `cleanTextForTtsProvider` 的 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') return cleanTextForTtsGenie(text);
```

第 106-111 行 `stripTtsMarkupForDisplay` 的 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') return cleanVoiceMarkupForDisplay(text);
```

第 114-115 行改为白名单：

```typescript
/** 只有 Fish / ElevenLabs 的清洗器需要看到原始 inline cue；MiniMax 用已消毒的 speech，Genie 不支持任何 cue。 */
export const providerUsesRawVoiceMarkup = (apiConfig: APIConfig): boolean => {
  const provider = resolveTtsProvider(apiConfig);
  return provider === 'fishaudio' || provider === 'elevenlabs';
};
```

- [ ] **Step 8: 新建 `utils/ttsRouter.test.ts`**

**新建文件**（当前不存在），完整内容：

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeTtsProvider } from './ttsProvider';
import {
  assertTtsLanguageSupported,
  canSynthesizeSpeech,
  characterHasVoice,
  cleanTextForTtsProvider,
  providerUsesRawVoiceMarkup,
  stripTtsMarkupForDisplay,
} from './ttsRouter';

describe('genie provider', () => {
  it('normalizeTtsProvider 认得 genie', () => {
    expect(normalizeTtsProvider('genie')).toBe('genie');
    expect(normalizeTtsProvider('nonsense')).toBe('minimax');
  });

  it('characterHasVoice 对 genie 无条件 true（无 per-char 音色配置）', () => {
    expect(characterHasVoice({ id: 'x' } as any, { ttsProvider: 'genie' } as any)).toBe(true);
  });

  it('canSynthesizeSpeech 对 genie 无条件 true（无 API Key）', () => {
    expect(canSynthesizeSpeech({ id: 'x' } as any, { ttsProvider: 'genie' } as any)).toBe(true);
  });

  it('providerUsesRawVoiceMarkup 是白名单（回归 Fish cue 被原样念出）', () => {
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'genie' } as any)).toBe(false);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'fishaudio' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'elevenlabs' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'minimax' } as any)).toBe(false);
  });

  it('cleanTextForTtsProvider 对 genie 只留 <语音> 块内正文', () => {
    const out = cleanTextForTtsProvider(
      '你说真的假的？<语音 emotion="surprised">(laughs)你认真的？</语音><字幕>等等</字幕>',
      { ttsProvider: 'genie' } as any,
    );
    expect(out).toBe('你认真的？');
    expect(out).not.toContain('laughs');
  });

  it('stripTtsMarkupForDisplay 对 genie 保留可读正文', () => {
    const out = stripTtsMarkupForDisplay(
      '正文一<语音 emotion="happy">口语一</语音><字幕>字幕一</字幕>',
      { ttsProvider: 'genie' } as any,
    );
    expect(out).toContain('正文一');
    expect(out).not.toContain('<语音');
  });

  it('assertTtsLanguageSupported 对 genie 拒绝粤语', () => {
    expect(() => assertTtsLanguageSupported(
      { id: 'x' } as any,
      { ttsProvider: 'genie' } as any,
      'yue',
    )).toThrow();
  });
});
```

- [ ] **Step 9: 跑测试**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts`
Expected: 全绿。`providerUsesRawVoiceMarkup` 那条必须 PASS——它修的是真 bug（旧实现会把 Fish 的 `(laughs)` 原样送进 Genie）。

- [ ] **Step 10: 类型检查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); npx tsc --noEmit 2>&1 | Select-String "types.ts|ttsProvider.ts|ttsRouter.ts|genieTts.ts"`
Expected: 无输出。仓库有存量 tsc 错误，只要求本次触碰的 4 个文件零命中。

- [ ] **Step 11: 编码自查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/mojibakeGuard.test.ts`
Expected: 1 passed。

- [ ] **Step 12: 提交**

```bash
git add types.ts utils/ttsProvider.ts utils/ttsRouter.ts utils/ttsRouter.test.ts utils/genieTts.ts utils/genieTts.test.ts
git commit -m "feat(tts): add genie provider and browser client"
```

---

### Task 3: main-agent `ttsProxy` 转发

**Files:**
- Modify: `worker/main-agent/src/index.js`（第 787 行 `/v1/models` 之后）
- Modify: `worker/main-agent/src/index.test.ts`
- Modify: `worker/main-agent/worker.bundle.js`（构建产物）

**Interfaces:**
- Consumes: Task 1 的 `/speak` 契约。
- Produces: `POST {agentUrl}/agent/v1/tts`，请求体 `{text, emotion?}`，响应与 `/speak` 一致（status + content-type + body）。**本层无状态。**

- [ ] **Step 1: 写测试**

`worker/main-agent/src/index.test.ts:14` 已 `import { describe, it, expect, vi, afterEach } from 'vitest'`，`:16` 已 `import worker from './index.js'`，`:49-52` 已有 `afterEach` 清理全局。**不要重复 import，也不要加新的 afterEach。**

在文件末尾追加：

```typescript
describe('POST /v1/tts', () => {
    // checkAuth 读 env.AMSG_CLIENT_TOKEN（index.js:61-68）
    const ttsEnv = { AMSG_CLIENT_TOKEN: 'tok' };
    const postTts = (
        body: unknown,
        headers: Record<string, string> = { 'x-client-token': 'tok' },
    ) => worker.fetch(
        new Request(`${AGENT}/agent/v1/tts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
        }),
        ttsEnv,
        { waitUntil: () => {} },
    );

    it('鉴权失败时拒绝', async () => {
        const res = await postTts({ text: 'hi' }, {});
        expect(res.status).toBe(403);
    });

    it('把 body 原样转发到适配层并回传音频', async () => {
        const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]).buffer;
        const calls: Array<{ url: string; init: any }> = [];
        vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
            calls.push({ url: String(url), init });
            return new Response(wav, { status: 200, headers: { 'content-type': 'audio/wav' } });
        }));
        const res = await postTts({ text: '你好', emotion: 'happy' });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('audio/wav');
        expect(calls[0].url).toBe('http://127.0.0.1:9882/speak');
        expect(JSON.parse(calls[0].init.body)).toEqual({ text: '你好', emotion: 'happy' });
    });

    it('503 忙 原样透传', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"busy"}', {
            status: 503, headers: { 'content-type': 'application/json' },
        })));
        const res = await postTts({ text: 'x' });
        expect(res.status).toBe(503);
    });

    it('适配层不可达时返回 502 而不是抛异常', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
        const res = await postTts({ text: 'x' });
        expect(res.status).toBe(502);
    });
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run worker/main-agent`
Expected: `鉴权失败时拒绝` **已绿**（`checkAuth` 现有行为就是 403），另外 3 条转发用例 **红**（当前 `/v1/tts` 落到 404）。**不是 4 条全红**——若鉴权那条也红，说明 `ttsEnv` 构造错了。

- [ ] **Step 3: 实现 `ttsProxy`**

在 `index.js` 的 `if (plain === '/v1/models') return llmModelsProxy(request, env, url);` 之后插入：

```javascript
    // Genie-TTS（VPS 自建中文克隆）。适配层已处理情绪表、队列、分块与 WAV 包裹，
    // 本层只做鉴权后的无状态转发——不记情绪、不缓存参考音频，避免跨进程失效。
    if (plain === '/v1/tts') {
      if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
      return ttsProxy(request, env);
    }
```

在 `webdavProxy` 函数附近加：

```javascript
// 配置走 main-agent 的 env 对象（与 getJsonEnv / providersOf 同一套读法），不是 process.env。
async function ttsProxy(request, env) {
  const speakUrl = (env?.GENIE_SPEAK_URL || '').trim() || 'http://127.0.0.1:9882/speak';
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
    return json({ error: 'bad_request' }, 400);
  }
  try {
    const upstream = await fetch(speakUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    // arrayBuffer 也要在 try 内：上游回 body 时断线会抛，不能漏成宿主 500。
    const body = await upstream.arrayBuffer();
    const out = new Headers();
    const ct = upstream.headers.get('content-type');
    if (ct) out.set('content-type', ct);
    const resolved = upstream.headers.get('x-genie-resolved-emotion');
    if (resolved) out.set('X-Genie-Resolved-Emotion', resolved);
    return new Response(body, { status: upstream.status, headers: out });
  } catch {
    return json({ error: 'genie_unavailable' }, 502);
  }
}
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run worker/main-agent`
Expected: 全绿。

- [ ] **Step 5: 重建 bundle 并验证同步**

```powershell
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
node scripts/build-workers.mjs
$a=(Get-FileHash worker/main-agent/src/index.js -Algorithm SHA256).Hash
$b=(Get-FileHash worker/main-agent/worker.bundle.js -Algorithm SHA256).Hash
if ($a -ne $b) { throw 'main-agent bundle 未同步' }
```

`scripts/build-workers.mjs:130-150` 已把 main-agent 列为逐字复制项，所以源文件与 bundle 的哈希应当相等。**不要改 `build-workers.mjs`，也不要手改 bundle。**

- [ ] **Step 6: 提交**

```bash
git add worker/main-agent/src/index.js worker/main-agent/src/index.test.ts worker/main-agent/worker.bundle.js
git commit -m "feat(main-agent): stateless tts proxy to Genie /speak"
```

---

### Task 4: localhost dev proxy 与端到端验证

**Files:**
- Modify: `vite.config.ts`（代理段）

- [ ] **Step 1: 加 `/agent` dev proxy**

`vite.config.ts:3,79-84` 已直接使用 `process.env`，照此写法。在 `server.proxy` 里紧跟 `'/api/elevenlabs/tts'` 之后加：

```typescript
      // Genie-TTS 走 VPS 后端。target 只从环境变量来，禁止把真实域名写进仓库。
      '/agent': {
        target: process.env.VITE_AGENT_PROXY_TARGET || 'http://127.0.0.1:8830',
        changeOrigin: true,
      },
```

不写 `secure: false`——保持默认 TLS 校验。

- [ ] **Step 2: 起 dev server**

```powershell
$env:VITE_AGENT_PROXY_TARGET = Read-Host 'Backend origin，例如 https://你的后端域名'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm dev
```

- [ ] **Step 3: 端到端验证**

另开一个终端：

```powershell
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$env:AMSG_CLIENT_TOKEN = Read-Host 'AMSG_CLIENT_TOKEN'

curl.exe -sS -o calm-1.wav -w "status=%{http_code} type=%{content_type}`n" `
  -X POST http://localhost:5173/agent/v1/tts `
  -H "content-type: application/json" `
  -H "x-client-token: $env:AMSG_CLIENT_TOKEN" `
  -d '{"text":"你回来啦，今天过得怎么样？","emotion":"calm"}'

curl.exe -sS -o calm-2.wav -w "status=%{http_code}`n" `
  -X POST http://localhost:5173/agent/v1/tts `
  -H "content-type: application/json" `
  -H "x-client-token: $env:AMSG_CLIENT_TOKEN" `
  -d '{"text":"你回来啦，今天过得怎么样？","emotion":"calm"}'

curl.exe -sS -o angry.wav -w "status=%{http_code}`n" `
  -X POST http://localhost:5173/agent/v1/tts `
  -H "content-type: application/json" `
  -H "x-client-token: $env:AMSG_CLIENT_TOKEN" `
  -d '{"text":"你回来啦，今天过得怎么样？","emotion":"angry"}'
```

PowerShell 单引号里的 JSON **不要加反斜杠**。

判据：
- 三条都 `status=200 type=audio/wav`
- `calm-1.wav` 与 `calm-2.wav` 哈希**允许不同**（Genie 合成不确定，已实测），但**时长都必须落在 1.0-3.0 秒**（`{0:N2}` 字节 ÷ 64000）
- `angry.wav` 与两个 calm 哈希**至少与其中一个不同**（不同参考音频 → 韵律不同）
- 三个文件头 4 字节都是 `RIFF`

**若返回 403**：`x-client-token` 值不对或 `AMSG_CLIENT_TOKEN` 未配置。**若返回 502**：`GENIE_SPEAK_URL` 指向的适配层不通——用 `ssh root@$env:VPS_HOST "curl --max-time 130 -sS -X POST http://127.0.0.1:9882/speak -H 'content-type: application/json' -d '{\"text\":\"x\",\"emotion\":\"calm\"}'"` 在 VPS 本机确认（9882 只监听 127.0.0.1，本机不能直连公网 9882）。

- [ ] **Step 4: 清理探针**

```powershell
Remove-Item calm-1.wav, calm-2.wav, angry.wav -ErrorAction SilentlyContinue
```

- [ ] **Step 5: 提交**

```bash
git add vite.config.ts
git commit -m "chore(vite): dev proxy for /agent so localhost can reach VPS TTS"
```

---

## 完成判据

阶段 A 全部满足才算完成：

1. Task 1 Step 7-10 全过，`test_speak.py` 打印 `ALL_PASS`，`NRestarts` 不增长、`MemoryPeak` ≤ 5G、输出 `NO_OOM`
2. `pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts worker/main-agent` 全绿
3. `npx tsc --noEmit` 对 `types.ts` / `utils/ttsProvider.ts` / `utils/ttsRouter.ts` / `utils/genieTts.ts` 零命中
4. `pnpm vitest run utils/mojibakeGuard.test.ts` 绿 + U+FFFD 字节扫零
5. `worker/main-agent/src/index.js` 与 `worker.bundle.js` 的 SHA-256 相等
6. localhost 端到端三条都 200 + 合法 WAV，时长在 1.0-3.0s，`angry` 与 calm 哈希至少一个不同
7. **Phase B 未污染**：对 `git diff --name-only <阶段A起始commit>..HEAD` 做路径白名单检查，结果**不得**出现 `apps/Settings.tsx`、`components/date/DateSession.tsx`、`apps/CallApp.tsx`、`apps/Chat.tsx`、`utils/promptPresetCatalog.ts`、`utils/chatPrompts.ts`、`utils/ttsCache.ts`（这些都是 Phase B 的文件）。设置页仍显示三家 provider 是预期状态。

## 阶段 A 不做的事

- 设置页第四个选项、角色页试听（Phase B）
- `voice.genie` 提示词指南及 8 处接线（Phase B）
- `DateSession.tsx:352` 缓存键修正（Phase B）
- `ttsCache.ts` 让 Genie 跳过共享缓存（Phase B）
- Chat/Call 下载文件后缀 `.wav`（Phase B）
- Capacitor APK 走 `agentUrl` 直连（Phase B）
