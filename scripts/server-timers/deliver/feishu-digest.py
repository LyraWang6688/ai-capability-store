#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""feishu-digest — 每天把飞书桥上「我和 AI 的新对话」总结成一条收件箱记录。

链路（投递契约见 orchestrations/dsh/COLLABORATION.md）：

    桥会话库 ──增量提取（水位）──▶ dsh headless 总结 ──▶ inbox-deliver ──▶ 飞书「任务收件箱」
                                                                         └─▶ DSH 📥 面板待读

设计要点：

- **增量**：水位按 session 记「已处理到哪个事件的 seq」，重复跑不会重复总结。
- **无内容不打扰**：没有新对话就不写表、不发消息，退出码 0。
- **失败也投递**：总结失败写一条「结果=失败」的记录（契约要求，避免静默断链）；
  同时**不推进水位**，第二天会重试，宁可重复也不丢内容。
- **摘要 ≤300 字**：收件箱「结果摘要」字段的上限，也是面板上能一眼读完的长度。

为什么读会话库而不是读桥的审计日志：审计只记用户指令全文，
AI 的回答只记了字数（`done` 的 `chars`）。完整对话只存在于 DSH 会话库。

用法：

    feishu-digest.py                 # 正常跑（systemd timer 用这个）
    feishu-digest.py --dry-run       # 只打印摘要，不投递、不动水位
    feishu-digest.py --all           # 忽略水位，总结全部历史对话（首次调试）
    feishu-digest.py --since-hours 26
    feishu-digest.py --task feishu-digest
