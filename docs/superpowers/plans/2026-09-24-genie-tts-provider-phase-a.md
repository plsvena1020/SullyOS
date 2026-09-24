# Genie-TTS 独立开关 阶段 A（VPS 适配层 + 最小可用链路） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VPS 上给 Genie 加一个带锁与队列的 `/speak` 适配端点，并把它接成一个**独立开关**（`apiConfig.genieVoiceEnabled`）而不是第 4 个 TTS provider，使 `/agent/v1/tts` 在 localhost 与生产链路都可用。**本期不含 UI 开关、默认关闭，对现有用户零行为变化。**

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
- 阶段 A 完成时设置页仍显示原有 provider 四选一，**没有任何可见变化**，这是预期状态

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
8. **未预热完成时收到请求** → 503 `warming_up`，不是泛化 500 → Task 1 Step 7
9. **Genie 后台推理失败**（吞异常、HTTP 200 已发出）→ 必须变成 500 `synth_failed`，不能返回半截音频当成功。判据是 `save_path` 未生成 → Task 1 Step 9 的 `sane()` 会因 `wave.open` 失败而 FAIL
10. **malformed 请求**（无 body / 非法 JSON / JSON 数组）→ 顶层 `{"error":"bad_request"}` 400，不是 FastAPI 默认的 422 `{"detail":...}` → Task 1 Step 9
11. **默认开启会把老用户切走** → 阶段 A 是 opt-in，`isGenieVoiceEnabled({})` 必须为 `false` → Task 2 Step 4
12. **通话绕过 router** → `CallApp.tsx:1205` 的条件必须含 `isGenieVoiceEnabled`，否则 Genie 在通话里永远不生效 → Task 2 Step 8（靠代码审查，无自动化测试能覆盖这条调用路径）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `vps-backend/deploy/genie/genie_server.py` | 适配层：`/speak`、锁与队列、readiness、情绪表、分块、WAV 包裹、错误契约。注册到 Genie 的 app |
| `vps-backend/deploy/genie/emotions.json` | 情绪 → `{wav, text}`，7 条 |
| `vps-backend/deploy/genie/install.sh` | 装到 `/opt/genie-tts`、更新 unit、重启、带超时的自检 |
| `vps-backend/deploy/genie/test_speak.py` | 适配层冒烟测试，覆盖 Review Focus 1/2/3/4/5/8 |
| `types.ts` | `APIConfig` 加 3 个配置字段（**不改** `TtsProvider`、**不改** `voicePrompts`） |
| `utils/genieTts.ts` | **新建**。浏览器客户端 + 4 个导出：`isGenieVoiceEnabled`、`resolveGenieEmotion`、`cleanTextForTtsGenie`、`synthesizeSpeechGenieDetailed` |
| `utils/genieTts.test.ts` | **新建** |
| `utils/ttsProvider.ts` | 加 `setGenieVoiceEnabled` / `isGenieVoiceEnabledSync` 单例（prompt 侧拿不到 apiConfig） |
| `utils/chatPrompts.ts` | 加 `GENIE_VOICE_ACTING_GUIDE` 常量 + `resolveVoiceActingGuide` 开头一个分支。**不进** `promptPresetCatalog.ts` |
| `context/OSContext.tsx` | 在既有 `setTtsProvider` 同步处加一行 `setGenieVoiceEnabled(...)` |
| `apps/CallApp.tsx` | **只改 `:1205` 一个条件 + 一个 import**（否则通话永远绕过 router） |
| `utils/ttsRouter.ts` | 7 处分流，全部读 `isGenieVoiceEnabled`；`providerUsesRawVoiceMarkup` 改判定；`SynthOptions` 加 export |
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
  - 失败：`{"error": "<code>"}`（**顶层就是 error，不包在 detail 里**），code ∈ `bad_request`(400) / `empty`(400) / `bad_emotion`(400) / `warming_up`(503) / `busy`(503) / `lock_timeout`(504) / `synth_timeout`(504) / `chunk_too_long`(413) / `too_many_chunks`(413) / `reference_missing`(500) / `synth_failed`(500)
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
import tempfile
import threading
import time
import urllib.error
import urllib.request
import wave
from io import BytesIO

os.environ.setdefault("GENIE_DATA_DIR", "/opt/genie-tts/GenieData")

import genie_tts as genie  # noqa: E402
from genie_tts.Server import app as genie_app  # noqa: E402
from fastapi import Request  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
from starlette.concurrency import run_in_threadpool  # noqa: E402

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
        # 目标 60 字：单段本身就超过目标（长句无标点）时也要先 flush，
        # 否则 "好的。"+100字 会被合成一个 103 字块。
        if buf and (
            len(buf) >= CHUNK_TARGET_CHARS
            or len(part) > CHUNK_TARGET_CHARS
            or len(buf) + len(part) > CHUNK_MAX_CHARS
        ):
            flush()
        buf += part
        if len(buf) >= CHUNK_TARGET_CHARS:
            flush()
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


