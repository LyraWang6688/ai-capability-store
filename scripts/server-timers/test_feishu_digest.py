#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feishu-digest 的离线夹具测试：不联网、不碰飞书、不启真的 dsh。

它守的是这条链路上**唯一会静默出错**的地方：

- 额度/水位算错 → 同一天重复总结，或者新对话永远不进摘要；
- 把运行上下文当成「我」说的话 → 摘要里混进系统提示词；
- 没有新对话时仍然投递 → 收件箱被空记录刷屏；
- 总结失败却推进水位 → 那一段对话永久丢失。

跑法：

    python3 scripts/server-timers/test_feishu_digest.py

依赖只有 `zstd`（压缩夹具会话文件）—— CI 的 ubuntu-latest 自带。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "deliver", "feishu-digest.py")
SID = "session-fake-1"
ROOT = tempfile.mkdtemp(prefix="feishu-digest-fixture-")
BASE_MS = int(time.time() * 1000) - 3600_000  # 夹具时间取「1 小时前」，避开首次运行的窗口过滤

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else "  :: " + str(detail)))
    if cond:
        return
    fails.append(name)


def ev(seq, etype, data):
    return json.dumps({"type": etype, "seq": seq, "time": BASE_MS + seq * 1000, "data": data},
                      ensure_ascii=False)


def user(seq, text, kind="user"):
    return ev(seq, "user/message", {"content": [{"type": "text", "text": text}],
                                    "source": {"kind": kind}})


