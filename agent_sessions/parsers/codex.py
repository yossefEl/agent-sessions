"""Parser for Codex rollout transcripts (~/.codex/sessions/YYYY/MM/DD/*.jsonl).

Every line is {"timestamp", "type", "payload"}. Record types:

  session_meta  payload: id, timestamp, cwd, originator, cli_version, source
  turn_context  payload: model (and other per-turn settings)
  event_msg     payload.type: task_started | token_count | task_complete | ...
  response_item payload.type: message | reasoning | function_call |
                function_call_output | custom_tool_call | custom_tool_call_output

TOKEN ACCOUNTING: event_msg/token_count carries `info.total_token_usage`, which
is CUMULATIVE for the session — not a per-turn delta. Summing those records
would multiply the real total by the number of turns, so we take the largest
(i.e. final) snapshot instead. `input_tokens` there is inclusive of
`cached_input_tokens`, so the uncached input is the difference.
"""

from __future__ import annotations

import json
import os

from ..pricing import estimate_cost
from .base import TEXT_CAP, TOOL_RESULT_CAP, Message, Session, clean_prompt, clip


def _text_of(content) -> str:
    """Flatten a Codex message content array into plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict):
            parts.append(block.get("text") or "")
        elif isinstance(block, str):
            parts.append(block)
    return "\n".join(p for p in parts if p)


def _reasoning_text(payload) -> str:
    """Codex reasoning items carry a `summary` list, sometimes `content`."""
    for field in ("summary", "content"):
        value = payload.get(field)
        text = _text_of(value)
        if text:
            return text
    return ""


def parse(path: str, prices, titles: dict[str, str] | None = None) -> Session | None:
    titles = titles or {}
    sess = Session(agent="codex", session_id="", path=path)
    seq = 0
    models: list[str] = []
    best_usage: dict | None = None
    best_total = -1

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
            payload = rec.get("payload") or {}
            ts = rec.get("timestamp")
            if ts:
                if sess.started_at is None:
                    sess.started_at = ts
                sess.ended_at = ts

            if rtype == "session_meta":
                sess.session_id = payload.get("id") or sess.session_id
                sess.cwd = payload.get("cwd") or sess.cwd
                sess.version = payload.get("cli_version") or sess.version
                model = payload.get("model")
                if model and model not in models:
                    models.append(model)

            elif rtype == "turn_context":
                model = payload.get("model")
                if model and model not in models:
                    models.append(model)

            elif rtype == "event_msg":
                if payload.get("type") == "token_count":
                    info = payload.get("info") or {}
                    total = info.get("total_token_usage") or {}
                    n = total.get("total_tokens")
                    # Cumulative snapshots: keep the largest, never sum.
                    if isinstance(n, int) and n > best_total:
                        best_total = n
                        best_usage = total

            elif rtype == "response_item":
                ptype = payload.get("type")

                if ptype == "message":
                    role = payload.get("role") or "assistant"
                    text_raw = _text_of(payload.get("content"))
                    if not text_raw:
                        continue
                    if role == "developer":
                        role_out, kind = "system", "text"
                        cap = TOOL_RESULT_CAP
                    elif role == "user":
                        role_out, kind, cap = "user", "text", TEXT_CAP
                        sess.n_user += 1
                        # Codex injects AGENTS.md and IDE context as user turns;
                        # only the human part is worth titling a session with.
                        human = clean_prompt(text_raw)
                        if human:
                            if sess.first_prompt is None:
                                sess.first_prompt = human[:400]
                            sess.last_prompt = human[:400]
                    else:
                        role_out, kind, cap = "assistant", "text", TEXT_CAP
                        sess.n_assistant += 1
                    text, cut = clip(text_raw, cap)
                    seq += 1
                    sess.messages.append(
                        Message(seq, ts, role_out, kind, text, truncated=cut)
                    )

                elif ptype == "reasoning":
                    text, cut = clip(_reasoning_text(payload))
                    if text:
                        seq += 1
                        sess.messages.append(
                            Message(seq, ts, "assistant", "thinking", text,
                                    truncated=cut)
                        )

                elif ptype in ("function_call", "custom_tool_call"):
                    raw = payload.get("arguments")
                    if raw is None:
                        raw = payload.get("input")
                    if not isinstance(raw, str):
                        raw = json.dumps(raw, ensure_ascii=False)
                    text, cut = clip(raw, TOOL_RESULT_CAP)
                    seq += 1
                    sess.messages.append(
                        Message(seq, ts, "assistant", "tool_use", text,
                                tool_name=payload.get("name"), truncated=cut)
                    )
                    sess.n_tool_calls += 1

                elif ptype in ("function_call_output", "custom_tool_call_output"):
                    out = payload.get("output")
                    if not isinstance(out, str):
                        out = json.dumps(out, ensure_ascii=False)
                    text, cut = clip(out, TOOL_RESULT_CAP)
                    seq += 1
                    sess.messages.append(
                        Message(seq, ts, "tool", "tool_result", text, truncated=cut)
                    )

    if not sess.session_id:
        # rollout-2026-08-13T11-14-23-<uuid>.jsonl
        stem = os.path.splitext(os.path.basename(path))[0]
        sess.session_id = stem.rsplit("-", 5)[-1] if "-" in stem else stem

    if best_usage:
        cached = best_usage.get("cached_input_tokens", 0) or 0
        total_in = best_usage.get("input_tokens", 0) or 0
        # input_tokens is inclusive of the cached portion.
        sess.input_tokens = max(total_in - cached, 0)
        sess.cache_read_tokens = cached
        sess.cache_write_tokens = best_usage.get("cache_write_input_tokens", 0) or 0
        sess.output_tokens = best_usage.get("output_tokens", 0) or 0
        model = models[-1] if models else None
        cost = estimate_cost(
            model,
            {
                "input": sess.input_tokens,
                "output": sess.output_tokens,
                "cache_read": sess.cache_read_tokens,
                "cache_write": sess.cache_write_tokens,
            },
            prices,
        )
        if cost is None:
            sess.unpriced = True
        else:
            sess.cost_usd = cost

    if not sess.messages and not sess.started_at:
        return None

    sess.models = models
    sess.title = titles.get(sess.session_id)
    if not sess.title:
        sess.title = (sess.first_prompt or "").strip().split("\n")[0][:120] or None
    if sess.cwd:
        sess.project = os.path.basename(sess.cwd)
    return sess