def _tts_completed_pcm(chunk: str, timeout: float) -> bytes:
    """合成一个分块，返回裸 PCM。

    必须借 save_path 判定成功：Genie 的 Server.run_tts_in_background 会吞掉推理异常
    （只发结束标记），而 HTTP 200 在进入后台前就已发出。只看状态码会把"半截音频"
    当成功返回。用 save_path 则只有 TTSPlayer 真正处理完才会写出完整 WAV。
    """
    fd, path = tempfile.mkstemp(prefix="genie-chunk-", suffix=".wav")
    os.close(fd)
    try:
        _genie_post(
            "/tts",
            {
                "character_name": CHARACTER,
                "text": chunk,
                "split_sentence": False,
                "save_path": path,
            },
            timeout=timeout,
        )
        if not os.path.isfile(path) or os.path.getsize(path) <= 44:
            raise RuntimeError("incomplete genie output")
        with wave.open(path, "rb") as wf:
            actual = (wf.getnchannels(), wf.getsampwidth(), wf.getframerate())
            if actual != (CHANNELS, BYTES_PER_SAMPLE, SAMPLE_RATE):
                raise RuntimeError("unexpected genie wav format")
            pcm = wf.readframes(wf.getnframes())
        if not pcm:
            raise RuntimeError("empty genie pcm")
        return pcm
    finally:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass


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
        pcm.extend(_tts_completed_pcm(chunk, timeout=remaining(SYNTH_TIMEOUT)))
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
async def speak_endpoint(request: Request):
    # 自己解析 body：若用 `payload: dict` 形参，FastAPI 对无 body / 非法 JSON / JSON 数组
    # 会返回 422 {"detail": ...}，违反顶层 {"error": ...} 的契约。
    try:
        payload = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "bad_request"})
    if not isinstance(payload, dict):
        return JSONResponse(status_code=400, content={"error": "bad_request"})

    if not _READY.is_set():
        return JSONResponse(status_code=503, content={"error": "warming_up"})

    text = payload.get("text")
    emotion = payload.get("emotion")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse(status_code=400, content={"error": "empty"})
    if emotion is not None and not isinstance(emotion, str):
        return JSONResponse(status_code=400, content={"error": "bad_emotion"})

    try:
        # 合成是阻塞的（最长 120 秒），必须放线程池，否则会堵住整个事件循环。
        wav, resolved = await run_in_threadpool(_speak_with_guard, text, emotion)
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
import sys
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
    """13 字中文的合理时长区间。垃圾音频（约 5.3s）会被这个上限挡住。

    要真正 wave.open 解析，不能只查 RIFF 魔数——魔数对了但帧数/格式错的文件也算坏。
    """
    import io as _io
    import wave as _wave
    try:
        with _wave.open(_io.BytesIO(body), "rb") as wf:
            if (wf.getnchannels(), wf.getsampwidth(), wf.getframerate()) != (1, 2, 32000):
                return False
            dur = wf.getnframes() / wf.getframerate()
    except Exception:
        return False
    return low <= dur <= high


def _raises(fn, expected: str) -> bool:
    try:
        fn()
        return False
    except ValueError as e:
        return str(e) == expected


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

    # 3 短句 + 长段无标点：必须切成两块而不是误判超长。
    #    先直接单测算法本身，否则"只检查 HTTP 非空"会假绿。
    sys.path.insert(0, "/opt/genie-tts")
    from genie_server import _split_text as split_text

    sample = "好的。" + "啊" * 100
    parts = split_text(sample)
    ok &= check(
        "split_exact_two_chunks",
        len(parts) == 2 and "".join(parts) == sample,
        f"chunks={len(parts)} sizes={[len(p) for p in parts]}",
    )
    ok &= check(
        "split_no_punctuation_300_raises",
        _raises(lambda: split_text("啊" * 300), "chunk_too_long"),
        "",
    )

    st_mix, body_mix, _ = post({"text": sample, "emotion": "calm"}, timeout=180)
    ok &= check("mixed_split_ok", st_mix == 200, f"status={st_mix}")
    ok &= check("mixed_sane_or_long", st_mix != 200 or len(body_mix) > 0, f"len={len(body_mix)}")

    # 3b 后台失败必须变成 synth_failed，不能返回半截音频当成功。
    #    手法：把 _genie_post 换成什么都不写盘，_tts_completed_pcm 必须抛。
    import genie_server

    original_post = genie_server._genie_post

    def rejects_missing_completed_file():
        genie_server._genie_post = lambda *a, **k: b""
        try:
            genie_server._tts_completed_pcm("测试", 1.0)
            return False
        except RuntimeError as exc:
            return str(exc) == "incomplete genie output"
        finally:
            genie_server._genie_post = original_post

    ok &= check("missing_completed_file_rejected", rejects_missing_completed_file())

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

