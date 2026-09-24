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
import http.client
import json
import os
import re
import sys
import tempfile
import threading
import time
import socket
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
STOP_CALL_TIMEOUT = 10.0
STOP_RETRIES = 3
WATCHDOG_CLEANUP_WAIT = 35.0

_SYNTH_LOCK = threading.Lock()
_READY = threading.Event()
_PENDING_TASKS = 0
_PENDING_LOCK = threading.Lock()
_POISON_LOCK = threading.Lock()
_POISONED = False
_STOP_LOCK = threading.Lock()
_STOP_OWNER_LOCK = threading.Lock()
_STOP_CLAIMED = False
_DEADLINE_FIRED = threading.Event()
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT_SOCK = None


class SpeakBusy(Exception):
    """队列已满。"""


class LockTimeout(Exception):
    """等锁超时。"""


class SynthesisTimeout(Exception):
    """合成本身超时（含任一分块）。"""


class EmptyText(Exception):
    """输入文本为空。"""


class ChunkTooLong(Exception):
    """单个文本分块超过长度限制。"""


class TooManyChunks(Exception):
    """文本分块数量超过上限。"""


class ReferenceMissing(Exception):
    """参考音频缺失。"""


class ServiceUnready(Exception):
    """服务不可用：已毒化，需要重启进程才能恢复。"""


class _GenieHTTPError(http.client.HTTPException):
    """Genie HTTP 响应携带的状态码异常。"""

    def __init__(self, code: int):
        self.code = code
        super().__init__(f"Genie HTTP {code}")


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
        raise EmptyText()

    matches = re.finditer(
        r"[^。！？；!?;\n]*[。！？；!?;\n]|[^。！？；!?;\n]+$", text
    )

    chunks: list[str] = []
    buf = ""
    found = False

    def flush() -> None:
        nonlocal buf
        if buf.strip():
            if len(chunks) >= CHUNK_MAX_COUNT:
                raise TooManyChunks()
            chunks.append(buf)
        buf = ""

    for m in matches:
        part = m.group(0)
        found = True
        if len(part) > CHUNK_MAX_CHARS:
            raise ChunkTooLong()
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

    if not found or not chunks:
        raise EmptyText()
    if len(chunks) > CHUNK_MAX_COUNT:
        raise TooManyChunks()
    return chunks


def _abort_inflight_response() -> None:
    """强制打断当前在途的本地 HTTP 请求，让阻塞中的读立刻返回。

    只 close() 唤醒不了另一个线程里阻塞的 recv：内核不会因为同一进程里
    另一个线程 close(fd) 就立刻把那次 recv 叫醒。必须先 shutdown(SHUT_RDWR)，
    让对端 FIN/RST 到达、那次读返回错误或 0 字节，再 close 释放 fd。
    shutdown 失败也不意味着请求会挂住：读仍受 settimeout(resp_left) 约束，
    且调用方随后照样会调 _stop_genie_safely()，TTSPlayer 状态不会被漏掉。
    """
    with _INFLIGHT_LOCK:
        sock = _INFLIGHT_SOCK
    if sock is None:
        return
    try:
        sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        sock.close()
    except OSError:
        pass


def _genie_post(path: str, payload: dict, timeout: float) -> bytes:
    global _INFLIGHT_SOCK
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "content-length": str(len(body)),
    }
    deadline = time.monotonic() + timeout
    conn = http.client.HTTPConnection(HOST, PORT, timeout=timeout)
    # 边界说明：timeout 参数会经 socket.create_connection 应用到 sock.connect()，
    # 调用方传的是 remaining(cap)，由本次 deadline 派生。所以建连阶段和读响应头
    # 阶段本来就受 socket timeout 约束、不会越过 deadline；看门狗的 socket abort
    # 是在此之上的额外强制打断，不是唯一的边界。
    try:
        conn.connect()
        # 建连后立刻登记底层 socket：连响应头都还没到的阶段也能被 deadline 打断。
        with _INFLIGHT_LOCK:
            _INFLIGHT_SOCK = conn.sock
        left = deadline - time.monotonic()
        if left <= 0:
            raise SynthesisTimeout()
        if conn.sock is not None:
            # 必须在 conn.request() 之前设置：写请求体也要受本次剩余时间约束，
            # 否则它用的还是构造连接时的旧 timeout。
            conn.sock.settimeout(left)
        conn.request("POST", path, body=body, headers=headers)
        resp = conn.getresponse()
        if conn.sock is not None:
            resp_left = deadline - time.monotonic()
            if resp_left <= 0:
                raise SynthesisTimeout()
            conn.sock.settimeout(resp_left)
        if resp.status >= 400:
            raise _GenieHTTPError(resp.status)
        return resp.read()
    except TimeoutError as exc:
        raise SynthesisTimeout() from exc
    finally:
        with _INFLIGHT_LOCK:
            if _INFLIGHT_SOCK is conn.sock:
                _INFLIGHT_SOCK = None
        try:
            conn.close()
        except OSError:
            pass