"""
import argparse
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta

HOME = os.environ.get("HOME", "/srv/dsh-jobs")
BRIDGE_DIR = os.environ.get("DSH_FEISHU_REMOTE_DIR", os.path.join(HOME, ".dsh-feishu-remote"))
SESSIONS_ROOT = os.environ.get("DSH_SESSIONS_ROOT", os.path.join(HOME, ".dsh", "sessions"))
STATE_PATH = os.environ.get("DSH_DIGEST_STATE", os.path.join(HOME, "state", "feishu-digest.json"))
LOG_PATH = os.environ.get("DSH_DIGEST_LOG", os.path.join(HOME, "logs", "feishu-digest.log"))
DSH_CLI = os.environ.get("DSH_CLI", os.path.join(HOME, ".local", "bin", "dsh"))
INBOX_DELIVER = os.environ.get("DSH_INBOX_DELIVER", os.path.join(HOME, "scripts", "inbox-deliver"))
TASK_NAME = os.environ.get("DSH_DIGEST_TASK", "feishu-digest")
MAX_SUMMARY = int(os.environ.get("DSH_INBOX_MAX_SUMMARY", "300"))

# 单条消息进入 prompt 前的截断，以及整段对话的上限。
# 不设上限会把整天的原文（含工具输出）灌给模型，既贵又容易被细节带跑。
USER_CHARS = 800
ASSISTANT_CHARS = 1200
TOTAL_CHARS = 24000
SUMMARY_TIMEOUT = int(os.environ.get("DSH_DIGEST_TIMEOUT", "300"))


def log(line):
    stamped = datetime.now().isoformat(timespec="seconds") + " " + line
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(stamped + "\n")
    except Exception:
        pass
    print(stamped, flush=True)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def save_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def run(cmd, timeout, stdin_text=None):
    """跑一个子进程，返回 (code, stdout, stderr)。超时返回 code='timeout'。"""
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            input=stdin_text, cwd=os.path.join(HOME, "work") if os.path.isdir(os.path.join(HOME, "work")) else None,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return "timeout", "", "timeout after %ss" % timeout
    except FileNotFoundError as error:
        return "missing", "", str(error)


# ---------------------------------------------------------------- 会话库


def bridge_session_ids():
    """桥的 state.json 里 chat → session 的映射（只取当前这个飞书私聊）。"""
    state = load_json(os.path.join(BRIDGE_DIR, "state.json"), {})
    sessions = state.get("sessions") or {}
    return {sid for sid in sessions.values() if isinstance(sid, str) and sid}


def find_session_files(session_ids):
    """session id → 会话文件路径。DSH 按 cwd 分目录，所以用 glob 找，不拼路径。"""
    found = {}
    for sid in session_ids:
        # 桥的 state.json 里存的已经是 `session-<uuid>` 全名，目录名与它一致。
        matches = glob.glob(os.path.join(SESSIONS_ROOT, "*", sid, "session.v4.jsonl.zstd"))
        if matches:
            found[sid] = sorted(matches, key=os.path.getmtime)[-1]
    return found


def read_events(path):
    """解压 + 逐行解析会话事件。返回事件列表（解析失败的行跳过）。"""
    code, out, err = run(["zstd", "-dc", path], timeout=180)
    if code != 0:
        raise SystemExit("读会话文件失败 (%s): %s" % (path, (err or out)[:300]))
    events = []
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            continue
    return events


def blocks_text(content):
    parts = []
    for block in content or []:
        if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(part for part in parts if part.strip()).strip()


def extract_turns(events, since_ms=None, after_seq=0):
    """把事件流还原成「一问一答」的回合。

    - 只认 `source.kind == "user"` 的 user/message（运行上下文的快照不是人说的话）；
    - 每个回合取**到最后一条 assistant 文本**，工具调用/中间步骤不进摘要；
    - 以 `turn/end` 为回合边界，水位用它的 seq。
    """
    turns = []
    pending_user = None
    pending_ms = None
    current = None

    def flush(turn):
        if not turn:
            return
        answer = turn["texts"][-1] if turn["texts"] else ""
        user = turn.get("user") or ""
        if not user and not answer:
            return
        turns.append({
            "turn": turn["turn"],
            "time": turn["time"],
            "user": user,
            "answer": answer,
            "endSeq": turn["endSeq"],
        })

    for event in events:
        etype = event.get("type")
        seq = event.get("seq") or 0
        if etype == "user/message":
            data = event.get("data") or {}
            source = data.get("source") or {}
            if source.get("kind") != "user":
                continue  # runtime-context 等系统注入
            text = blocks_text(data.get("content"))
            if not text:
                continue
            if current is not None:
                flush(current)
                current = None
            pending_user = text
            pending_ms = event.get("time")
        elif etype == "assistant/message":
            data = event.get("data") or {}
            message = data.get("message") or {}
            turn_no = data.get("turn")
            final_text = blocks_text(message.get("content")) if message.get("role") == "assistant" else ""
            if current is None or current.get("turn") != turn_no:
                if current is not None:
                    flush(current)
                current = {
                    "turn": turn_no,
                    "time": pending_ms or event.get("time"),
                    "user": pending_user or "",
                    "texts": [],
                    "endSeq": seq,
                }
                pending_user = None
                pending_ms = None
            if final_text:
                current["texts"].append(final_text)
                current["endSeq"] = seq
        elif etype == "turn/end":
            if current is not None:
                current["endSeq"] = max(current.get("endSeq") or 0, seq)
                flush(current)
                current = None
            pending_user = None
            pending_ms = None

    if current is not None:
        flush(current)

    if after_seq:
        turns = [turn for turn in turns if (turn.get("endSeq") or 0) > after_seq]
    if since_ms:
        turns = [turn for turn in turns if (turn.get("time") or 0) >= since_ms]
    return turns


# ---------------------------------------------------------------- 摘要


def build_transcript(turns):
    lines = []
    for turn in turns:
        stamp = datetime.fromtimestamp((turn.get("time") or 0) / 1000).strftime("%m-%d %H:%M")
        user = (turn.get("user") or "").strip()
        answer = (turn.get("answer") or "").strip()
        if len(user) > USER_CHARS:
            user = user[:USER_CHARS] + "…（后略）"
        if len(answer) > ASSISTANT_CHARS:
            answer = answer[:ASSISTANT_CHARS] + "…（后略）"
        lines.append("[%s] 我：%s\nAI：%s" % (stamp, user, answer))
    text = "\n\n".join(lines)
    if len(text) > TOTAL_CHARS:
        text = text[-TOTAL_CHARS:]
        text = "……（更早的记录已截断）\n\n" + text
    return text


def build_prompt(transcript):
    return (
        "下面是过去一天我和 AI 的对话记录。请写一段中文摘要，供我在桌面端扫一眼。\n"
        "要求：\n"
        "- 总长不超过 280 字；\n"
        "- 第一句总述这段时间主要在聊什么；\n"
        "- 再分条列出 2–4 件具体的事，每条一句，用 1) 2) 3) 编号；\n"
        "- 最后一行是「待跟进：…」，没有就写「待跟进：无」；\n"
        "- 只写结论与决定，不复述原文、不写工具细节、不加标题、不用 Markdown 符号。\n\n"
        "对话记录：\n" + transcript
    )


def parse_dsh_output(stdout):
    """dsh headless --json 每行一个事件；取 finally 的 final.text，退而求其次取最后的 text。"""
    final_text = None
    texts = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        if event.get("type") == "final" and isinstance(event.get("text"), str):
            final_text = event["text"]
        elif event.get("type") == "text" and isinstance(event.get("text"), str):
            texts.append(event["text"])
    return (final_text if final_text is not None else "".join(texts)).strip()


def summarize(transcript):
    """调服务器本机的 dsh headless 出摘要。失败返回 (None, 原因)。"""
    if not os.path.exists(DSH_CLI):
        return None, "找不到执行后端 %s" % DSH_CLI
    code, out, err = run([DSH_CLI, "headless", "--json", build_prompt(transcript)], timeout=SUMMARY_TIMEOUT)
    if code != 0:
        reason = ("超时（%ss）" % SUMMARY_TIMEOUT) if code == "timeout" else ((err or out).strip().splitlines()[-1:] or ["exit %s" % code])[0]
        return None, "总结失败：" + str(reason)[:120]
    text = parse_dsh_output(out)
    if not text:
        return None, "总结失败：模型没有输出（可能是 Key 或 Node 版本问题）"
    text = " ".join(text.split())
    return text, ""


def cap(text, limit=MAX_SUMMARY):
    text = (text or "").strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


# ---------------------------------------------------------------- 投递


def deliver(result, summary, task=None):
    if not os.path.exists(INBOX_DELIVER):
        raise SystemExit("找不到投递脚本 %s" % INBOX_DELIVER)
    code, out, err = run(
        [INBOX_DELIVER, "--task", task or TASK_NAME, "--result", result, "--summary", summary],
        timeout=120,
    )
    if code != 0:
        raise SystemExit("投递失败: %s" % ((err or out).strip()[:300] or code))
    return out.strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只打印摘要，不投递、不动水位")
    parser.add_argument("--all", action="store_true", help="忽略水位，总结全部历史对话")
    parser.add_argument("--since-hours", type=float, default=26.0,
                        help="首次运行（没有水位）时往前取多少小时，默认 26")
    parser.add_argument("--task", default=TASK_NAME, help="收件箱「定时任务」表里的任务名")
    parser.add_argument("--max-chars", type=int, default=MAX_SUMMARY, help="摘要上限，默认 300")
    args = parser.parse_args()

    state = load_json(STATE_PATH, {})
    state.setdefault("sessions", {})
    known = set(state.get("sessions") or {}) | bridge_session_ids()
    if not known:
        log("没有可读的桥会话映射（%s），跳过" % os.path.join(BRIDGE_DIR, "state.json"))
        return 0

    files = find_session_files(known)
    if not files:
        log("找不到已知会话的会话文件（%s），跳过" % SESSIONS_ROOT)
        return 0

    now = datetime.now()
    first_run = not args.all and not any(
        isinstance(state["sessions"].get(sid), dict) and state["sessions"][sid].get("watermark")
        for sid in files
    )
    since_ms = int((now - timedelta(hours=args.since_hours)).timestamp() * 1000) if first_run else None
    if first_run:
        log("首次运行：只取最近 %s 小时的对话" % args.since_hours)

    all_turns = []
    per_session = {}
    for sid, path in files.items():
        watermark = 0 if args.all else int((state["sessions"].get(sid) or {}).get("watermark") or 0)
        try:
            events = read_events(path)
        except SystemExit as error:
            log(str(error))
            continue
        turns = extract_turns(events, since_ms=since_ms, after_seq=watermark)
        if turns:
            log("会话 %s：%d 个新回合（水位 %s）" % (sid, len(turns), watermark or "-"))
        if turns:
            per_session[sid] = turns
        all_turns.extend(turns)

    if not all_turns:
        log("过去一段时间没有新对话，不投递")
        return 0

    all_turns.sort(key=lambda turn: turn.get("time") or 0)
    transcript = build_transcript(all_turns)
    log("新对话 %d 个回合，送进总结（%d 字）" % (len(all_turns), len(transcript)))

    summary, error = summarize(transcript)
    if summary is None:
        log(error)
        if args.dry_run:
            return 1
        deliver("失败", cap(error), args.task)
        return 1

    summary = cap(summary, args.max_chars)
    log("摘要：%s" % summary)

    if args.dry_run:
        log("--dry-run：不投递，也不推进水位")
        return 0

    deliver("成功", summary, args.task)
    log("已投递收件箱（task=%s）" % (args.task or TASK_NAME))

    # 只有投递成功才推进水位：投递失败宁可第二天重试，也不让内容静默丢掉。
    for sid, turns in per_session.items():
        state["sessions"][sid] = {
            "watermark": max((turn.get("endSeq") or 0) for turn in turns),
            "lastRun": now.isoformat(timespec="seconds"),
            "lastTurns": len(turns),
        }
    state["lastSummary"] = summary
    state["lastDeliveredAt"] = now.isoformat(timespec="seconds")
    save_json(STATE_PATH, state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
