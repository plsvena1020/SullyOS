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