在工作树根目录执行（`<你的 VPS IP>` 用交互输入，不进命令历史）。

**不要用 `tar -cf - ... | ssh ...`**：PowerShell 5.1 的 stdout 管道会做文本解码，二进制会被破坏。必须先落成文件再 `scp`。

```powershell
$env:VPS_HOST = Read-Host 'VPS IP'
$archive = Join-Path $env:TEMP 'genie-phase-a.tar.gz'
try {
  tar -czf $archive -C vps-backend/deploy/genie .
  scp $archive "root@$env:VPS_HOST:/tmp/genie-phase-a.tar.gz"
  ssh "root@$env:VPS_HOST" 'tar -xzf /tmp/genie-phase-a.tar.gz -C /opt/genie-tts && bash /opt/genie-tts/install.sh && /opt/genie-tts/venv/bin/python /opt/genie-tts/test_speak.py; rc=$?; rm -f /tmp/genie-phase-a.tar.gz; exit $rc'
}
finally {
  Remove-Item $archive -ErrorAction SilentlyContinue
}
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

`test_speak.py` 的 `split_exact_two_chunks PASS` 与 `mixed_split_ok PASS` 即为通过。若 `split_exact_two_chunks` 是 FAIL，说明 `_split_text` 的装箱循环没加"单段超目标就 flush"那条条件。

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

### Task 2: 配置字段、路由分流与浏览器客户端

**Files:**
- Modify: `types.ts`（`APIConfig` 内加 3 个字段）
- Modify: `utils/ttsRouter.ts`（`export` + 7 处分流）
- Modify: `utils/ttsProvider.ts`（**只新增** Genie 开关镜像单例）
- Modify: `utils/chatPrompts.ts`（**只新增** Genie 短指南常量与一个选择分支）
- Modify: `context/OSContext.tsx`（既有同步 effect 加一行 + 补依赖数组）
- Modify: `apps/CallApp.tsx`（**只改** `:1205` 一个条件 + 一个 import）
- Create: `utils/genieTts.ts`、`utils/genieTts.test.ts`、`utils/ttsRouter.test.ts`、`utils/ttsProvider.genie.test.ts`

**边界（哪些不碰）：**
- **不改** `TtsProvider` 联合类型、**不改** `normalizeTtsProvider()`、**不改** `VoicePromptKey`
- `utils/ttsProvider.ts` 只新增 `setGenieVoiceEnabled` / `isGenieVoiceEnabledSync`，不动 `setTtsProvider` / `getTtsProvider` / `setVoicePromptOverrides`
- `utils/chatPrompts.ts` 只新增 `GENIE_VOICE_ACTING_GUIDE` 与 `resolveVoiceActingGuide` 开头的一个分支；**不改** `chatVoiceEnabled` 主门禁，也不改 `:1214-1277` 的整体结构
- **不碰** `utils/promptPresetCatalog.ts`、`utils/promptPresetSeeding.ts`、`utils/presetEffective.ts`、`utils/promptCallRegistry.ts`、`utils/promptPresetRuntime.ts`

**Interfaces:**
- Consumes: Task 1 的 `/speak` 错误契约与 `X-Genie-Resolved-Emotion` 响应头。
- Produces（全部从 `./genieTts` 导出）:
  - `isGenieVoiceEnabled(apiConfig: APIConfig): boolean` — 语义 `apiConfig.genieVoiceEnabled !== false`
  - `resolveGenieEmotion(options: SynthOptions | undefined, apiConfig: APIConfig): string` — 永远返回 7 个白名单之一
  - `cleanTextForTtsGenie(raw: string): string`
  - `synthesizeSpeechGenieDetailed(text, char, apiConfig, options?): Promise<TtsResult>`

- [ ] **Step 1: 写 `utils/genieTts.test.ts`（先失败）**

创建 `utils/genieTts.test.ts`。注意三点：import **不带 `.js`**；每个用例前必须写 `localStorage`（否则 `readAgentRoutingConfig()` 返回空、客户端会先抛"未配置主代理地址"，fetch 根本不会被调用）。

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  cleanTextForTtsGenie,
  isGenieVoiceEnabled,
  resolveGenieEmotion,
  synthesizeSpeechGenieDetailed,
} from './genieTts';

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
  // Genie 是独立开关，不进 TtsProvider；默认开启即 undefined。
  const apiConfig = { ttsProvider: 'minimax' } as any;
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

describe('isGenieVoiceEnabled', () => {
  it('阶段 A 是 opt-in：undefined 不算开启（老用户零行为变化）', () => {
    expect(isGenieVoiceEnabled({} as any)).toBe(false);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: undefined } as any)).toBe(false);
  });
  it('只有显式 true 才开启', () => {
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: true } as any)).toBe(true);
    expect(isGenieVoiceEnabled({ genieVoiceEnabled: false } as any)).toBe(false);
  });
});

describe('resolveGenieEmotion', () => {
  it('auto 模式跟随 options.emotion', () => {
    expect(resolveGenieEmotion({ emotion: 'sad' }, {} as any)).toBe('sad');
  });
  it('auto 模式遇非白名单回落 calm', () => {
    expect(resolveGenieEmotion({ emotion: 'disgusted' }, {} as any)).toBe('calm');
    expect(resolveGenieEmotion(undefined, {} as any)).toBe('calm');
  });
  it('fixed 模式忽略 options.emotion，用配置值', () => {
    expect(resolveGenieEmotion(
      { emotion: 'sad' },
      { genieEmotionMode: 'fixed', genieEmotion: 'angry' } as any,
    )).toBe('angry');
  });
  it('fixed 模式配置值非法时回落 calm', () => {
    expect(resolveGenieEmotion(
      undefined,
      { genieEmotionMode: 'fixed', genieEmotion: 'nope' } as any,
    )).toBe('calm');
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
  bad_request: '请求格式不正确',
  bad_emotion: '情绪值格式不正确',
  empty: '没有可朗读的文字',
  warming_up: '语音服务正在准备中，请稍后',
  busy: '语音正忙，稍后再试',
  lock_timeout: '语音排队超时',
  synth_timeout: '语音合成超时',
  synth_failed: '语音合成失败',
  reference_missing: '参考音频缺失',
  chunk_too_long: '这段文字太长，无法朗读',
  too_many_chunks: '这段文字段落太多，无法朗读',
  genie_unavailable: '语音服务暂时不可用',
};

/**
 * 阶段 A 是 opt-in：只有显式写 true 才启用。
 * 用户要的「默认开启」由阶段 B 的设置开关落地（UI 默认勾选 + 保存时写入 true），
 * 不能在这里把 undefined 当 true——阶段 A 没有 UI，老用户会被切走且无法关闭。
 */
export function isGenieVoiceEnabled(apiConfig: APIConfig): boolean {
  return apiConfig.genieVoiceEnabled === true;
}

const GENIE_EMOTIONS = ['calm', 'happy', 'sad', 'angry', 'surprised', 'fearful', 'fluent'] as const;

/** auto 跟随 <语音 emotion>，fixed 用配置值；非白名单一律回落 calm。 */
export function resolveGenieEmotion(
  options: SynthOptions | undefined,
  apiConfig: APIConfig,
): string {
  const raw = apiConfig.genieEmotionMode === 'fixed'
    ? apiConfig.genieEmotion
    : options?.emotion;
  return raw && (GENIE_EMOTIONS as readonly string[]).includes(raw) ? raw : 'calm';
}

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
      body: JSON.stringify({ text: spoken, emotion: resolveGenieEmotion(options, apiConfig) }),
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
Expected: 15 tests passed, 0 failed。

- [ ] **Step 5: 改 `types.ts`（只加配置字段）**

在 `APIConfig` 接口内（与 `ttsProvider`、`voicePrompts` 同级）加三个字段：

```typescript
  /** Genie 自建中文语音。undefined 视为 true（升级后默认开启）。 */
  genieVoiceEnabled?: boolean;
  /** 情绪来源：'auto' 跟随 <语音 emotion>；'fixed' 固定用 genieEmotion。 */
  genieEmotionMode?: 'auto' | 'fixed';
  /** 固定模式下使用的情绪，7 项之一；非法值回落 calm。 */
  genieEmotion?: string;
