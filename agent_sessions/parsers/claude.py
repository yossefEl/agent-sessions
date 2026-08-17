"""Parser for Claude Code transcripts (~/.claude/projects/*/*.jsonl).

Record shapes this handles (one JSON object per line, `type` discriminates):

  user      message.content: str, or list of {text|tool_result|image} blocks
  assistant message.content: list of {text|thinking|tool_use} blocks,
            plus message.model and message.usage
  system    content, level, subtype
  ai-title  aiTitle          - session title chosen by the model
  last-prompt lastPrompt     - most recent user prompt

TOKEN ACCOUNTING: Claude Code writes ONE RECORD PER CONTENT BLOCK. Every record
belonging to the same assistant turn repeats the same `message.id` and the same
`message.usage` object. Summing usage across records overcounts by roughly the
average number of blocks per turn (~2.2x on real transcripts), so usage is
counted once per distinct message.id.
"""

from __future__ import annotations

import json
import os

from ..pricing import estimate_cost
from .base import TEXT_CAP, TOOL_RESULT_CAP, Message, Session, clean_prompt, clip


def _decode_project(dirname: str) -> str:
    """Fallback project name from the encoded directory.

    Claude encodes the cwd by replacing '/' with '-', which is lossy when the
    path itself contains dashes. We drop the leading home-directory segments
    and keep the rest, so '-Users-alice-Documents-my-side-project' reads as
    'my-side-project' rather than 'project'. When the record carries a real
    `cwd` it is preferred over this guess.
    """
    parts = [p for p in dirname.split("-") if p]
    for lead in (["Users"], ["home"]):
        if parts[: len(lead)] == lead:
            parts = parts[len(lead) + 1 :]  # drop 'Users' and the username
            break
    for folder in ("Documents", "Desktop", "Projects", "src", "code"):
        if parts and parts[0] == folder:
            parts = parts[1:]
    return "-".join(parts) or dirname.strip("-") or dirname


def _blocks(content) -> list:
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def _stringify(value) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                parts.append(item.get("text") or item.get("content") or "")
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p)
    if value is None:
        return ""
    return json.dumps(value)[:TEXT_CAP]


