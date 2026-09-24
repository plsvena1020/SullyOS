# Genie-TTS Provider 阶段 A（VPS 适配层 + 最小可用链路） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 VPS 上给 Genie 加一个带锁与队列的 `/speak` 适配端点，并把它接成 SullyOS 的第 4 个 TTS provider，使 `/v1/tts` 可用。本期不含 UI 与提示词。

**Architecture:** 情绪表、队列、文本分块、WAV 格式知识全部在 VPS 适配层（与 Genie 同进程生命周期）。main-agent 退化为无状态鉴权转发。浏览器只传白名单内的 `emotion` 字符串，不知道参考文件路径。

**Tech Stack:** Python 3.14 + FastAPI + uvicorn（VPS）；TypeScript + React + vitest（仓库）；Cloudflare Pages functions / Vercel serverless（同源中转）。

**Spec:** `docs/superpowers/specs/2026-09-24-genie-tts-provider-design.md`（执行前必读，plan 与 spec 配套）

## Global Constraints

- Genie 服务：`genie-tts.service`，127.0.0.1:9882，`MemoryMax=5G`，`OMP_NUM_THREADS=4`，systemd 已自启
- 适配层新端点：`127.0.0.1:9882/speak`，同进程复用 Genie 的 FastAPI app
- 队列上限 **2**：第 3 条并发立即 503，不等待
- 锁等待超时 **5 秒** → 504；单次合成超时 **120 秒** → 504
- 单块文本上限 **60 字**，单块超 **120 字**且无法再切 → 413；总块数 > **20** → 413
- 采样率固定 **32000 Hz / 16-bit / mono**，WAV 头 44 字节
- 语言只支持中文（含中英自动 hybrid）。`languageBoost` 非空一律拒绝
- 浏览器侧只用 `agentUrl` / `agentToken`，**禁止把 VPS 域名或 Token 写进仓库**
- 不改 Caddy；不改 `api/backend-proxy.ts` 与 `functions/_lib/backendProxy.js`
- 不引入新依赖（Python 侧只用已装的 fastapi/uvicorn/numpy/httpx；TS 侧零新依赖）
- commit message 用英文
- 每次动过含中文文件后跑 `pnpm vitest run utils/mojibakeGuard.test.ts` + U+FFFD 字节扫
- 阶段 A 完成时前端仍只显示三家 provider，这是**预期状态**，不是缺陷

## Review Focus

以下五类是 spec 暗示但没有任何任务测过的最可能伤到人的输入，每一条都已挂到拥有该代码的任务里：

1. **两条语音请求同时到达** → 两条都出声、都不挂死（现在 Genie 并发会一条 240 秒超时、另一条返回 2.4 倍长垃圾音频）→ Task 1 Step 7
2. **未映射的情绪（如 `foo`）** → 正常出声且音色等同 `calm`，不报错 → Task 1 Step 8
3. **同一句话 + 不同情绪** → 两次音频必须不同（`DateSession.tsx:352` 缓存键只有台词文本，同句 calm/sad 会串音；本期先在适配层验差异，Phase B 修缓存）→ Task 1 Step 9
4. **长文本无标点串（如一整段没有句号）** → 返回 413 而不是静默截断（`Core/Inference.py:9` 的 `MAX_T2S_LEN=1000` 未被使用，`:95-109` 最多 500 步仍返回）→ Task 1 Step 10 的 `long_unpunctuated_413`
5. **空文本 / 纯空白** → 400，且不占用队列槽位 → Task 1 Step 10 的 `empty_text_400`（与上一条同属一个冒烟命令）

---

## File Structure

| 文件 | 职责 |
|---|---|
| `vps-backend/deploy/genie/genie_server.py` | 适配层：`/speak` 端点、锁与队列、情绪表、分块、WAV 包裹、预热。复用 Genie 自己的 app，不再单独起服务 |
| `vps-backend/deploy/genie/emotions.json` | 情绪 → `{wav, text}` 映射，7 条 |
| `vps-backend/deploy/genie/install.sh` | 把上面两个文件装到 `/opt/genie-tts`，更新 systemd unit 的 ExecStart，重启并自检 |
| `vps-backend/deploy/genie/test_speak.py` | 适配层冒烟测试，覆盖 Review Focus 的 1/2/4/5 |
| `types.ts` | `TtsProvider` 加 `'genie'`；`voicePrompts` 加 `genie?` |
| `utils/ttsProvider.ts` | provider 归一化与提示词 override 的 genie 分支 |
| `utils/ttsRouter.ts` | 7 处分发点加 genie 分支；`providerUsesRawVoiceMarkup` 改白名单 |
| `utils/genieTts.ts` | **新建**。浏览器侧客户端：调 `/v1/tts`，错误映射，返回统一 `TtsResult` |
| `utils/genieTts.test.ts` | **新建**。genieTts 单测 |
| `worker/main-agent/src/index.js` | 加 `ttsProxy`（无状态转发） |
| `worker/main-agent/src/index.test.ts` | 加 ttsProxy 测试（鉴权、透传、错误码） |
| `vite.config.ts` | 加 `/agent` dev proxy，target 取自环境变量 |

---

### Task 1: VPS 适配层 `/speak`

**Files:**
- Create: `vps-backend/deploy/genie/genie_server.py`
- Create: `vps-backend/deploy/genie/emotions.json`
- Create: `vps-backend/deploy/genie/install.sh`
- Create: `vps-backend/deploy/genie/test_speak.py`