```

**不要改** `TtsProvider`（第 403 行）与 `voicePrompts`（第 446-451 行）。**不要碰** `utils/ttsProvider.ts`——归一化逻辑保持原样。

- [ ] **Step 6: 跑一次类型检查确认没碰坏**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); npx tsc --noEmit 2>&1 | Select-String "types.ts"`
Expected: 无输出。存量错误不算，只要 `types.ts` 零命中。

- [ ] **Step 7: 改 `utils/ttsRouter.ts`**

第 28 行加 `export`（当前**没有**，Task 2 的 import 依赖它）：

```typescript
export type SynthOptions = { languageBoost?: string; groupId?: string; emotion?: string };
```

第 31-45 行 `assertTtsLanguageSupported` 开头插入（**保留**原第 37 行的 `const provider`，它下面还要用）：

```typescript
  if (isGenieVoiceEnabled(apiConfig) && (languageBoost || '').trim()) {
    throw new Error('Genie 自建语音目前只支持中文（含中英混读），请先关闭其他朗读语种');
  }
```

第 47-62 行 `synthesizeSpeechDetailed` 在 `assertTtsLanguageSupported(...)` 那一行**之后**、`const provider = ...` 之前插入：

```typescript
  if (isGenieVoiceEnabled(apiConfig)) {
    return synthesizeSpeechGenieDetailed(text, char, apiConfig, options);
  }
```

