"""SQLite index over parsed sessions, with incremental re-indexing.

The unit of indexing is a *session group*: a main transcript plus any subagent
transcripts it spawned. If any file in the group changed, the whole group is
re-parsed, because subagent tokens roll up into the parent session's totals.
"""

from __future__ import annotations

import os
import sqlite3
import time

from . import discovery
from .parsers import claude as claude_parser
from .parsers import codex as codex_parser
from .pricing import load_prices

DEFAULT_HOME = os.path.expanduser("~/.agent-sessions")
DB_NAME = "index.db"
PRICES_NAME = "prices.json"
SCHEMA_VERSION = 2  # bump to force a rebuild when the shape changes

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
    key             TEXT PRIMARY KEY,
    agent           TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    title           TEXT,
    path            TEXT NOT NULL,
    project         TEXT,
    cwd             TEXT,
    git_branch      TEXT,
    model           TEXT,
    models          TEXT,
    version         TEXT,
    started_at      TEXT,
    ended_at        TEXT,
    duration_s      REAL,
    day             TEXT,
    n_messages      INTEGER DEFAULT 0,
    n_user          INTEGER DEFAULT 0,
    n_assistant     INTEGER DEFAULT 0,
    n_tool_calls    INTEGER DEFAULT 0,
    n_subagents     INTEGER DEFAULT 0,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cache_read      INTEGER DEFAULT 0,
    cache_write     INTEGER DEFAULT 0,
    total_tokens    INTEGER DEFAULT 0,
    cost_usd        REAL,
    unpriced        INTEGER DEFAULT 0,
    file_size       INTEGER DEFAULT 0,
    first_prompt    TEXT,
    last_prompt     TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    session_key TEXT NOT NULL,
    seq         INTEGER,
    ts          TEXT,
    role        TEXT,
    kind        TEXT,
    tool_name   TEXT,
    model       TEXT,
    truncated   INTEGER DEFAULT 0,
    sidechain   INTEGER DEFAULT 0,
    label       TEXT,
    text        TEXT
);

CREATE TABLE IF NOT EXISTS files (
    path        TEXT PRIMARY KEY,
    agent       TEXT,
    mtime       REAL,
    size        INTEGER,
    session_key TEXT,
    indexed_at  REAL
);

