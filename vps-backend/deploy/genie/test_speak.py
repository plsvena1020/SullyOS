"""适配层冒烟测试。部署后在 VPS 上跑：/opt/genie-tts/venv/bin/python test_speak.py

注意：Genie 的 ONNX 图含采样随机性，同一输入的输出长度/哈希每次都不同。
（实测 13 字文本连跑三次：135680 / 151040 / 120320 字节）
所以只能用时长区间与"至少一次不同"来断言，不能逐字节比较。
"""
import json
import sys
import threading
import time
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


def parse_error(body):
    """从错误响应体里取 {"error": "<code>"}。取不到就返回 None。"""
    try:
        return json.loads(body.decode("utf-8", "replace")).get("error")
    except Exception:
        return None


def _raises(fn, expected_type) -> bool:
    try:
        fn()
        return False
    except ValueError:
        return False
    except expected_type:
        return True


def run_threaded(payloads):
    """并发执行。每个线程把结果写进自己的 Result，不允许异常逃逸导致 KeyError。"""
    outs = [Result() for _ in payloads]
    barrier = threading.Barrier(len(payloads))

    def worker(payload, out):
        try:
            barrier.wait(timeout=20)
            status, body, emotion = post(payload, timeout=180)
            out.status, out.body, out.emotion = status, body, emotion
            if status is not None and status != 200:
                # HTTPError 不会走 except，错误码在响应体里，必须单独取出来，
                # 否则没法区分 busy / lock_timeout / synth_timeout。
                out.error = parse_error(body)
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
    from genie_server import (
        ChunkTooLong,
        TooManyChunks,
        _split_text as split_text,
    )

    sample = "好的。" + "啊" * 100
    parts = split_text(sample)
    ok &= check(
        "split_exact_two_chunks",
        len(parts) == 2 and "".join(parts) == sample,
        f"chunks={len(parts)} sizes={[len(p) for p in parts]}",
    )
    ok &= check(
        "split_no_punctuation_300_raises",
        _raises(lambda: split_text("啊" * 300), ChunkTooLong),
        "",
    )
    ok &= check(
        "split_typed_error_not_value_error",
        _raises(lambda: split_text("啊" * 300), ChunkTooLong),
        "",
    )
    # 30 个 61 字分片可稳定触发第 21 块；简报中的 200 字前缀会先命中 chunk_too_long。
    ok &= check(
        "split_too_many_chunks_raises",
        _raises(lambda: split_text(("啊" * 60 + "。") * 30), TooManyChunks),
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

    # 6 三条并发：第 3 条必须 503 busy（队列上限 2）。另两条要么 200，要么在
    #    等锁超过 LOCK_WAIT_TIMEOUT=5.0s 时按设计返回 504 lock_timeout——合成耗时
    #    3.4s 时余量只有 1.5s，内存压力下偶尔越线，属规格内行为。
    #    绝不允许 synth_timeout：那意味着 120s 上限被突破，是真 bug。
    outs3 = run_threaded([{"text": SENTENCE, "emotion": "calm"},
                          {"text": SENTENCE, "emotion": "happy"},
                          {"text": SENTENCE, "emotion": "sad"}])
    codes = sorted(o.status for o in outs3)
    busy = [o for o in outs3 if o.status == 503]
    admitted = [o for o in outs3 if o.status != 503]
    ok &= check(
        "triple_exactly_one_busy",
        len(busy) == 1 and busy[0].error == "busy" and len(admitted) == 2,
        f"codes={codes} busy_errors={[o.error for o in busy]}",
    )
    ok &= check(
        "triple_admitted_200_or_lock_timeout",
        all(
            o.status == 200 or (o.status == 504 and o.error == "lock_timeout")
            for o in admitted
        )
        and sum(o.status == 200 for o in admitted) >= 1,
        f"codes={codes} admitted={[(o.status, o.error) for o in admitted]}",
    )
    ok &= check(
        "triple_never_synth_timeout",
        all(o.error != "synth_timeout" for o in outs3),
        f"codes={codes} errors={[(o.status, o.error) for o in outs3]}",
    )

    # 6b 长文本必然超过 5s 锁等待：把"第二个请求按设计 504 lock_timeout"钉成
    #    确定断言，不再依赖短文本的运气。
    LONG = SENTENCE * 5
    outs_long = run_threaded([{"text": LONG, "emotion": "calm"},
                              {"text": LONG, "emotion": "happy"},
                              {"text": LONG, "emotion": "sad"}])
    long_codes = sorted(o.status for o in outs_long)
    ok &= check(
        "long_text_lock_timeout",
        sorted((o.status, o.error) for o in outs_long)
        == [(200, None), (503, "busy"), (504, "lock_timeout")],
        f"codes={long_codes} errors={[(o.status, o.error) for o in outs_long]}",
    )

    # 7 stop 自身失败必须毒化服务：之后所有请求 503 warming_up，直到进程重启
    def poison_blocks_new_requests():
        genie_server._POISONED = False
        orig_stop = genie_server.genie.stop

        def boom():
            raise RuntimeError("stop unavailable")

        genie_server.genie.stop = boom
        try:
            stopped = genie_server._stop_genie_safely("test")
            poisoned = genie_server._is_poisoned()
            raised = _raises(
                lambda: genie_server._speak_with_guard("测试", "calm", time.monotonic() + genie_server.SYNTH_TIMEOUT), genie_server.ServiceUnready
            )
            return (not stopped) and poisoned and raised
        finally:
            genie_server.genie.stop = orig_stop
            genie_server._POISONED = False

    ok &= check("stop_failure_poisons_service", poison_blocks_new_requests(), "")

    # 8 看门狗必须真的在 deadline 时刻把阻塞的等待唤醒，而不是等主线程自己返回
    def watchdog_interrupts_before_post_returns():
        orig_post = genie_server._genie_post
        orig_timeout = genie_server.SYNTH_TIMEOUT
        orig_stop = genie_server.genie.stop
        stop_times = []
        gate = threading.Event()

        def blocking_post(path, payload, timeout):
            # 模拟 resp.read()：只有在 stop 生效后才返回，最长等 10 秒
            gate.wait(10.0)
            return b""

        def rec_stop():
            stop_times.append(time.monotonic())
            gate.set()

        genie_server._genie_post = blocking_post
        genie_server.genie.stop = rec_stop
        genie_server.SYNTH_TIMEOUT = 1.0
        genie_server._POISONED = False
        try:
            started = time.monotonic()
            deadline = time.monotonic() + genie_server.SYNTH_TIMEOUT
            raised = _raises(
                lambda: genie_server._synthesize("测试。", "calm", deadline),
                genie_server.SynthesisTimeout,
            )
            elapsed = time.monotonic() - started
            # 没有看门狗的话这里要睡满 10 秒；stop 在 2 秒前发生只可能是看门狗干的。
            return raised and bool(stop_times) and stop_times[0] - started < 2.0
        finally:
            genie_server._genie_post = orig_post
            genie_server.genie.stop = orig_stop
            genie_server.SYNTH_TIMEOUT = orig_timeout
            genie_server._POISONED = False
            genie_server._STOP_CLAIMED = False

    ok &= check("watchdog_stops_at_deadline", watchdog_interrupts_before_post_returns(), "")

    # 9 等锁期间被毒化的请求，拿到锁后必须被拒绝
    def poison_during_lock_wait_blocks_admission():
        genie_server._POISONED = False
        result: list[str] = []

        def waiter():
            try:
                genie_server._speak_with_guard("测试", "calm", time.monotonic() + genie_server.SYNTH_TIMEOUT)
                result.append("admitted")
            except genie_server.ServiceUnready:
                result.append("blocked")
            except Exception as exc:  # noqa: BLE001
                result.append(f"other:{exc!r}")

        genie_server._SYNTH_LOCK.acquire()
        worker = threading.Thread(target=waiter)
        worker.start()
        time.sleep(0.5)  # 让 waiter 走完前置检查并阻塞在锁上
        genie_server._mark_poisoned("test")
        genie_server._SYNTH_LOCK.release()
        worker.join(20)
        genie_server._POISONED = False
        return result == ["blocked"]

    ok &= check("poison_during_lock_wait_blocked", poison_during_lock_wait_blocks_admission(), "")

    # 10 真实 socket：服务端建连后永不响应，证明 abort 真的能唤醒阻塞中的读，
    #    且 socket 在响应头到达之前就已被登记。
    def real_socket_abort_wakes_blocked_read():
        import http.server

        class Hang(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                time.sleep(30)  # 建连后不写任何响应头

            def log_message(self, *args):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Hang)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        orig_host = genie_server.HOST
        orig_port = genie_server.PORT
        outcome = []
        try:
            genie_server.HOST = "127.0.0.1"
            genie_server.PORT = port

            def caller():
                try:
                    genie_server._genie_post("/set_reference_audio", {"text": "x"}, 30.0)
                    outcome.append("returned")
                except BaseException as exc:  # noqa: BLE001
                    outcome.append(f"raised:{type(exc).__name__}")

            worker = threading.Thread(target=caller, daemon=True)
            worker.start()
            time.sleep(0.5)  # 让它完成建连并阻塞在读响应头上
            registered = genie_server._INFLIGHT_SOCK is not None
            genie_server._abort_inflight_response()
            worker.join(5)
            # socket timeout 给的是 30 秒，所以能在 5 秒内退出只可能是 abort 生效
            return registered and len(outcome) == 1 and outcome[0] != "returned"
        finally:
            genie_server.HOST = orig_host
            genie_server.PORT = orig_port
            genie_server._INFLIGHT_SOCK = None
            srv.shutdown()

    ok &= check("socket_abort_wakes_blocked_read", real_socket_abort_wakes_blocked_read(), "")

    # 11 端到端：真实 _synthesize + 真实 hang server，由 watchdog 按绝对 deadline
    #     自动 abort，主读线程必须远早于 server 的 30 秒 timeout 退出。
    #     这条同时覆盖前面的 watchdog 测试和 socket 测试各自覆盖的那一半。
    def watchdog_drives_real_socket_abort():
        import http.server

        class HangHeaders(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                # 故意不回任何响应头，让客户端阻塞在读响应头上
                time.sleep(30)

            def log_message(self, *args):
                pass

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HangHeaders)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()

        orig_host = genie_server.HOST
        orig_port = genie_server.PORT
        orig_timeout = genie_server.SYNTH_TIMEOUT
        orig_stop = genie_server.genie.stop
        stop_calls = []
        try:
            genie_server.HOST = "127.0.0.1"
            genie_server.PORT = port
            genie_server.SYNTH_TIMEOUT = 1.0
            genie_server.genie.stop = lambda: stop_calls.append(1)
            genie_server._POISONED = False

            started = time.monotonic()
            deadline = time.monotonic() + genie_server.SYNTH_TIMEOUT
            # 不手动 abort：完全交给 watchdog 的绝对 deadline
            raised = _raises(
                lambda: genie_server._synthesize("测试。", "calm", deadline),
                genie_server.SynthesisTimeout,
            )
            elapsed = time.monotonic() - started
            # 1.0s 的 SYNTH_TIMEOUT 同时决定了客户端 socket timeout 和看门狗的
            # 触发时刻，两者都在 1 秒附近；上限放到 20 秒是为了证明「确实退出了」
            # 且「watchdog 真的调过 stop」，而不是去区分是谁先到的。
            return raised and elapsed < 20.0 and len(stop_calls) >= 1
        finally:
            genie_server.HOST = orig_host
            genie_server.PORT = orig_port
            genie_server.SYNTH_TIMEOUT = orig_timeout
            genie_server.genie.stop = orig_stop
            genie_server._POISONED = False
            genie_server._INFLIGHT_SOCK = None
            genie_server._DEADLINE_FIRED.clear()
            genie_server._STOP_CLAIMED = False
            srv.shutdown()

    ok &= check("watchdog_drives_real_socket_abort", watchdog_drives_real_socket_abort(), "")

    def request_deadline_includes_lock_wait():
        orig_timeout = genie_server.SYNTH_TIMEOUT
        orig_poisoned = genie_server._POISONED
        try:
            genie_server._POISONED = False
            genie_server.SYNTH_TIMEOUT = 0.01
            genie_server._SYNTH_LOCK.acquire()
            try:
                return _raises(
                    lambda: genie_server._speak_with_guard("x", "calm", time.monotonic() + genie_server.SYNTH_TIMEOUT),
                    genie_server.SynthesisTimeout,
                )
            finally:
                genie_server._SYNTH_LOCK.release()
        finally:
            genie_server.SYNTH_TIMEOUT = orig_timeout
            genie_server._POISONED = orig_poisoned

    ok &= check("request_deadline_includes_lock_wait", request_deadline_includes_lock_wait(), "")

    def stop_claim_is_one_shot():
        orig_claim = genie_server._STOP_CLAIMED
        try:
            genie_server._STOP_CLAIMED = False
            first = genie_server._claim_stop()
            second = genie_server._claim_stop()
            return first and not second
        finally:
            genie_server._STOP_CLAIMED = orig_claim

    ok &= check("stop_claim_is_one_shot", stop_claim_is_one_shot(), "")

    def validation_precedes_readiness():
        import asyncio

        class JsonRequest:
            async def json(self):
                return {"text": "   ", "emotion": "calm"}

        genie_server._READY.clear()
        try:
            response = asyncio.run(genie_server.speak_endpoint(JsonRequest()))
            body = json.loads(response.body.decode("utf-8"))
            return response.status_code == 400 and body.get("error") == "empty"
        finally:
            genie_server._READY.set()

    ok &= check("validation_precedes_readiness", validation_precedes_readiness(), "")

    # 9 deadline 之前的裸 OSError 也必须先停 Genie 再放锁。
    #    旧实现在 _tts_completed_pcm 只捕获 (OSError 子类, SynthesisTimeout, HTTPException)，
    #    裸 OSError 会漏到上层，而上层只在 deadline 已触发时才停机——锁照样被释放，
    #    TTSPlayer 可能仍在跑，下个请求就会重置它的全局队列。
    def bare_oserror_triggers_stop():
        orig_post = genie_server._genie_post
        orig_stop = genie_server.genie.stop
        calls = []

        def raise_oserror(*args, **kwargs):
            raise OSError(105, "No buffer space available")

        genie_server._genie_post = raise_oserror
        genie_server.genie.stop = lambda: calls.append(1)
        genie_server._STOP_CLAIMED = False
        genie_server._DEADLINE_FIRED.clear()
        try:
            try:
                genie_server._tts_completed_pcm("测试", 1.0)
                return False
            except OSError:
                return len(calls) == 1
        finally:
            genie_server._genie_post = orig_post
            genie_server.genie.stop = orig_stop
            genie_server._STOP_CLAIMED = False
            genie_server._DEADLINE_FIRED.clear()

    ok &= check("bare_oserror_triggers_stop", bare_oserror_triggers_stop(), "")

    # 10 stop 重试的耗时应与 stop 实际耗时成正比，而不是吃满 join 上限。
    #     STOP_RETRIES=3 x STOP_CALL_TIMEOUT=10 看着像 30 秒，但抛异常的尝试会立即
    #     退出 runner 并写入 outcome，join 随即返回——10 秒只在 hung 时被吃掉，
    #     而 hung 不重试。这条把该性质钉住，防止有人日后改成真的睡满 10 秒。
    def stop_retry_budget_is_proportional():
        orig_stop = genie_server.genie.stop

        def slow_raise():
            time.sleep(0.2)
            raise RuntimeError("slow stop unavailable")

        genie_server.genie.stop = slow_raise
        genie_server._STOP_CLAIMED = False
        genie_server._POISONED = False
        try:
            started = time.monotonic()
            genie_server._stop_genie_safely("test")
            elapsed = time.monotonic() - started
            return elapsed < 2.0
        finally:
            genie_server.genie.stop = orig_stop
            genie_server._POISONED = False

    ok &= check("stop_retry_budget_is_proportional", stop_retry_budget_is_proportional(), "")


    # 12 输出校验失败必须恰好触发一次 stop。
    #     /tts 返回 200 但 save_path 没写成合法 WAV，此时后台 TTSPlayer 可能仍没收尾；
    #     若直接放锁，下一个请求会重置它的全局队列。旧测试只断言抛 RuntimeError，
    #     那是 mock 行为断言，不是生命周期契约。
    def output_validation_failure_stops_genie():
        orig_post = genie_server._genie_post
        orig_stop = genie_server.genie.stop
        calls = []

        # 返回 200 但不写盘：mkstemp 留下的是 0 字节文件，必然校验失败
        genie_server._genie_post = lambda *a, **k: b""
        genie_server.genie.stop = lambda: calls.append(1)
        genie_server._STOP_CLAIMED = False
        genie_server._DEADLINE_FIRED.clear()
        try:
            try:
                genie_server._tts_completed_pcm("测试", 1.0)
                return False
            except RuntimeError as exc:
                return str(exc) == "incomplete genie output" and len(calls) == 1
        finally:
            genie_server._genie_post = orig_post
            genie_server.genie.stop = orig_stop
            genie_server._STOP_CLAIMED = False
            genie_server._DEADLINE_FIRED.clear()

    ok &= check("output_validation_failure_stops_genie", output_validation_failure_stops_genie(), "")

    # 13 stop 的重试共享一个总预算。
    #     单次「在单次上限内抛异常」可以耗时接近该上限；若无总预算，三次相加
    #     就接近 3 倍，足以让整个响应越过客户端预算。这里把两者都调小来快速验证。
    def stop_total_budget_is_enforced():
        orig_stop = genie_server.genie.stop
        orig_budget = genie_server.STOP_TOTAL_BUDGET
        orig_per_try = genie_server.STOP_CALL_TIMEOUT

        def slow_raise():
            time.sleep(0.30)
            raise RuntimeError("slow stop unavailable")

        genie_server.genie.stop = slow_raise
        genie_server.STOP_TOTAL_BUDGET = 0.45
        genie_server.STOP_CALL_TIMEOUT = 0.40
        genie_server._STOP_CLAIMED = False
        genie_server._POISONED = False
        try:
            started = time.monotonic()
            genie_server._stop_genie_safely("test")
            elapsed = time.monotonic() - started
            # 预算 0.45s、单次 0.30s：最多跑两次（0.6s > 0.45 会在第二次前被截断），
            # 绝不能跑满三次的 0.9s。
            return elapsed < 0.75
        finally:
            genie_server.genie.stop = orig_stop
            genie_server.STOP_TOTAL_BUDGET = orig_budget
            genie_server.STOP_CALL_TIMEOUT = orig_per_try
            genie_server._POISONED = False

    ok &= check("stop_total_budget_is_enforced", stop_total_budget_is_enforced(), "")

    # 14 毒化后 warmup 必须跳过，不再 load_character。
    #     stop 卡死会毒化，而那个卡死的 runner 仍可能活在 TTSPlayer 内部；
    #     此时重入等于让它与旧 stop 并发操作同一单例。
    def warmup_skips_when_poisoned():
        orig_poisoned = genie_server._POISONED
        orig_sleep = time.sleep
        orig_load = genie_server.genie.load_character
        loaded = []
        genie_server._POISONED = True
        genie_server.genie.load_character = lambda *a, **k: loaded.append(1)
        time.sleep = lambda *a, **k: None
        try:
            genie_server._warmup()
            return loaded == []
        finally:
            genie_server._POISONED = orig_poisoned
            time.sleep = orig_sleep
            genie_server.genie.load_character = orig_load

    ok &= check("warmup_skips_when_poisoned", warmup_skips_when_poisoned(), "")

    print("ALL_PASS" if ok else "HAS_FAILURE", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