并 import：`import { cleanTextForTtsGenie, isGenieVoiceEnabled, synthesizeSpeechGenieDetailed } from './genieTts';`

第 79-87 行 `characterHasVoice`，在 `const provider = resolveTtsProvider(apiConfig);` 之后加：

```typescript
  if (isGenieVoiceEnabled(apiConfig)) return true;
```

第 90-96 行 `canSynthesizeSpeech`，在 `const provider = resolveTtsProvider(apiConfig);` 之后、`if (provider === 'fishaudio')` 之前加：

```typescript
  if (isGenieVoiceEnabled(apiConfig)) return true;
```

第 99-104 行 `cleanTextForTtsProvider`，在 `const provider = resolveTtsProvider(apiConfig);` 之后加：

```typescript
  if (isGenieVoiceEnabled(apiConfig)) return cleanTextForTtsGenie(text);
```

第 106-111 行 `stripTtsMarkupForDisplay`，在 `const provider = resolveTtsProvider(apiConfig);` 之后加：

```typescript
  // 用 cleanTextForTtsGenie 而不是 cleanVoiceMarkupForDisplay：后者不移除 Fish 的 [whispering] 等方括号 cue。
  if (isGenieVoiceEnabled(apiConfig)) return cleanTextForTtsGenie(text);
```

第 114-115 行整段替换为：

```typescript
/** 只有 Fish / ElevenLabs 的清洗器需要看到原始 inline cue；MiniMax 用已消毒的 speech，Genie 不支持任何 cue。 */
export const providerUsesRawVoiceMarkup = (apiConfig: APIConfig): boolean => {
  if (isGenieVoiceEnabled(apiConfig)) return false;
  const provider = resolveTtsProvider(apiConfig);
  return provider === 'fishaudio' || provider === 'elevenlabs';
};
```

- [ ] **Step 8: 修 `apps/CallApp.tsx` 漏接（否则通话永远用不到 Genie）**

`apps/CallApp.tsx:1204-1205` 现状：

```typescript
  const synthesizeCallAudioUrl = async (rawText: string, emotion?: string): Promise<{ url: string; traceIds: string[] }> => {
    if (activeTtsProvider !== 'minimax') {
```

默认 provider 就是 minimax，所以这个 `if` 恒为 false，通话**永远直连 MiniMax、完全绕过 router**。Genie 是开关不是 provider，改成：

```typescript
    if (isGenieVoiceEnabled(apiConfig) || activeTtsProvider !== 'minimax') {
```

并在文件顶部 import：`import { isGenieVoiceEnabled } from '../utils/genieTts';`

**只改这一行 + 一个 import。不要动 CallApp 的提示词段（`:355-370`、`:488-508`）。**

- [ ] **Step 9: `utils/ttsProvider.ts` 加单例**

`resolveVoiceActingGuide()` 拿不到 `apiConfig`（它只用 `getTtsProvider()` 这个模块级单例），所以需要一个同步单例。照现有 `setTtsProvider` / `getTtsProvider`（第 15-23 行）的模式，在其后加：

```typescript
let currentGenieEnabled = false;

/** Genie 开关的模块级镜像，供拿不到 apiConfig 的 prompt 侧使用。与 setTtsProvider 同一套理由。 */
export function setGenieVoiceEnabled(v: boolean | undefined | null): void {
  currentGenieEnabled = v === true;
}

export function isGenieVoiceEnabledSync(): boolean {
  return currentGenieEnabled;
}
```

同时新建 `utils/ttsProvider.genie.test.ts`：

```typescript
import { describe, expect, it } from 'vitest';
import { isGenieVoiceEnabledSync, setGenieVoiceEnabled } from './ttsProvider';

describe('Genie 开关单例', () => {
  it('只有显式 true 才为 true（undefined/false 都关闭）', () => {
    setGenieVoiceEnabled(undefined);
    expect(isGenieVoiceEnabledSync()).toBe(false);
    setGenieVoiceEnabled(false);
    expect(isGenieVoiceEnabledSync()).toBe(false);
    setGenieVoiceEnabled(true);
    expect(isGenieVoiceEnabledSync()).toBe(true);
  });
});
```

- [ ] **Step 10: `utils/chatPrompts.ts` 加 Genie 专属短指南**

**为什么不走 provider 选择**：`:1273` 追加的指南按 provider 选，而 `voice.fish`（`utils/promptPresetCatalog.ts:154`）**明文禁止** `<语音 emotion>`，与 `:1256` 教的东西直接冲突。Genie 开启时绕开 provider 选择即可。

**必须同时参数化前两处，否则新指南会和硬编码块自相矛盾**（`:1256` 教 8 个情绪含 `disgusted`、`:1265` 要求写 `(laughs)/(sighs)`；而 Genie 只有 7 个可用情绪、动作词会被剥掉）：

在 `utils/chatPrompts.ts:1214` 之前插入：