CREATE INDEX IF NOT EXISTS idx_msg_session  ON messages(session_key, seq);
CREATE INDEX IF NOT EXISTS idx_sess_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sess_agent   ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sess_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sess_day     ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_files_key    ON files(session_key);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(text, content='messages', content_rowid='id', tokenize='porter unicode61');
"""


def db_path(home: str = DEFAULT_HOME) -> str:
    return os.path.join(home, DB_NAME)


def prices_path(home: str = DEFAULT_HOME) -> str:
    return os.path.join(home, PRICES_NAME)


def connect(home: str = DEFAULT_HOME) -> sqlite3.Connection:
    os.makedirs(home, exist_ok=True)
    path = db_path(home)

    if os.path.exists(path):
        probe = sqlite3.connect(path)
        try:
            row = probe.execute(
                "SELECT value FROM meta WHERE key='schema_version'"
            ).fetchone()
            stale = not row or int(row[0]) != SCHEMA_VERSION
        except sqlite3.Error:
            stale = True
        probe.close()
        if stale:
            # Local cache, fully rebuildable from the transcripts on disk.
            for suffix in ("", "-wal", "-shm"):
                try:
                    os.remove(path + suffix)
                except OSError:
                    pass

    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    try:
        conn.executescript(FTS_SCHEMA)
    except sqlite3.OperationalError:
        pass  # SQLite built without FTS5: search degrades to LIKE
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)",
        (str(SCHEMA_VERSION),),
    )
    conn.commit()
    return conn


def has_fts(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE name='messages_fts'"
    ).fetchone() is not None


def _delete_session(conn: sqlite3.Connection, key: str) -> None:
    if has_fts(conn):
        conn.execute(
            "INSERT INTO messages_fts(messages_fts, rowid, text) "
            "SELECT 'delete', id, text FROM messages WHERE session_key=?",
            (key,),
        )
    conn.execute("DELETE FROM messages WHERE session_key=?", (key,))
    conn.execute("DELETE FROM sessions WHERE key=?", (key,))
    conn.execute("DELETE FROM files WHERE session_key=?", (key,))


def _duration(started: str | None, ended: str | None) -> float | None:
    if not started or not ended:
        return None
    from datetime import datetime

    def _p(value: str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    a, b = _p(started), _p(ended)
    return max((b - a).total_seconds(), 0.0) if a and b else None


def _store(conn: sqlite3.Connection, sess, size: int) -> None:
    _delete_session(conn, sess.key)
    # Claude returns thinking blocks with empty text unless `display` is set to
    # "summarized", so ~17% of raw records carry no content at all. They add
    # nothing to read or search — keep them out of the index.
    msgs = [m for m in sess.messages if (m.text or "").strip()]
    conn.execute(
        """INSERT INTO sessions (key, agent, session_id, title, path, project, cwd,
             git_branch, model, models, version, started_at, ended_at, duration_s,
             day, n_messages, n_user, n_assistant, n_tool_calls, n_subagents,
             input_tokens, output_tokens, cache_read, cache_write, total_tokens,
             cost_usd, unpriced, file_size, first_prompt, last_prompt)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sess.key, sess.agent, sess.session_id, sess.title, sess.path,
            sess.project, sess.cwd, sess.git_branch,
            sess.models[-1] if sess.models else None,
            ",".join(sess.models), sess.version, sess.started_at, sess.ended_at,
            _duration(sess.started_at, sess.ended_at), (sess.started_at or "")[:10] or None,
            len(msgs), sess.n_user, sess.n_assistant, sess.n_tool_calls,
            sess.n_subagents, sess.input_tokens, sess.output_tokens,
            sess.cache_read_tokens, sess.cache_write_tokens, sess.total_tokens,
            sess.cost_usd, 1 if sess.unpriced else 0, size,
            sess.first_prompt, sess.last_prompt,
        ),
    )
    if not msgs:
        return
    first_id = conn.execute("SELECT COALESCE(MAX(id),0) FROM messages").fetchone()[0] + 1
    conn.executemany(
        """INSERT INTO messages
           (session_key, seq, ts, role, kind, tool_name, model, truncated,
            sidechain, label, text)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        [
            (sess.key, m.seq, m.ts, m.role, m.kind, m.tool_name, m.model,
             1 if m.truncated else 0, 1 if m.sidechain else 0, m.label, m.text)
            for m in msgs
        ],
    )
    if has_fts(conn):
        conn.execute(
            "INSERT INTO messages_fts(rowid, text) "
            "SELECT id, text FROM messages WHERE id >= ?",
            (first_id,),
        )


def reindex(home: str = DEFAULT_HOME, force: bool = False, progress=None) -> dict:
    conn = connect(home)
    prices = load_prices(prices_path(home))
    titles = discovery.codex_titles()

    known: dict[str, tuple[float, int]] = {}
    recorded: dict[str, set[str]] = {}
    key_of_path: dict[str, str] = {}
    for row in conn.execute("SELECT path, mtime, size, session_key FROM files"):
        known[row["path"]] = (row["mtime"], row["size"])
        recorded.setdefault(row["session_key"], set()).add(row["path"])
        key_of_path[row["path"]] = row["session_key"]

    stats = {"indexed": 0, "skipped": 0, "failed": 0, "bytes": 0,
             "removed": 0, "files": 0, "subagents": 0, "agents": {}}
    live_keys: set[str] = set()
    started = time.time()

    for agent, groups in discovery.discover().items():
        stats["agents"][agent] = 0
        for group in groups:
            main = group["main"]
            subs = [p for p in group["subs"] if os.path.exists(p)]
            paths = ([main] if main and os.path.exists(main) else []) + subs
            if not paths:
                continue

            try:
                stat_by_path = {p: os.stat(p) for p in paths}
            except OSError:
                continue

            # The stored key comes from inside the transcript (Codex records a
            # session UUID that the filename doesn't carry), so recover it from
            # a path we indexed before rather than guessing it from the name.
            prior_key = key_of_path.get(paths[0])
            unchanged = (
                not force
                and prior_key is not None
                and recorded.get(prior_key) == set(paths)
                and all(
                    known.get(p) == (st.st_mtime, st.st_size)
                    for p, st in stat_by_path.items()
                )
            )
            if unchanged:
                live_keys.add(prior_key)
                stats["skipped"] += 1
                stats["agents"][agent] += 1
                continue

            if progress:
                progress(agent, main or subs[0], len(subs))
            try:
                if agent == "claude":
                    sess = claude_parser.parse_group(main, subs, prices)
                else:
                    sess = codex_parser.parse(main, prices, titles)
            except Exception:
                stats["failed"] += 1
                continue
            if sess is None:
                stats["skipped"] += 1
                continue

            total_size = sum(st.st_size for st in stat_by_path.values())
            live_keys.add(sess.key)
            _store(conn, sess, total_size)
            now = time.time()
            conn.executemany(
                """INSERT OR REPLACE INTO files
                   (path, agent, mtime, size, session_key, indexed_at)
                   VALUES (?,?,?,?,?,?)""",
                [
                    (p, agent, st.st_mtime, st.st_size, sess.key, now)
                    for p, st in stat_by_path.items()
                ],
            )
            conn.commit()
            stats["indexed"] += 1
            stats["files"] += len(paths)
            stats["subagents"] += len(subs)
            stats["agents"][agent] += 1
            stats["bytes"] += total_size

    # Drop sessions whose transcripts have all disappeared.
    for key in list(recorded):
        if key not in live_keys:
            _delete_session(conn, key)
            stats["removed"] += 1

    conn.commit()
    if stats["indexed"] or stats["removed"]:
        try:
            conn.execute("ANALYZE")
        except sqlite3.OperationalError:
            pass
    conn.commit()
    conn.close()
    stats["elapsed"] = time.time() - started
    return stats