def _tts_completed_pcm(chunk: str, timeout: float) -> bytes:
    """合成一个分块，返回裸 PCM。

    必须借 save_path 判定成功：Genie 的 Server.run_tts_in_background 会吞掉推理异常
    （只发结束标记），而 HTTP 200 在进入后台前就已发出。只看状态码会把"半截音频"
    当成功返回。用 save_path 则只有 TTSPlayer 真正处理完才会写出完整 WAV。
    """
    fd, path = tempfile.mkstemp(prefix="genie-chunk-", suffix=".wav")
    os.close(fd)
    call_deadline = time.monotonic() + timeout
    try:
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
            if time.monotonic() >= call_deadline:
                raise SynthesisTimeout()
        except (
            TimeoutError,
            SynthesisTimeout,
            http.client.HTTPException,
            ConnectionError,
        ):
            # 连接侧与读侧失败（IncompleteRead / RemoteDisconnected / ConnectionReset 等）
            # 都不会取消 Genie 的后台任务：必须先停掉再让上层释放锁，否则下一个请求
            # 会重置 TTSPlayer 全局队列，复现最初的挂死+垃圾音频。
            # _genie_post 会把 socket 超时转换成 SynthesisTimeout，因此也需在此接住。
            if _claim_stop():
                _stop_genie_safely("tts transport failure")
            raise
        if not os.path.isfile(path) or os.path.getsize(path) <= 44:
            raise RuntimeError("incomplete genie output")
        with wave.open(path, "rb") as wf:
            actual = (wf.getnchannels(), wf.getsampwidth(), wf.getframerate())
            if actual != (CHANNELS, BYTES_PER_SAMPLE, SAMPLE_RATE):
                raise RuntimeError("unexpected genie wav format")
            frames = wf.getnframes()
            expected = frames * wf.getnchannels() * wf.getsampwidth()
            pcm = wf.readframes(frames)
            if expected <= 0 or len(pcm) != expected:
                raise RuntimeError("truncated genie wav")
        if not pcm:
            raise RuntimeError("empty genie pcm")
        return pcm
    finally:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass
        except OSError:
            pass