```typescript
  const genieVoice = isGenieVoiceEnabledSync();
  const voiceEmotionList = genieVoice
    ? 'happy/sad/angry/fearful/surprised/calm/fluent'
    : 'happy/sad/angry/fearful/disgusted/surprised/calm/fluent';
  const voiceCueRule = genieVoice
    ? '- <语音> 里不要写括号动作；Genie 不支持，会在发送前剥掉。'
    : '- 想表达笑、叹气等真实语气，使用官方英文标签 (laughs)/(sighs)/(chuckle)/(gasps) 等（中文括号会被直接删掉、不朗读）。';
```

然后把 `:1228`、`:1256` 里写死的 8 个情绪列表替换为 `${voiceEmotionList}`，把 `:1242`、`:1265` 里写死的动作词规则替换为 `${voiceCueRule}`。

**注意** `resolveVoiceActingGuide` 的两个调用点（`:1248`、`:1273`）是互斥的——`:1248` 是 `char.chatVoiceLang` 非空的双语语音消息分支，`:1273` 是普通语音消息分支。每次构建只执行一个，不存在重复注入。Date 走 `utils/datePrompts.ts` 的 `voice.date`，不受影响。

然后在 `resolveVoiceActingGuide()`（第 52-63 行）**最开头**插入：

```typescript
  if (isGenieVoiceEnabledSync()) return GENIE_VOICE_ACTING_GUIDE;
```

并 import `isGenieVoiceEnabledSync` from `./ttsProvider`。

新增常量（约 10 行，模板字符串里反引号用**单个** `\`` 转义，不要写 `\\``）：

```typescript
/**
 * Genie 自建语音的表演规则。放在本文件而不是 promptPresetCatalog：
 * 放进 catalog 要连带改 promptPresetSeeding 的迁移表（它会删整个旧 voicePrompts，
 * 漏一处就抹掉用户数据），不值当。代价是 v1 不能在预设面板里编辑这一段。
 */
const GENIE_VOICE_ACTING_GUIDE = `### 语音表演（Genie 自建语音）

- 用 \`<语音 emotion="...">\` 发送语音块，情绪只能取 happy/sad/angry/fearful/surprised/calm/fluent。
- 没标 emotion 时会回落 calm；用户在设置里选了固定情绪的，按设置来。
- 每条消息最多一个 <语音> 标签。不是每条都要发语音——像真人一样，有时候打字有时候发语音。
- **不要复读**：同时发文字和语音时，语音内容不能是文字的重复或复述。
- 语音和文字的标点、语气词要自然，口语化，不要念稿腔。`;
```

- [ ] **Step 11: `context/OSContext.tsx` 同步单例**

`context/OSContext.tsx:2157-2159` 现状：

```typescript
  useEffect(() => {
    setTtsProvider(apiConfig.ttsProvider);
  }, [apiConfig.ttsProvider]);
```

改成（**依赖数组必须一起加**，否则 Phase B 打开 Genie 开关后提示词仍走旧指南）：

```typescript
  useEffect(() => {
    setTtsProvider(apiConfig.ttsProvider);
    setGenieVoiceEnabled(apiConfig.genieVoiceEnabled);
  }, [apiConfig.ttsProvider, apiConfig.genieVoiceEnabled]);
