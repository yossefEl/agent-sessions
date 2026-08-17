"""Locate agent session transcripts on disk."""

from __future__ import annotations

import glob
import json
import os

HOME = os.path.expanduser("~")

CLAUDE_ROOT = os.path.join(HOME, ".claude", "projects")
CODEX_ROOT = os.path.join(HOME, ".codex", "sessions")
CODEX_INDEX = os.path.join(HOME, ".codex", "session_index.jsonl")


def claude_files() -> list[str]:
    """Top-level session transcripts: projects/<encoded-cwd>/<session-uuid>.jsonl"""
    return sorted(glob.glob(os.path.join(CLAUDE_ROOT, "*", "*.jsonl")))


def claude_subagent_files() -> list[str]:
    """Subagent transcripts spawned by a session.

    Two layouts, both under the parent session's directory:
      <session>/subagents/agent-<id>.jsonl                      (Task subagents)
      <session>/subagents/workflows/wf_<id>/agent-<id>.jsonl    (workflow agents)

    `journal.jsonl` sits alongside workflow agents but is a run log, not a
    transcript, so it is excluded.
    """
    pattern = os.path.join(CLAUDE_ROOT, "*", "*", "subagents", "**", "*.jsonl")
    return sorted(
        p for p in glob.glob(pattern, recursive=True)
        if os.path.basename(p) != "journal.jsonl"
    )


def claude_groups() -> list[dict]:
    """One entry per session: its main transcript plus any subagent files.

    A group is the unit of indexing, because a subagent's tokens belong to the
    session that spawned it.
    """
    groups: dict[str, dict] = {}

    for path in claude_files():
        session_id = os.path.splitext(os.path.basename(path))[0]
        groups.setdefault(session_id, {"session_id": session_id, "main": None,
                                       "subs": []})["main"] = path

    for path in claude_subagent_files():
        # .../<project>/<session-uuid>/subagents/[workflows/wf_x/]agent-y.jsonl
        parts = path.split(os.sep)
        try:
            session_id = parts[parts.index("subagents") - 1]
        except ValueError:
            continue
        groups.setdefault(session_id, {"session_id": session_id, "main": None,
                                       "subs": []})["subs"].append(path)

    return [groups[k] for k in sorted(groups)]


def codex_files() -> list[str]:
    """~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl"""
    return sorted(glob.glob(os.path.join(CODEX_ROOT, "**", "*.jsonl"), recursive=True))


def codex_titles() -> dict[str, str]:
    """session id -> thread_name, from Codex's own session index."""
    titles: dict[str, str] = {}
    if not os.path.exists(CODEX_INDEX):
        return titles
    with open(CODEX_INDEX, errors="replace") as fh:
        for line in fh:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("id") and row.get("thread_name"):
                titles[row["id"]] = row["thread_name"]
    return titles


def discover() -> dict[str, list[dict]]:
    """{agent: [group]} where a group is {session_id, main, subs}.

    Codex writes one self-contained file per session, so each Codex group has
    a main transcript and no subs.
    """
    found: dict[str, list[dict]] = {}
    if groups := claude_groups():
        found["claude"] = groups
    codex = [
        {"session_id": os.path.basename(p), "main": p, "subs": []}
        for p in codex_files()
    ]
    if codex:
        found["codex"] = codex
    return found