def _synthesize(text: str, emotion: str, deadline: float) -> tuple[bytes, str]:
    global _STOP_CLAIMED
    _DEADLINE_FIRED.clear()
    _STOP_CLAIMED = False

    finished = threading.Event()
    watchdog_done = threading.Event()

    def _watchdog() -> None:
        try:
            # 按已保存的 deadline 算剩余时间，而不是从本线程启动那一刻起算
            # SYNTH_TIMEOUT，否则线程调度延迟会叠加到严格上限之外。
            left = max(0.0, deadline - time.monotonic())
            if finished.wait(left):
                return
            _DEADLINE_FIRED.set()
            print("[genie] deadline reached; aborting socket", file=sys.stderr, flush=True)
            # 先打断读，deadline 才立得住；stop 放在后面做清理。
            _abort_inflight_response()
            if _claim_stop():
                _stop_genie_safely("deadline reached")
        finally:
            watchdog_done.set()

    watchdog = threading.Thread(target=_watchdog, daemon=True)
    watchdog.start()

    def remaining(cap: float) -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise SynthesisTimeout()
        return min(cap, left)

    try:
        resolved, entry = _resolve_emotion(emotion)
        wav_path = os.path.join(REFS_DIR, entry["wav"])
        if not os.path.isfile(wav_path):
            raise FileNotFoundError(wav_path)
        remaining(0.001)

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
        remaining(0.001)

        chunks = _split_text(text)
        remaining(0.001)
        pcm = bytearray()
        for chunk in chunks:
            chunk_pcm = _tts_completed_pcm(chunk, timeout=remaining(SYNTH_TIMEOUT))
            remaining(0.001)
            pcm.extend(chunk_pcm)
            remaining(0.001)
        if not pcm:
            raise RuntimeError("empty pcm")
        remaining(0.001)
        wav = _wrap_pcm_as_wav(bytes(pcm))
        remaining(0.001)
        return wav, resolved
    except _GenieHTTPError as exc:
        code = exc.code
        if code == 404:
            raise ReferenceMissing() from exc
        if code in (408, 504):
            if _claim_stop():
                _stop_genie_safely(f"Genie HTTP {code}")
            raise SynthesisTimeout() from exc
        raise RuntimeError(f"Genie HTTP {code}") from exc
    except SynthesisTimeout:
        # remaining() 可能在 /tts 返回后抛出，此时 Genie 可能仍在收尾。
        # 但若看门狗已经接手停机，就不要跟它抢 _STOP_LOCK。
        if _claim_stop():
            _stop_genie_safely("SynthesisTimeout")
        raise
    except (OSError, http.client.HTTPException) as exc:
        # 看门狗 abort socket 后，主线程的读会抛这些传输异常。deadline 已触发时，
        # 它们就是超时的一部分，必须映射成 synth_timeout；否则会落到端点的兜底
        # 分支变成 500 synth_failed，破坏调用方依赖的错误码契约。
        # 注意本分支必须排在 except _GenieHTTPError 之后：_GenieHTTPError 是
        # http.client.HTTPException 的子类，顺序反了会把 404/504 映射吃掉。
        if _DEADLINE_FIRED.is_set():
            raise SynthesisTimeout() from exc
        raise
    finally:
        finished.set()
        # 关键：绝不能在看门狗还可能去调 genie.stop() / close socket 时就返回，
        # 否则它会误伤已经拿到锁的下一个请求。等不到就毒化并让本次失败。
        if not watchdog_done.wait(WATCHDOG_CLEANUP_WAIT):
            _mark_poisoned("watchdog cleanup did not finish in time")
            raise SynthesisTimeout()


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


def _mark_poisoned(reason: str) -> None:
    """标记 TTSPlayer 状态不可信：此后不再放行任何请求，直到进程重启。"""
    global _POISONED
    with _POISON_LOCK:
        _POISONED = True
    print(
        f"[genie] POISONED: {reason}; restart genie-tts required",
        file=sys.stderr,
        flush=True,
    )


def _is_poisoned() -> bool:
    with _POISON_LOCK:
        return _POISONED


def _try_genie_stop(timeout: float) -> str:
    """在有界时间内调一次 genie.stop()。

    返回 "ok"（正常返回）、"raised"（抛了异常）、"hung"（超时仍未返回）。
    三种必须分开：抛异常说明 stop 内部炸了，卡死说明它根本不理人，运维要查的
    方向完全不同，日志不能把两者混成同一句。

    故意放进独立线程再 join：genie.stop() 自己没有超时，永久阻塞时我们不能
    被它拖住。放弃等待并毒化，好过无限期占着 _SYNTH_LOCK。
    """
    outcome: list[bool] = []

    def runner() -> None:
        try:
            genie.stop()
            outcome.append(True)
        except Exception as exc:  # noqa: BLE001
            print(f"[genie] genie.stop() raised: {exc!r}", file=sys.stderr, flush=True)
            outcome.append(False)

    worker = threading.Thread(target=runner, daemon=True)
    worker.start()
    worker.join(timeout)
    if not outcome:
        return "hung"
    return "ok" if outcome[0] else "raised"


def _claim_stop() -> bool:
    """原子认领本次合成的停机责任。返回 True 表示只有调用者该执行 genie.stop()。

    单看 _DEADLINE_FIRED.is_set() 再取 _STOP_LOCK 不是原子的：看门狗和请求线程
    都可能判定「该停了」并各调一次 genie.stop()。同一时刻只有一个合成在跑
    （_SYNTH_LOCK 保证），所以用一个模块级标志做一次性认领即可。
    """
    global _STOP_CLAIMED
    with _STOP_OWNER_LOCK:
        if _STOP_CLAIMED:
            return False
        _STOP_CLAIMED = True
        return True