**Interfaces:**
- Consumes: Genie 包 `genie_tts`（已装于 `/opt/genie-tts/venv`），其 `Server.app` 是现成 FastAPI 实例；`/set_reference_audio` 与 `/tts` 为已验证的 JSON 端点。
- Produces: HTTP 端点 `POST 127.0.0.1:9882/speak`，请求 `{"text": string, "emotion": string?}`，成功返回 `200` + `content-type: audio/wav` + 完整 RIFF/WAV 字节；失败返回 `400/413/503/504/500` + `{"error": <code>}`。此契约供 Task 3 的 `ttsProxy` 与 Task 4 的 `genieTts.ts` 依赖。

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
  1. Genie 的 /tts 返回裸 PCM 却声明 audio/wav，需要补 44 字节 RIFF 头。
  2. Genie 的 Core/TTSPlayer 是全局单例（start_session 清空队列并替换 callback），
     并发进入会互相踩：实测两条并发一条 240 秒超时、另一条返回 2.4 倍长垃圾音频。
  3. /set_reference_audio 写的是模块级 dict，必须与 /tts 在同一把锁内完成，
     否则 A 设置 happy、B 改成 sad、A 却用 sad 合成。
  4. 长文本需要自己分块；Genie 对超长文本会静默截断。
  5. Genie 后台吞异常且 HTTP 200 已发出，错误无法传播。