```

并 import `setGenieVoiceEnabled`（`utils/ttsProvider.ts`）。**照同一处的既有同步写法，不要新建第二个同步点。**

初始化顺序本身没有冲突：首次 render 时单例为 `false`；`OSContext.tsx:1388-1391` 加载配置后触发 re-render，下一次 effect 才同步为 `true`——正常用户交互前会完成。

- [ ] **Step 12: 新建 `utils/ttsRouter.test.ts`**

**新建文件**（当前不存在），完整内容：

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertTtsLanguageSupported,
  canSynthesizeSpeech,
  characterHasVoice,
  cleanTextForTtsProvider,
  providerUsesRawVoiceMarkup,
  stripTtsMarkupForDisplay,
  synthesizeSpeechDetailed,
} from './ttsRouter';

describe('Genie 开关分流', () => {
  // 开：必须显式 true（阶段 A 是 opt-in）
  const ON = { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any;
  // 关：未设置或显式 false，回退原 provider
  const OFF = { genieVoiceEnabled: false, ttsProvider: 'minimax' } as any;

  it('characterHasVoice 开启时无条件 true（无 per-char 音色配置）', () => {
    expect(characterHasVoice({ id: 'x' } as any, ON)).toBe(true);
  });

  it('characterHasVoice 关闭时回到原 provider 判定', () => {
    expect(characterHasVoice({ id: 'x' } as any, OFF)).toBe(false);
    expect(characterHasVoice({ id: 'x', voiceProfile: { voiceId: 'v' } } as any, OFF)).toBe(true);
  });

  it('canSynthesizeSpeech 开启时无条件 true（无 API Key）', () => {
    expect(canSynthesizeSpeech({ id: 'x' } as any, ON)).toBe(true);
  });

  it('providerUsesRawVoiceMarkup 开启时为 false（回归 Fish cue 被原样念出）', () => {
    expect(providerUsesRawVoiceMarkup(ON)).toBe(false);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'fishaudio' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'elevenlabs' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ genieVoiceEnabled: false, ttsProvider: 'minimax' } as any)).toBe(false);
  });

  it('cleanTextForTtsProvider 开启时只留 <语音> 块内正文', () => {
    const out = cleanTextForTtsProvider(
      '你说真的假的？<语音 emotion="surprised">(laughs)你认真的？</语音><字幕>等等</字幕>',
      ON,
    );
    expect(out).toBe('你认真的？');
    expect(out).not.toContain('laughs');
  });

  it('cleanTextForTtsProvider 关闭时按原 provider 走', () => {
    const out = cleanTextForTtsProvider('你好<#0.5#>世界', OFF);
    expect(typeof out).toBe('string');
  });

  it('stripTtsMarkupForDisplay 开启时移除 Genie 不支持的标记', () => {
    const out = stripTtsMarkupForDisplay(
      '<语音 emotion="happy">口语一(laughs)[whispering]</语音>',
      ON,
    );
    expect(out).toBe('口语一');
  });

  it('assertTtsLanguageSupported 开启时拒绝粤语', () => {
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, ON, 'yue')).toThrow();
    expect(() => assertTtsLanguageSupported({ id: 'x' } as any, OFF, 'yue')).not.toThrow();
  });

  // 阶段 A 没有 UI 开关，只有显式 true 才可能触发。这条是"链路真的接通"的唯一自动化证据。
  describe('真实分发', () => {
    beforeEach(() => {
      localStorage.setItem('os_api_config', JSON.stringify({
        agentUrl: 'https://agent.test',
        agentToken: 'tok',
      }));
      vi.stubGlobal('URL', {
        createObjectURL: () => 'blob:genie',
        revokeObjectURL: () => {},
      } as any);
    });
    afterEach(() => {
      localStorage.removeItem('os_api_config');
      vi.unstubAllGlobals();
    });

    it('显式 true 时 synthesizeSpeechDetailed 真正打 Genie', async () => {
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(2048),
      } as unknown as Response));
      vi.stubGlobal('fetch', fetchMock);

      await synthesizeSpeechDetailed(
        '测试',
        { id: 'x' } as any,
        { genieVoiceEnabled: true, ttsProvider: 'minimax' } as any,
      );

      expect(String(fetchMock.mock.calls[0][0])).toBe('https://agent.test/agent/v1/tts');
    });

    it('未开启时不打 Genie（回退原 provider）', async () => {
      const fetchMock = vi.fn(async () => new Response('{}', {
        status: 500, headers: { 'content-type': 'application/json' },
      }));
      vi.stubGlobal('fetch', fetchMock);
      await synthesizeSpeechDetailed('测试', { id: 'x' } as any, { ttsProvider: 'minimax' } as any)
        .catch(() => {});
      expect(String(fetchMock.mock.calls[0]?.[0] ?? '')).not.toContain('/agent/v1/tts');
    });
  });
});
```

- [ ] **Step 13: 跑测试**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts`
Expected: 全绿。`providerUsesRawVoiceMarkup` 那条必须 PASS——它修的是真 bug（旧实现会把 Fish 的 `(laughs)` 原样送进 Genie）。

- [ ] **Step 14: 类型检查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); npx tsc --noEmit 2>&1 | Select-String "types.ts|ttsProvider.ts|ttsRouter.ts|genieTts.ts|chatPrompts.ts|OSContext.tsx|CallApp.tsx"`
Expected: 无输出。仓库有存量 tsc 错误，只要求本次触碰的 7 个文件零命中。

- [ ] **Step 15: 编码自查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/mojibakeGuard.test.ts`
Expected: 1 passed。

- [ ] **Step 16: 提交**

```bash
git add types.ts utils/ttsRouter.ts utils/ttsRouter.test.ts utils/genieTts.ts utils/genieTts.test.ts utils/ttsProvider.ts utils/chatPrompts.ts context/OSContext.tsx apps/CallApp.tsx
git commit -m "feat(tts): add Genie routing switch and browser client"
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

function Speak($emotion, $out) {
  curl.exe -sS -D "$out.hdr" -o $out -w "status=%{http_code} type=%{content_type}`n" `
    -X POST http://localhost:5173/agent/v1/tts `
    -H "content-type: application/json" `
    -H "x-client-token: $env:AMSG_CLIENT_TOKEN" `
    -d ('{"text":"你回来啦，今天过得怎么样？","emotion":"' + $emotion + '"}')
}