def answer(turn, seq, text):
    return ev(seq, "assistant/message", {"turn": turn, "step": 2,
              "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})


def write_session(events):
    directory = os.path.join(ROOT, ".dsh/sessions/--srv-dsh-jobs-work--", SID)
    os.makedirs(directory, exist_ok=True)
    target = os.path.join(directory, "session.v4.jsonl.zstd")
    if os.path.exists(target):
        os.remove(target)
    raw = ("\n".join(events) + "\n").encode()
    proc = subprocess.run(["zstd", "-q", "-f", "-o", target], input=raw, capture_output=True)
    if proc.returncode != 0:
        raise SystemExit("夹具压缩失败: " + proc.stderr.decode(errors="replace"))


def setup():
    shutil.rmtree(ROOT, ignore_errors=True)
    os.makedirs(os.path.join(ROOT, ".dsh-feishu-remote"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "fake"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "work"), exist_ok=True)

    # 桥的 state.json：一个私聊 → 一个 session
    with open(os.path.join(ROOT, ".dsh-feishu-remote/state.json"), "w", encoding="utf-8") as fh:
        json.dump({"sessions": {"oc_test": SID}}, fh)

    prompt_out = os.path.join(ROOT, "fake/prompt.txt")
    # 假执行后端：把收到的 prompt 落盘，并回一个固定摘要
    with open(os.path.join(ROOT, "fake/dsh"), "w", encoding="utf-8") as fh:
        fh.write("#!/bin/sh\n")
        fh.write('printf %s "$3" > "' + prompt_out + '"\n')
        fh.write('printf \'{"type":"final","text":"夹具摘要"}\\n\'\n')
    os.chmod(os.path.join(ROOT, "fake/dsh"), 0o755)

    # 假的投递：把参数逐行记下来
    with open(os.path.join(ROOT, "fake/inbox-deliver"), "w", encoding="utf-8") as fh:
        fh.write("#!/bin/sh\n")
        fh.write('printf "%s\\n" "$*" >> "' + os.path.join(ROOT, "fake/calls.log") + '"\n')
    os.chmod(os.path.join(ROOT, "fake/inbox-deliver"), 0o755)

    # 假的失败后端
    with open(os.path.join(ROOT, "fake/bad-dsh"), "w", encoding="utf-8") as fh:
        fh.write("#!/bin/sh\nexit 3\n")
    os.chmod(os.path.join(ROOT, "fake/bad-dsh"), 0o755)

    write_session([
        user(1, "运行时上下文，不该被当成我说话", kind="runtime-context"),
        user(2, "第一问：服务器还活着吗"),
        answer(1, 3, "第一答：活着"),
        ev(4, "turn/end", {"turn": 1}),
        user(5, "第二问：帮我看下日志"),
        answer(2, 6, "第二答：日志正常"),
        ev(7, "turn/end", {"turn": 2}),
    ])


def env(dsh=None):
    merged = dict(os.environ)
    merged.update({
        "HOME": ROOT,
        "DSH_FEISHU_REMOTE_DIR": os.path.join(ROOT, ".dsh-feishu-remote"),
        "DSH_SESSIONS_ROOT": os.path.join(ROOT, ".dsh/sessions"),
        "DSH_DIGEST_STATE": os.path.join(ROOT, "state/digest.json"),
        "DSH_DIGEST_LOG": os.path.join(ROOT, "logs/digest.log"),
        "DSH_CLI": dsh or os.path.join(ROOT, "fake/dsh"),
        "DSH_INBOX_DELIVER": os.path.join(ROOT, "fake/inbox-deliver"),
        "DSH_DIGEST_TASK": "feishu-digest",
    })
    return merged


def run(*args, dsh=None):
    proc = subprocess.run([sys.executable, SCRIPT, *args], env=env(dsh), capture_output=True, text=True)
    return proc.returncode, proc.stdout + proc.stderr


def calls():
    path = os.path.join(ROOT, "fake/calls.log")
    if not os.path.exists(path):
        return []
    return [line for line in open(path, encoding="utf-8").read().splitlines() if line.strip()]


def state():
    path = os.path.join(ROOT, "state/digest.json")
    return json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}


def prompted_turns():
    path = os.path.join(ROOT, "fake/prompt.txt")
    return open(path, encoding="utf-8").read().count("我：") if os.path.exists(path) else 0


def main():
    # 1) dry-run：两个回合都进 prompt，但不投递、不写状态
    setup()
    code, out = run("--dry-run", "--all")
    check("dry-run 退出码 0", code == 0, out)
    check("dry-run 送进 2 个回合", prompted_turns() == 2, prompted_turns())
    check("dry-run 不投递", calls() == [], calls())
    check("dry-run 不写状态", state() == {}, state())

    # 2) 正常运行：投递成功一次，水位推进到 turn/end 的 seq
    code, out = run()
    check("正常跑退出码 0", code == 0, out)
    check("投递一条且结果=成功", len(calls()) == 1 and "--result 成功" in calls()[0], calls())
    check("摘要来自模型输出", "夹具摘要" in calls()[0], calls())
    check("水位推进到 7", (state().get("sessions", {}).get(SID) or {}).get("watermark") == 7, state())

    # 3) 重跑：没有新对话 → 静默，不重复投递
    code, out = run()
    check("重跑退出码 0", code == 0, out)
    check("没有新对话不投递", len(calls()) == 1, calls())
    check("日志写清原因", "没有新对话" in out, out)

    # 4) 追加第三轮：只总结新的那一轮
    write_session([
        user(1, "运行时上下文", kind="runtime-context"),
        user(2, "第一问：服务器还活着吗"),
        answer(1, 3, "第一答：活着"),
        ev(4, "turn/end", {"turn": 1}),
        user(5, "第二问：帮我看下日志"),
        answer(2, 6, "第二答：日志正常"),
        ev(7, "turn/end", {"turn": 2}),
        user(8, "第三问：今天的总结呢"),
        answer(3, 9, "第三答：马上"),
        ev(10, "turn/end", {"turn": 3}),
    ])
    code, out = run()
    check("增量跑退出码 0", code == 0, out)
    check("只送进 1 个新回合", prompted_turns() == 1, prompted_turns())
    check("增量后投递 2 条", len(calls()) == 2, calls())
    check("水位推进到 10", (state().get("sessions", {}).get(SID) or {}).get("watermark") == 10, state())

    # 5) 总结失败：仍然投递「失败」，且不推进水位（第二天重试）
    setup()
    code, out = run(dsh=os.path.join(ROOT, "fake/bad-dsh"))
    check("失败分支非零退出", code != 0, out)
    check("失败也投递", len(calls()) == 1 and "--result 失败" in calls()[0], calls())
    check("失败不推进水位", state() == {}, state())

    # 6) 桥还没有会话映射：静默退出
    setup()
    os.remove(os.path.join(ROOT, ".dsh-feishu-remote/state.json"))
    code, out = run()
    check("无会话映射时静默退出", code == 0 and calls() == [], out)

    shutil.rmtree(ROOT, ignore_errors=True)
    print()
    if fails:
        print("失败 %d 项: %s" % (len(fails), fails))
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