因此情绪表、队列、分块、WAV 格式知识都收在本层；main-agent 只做鉴权转发。
"""
import json
import os
import queue
import struct
import threading
import time
import urllib.error
import urllib.request
import wave
from io import BytesIO

os.environ.setdefault("GENIE_DATA_DIR", "/opt/genie-tts/GenieData")

import genie_tts as genie  # noqa: E402
from genie_tts.Server import app as genie_app  # noqa: E402

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
_PENDING = queue.Queue()
_PENDING_TASKS = 0
_PENDING_LOCK = threading.Lock()


def _load_emotions() -> dict:
    path = os.path.join(REFS_DIR, "emotions.json")
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _resolve_emotion(raw: str | None) -> dict:
    table = _load_emotions()
    if raw is None:
        return table["calm"]
    return table.get(raw, table["calm"])


def _wrap_pcm_as_wav(pcm: bytes) -> bytes:
    buf = BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(CHANNELS)
        wf.setsampwidth(BYTES_PER_SAMPLE)
        wf.setframerate(SAMPLE_RATE)
        wf.writeframes(pcm)
    return buf.getvalue()


def _split_text(text: str) -> list[str]:
    """按中文标点切块，块间不丢标点；单块超过 CHUNK_MAX_CHARS 且无标点可切时抛 ValueError。"""
    delimiters = "。！？；!?;\n"
    chunks: list[str] = []
    buf = ""
    for ch in text:
        buf += ch
        if ch in delimiters and len(buf) >= CHUNK_TARGET_CHARS:
            chunks.append(buf)
            buf = ""
    if buf.strip():
        chunks.append(buf)
    if not chunks:
        raise ValueError("empty")
    for c in chunks:
        if len(c) > CHUNK_MAX_CHARS:
            raise ValueError("chunk_too_long")
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
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _synthesize(text: str, emotion: str) -> bytes:
    entry = _resolve_emotion(emotion)
    wav_path = os.path.join(REFS_DIR, entry["wav"])
    if not os.path.isfile(wav_path):
        raise FileNotFoundError(f"reference audio missing: {wav_path}")
    # 每次都重设参考：去掉跨进程缓存失效点，代价是每次多一次本地 HTTP（<50ms）。
    _genie_post(
        "/set_reference_audio",
        {
            "character_name": CHARACTER,
            "audio_path": wav_path,
            "audio_text": entry["text"],
            "language": LANGUAGE,
        },
        timeout=30.0,
    )
    pcm = bytearray()
    for chunk in _split_text(text):
        pcm.extend(
            _genie_post(
                "/tts",
                {
                    "character_name": CHARACTER,
                    "text": chunk,
                    "split_sentence": False,
                },
                timeout=SYNTH_TIMEOUT,
            )
        )
    if not pcm:
        raise RuntimeError("empty pcm")
    return _wrap_pcm_as_wav(bytes(pcm))


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


def _speak_with_guard(text: str, emotion: str) -> bytes:
    if not _acquire_slot():
        raise TimeoutError("busy")
    try:
        deadline = time.monotonic() + LOCK_WAIT_TIMEOUT
        acquired = _SYNTH_LOCK.acquire(timeout=max(0.0, deadline - time.monotonic()))
        if not acquired:
            raise TimeoutError("lock_timeout")
        try:
            return _synthesize(text, emotion)
        finally:
            _SYNTH_LOCK.release()
    finally:
        _release_slot()


@genie_app.post("/speak")
def speak_endpoint(payload: dict):
    from fastapi import HTTPException

    text = payload.get("text")
    emotion = payload.get("emotion")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail=json.dumps({"error": "empty_text"}))
    if emotion is not None and not isinstance(emotion, str):
        raise HTTPException(status_code=400, detail=json.dumps({"error": "bad_emotion"}))
    try:
        wav = _speak_with_guard(text, emotion)
    except TimeoutError as exc:
        code = "busy" if str(exc) == "busy" else "lock_timeout"
        status = 503 if code == "busy" else 504
        raise HTTPException(status_code=status, detail=json.dumps({"error": code}))
    except ValueError as exc:
        code = {v: v for v in ("empty", "chunk_too_long", "too_many_chunks")}.get(str(exc), "bad_text")
        status = 413 if code in ("chunk_too_long", "too_many_chunks") else 400
        raise HTTPException(status_code=status, detail=json.dumps({"error": code}))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=json.dumps({"error": "reference_missing"}))
    except Exception:
        raise HTTPException(status_code=500, detail=json.dumps({"error": "synth_failed"}))
    from fastapi.responses import Response

    return Response(content=wav, media_type="audio/wav")


def _warmup() -> None:
    time.sleep(5)
    for attempt in range(1, 6):
        try:
            genie.load_character(
                character_name=CHARACTER, onnx_model_dir=MODEL_DIR, language=LANGUAGE
            )
            entry = _resolve_emotion("calm")
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
            print(f"[genie] warmup ok on attempt {attempt}", flush=True)
            return
        except Exception as exc:  # noqa: BLE001
            print(f"[genie] warmup attempt {attempt} failed: {exc}", flush=True)
            time.sleep(10)
    print("[genie] warmup gave up; /speak will 500 until manual setup", flush=True)


if __name__ == "__main__":
    threading.Thread(target=_warmup, daemon=True).start()
    print(f"[genie] serving on {HOST}:{PORT}", flush=True)
    genie.start_server(host=HOST, port=PORT, workers=1)
```

注意这个文件把 `warmup()` 改成**走 HTTP 自 POST** 而不是 `genie.set_reference_audio()`。原因：Genie 2.0.2 的 `Server.py` 与 `Internal.py` 各有一份模块级 `_reference_audios`，函数式 API 写的那份不是 HTTP `/tts` 校验的那份，会导致预热后 `/tts` 永远 404。

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

# systemd unit 只改 ExecStart，其余（MemoryMax=5G / 4 线程 / 自启）保持不变
if ! grep -q 'genie_server.py' "$UNIT"; then
  echo "ERROR: $UNIT 的 ExecStart 未指向 genie_server.py，请手工检查" >&2
  exit 1
fi

systemctl daemon-reload
systemctl restart genie-tts
sleep 60

for i in $(seq 1 30); do
  if curl -sf -X POST http://127.0.0.1:9882/speak \
      -H 'content-type: application/json' \
      -d '{"text":"安装自检。","emotion":"calm"}' \
      -o /tmp/genie-install-check.wav; then
    break
  fi
  sleep 10
done

if [ ! -s /tmp/genie-install-check.wav ]; then
  echo "ERROR: /speak 自检未通过，见 journalctl -u genie-tts" >&2
  exit 1
fi

head -c 4 /tmp/genie-install-check.wav | grep -q 'RIFF' || {
  echo "ERROR: 返回的不是合法 WAV" >&2
  exit 1
}

echo "OK: /speak 就绪，WAV 头合法"
rm -f /tmp/genie-install-check.wav
```

- [ ] **Step 4: 写冒烟测试**

创建 `vps-backend/deploy/genie/test_speak.py`：

```python
"""适配层冒烟测试。部署后在 VPS 上跑：/opt/genie-tts/venv/bin/python test_speak.py"""
import json
import threading
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:9882"
SENTENCE = "你回来啦，今天过得怎么样？"


def post(payload, timeout=240):
    req = urllib.request.Request(
        BASE + "/speak",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def check(name, cond, detail=""):
    print(("PASS" if cond else "FAIL"), name, detail, flush=True)
    return cond


def main():
    ok = True

    # 1 基本成功 + WAV 头
    st, body = post({"text": SENTENCE, "emotion": "calm"})
    ok &= check("calm_200", st == 200, f"status={st}")
    ok &= check("calm_riff", body[:4] == b"RIFF", f"head={body[:4]!r}")
    ok &= check("calm_nonempty", len(body) > 10000, f"len={len(body)}")
    ok &= check(
        "calm_wave_header", body[8:12] == b"WAVE" and body[36:40] == b"data", ""
    )

    # 2 未映射情绪回落 calm
    st_foo, body_foo = post({"text": SENTENCE, "emotion": "definitely_not_mapped"})
    st_sad, body_sad = post({"text": SENTENCE, "emotion": "sad"})
    ok &= check("unknown_emotion_200", st_foo == 200, f"status={st_foo}")
    ok &= check(
        "unknown_falls_back_to_calm",
        body_foo == body and st_sad == 200,
        f"foo_len={len(body_foo)} calm_len={len(body)}",
    )

    # 3 同句不同情绪必须不同（回归缓存串音）
    st_happy, body_happy = post({"text": SENTENCE, "emotion": "happy"})
    ok &= check(
        "happy_differs_from_sad",
        body_happy != body_sad,
        f"happy_len={len(body_happy)} sad_len={len(body_sad)}",
    )

    # 4 并发两条：都 200、都非空、都长度合理（回归 Genie 单例互踩）
    results = {}

    def run(tag, emotion):
        results[tag] = post({"text": SENTENCE, "emotion": emotion}, timeout=240)

    t1 = threading.Thread(target=run, args=("a", "calm"))
    t1.start()
    t2 = threading.Thread(target=run, args=("b", "happy"))
    t2.start()
    t1.join()
    t2.join()
    for tag in ("a", "b"):
        st_c, body_c = results[tag]
        ok &= check(f"concurrent_{tag}_200", st_c == 200, f"status={st_c}")
        ok &= check(
            f"concurrent_{tag}_sane_len",
            10000 < len(body_c) < 400000,
            f"len={len(body_c)}",
        )

    # 5 长文本无标点串 -> 413
    st_long, _ = post({"text": "啊" * 300, "emotion": "calm"}, timeout=60)
    ok &= check("long_unpunctuated_413", st_long == 413, f"status={st_long}")

    # 6 空文本 -> 400
    st_empty, _ = post({"text": "   ", "emotion": "calm"}, timeout=60)
    ok &= check("empty_text_400", st_empty == 400, f"status={st_empty}")

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

把 `vps-backend/deploy/genie/` 四个文件传到 VPS `/opt/genie-tts/`（`emotions.json` 传到 `/opt/genie-tts/refs/`），然后执行 `install.sh`。预期输出末行是 `OK: /speak 就绪，WAV 头合法`。

若 `install.sh` 报 `ERROR: ExecStart 未指向 genie_server.py`，先手工确认 `/etc/systemd/system/genie-tts.service` 的 `ExecStart` 是：

```
ExecStart=/opt/genie-tts/venv/bin/python /opt/genie-tts/genie_server.py
```

若报 `/speak 自检未通过`，跑 `journalctl -u genie-tts -n 50 | grep -v INFO` 看原始报错并贴出来，**不要自行改端口或参数绕过**。

- [ ] **Step 7: 跑并发回归（Review Focus 1）**

```bash
/opt/genie-tts/venv/bin/python /opt/genie-tts/test_speak.py
```

预期：`concurrent_a_200 PASS`、`concurrent_b_200 PASS`、两个 `concurrent_*_sane_len PASS`。**如果任何一个并发用例 FAIL 或超时，说明队列/锁没生效，不要继续下一个任务**，贴出 `journalctl -u genie-tts -n 30` 的输出。

- [ ] **Step 8: 验未知情绪回落（Review Focus 2）**

同一条命令里 `unknown_emotion_200 PASS` 与 `unknown_falls_back_to_calm PASS` 即为通过。`unknown_falls_back_to_calm` 断言 `body_foo == body`（与 calm 逐字节相同），若因为 Genie 内部采样非确定性而不相等，改成断言 `abs(len(body_foo) - len(body)) / len(body) < 0.2` 并在报告里说明。

- [ ] **Step 9: 验同句不同情绪（Review Focus 3）**

`happy_differs_from_sad PASS` 即为通过。若 FAIL，说明情绪没真正切换，检查 `emotions.json` 路径与 `emo-happy.wav` / `emo-sad.wav` 是否都在 `/opt/genie-tts/refs/`。

- [ ] **Step 10: 验长文本截断（Review Focus 4）**

`long_unpunctuated_413 PASS` 与 `empty_text_400 PASS` 即为通过。

- [ ] **Step 11: 验内存未越界**

连续 10 次调用后：

```bash
pid=$(systemctl show genie-tts -p MainPID --value)
grep -E 'VmRSS|VmHWM' /proc/$pid/status
```

预期 `VmHWM` 不超过 `5242880` kB（5G）。若越界，先把 `emotions.json` 里的情绪数减到 4 再测。

---

### Task 2: provider 类型、路由与浏览器客户端

**Files:**
- Modify: `types.ts:403`（`TtsProvider`）、`types.ts:446-451`（`voicePrompts`）
- Modify: `utils/ttsProvider.ts:12-13`、`utils/ttsProvider.ts:59-63`
- Modify: `utils/ttsRouter.ts:31-45`、`:47-62`、`:79-87`、`:90-96`、`:99-104`、`:106-111`、`:114-115`
- Create: `utils/genieTts.ts`
- Create: `utils/genieTts.test.ts`
- Test: `utils/ttsRouter.test.ts`（若不存在则新建；若存在则追加）

**Interfaces:**
- Consumes: Task 1 的 `/speak` 契约（经 Task 3 的 main-agent 转发，本任务只关心 HTTP 层形状：`200 + audio/wav`，或 `400/413/503/504/500 + {"error": code}`）。
- Produces:
  - `TtsProvider` 联合类型新增 `'genie'`
  - `synthesizeSpeechGenieDetailed(text: string, char: CharacterProfile, apiConfig: APIConfig, options?: SynthOptions): Promise<TtsResult>`（从 `utils/genieTts.ts` 导出，供 `ttsRouter` 调用）
  - `cleanTextForTtsProvider` 对 genie 走纯文本清洗

- [ ] **Step 1: 写 `utils/genieTts.test.ts`（先失败）**

创建 `utils/genieTts.test.ts`：

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { synthesizeSpeechGenieDetailed } from './genieTts.js';

const wav = (bytes: number) => new Uint8Array(bytes);

function makeResponse(status: number, body: ArrayBuffer | string, contentType = 'audio/wav') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body).buffer : body),
    text: async () => (typeof body === 'string' ? body : ''),
  } as unknown as Response;
}

describe('synthesizeSpeechGenieDetailed', () => {
  const apiConfig = { ttsProvider: 'genie' } as any;
  const char = { id: 'c1' } as any;

  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('成功时把 audio/wav 转成 Blob URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(200, wav(2048).buffer)));
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:genie-1', revokeObjectURL: () => {} } as any);
    const res = await synthesizeSpeechGenieDetailed('你好', char, apiConfig, { emotion: 'happy' });
    expect(res.url).toBe('blob:genie-1');
  });

  it('请求体带 character_name 之外的 text 与 emotion', async () => {
    const fetchMock = vi.fn(async () => makeResponse(200, wav(2048).buffer));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} } as any);
    await synthesizeSpeechGenieDetailed('测试文本', char, apiConfig, { emotion: 'sad' });
    const [, init] = fetchMock.mock.calls[0] as any;
    const body = JSON.parse(init.body);
    expect(body.text).toBe('测试文本');
    expect(body.emotion).toBe('sad');
  });

  it('503 busy 抛出可读的中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(503, '{"error":"busy"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/忙|busy/i);
  });

  it('504 抛出超时错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(504, '{"error":"lock_timeout"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/超时|timeout/i);
  });

  it('413 抛出文本过长错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => makeResponse(413, '{"error":"chunk_too_long"}', 'application/json')));
    await expect(synthesizeSpeechGenieDetailed('x', char, apiConfig)).rejects.toThrow(/过长|too long/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/genieTts.test.ts`
Expected: FAIL，报 `Failed to resolve import "./genieTts.js"`。

- [ ] **Step 3: 建 `utils/genieTts.ts`**

创建 `utils/genieTts.ts`：

```typescript
/**
 * Genie-TTS（VPS 自建，中文克隆）客户端。
 *
 * 走现有的同源中转 `/agent/v1/tts` → main-agent → VPS 适配层 → Genie。
 * 适配层已把情绪表、队列、分块与 WAV 包裹都做完，这里只负责：
 *   1. 组请求体（text + emotion）
 *   2. 把错误码翻译成人话
 *   3. audio/wav → Blob URL
 *
 * 与另外三家的差异：没有 API Key、没有 per-char 音色，所以 ttsRouter 里
 * characterHasVoice / canSynthesizeSpeech 对 genie 无条件返回 true。
 */
import type { APIConfig, CharacterProfile } from '../types';
import type { TtsResult } from './minimaxTts';
import type { SynthOptions } from './ttsRouter';
import { readAgentRoutingConfig } from './agentRouting';

const ERROR_TEXT: Record<string, string> = {
  busy: '语音正忙，稍后再试',
  lock_timeout: '语音排队超时',
  synth_failed: '语音合成失败',
  reference_missing: '参考音频缺失',
  chunk_too_long: '这段文字太长，无法朗读',
  too_many_chunks: '这段文字段落太多，无法朗读',
  warming_up: '语音服务正在准备中',
  empty_text: '没有可朗读的文字',
};

export async function synthesizeSpeechGenieDetailed(
  text: string,
  char: CharacterProfile,
  apiConfig: APIConfig,
  options?: SynthOptions,
): Promise<TtsResult> {
  void char;
  void apiConfig;
  const { agentUrl, agentToken } = readAgentRoutingConfig();
  if (!agentUrl) throw new Error('未配置主代理地址，无法使用 Genie-TTS');
  const controller = new AbortController();
  // 与适配层的 120 秒合成上限对齐，再留 15 秒余量。
  const timer = setTimeout(() => controller.abort(), 135_000);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (agentToken) headers['X-Client-Token'] = agentToken;
    const res = await fetch(`${agentUrl}/agent/v1/tts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, emotion: options?.emotion ?? 'calm' }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      throw new Error(ERROR_TEXT[code] ?? `语音服务返回 ${res.status}`);
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 44) throw new Error('语音服务返回了空音频');
    const blob = new Blob([buf], { type: 'audio/wav' });
    return { url: URL.createObjectURL(blob), blob };
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const raw = await res.text();
    const parsed = JSON.parse(raw);
    const detail = parsed.detail ?? parsed;
    if (typeof detail === 'string') {
      try { return (JSON.parse(detail) as { error?: string }).error ?? ''; } catch { return ''; }
    }
    return typeof detail?.error === 'string' ? detail.error : '';
  } catch { return ''; }
}
```

**实现者注意**：

- `readAgentRoutingConfig` 来自 `utils/agentRouting.ts:12`，已导出，返回 `{ agentUrl, agentToken }`。**不要另写一套 agent 地址/凭据解析。**
- 鉴权头名是 `X-Client-Token`（见 `utils/agentRelayRequest.ts:26-30` 的 `relayHeaders`）。
- `TtsResult` 有**两个必填字段** `url` 与 `blob`（`utils/minimaxTts.ts:417-422`），必须两个都返回。
- `utils/ttsRouter.ts:28` 的 `type SynthOptions` 当前**没有 `export`**，本任务要给它加上 `export`，否则上面那行 import 编译不过。

- [ ] **Step 4: 跑测试确认通过**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/genieTts.test.ts`
Expected: 5 tests passed。

- [ ] **Step 5: 改 `types.ts`**

`types.ts:403`：

```typescript
export type TtsProvider = 'minimax' | 'fishaudio' | 'elevenlabs' | 'genie';
```

`types.ts:446-451` 的 `voicePrompts` 加一项：

```typescript
voicePrompts?: {
  minimax?: string;
  fishaudio?: string;
  elevenlabs?: string;
  genie?: string;
  dateVoice?: string;
};
```

- [ ] **Step 6: 改 `utils/ttsProvider.ts`**

第 12-13 行改为：

```typescript
export const normalizeTtsProvider = (raw: unknown): TtsProvider =>
  raw === 'fishaudio' ? 'fishaudio'
  : raw === 'elevenlabs' ? 'elevenlabs'
  : raw === 'genie' ? 'genie'
  : 'minimax';
```

第 59-63 行的对象字面量加一行 `genie: typeof overrides?.genie === 'string' ? overrides.genie : undefined,`。

- [ ] **Step 7: 改 `utils/ttsRouter.ts` 的 7 处**

`:31-45` `assertTtsLanguageSupported` 开头加：

```typescript
  const provider = resolveTtsProvider(apiConfig);
  if (provider === 'genie' && (languageBoost || '').trim()) {
    throw new Error('Genie-TTS 目前只支持中文（含中英混读），请先关闭其他朗读语种');
  }
  if ((languageBoost || '').trim().toLowerCase() !== 'yue') return;
```

（把原来第 37 行的 `const provider = ...` 删掉，避免重复声明。）

`:47-62` `synthesizeSpeechDetailed` 在 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') {
    return synthesizeSpeechGenieDetailed(text, char, apiConfig, options);
  }
```

并在文件顶部 import：`import { synthesizeSpeechGenieDetailed } from './genieTts';`

`:79-87` `characterHasVoice` 的 fish 分支前加：

```typescript
  if (provider === 'genie') return true;
```

`:90-96` `canSynthesizeSpeech` 的 `if (!characterHasVoice(...)) return false;` 之后加：

```typescript
  if (provider === 'genie') return true;
```

`:99-104` `cleanTextForTtsProvider` 的 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') return cleanTextForTtsGenie(text);
```

并在同文件实现（放在 `cleanTextForTtsProvider` 上方）：

```typescript
/** Genie 不理解任何 inline cue：动作词、情绪标签全部剥掉，只留纯朗读文本。 */
function cleanTextForTtsGenie(text: string): string {
  return cleanVoiceMarkupForDisplay(text)
    .replace(/\((?:laughs?|sighs?|breath|clears throat|chuckles?)[^)]*\)/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
```

`:106-111` `stripTtsMarkupForDisplay` 的 elevenlabs 分支后加：

```typescript
  if (provider === 'genie') return cleanVoiceMarkupForDisplay(text);
```

`:114-115` 改为白名单：

```typescript
/** 只有 Fish / ElevenLabs 的清洗器需要看到原始 inline cue；MiniMax 用已消毒的 speech，Genie 不支持任何 cue。 */
export const providerUsesRawVoiceMarkup = (apiConfig: APIConfig): boolean => {
  const provider = resolveTtsProvider(apiConfig);
  return provider === 'fishaudio' || provider === 'elevenlabs';
};
```

- [ ] **Step 8: 补 ttsRouter 的 genie 测试**

在 `utils/ttsRouter.test.ts` 追加（文件不存在则新建）：

```typescript
describe('genie provider', () => {
  it('normalizeTtsProvider 认得 genie', () => {
    expect(normalizeTtsProvider('genie')).toBe('genie');
  });

  it('characterHasVoice 对 genie 无条件 true（无 per-char 音色配置）', () => {
    expect(characterHasVoice({ id: 'x' } as any, { ttsProvider: 'genie' } as any)).toBe(true);
  });

  it('canSynthesizeSpeech 对 genie 无条件 true（无 API Key）', () => {
    expect(canSynthesizeSpeech({ id: 'x' } as any, { ttsProvider: 'genie' } as any)).toBe(true);
  });

  it('providerUsesRawVoiceMarkup 对 genie 为 false（回归 Fish cue 被原样念出）', () => {
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'genie' } as any)).toBe(false);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'fishaudio' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'elevenlabs' } as any)).toBe(true);
    expect(providerUsesRawVoiceMarkup({ ttsProvider: 'minimax' } as any)).toBe(false);
  });

  it('cleanTextForTtsProvider 对 genie 剥掉动作词与标签', () => {
    const out = cleanTextForTtsProvider(
      '<语音 emotion="happy">(laughs)今天真开心</语音><字幕>今天真开心</字幕>',
      { ttsProvider: 'genie' } as any,
    );
    expect(out).toBe('今天真开心');
    expect(out).not.toContain('laughs');
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
Expected: 全绿。`providerUsesRawVoiceMarkup` 那条必须 PASS——它是本任务修的真 bug（旧实现会把 Fish 的 `(laughs)` 原样送进 Genie）。

- [ ] **Step 10: 类型检查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); npx tsc --noEmit 2>&1 | Select-String "types.ts|ttsProvider.ts|ttsRouter.ts|genieTts.ts"`
Expected: 无输出。仓库有存量 tsc 错误（见 `notes/ethernet-branch-context.md`），只要求本次触碰的 4 个文件零命中。

- [ ] **Step 11: 编码自查**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run utils/mojibakeGuard.test.ts`
Expected: 1 passed。

- [ ] **Step 12: 提交**

```bash
git add types.ts utils/ttsProvider.ts utils/ttsRouter.ts utils/genieTts.ts utils/genieTts.test.ts utils/ttsRouter.test.ts
git commit -m "feat(tts): add genie provider and browser client"
```

---

### Task 3: main-agent `ttsProxy` 转发

**Files:**
- Modify: `worker/main-agent/src/index.js`（在第 787 行 `/v1/models` 之后插入）
- Modify: `worker/main-agent/src/index.test.ts`
- Modify: `worker/main-agent/worker.bundle.js`（构建产物，不手改）

**Interfaces:**
- Consumes: Task 1 的 `/speak` 契约（`127.0.0.1:9882/speak`）。
- Produces: `POST {agentBase}/v1/tts`，请求体 `{text, emotion?}`，响应与 `/speak` 完全一致（status + `content-type` + body）。**本层无状态**：不记情绪、不缓存参考音频。

- [ ] **Step 1: 写失败的测试**

在 `worker/main-agent/src/index.test.ts` 追加：

```typescript
describe('POST /v1/tts', () => {
  // checkAuth 读 env.AMSG_CLIENT_TOKEN（index.js:61-68），认 x-client-token 头；
  // 未配置令牌时直接放行，所以要测鉴权必须显式给 env。
  const env = { AMSG_CLIENT_TOKEN: 'test-token' };
  const post = (body: unknown, headers: Record<string, string> = { 'x-client-token': 'test-token' }) =>
    handler.fetch(new Request('https://agent.example.com/v1/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }), env as any, {} as any);

  it('鉴权失败时拒绝', async () => {
    const res = await post({ text: 'hi' }, {});
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('把 body 原样转发到适配层并回传音频', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]).buffer;
    const fetchMock = vi.fn(async () => new Response(wav, {
      status: 200, headers: { 'content-type': 'audio/wav' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ text: '你好', emotion: 'happy' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('audio/wav');
    const [, init] = fetchMock.mock.calls[0] as any;
    expect(JSON.parse(init.body)).toEqual({ text: '你好', emotion: 'happy' });
  });

  it('503 忙 原样透传', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"busy"}', {
      status: 503, headers: { 'content-type': 'application/json' },
    })));
    const res = await post({ text: 'x' });
    expect(res.status).toBe(503);
  });

  it('适配层不可达时返回 502 而不是抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const res = await post({ text: 'x' });
    expect(res.status).toBe(502);
  });
});
```

**实现者注意**：先读 `worker/main-agent/src/index.test.ts` 全文，确认它怎么构造 `env`（`AMSG_CLIENT_TOKEN` 等）与 `handler.fetch` 的调用签名。上面用的 `env as any` 与 `x-client-token` 头名**必须换成文件里既有的真实写法**，不要照抄。`vi` 若该文件未 import，补 `import { describe, it, expect, vi, afterEach } from 'vitest';` 并在末尾加 `afterEach(() => vi.unstubAllGlobals());`。

- [ ] **Step 2: 跑测试确认失败**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run worker/main-agent`
Expected: FAIL，4 条 `/v1/tts` 用例全红（当前 main-agent 对该路径返回 404）。

- [ ] **Step 3: 实现 `ttsProxy`**

在 `worker/main-agent/src/index.js` 找到 `if (plain === '/v1/models') return llmModelsProxy(request, env, url);` 这一行，**在它后面**插入：

```javascript
    // Genie-TTS（VPS 自建中文克隆）。适配层已处理情绪表、队列、分块与 WAV 包裹，
    // 本层只做鉴权后的无状态转发——不记情绪、不缓存参考音频，避免跨进程失效。
    if (plain === '/v1/tts') return ttsProxy(request, env);
```

然后在文件里 `webdavProxy` 函数附近（保持转发类函数聚在一起）加：

```javascript
async function ttsProxy(request, env) {
  // 配置走 main-agent 的 env 对象（与 getJsonEnv / providersOf 同一套读法），
  // 不是 process.env——main-agent 由 vps-backend 以 env 注入方式启动。
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
  let upstream;
  try {
    upstream = await fetch(speakUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return json({ error: 'genie_unavailable' }, 502);
  }
  const body = await upstream.arrayBuffer();
  const out = new Headers();
  const ct = upstream.headers.get('content-type');
  if (ct) out.set('content-type', ct);
  return new Response(body, { status: upstream.status, headers: out });
}
```

**实现者注意**：

- 鉴权已由第 779-780 行的 `checkAuth(request, env)` 统一处理，`ttsProxy` 里**不要重复鉴权**。
- `checkAuth`（`index.js:61-68`）读 `env.AMSG_CLIENT_TOKEN`，认 `x-client-token` 头或 `Authorization: Bearer`。注意它**未配置令牌时开发模式全放行**（第 63 行）——这是既有行为，本任务不改，但 Phase B 上线前要确认生产 `AMSG_CLIENT_TOKEN` 非空。
- `GENIE_SPEAK_URL` 从 `env` 对象读，与同文件的 `getJsonEnv` / `providersOf` 同一套读法。**不要用 `process.env` 或 `globalThis.process`**。

- [ ] **Step 4: 跑测试确认通过**

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm vitest run worker/main-agent`
Expected: 全绿，新加 4 条 `/v1/tts` 用例 PASS。

- [ ] **Step 5: 重建 bundle**

VPS 实际加载 `worker/main-agent/worker.bundle.js`（`vps-backend/config/services.js:47`），不重建等于没改。

Run: `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); node scripts/build-workers.mjs`
Expected: 输出提到 `main-agent` 成功。然后：

Run: `Select-String -Path worker/main-agent/worker.bundle.js -Pattern "v1/tts" | Measure-Object`
Expected: `Count` ≥ 1。

若 `scripts/build-workers.mjs` 不含 main-agent，先 `Get-Content scripts/build-workers.mjs` 看它构建哪些 worker，按它的既有模式补上 main-agent，**不要手改 bundle**。

- [ ] **Step 6: 提交**

```bash
git add worker/main-agent/src/index.js worker/main-agent/src/index.test.ts worker/main-agent/worker.bundle.js
git commit -m "feat(main-agent): stateless tts proxy to Genie /speak"
```

---

### Task 4: localhost dev proxy 与端到端验证

**Files:**
- Modify: `vite.config.ts`（代理段，现有 minimax/fish/elevenlabs 在 90-131 行附近）
- Test: 手工端到端（`curl`）

**Interfaces:**
- Consumes: Task 3 的 `POST {agentBase}/v1/tts`。
- Produces: localhost 下 `pnpm dev` 时 `http://localhost:5173/agent/v1/tts` 可用。

- [ ] **Step 1: 加 `/agent` dev proxy**

在 `vite.config.ts` 的 `server.proxy` 对象里，紧跟现有 `'/api/elevenlabs/tts'` 之后加：

```typescript
      // Genie-TTS 走 VPS 后端。target 取自环境变量，禁止把真实域名写进仓库。
      '/agent': {
        target: process.env.VITE_AGENT_PROXY_TARGET || 'http://127.0.0.1:8830',
        changeOrigin: true,
        secure: false,
      },
```

若 `vite.config.ts` 顶部没有 `process`（例如是 ESM 且禁用了 node globals），先读文件确认它已有的环境变量读法（搜 `process.env` 或 `loadEnv`），**照既有写法**。默认 target 写 `127.0.0.1:8830` 是给「本机跑 main-agent」的场景；若用户是 localhost 直连远端 VPS，用 `VITE_AGENT_PROXY_TARGET=https://<backend-host>` 覆盖，**该值只进环境变量或 .env.local，不进仓库**。

- [ ] **Step 2: 起 dev server 并手工验证**

```powershell
$env:VITE_AGENT_PROXY_TARGET = 'https://<你的 backend host>'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); pnpm dev
```

另开一个终端：

```powershell
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
curl.exe -s -o probe.wav -w "status=%{http_code} type=%{content_type}`n" `
  -X POST http://localhost:5173/agent/v1/tts `
  -H "content-type: application/json" `
  -H "x-client-token: <你的 AMSG_CLIENT_TOKEN>" `
  -d '{\"text\":\"你回来啦。\",\"emotion\":\"happy\"}'
```

Expected: `status=200 type=audio/wav`，且 `probe.wav` 前 4 字节是 `RIFF`。

**若返回 401/403**：说明 `x-client-token` 头名不对——去 `worker/main-agent/src/index.js` 的 `checkAuth` 确认它读的是哪个头（可能是 `Authorization: Bearer` 或 `x-agent-token`），改成真实那个。

**若返回 502**：`GENIE_SPEAK_URL` 指向的 9882 不通。跑 `curl -X POST http://<vps>:9882/speak`（VPS 本机则是 `127.0.0.1:9882`）确认适配层活着。

- [ ] **Step 3: 验情绪切换在线上链路生效**

重复 Step 2 两次，`emotion` 分别填 `calm` 与 `angry`，比对两个 wav 的字节长度。预期**长度不同**（不同参考音频 → 不同韵律 → 长度不同）。若完全相同，说明 `emotions.json` 没被读到或 `emo-angry.wav` 缺失。

- [ ] **Step 4: 清理探针文件**

```powershell
Remove-Item probe.wav -ErrorAction SilentlyContinue
```

- [ ] **Step 5: 提交**

```bash
git add vite.config.ts
git commit -m "chore(vite): dev proxy for /agent so localhost can reach VPS TTS"
```

---

## 完成判据

阶段 A 全部满足才算完成：

1. Task 1 Step 7-11 的冒烟用例全 PASS，`VmHWM` ≤ 5G
2. `pnpm vitest run utils/ttsRouter utils/ttsProvider utils/genieTts worker/main-agent` 全绿
3. `npx tsc --noEmit` 对 `types.ts` / `utils/ttsProvider.ts` / `utils/ttsRouter.ts` / `utils/genieTts.ts` 零命中
4. `pnpm vitest run utils/mojibakeGuard.test.ts` 绿 + U+FFFD 字节扫零
5. `worker/main-agent/worker.bundle.js` 含 `v1/tts`
6. localhost 端到端返回 200 + 合法 WAV，且两种情绪的音频不同
7. **Phase B 未开始**（设置页仍显示三家 provider，这是预期）

## 阶段 A 不做的事

- 设置页第四个选项、角色页试听（Phase B）
- `voice.genie` 提示词指南及 8 处接线（Phase B）
- `DateSession.tsx:352` 缓存键修正（Phase B；本期 Task 1 Step 9 只验适配层层面情绪确实不同）
- `ttsCache.ts` 让 Genie 跳过共享缓存（Phase B）
- Chat/Call 下载文件后缀 `.wav`（Phase B）
- Capacitor APK 走 `agentUrl` 直连（Phase B）