def _stop_genie_safely(reason: str) -> bool:
    """停掉 Genie 后台 TTS。True = 已确认停；False = 无法确认，调用方须毒化。

    请求线程、看门狗线程、warmup 线程都可能调用，因此只用独立的 _STOP_LOCK
    串行化，绝不去拿 _SYNTH_LOCK（看门狗拿不到，warmup 也没持锁）。

    只有"抛异常"才重试：那种情况 runner 已经退出，重试是安全的。
    "卡死未返回"绝不能重试——上一个 runner 还卡在 TTSPlayer 内部，再起一个
    只会让多个 genie.stop() 并发操作同一个单例。遇到卡死直接毒化。
    """
    with _STOP_LOCK:
        for attempt in range(1, STOP_RETRIES + 1):
            status = _try_genie_stop(STOP_CALL_TIMEOUT)
            if status == "ok":
                return True
            if status == "hung":
                print(
                    f"[genie] genie.stop() hung on attempt {attempt}; not retrying",
                    file=sys.stderr,
                    flush=True,
                )
                _mark_poisoned(f"genie.stop() hung: {reason}")
                return False
            print(
                f"[genie] genie.stop() attempt {attempt}/{STOP_RETRIES} raised an exception",
                file=sys.stderr,
                flush=True,
            )
    _mark_poisoned(f"genie.stop() failed: {reason}")
    return False


def _speak_with_guard(text: str, emotion: str) -> tuple[bytes, str]:
    if _is_poisoned():
        # TTSPlayer 状态不可信，放行任何请求都会重演最初的挂死+垃圾音频。
        # 复用已锁定的 warming_up 错误码，不新增契约里的码。
        raise ServiceUnready()
    if not _acquire_slot():
        raise SpeakBusy()
    # 绝对 deadline 从请求入口起算，必须包含等锁时间。等锁发生在 _synthesize 之前，
    # 若 deadline 留在 _synthesize 内部创建，5 秒锁等待就会叠加在 120 秒之外，
    # 服务端上界变成 5+120+stop，与客户端预算之间没有任何余量。
    deadline = time.monotonic() + SYNTH_TIMEOUT
    try:
        left = deadline - time.monotonic()
        if left <= 0:
            raise SynthesisTimeout()
        acquired = _SYNTH_LOCK.acquire(timeout=min(LOCK_WAIT_TIMEOUT, left))
        if not acquired:
            if deadline - time.monotonic() <= 0:
                raise SynthesisTimeout()
            raise LockTimeout()
        try:
            if _is_poisoned():
                # 等锁期间服务可能被毒化：拿到锁必须复查，否则会重演最初的故障。
                raise ServiceUnready()
            return _synthesize(text, emotion, deadline)
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

    text = payload.get("text")
    emotion = payload.get("emotion")
    if not isinstance(text, str) or not text.strip():
        return JSONResponse(status_code=400, content={"error": "empty"})
    if emotion is not None and not isinstance(emotion, str):
        return JSONResponse(status_code=400, content={"error": "bad_emotion"})

    if not _READY.is_set():
        return JSONResponse(status_code=503, content={"error": "warming_up"})

    try:
        # 合成是阻塞的（最长 120 秒），必须放线程池，否则会堵住整个事件循环。
        wav, resolved = await run_in_threadpool(_speak_with_guard, text, emotion)
    except SpeakBusy:
        return JSONResponse(status_code=503, content={"error": "busy"})
    except ServiceUnready:
        return JSONResponse(status_code=503, content={"error": "warming_up"})
    except LockTimeout:
        return JSONResponse(status_code=504, content={"error": "lock_timeout"})
    except SynthesisTimeout:
        return JSONResponse(status_code=504, content={"error": "synth_timeout"})
    except EmptyText:
        return JSONResponse(status_code=400, content={"error": "empty"})
    except ChunkTooLong:
        return JSONResponse(status_code=413, content={"error": "chunk_too_long"})
    except TooManyChunks:
        return JSONResponse(status_code=413, content={"error": "too_many_chunks"})
    except ReferenceMissing:
        return JSONResponse(status_code=500, content={"error": "reference_missing"})
    except FileNotFoundError:
        return JSONResponse(status_code=500, content={"error": "reference_missing"})
    except Exception as exc:
        print(f"[genie] synthesis failed: {exc}", file=sys.stderr, flush=True)
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
            ref_path = os.path.join(REFS_DIR, entry["wav"])
            if not os.path.isfile(ref_path):
                raise FileNotFoundError(ref_path)
            _genie_post(
                "/set_reference_audio",
                {
                    "character_name": CHARACTER,
                    "audio_path": ref_path,
                    "audio_text": entry["text"],
                    "language": LANGUAGE,
                },
                timeout=30.0,
            )
            probe_pcm = _tts_completed_pcm("你好。", timeout=60.0)
            if not probe_pcm:
                raise RuntimeError("empty warmup probe pcm")
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