def parse(path: str, prices) -> Session | None:
    session_id = os.path.splitext(os.path.basename(path))[0]
    sess = Session(agent="claude", session_id=session_id, path=path)
    sess.project = _decode_project(os.path.basename(os.path.dirname(path)))

    seen_usage: set[str] = set()  # message.id values already counted
    seq = 0
    models: list[str] = []

    with open(path, errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue

            rtype = rec.get("type")

            if rtype == "ai-title":
                sess.title = rec.get("aiTitle") or sess.title
                continue
            if rtype == "last-prompt":
                sess.last_prompt = (
                    clean_prompt(rec.get("lastPrompt")) or sess.last_prompt
                )
                continue

            ts = rec.get("timestamp")
            if ts:
                if sess.started_at is None:
                    sess.started_at = ts
                sess.ended_at = ts
            sess.cwd = rec.get("cwd") or sess.cwd
            sess.git_branch = rec.get("gitBranch") or sess.git_branch
            sess.version = rec.get("version") or sess.version
            sidechain = bool(rec.get("isSidechain"))

            if rtype == "user":
                msg = rec.get("message") or {}
                content = msg.get("content")
                if isinstance(content, str):
                    text, cut = clip(content)
                    seq += 1
                    sess.messages.append(
                        Message(seq, ts, "user", "text", text, truncated=cut,
                                sidechain=sidechain)
                    )
                    if not rec.get("isMeta"):
                        sess.n_user += 1
                        human = clean_prompt(content)
                        if human and sess.first_prompt is None:
                            sess.first_prompt = human[:400]
                else:
                    for block in _blocks(content):
                        btype = block.get("type")
                        if btype == "text":
                            text, cut = clip(block.get("text"))
                            seq += 1
                            sess.messages.append(
                                Message(seq, ts, "user", "text", text,
                                        truncated=cut, sidechain=sidechain)
                            )
                            if not rec.get("isMeta"):
                                sess.n_user += 1
                                human = clean_prompt(block.get("text"))
                                if human and sess.first_prompt is None:
                                    sess.first_prompt = human[:400]
                        elif btype == "tool_result":
                            text, cut = clip(
                                _stringify(block.get("content")), TOOL_RESULT_CAP
                            )
                            seq += 1
                            sess.messages.append(
                                Message(seq, ts, "tool", "tool_result", text,
                                        truncated=cut, sidechain=sidechain)
                            )
                        elif btype == "image":
                            seq += 1
                            sess.messages.append(
                                Message(seq, ts, "user", "image", "[image]",
                                        sidechain=sidechain)
                            )

            elif rtype == "assistant":
                msg = rec.get("message") or {}
                model = msg.get("model")
                # '<synthetic>' marks locally-generated messages (no API call).
                if model and not model.startswith("<") and model not in models:
                    models.append(model)

                mid = msg.get("id")
                usage = msg.get("usage") or {}
                # Count usage once per assistant turn, not once per block.
                if usage and (mid is None or mid not in seen_usage):
                    if mid:
                        seen_usage.add(mid)
                    sess.input_tokens += usage.get("input_tokens", 0) or 0
                    sess.output_tokens += usage.get("output_tokens", 0) or 0
                    sess.cache_read_tokens += (
                        usage.get("cache_read_input_tokens", 0) or 0
                    )
                    created = usage.get("cache_creation") or {}
                    w5 = created.get("ephemeral_5m_input_tokens", 0) or 0
                    w1h = created.get("ephemeral_1h_input_tokens", 0) or 0
                    total_write = usage.get("cache_creation_input_tokens", 0) or 0
                    sess.cache_write_tokens += total_write
                    if model and model.startswith("<"):
                        # '<synthetic>' and friends are generated locally by the
                        # CLI, not billed API calls. Zero cost, not "unpriced".
                        cost = 0.0
                    else:
                        cost = estimate_cost(
                            model,
                            {
                                "input": usage.get("input_tokens", 0) or 0,
                                "output": usage.get("output_tokens", 0) or 0,
                                "cache_read": usage.get("cache_read_input_tokens", 0) or 0,
                                "cache_write_5m": w5,
                                "cache_write_1h": w1h,
                                # only when the TTL split is absent
                                "cache_write": 0 if (w5 or w1h) else total_write,
                            },
                            prices,
                        )
                    if cost is None:
                        sess.unpriced = True
                    else:
                        sess.cost_usd = (sess.cost_usd or 0.0) + cost

                counted_turn = False
                for block in _blocks(msg.get("content")):
                    btype = block.get("type")
                    if btype == "text":
                        text, cut = clip(block.get("text"))
                        seq += 1
                        sess.messages.append(
                            Message(seq, ts, "assistant", "text", text, model=model,
                                    truncated=cut, sidechain=sidechain)
                        )
                        counted_turn = True
                    elif btype == "thinking":
                        text, cut = clip(block.get("thinking"))
                        seq += 1
                        sess.messages.append(
                            Message(seq, ts, "assistant", "thinking", text,
                                    model=model, truncated=cut, sidechain=sidechain)
                        )
                    elif btype == "tool_use":
                        text, cut = clip(
                            json.dumps(block.get("input"), ensure_ascii=False),
                            TOOL_RESULT_CAP,
                        )
                        seq += 1
                        sess.messages.append(
                            Message(seq, ts, "assistant", "tool_use", text,
                                    tool_name=block.get("name"), model=model,
                                    truncated=cut, sidechain=sidechain)
                        )
                        sess.n_tool_calls += 1
                if counted_turn:
                    sess.n_assistant += 1

            elif rtype == "system":
                text, cut = clip(_stringify(rec.get("content")), TOOL_RESULT_CAP)
                if text:
                    seq += 1
                    sess.messages.append(
                        Message(seq, ts, "system", "text", text, truncated=cut,
                                sidechain=sidechain)
                    )

    if not sess.messages and not sess.started_at:
        return None

    sess.models = models
    if not sess.title:
        sess.title = (sess.first_prompt or "").strip().split("\n")[0][:120] or None
    # The real cwd beats the lossy directory-name decoding.
    if sess.cwd:
        sess.project = os.path.basename(sess.cwd.rstrip("/")) or sess.project
    return sess


def subagent_label(path: str) -> str:
    """Human label for a subagent transcript, from its path.

    <session>/subagents/agent-a77be.jsonl            -> 'agent-a77be'
    <session>/subagents/workflows/wf_975f/agent-a05.jsonl -> 'wf_975f / agent-a05'
    """
    stem = os.path.splitext(os.path.basename(path))[0]
    parent = os.path.basename(os.path.dirname(path))
    if parent.startswith("wf_"):
        return f"{parent} / {stem}"
    return stem


def parse_group(main_path: str | None, sub_paths: list[str], prices) -> Session | None:
    """Parse a session together with the subagent transcripts it spawned.

    Claude Code stores subagent turns in separate files under
    <project>/<session-uuid>/subagents/. They carry the parent's sessionId and
    their own real `usage`, so their tokens are part of the parent session's
    cost and are folded in here rather than counted as separate sessions.
    """
    if main_path:
        sess = parse(main_path, prices)
    else:
        sess = None
    if sess is None and not sub_paths:
        return None

    if sess is None:
        # Parent transcript is gone but subagent files remain.
        session_id = os.path.basename(os.path.dirname(os.path.dirname(sub_paths[0])))
        sess = Session(agent="claude", session_id=session_id, path=sub_paths[0])

    base_count = len(sess.messages)
    for order, sub_path in enumerate(sorted(sub_paths)):
        child = parse(sub_path, prices)
        if child is None:
            continue
        sess.n_subagents += 1
        label = subagent_label(sub_path)
        for msg in child.messages:
            msg.sidechain = True
            msg.label = label
            sess.messages.append(msg)

        sess.input_tokens += child.input_tokens
        sess.output_tokens += child.output_tokens
        sess.cache_read_tokens += child.cache_read_tokens
        sess.cache_write_tokens += child.cache_write_tokens
        sess.n_tool_calls += child.n_tool_calls
        sess.unpriced = sess.unpriced or child.unpriced
        if child.cost_usd is not None:
            sess.cost_usd = (sess.cost_usd or 0.0) + child.cost_usd
        for model in child.models:
            if model not in sess.models:
                sess.models.append(model)
        if child.started_at and (
            not sess.started_at or child.started_at < sess.started_at
        ):
            sess.started_at = child.started_at
        if child.ended_at and (not sess.ended_at or child.ended_at > sess.ended_at):
            sess.ended_at = child.ended_at
        if not sess.cwd:
            sess.cwd, sess.project = child.cwd, child.project

    # Interleave subagent turns with the main thread by timestamp, keeping
    # records that carry no timestamp in their original position.
    if len(sess.messages) > base_count:
        decorated = [(m.ts or "", i, m) for i, m in enumerate(sess.messages)]
        decorated.sort(key=lambda row: (row[0] == "", row[0], row[1]))
        sess.messages = [row[2] for row in decorated]
        for i, msg in enumerate(sess.messages, 1):
            msg.seq = i
    return sess
