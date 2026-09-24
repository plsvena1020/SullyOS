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