Speak 'calm'  .\calm-1.wav
Speak 'calm'  .\calm-2.wav
Speak 'angry' .\angry.wav

'--- 情绪映射只看响应头（音频 hash 不能用来判情绪：合成不确定，同一情绪两次也不同）'
Get-Content .\calm-1.wav.hdr, .\angry.wav.hdr | Select-String -Pattern 'x-genie-resolved-emotion'

'--- 时长必须在 1.0-3.0 秒（32000Hz 16bit mono → 字节数 ÷ 64000）'
Get-ChildItem calm-1.wav, calm-2.wav, angry.wav |
  Select-Object Name, @{n='sec';e={[math]::Round($_.Length/64000,2)}}
```

PowerShell 单引号里的 JSON **不要加反斜杠**；用 `-d '...'` 时若要插值请用上例的字符串拼接。

判据：
- 三条都 `status=200 type=audio/wav`
- `calm-1.wav.hdr` 与 `angry.wav.hdr` 里的 `x-genie-resolved-emotion` 分别是 `calm` 与 `angry`——**这是情绪映射唯一的可靠证据**
- 三个文件的时长都落在 1.0-3.0 秒
- 三个文件都能被 `wave` 解析（`RIFF`/`WAVE`/`fmt `/`data` 四段齐全）

**不要**用"angry 与 calm 的 hash 不同"来证明情绪映射——Genie 采样不确定，同一情绪连跑两次 hash 也会不同。

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

**先说清楚阶段 A 交付的是什么**：VPS `/speak`、main-agent 转发、Vite 传输、以及 `genieVoiceEnabled === true` 时的浏览器 router 分发，四段链路都接通且可验证。**阶段 A 不提供普通用户开关，Genie 默认不生效**——普通用户的 `os_api_config` 里没有该字段，只有显式写入 `true`（改 localStorage 后刷新、导入含该字段的备份、或调底层函数）才会走到 Genie。所以下面第 6 条是 curl + 响应头，不是"打开 App 就能听到声音"。

阶段 A 全部满足才算完成：

1. Task 1 Step 7-10 全过，`test_speak.py` 打印 `ALL_PASS`，`NRestarts` 不增长、`MemoryPeak` ≤ 5G、输出 `NO_OOM`
2. `pnpm vitest run utils/ttsRouter utils/genieTts utils/ttsProvider worker/main-agent` 全绿
3. `npx tsc --noEmit` 对 `types.ts` / `utils/ttsProvider.ts` / `utils/ttsRouter.ts` / `utils/genieTts.ts` / `utils/chatPrompts.ts` / `context/OSContext.tsx` / `apps/CallApp.tsx` 零命中
4. `pnpm vitest run utils/mojibakeGuard.test.ts` 绿 + U+FFFD 字节扫零
5. `worker/main-agent/src/index.js` 与 `worker.bundle.js` 的 SHA-256 相等
6. localhost 端到端：三条都 200 + 合法 WAV，时长在 1.0-3.0s，且 `X-Genie-Resolved-Emotion` 分别是 `calm` / `calm` / `angry`
7. `utils/ttsRouter.test.ts` 的「显式 true 时 synthesizeSpeechDetailed 真正打 Genie」PASS——这是浏览器侧唯一能自动证明"链路真的接通"的用例
8. **Phase B 未污染**：对 `git diff --name-only <阶段A起始commit>..HEAD` 做路径白名单检查，结果**不得**出现 `apps/Settings.tsx`、`components/date/DateSession.tsx`、`apps/Chat.tsx`、`utils/ttsCache.ts`（这些是 Phase B 的文件）。**也不得出现** `utils/promptPresetCatalog.ts`、`utils/promptPresetSeeding.ts`、`utils/presetEffective.ts`、`utils/promptCallRegistry.ts`、`utils/promptPresetRuntime.ts`——Genie 指南刻意放 `chatPrompts.ts` 常量而非 catalog，正是为了不碰这条会抹用户数据的迁移链。`apps/CallApp.tsx` 允许出现，但 diff 里只能有 `:1205` 附近那一个条件和一个 import。设置页仍显示原有 provider 四选一是预期状态。

## 阶段 A 不做的事

- 设置页的 Genie 开关 / 情绪下拉 / 试听按钮、角色页试听（Phase B）
- 让老用户升级即生效的数据迁移（Phase B 结束时单独决定，见 spec §10.1）
- `DateSession.tsx` 缓存键修正（Phase B）
- `ttsCache.ts` 让 Genie 跳过共享缓存（Phase B）
- Chat/Call 下载文件后缀 `.wav`（Phase B）
- Capacitor APK 走 `agentUrl` 直连（Phase B）
- 删掉或改动原有 minimax / 鱼声 / ElevenLabs 三家（永久不做，它们是 Genie 关闭时的回退路径）
- 把 Genie 指南放进 `utils/promptPresetCatalog.ts`（永久不做，理由见上）
