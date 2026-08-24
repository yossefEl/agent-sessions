"""Local HTTP server: JSON API + the static dashboard. Python stdlib only."""

from __future__ import annotations

import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

from . import index as idx
from . import launcher

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# The browser picks a command by KEY, never by sending a command string. Even
# if every other check below were defeated, the worst a request can do is start
# one of these.
LAUNCH_COMMANDS = {
    "claude": ("claude", "Claude Code"),
    "claude-continue": ("claude --continue", "Claude Code, continuing the last session"),
    "claude-resume": ("claude --resume", "Claude Code, pick a session to resume"),
    "codex": ("codex", "Codex"),
    "shell": ("$SHELL", "A plain shell"),
}

# Minted per server run. A cross-origin page cannot read /api/meta (CORS blocks
# reading the response), so it cannot learn this, which is what stops a random
# website from POSTing to localhost and opening terminals.
LAUNCH_TOKEN = secrets.token_urlsafe(24)

SORT_COLUMNS = {
    "started": "started_at",
    "tokens": "total_tokens",
    "cost": "cost_usd",
    "messages": "n_messages",
    "tools": "n_tool_calls",
    "duration": "duration_s",
    "size": "file_size",
}


def _fts_query(raw: str) -> str:
    """Quote each term so user punctuation can't break FTS5 syntax."""
    terms = [t for t in re.split(r"\s+", raw.strip()) if t]
    return " AND ".join('"' + t.replace('"', '""') + '"' for t in terms)


class Handler(BaseHTTPRequestHandler):
    server_version = "agent-sessions"
    home = idx.DEFAULT_HOME
    _local = threading.local()

    # -- plumbing ---------------------------------------------------------
    def log_message(self, fmt, *args):  # quieter than the default
        pass

    @property
    def db(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(idx.db_path(self.home))
            conn.row_factory = sqlite3.Row
            self._local.conn = conn
        return conn

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def json(self, payload, code: int = 200) -> None:
        self._send(code, json.dumps(payload, default=str).encode(), "application/json")

    def rows(self, sql: str, args=()) -> list[dict]:
        return [dict(r) for r in self.db.execute(sql, args)]

    # -- routing ----------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if path == "/" or path == "/index.html":
                return self.static("index.html")
            if path.startswith("/static/"):
                return self.static(path[len("/static/"):])
            if path == "/api/meta":
                return self.api_meta()
            if path == "/api/projects":
                return self.api_projects(q)
            m = re.match(r"^/api/project/(.+)$", path)
            if m:
                return self.api_project(unquote(m.group(1)))
            if path == "/api/overview":
                return self.api_overview(q)
            if path == "/api/sessions":
                return self.api_sessions(q)
            if path == "/api/search":
                return self.api_search(q)
            m = re.match(r"^/api/session/([^/]+)/messages$", path)
            if m:
                return self.api_messages(unquote(m.group(1)), q)
            m = re.match(r"^/api/session/([^/]+)$", path)
            if m:
                return self.api_session(unquote(m.group(1)))
        except Exception as exc:  # surface errors as JSON, don't 500 blindly
            return self.json({"error": str(exc)}, 500)
        self.json({"error": "not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/api/reindex":
            try:
                stats = idx.reindex(self.home)
                if conn := getattr(self._local, "conn", None):
                    conn.close()
                    self._local.conn = None
                return self.json(stats)
            except Exception as exc:
                return self.json({"error": str(exc)}, 500)
        if path == "/api/launch":
            return self.api_launch()
        self.json({"error": "not found"}, 404)

    # -- request helpers --------------------------------------------------
    def _body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0 or length > 64_000:
            return {}
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, OSError):
            return {}

    def _same_origin(self) -> bool:
        """Reject a POST that some other page in the browser sent here.

        The dashboard is served from this origin, so its own requests either
        carry a matching Origin or none at all (same-origin fetch in some
        browsers). Anything naming a different origin is not ours.
        """
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("Host") or ""
        return urlparse(origin).netloc == host

    # -- static -----------------------------------------------------------
    def static(self, name: str) -> None:
        safe = os.path.normpath(name).lstrip("./")
        full = os.path.join(WEB_DIR, safe)
        if not full.startswith(WEB_DIR) or not os.path.isfile(full):
            return self.json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            self._send(200, fh.read(), ctype)

    # -- API --------------------------------------------------------------
    def api_meta(self) -> None:
        agents = self.rows(
            "SELECT agent, COUNT(*) n, SUM(file_size) bytes FROM sessions "
            "GROUP BY agent ORDER BY n DESC"
        )
        total = self.rows(
            "SELECT COUNT(*) n, COALESCE(SUM(file_size),0) bytes, "
            "MIN(started_at) first, MAX(started_at) last FROM sessions"
        )[0]
        unpriced = self.rows(
            "SELECT DISTINCT model FROM sessions WHERE unpriced=1 AND model IS NOT NULL"
        )
        db = idx.db_path(self.home)
        return self.json({
            "agents": agents,
            "total": total,
            "unpriced_models": [r["model"] for r in unpriced],
            "db_path": db,
            "db_bytes": os.path.getsize(db) if os.path.exists(db) else 0,
            "prices_path": idx.prices_path(self.home),
            "fts": idx.has_fts(self.db),
            "home": os.path.expanduser("~"),
            "launch": self.launch_info(),
        })

    def _filters(self, q: dict) -> tuple[str, list]:
        where, args = [], []
        if q.get("agent"):
            where.append("agent = ?")
            args.append(q["agent"])
        if q.get("project"):
            where.append("project = ?")
            args.append(q["project"])
        if q.get("model"):
            where.append("model = ?")
            args.append(q["model"])
        if q.get("since"):
            where.append("day >= ?")
            args.append(q["since"])
        if q.get("until"):
            where.append("day <= ?")
            args.append(q["until"])
        if q.get("q"):
            where.append(
                "(title LIKE ? OR project LIKE ? OR first_prompt LIKE ? "
                "OR last_prompt LIKE ?)"
            )
            args.extend([f"%{q['q']}%"] * 4)
        return (" WHERE " + " AND ".join(where) if where else ""), args

    def api_overview(self, q: dict) -> None:
        clause, args = self._filters(q)
        totals = self.rows(
            f"""SELECT COUNT(*) sessions,
                       COALESCE(SUM(input_tokens),0)  input_tokens,
                       COALESCE(SUM(output_tokens),0) output_tokens,
                       COALESCE(SUM(cache_read),0)    cache_read,
                       COALESCE(SUM(cache_write),0)   cache_write,
                       COALESCE(SUM(total_tokens),0)  total_tokens,
                       COALESCE(SUM(cost_usd),0)      cost_usd,
                       COALESCE(SUM(n_messages),0)    messages,
                       COALESCE(SUM(n_tool_calls),0)  tool_calls,
                       COALESCE(SUM(duration_s),0)    duration_s,
                       COALESCE(SUM(file_size),0)     bytes,
                       SUM(unpriced)                  unpriced
                FROM sessions{clause}""",
            args,
        )[0]
        return self.json({
            "totals": totals,
            "by_agent": self.rows(
                f"""SELECT agent, COUNT(*) sessions,
                           COALESCE(SUM(total_tokens),0) tokens,
                           COALESCE(SUM(cost_usd),0) cost_usd,
                           COALESCE(SUM(n_tool_calls),0) tool_calls
                    FROM sessions{clause} GROUP BY agent ORDER BY sessions DESC""",
                args,
            ),
            "by_day": self.rows(
                f"""SELECT day, agent, COUNT(*) sessions,
                           COALESCE(SUM(total_tokens),0) tokens,
                           COALESCE(SUM(cost_usd),0) cost_usd
                    FROM sessions{clause}{' AND' if clause else ' WHERE'}
                         day IS NOT NULL
                    GROUP BY day, agent ORDER BY day""",
                args,
            ),
            "by_project": self.rows(
                f"""SELECT project, COUNT(*) sessions,
                           COALESCE(SUM(total_tokens),0) tokens,
                           COALESCE(SUM(cost_usd),0) cost_usd
                    FROM sessions{clause}{' AND' if clause else ' WHERE'}
                         project IS NOT NULL
                    GROUP BY project ORDER BY tokens DESC LIMIT 12""",
                args,
            ),
            "by_model": self.rows(
                f"""SELECT model, agent, COUNT(*) sessions,
                           COALESCE(SUM(total_tokens),0) tokens,
                           COALESCE(SUM(cost_usd),0) cost_usd
                    FROM sessions{clause}{' AND' if clause else ' WHERE'}
                         model IS NOT NULL
                    GROUP BY model ORDER BY tokens DESC""",
                args,
            ),
            "by_hour": self.rows(
                f"""SELECT CAST(strftime('%H', started_at) AS INTEGER) hour,
                           COUNT(*) sessions
                    FROM sessions{clause}{' AND' if clause else ' WHERE'}
                         started_at IS NOT NULL
                    GROUP BY hour ORDER BY hour""",
                args,
            ),
            "top_tools": self.rows(
                """SELECT tool_name, COUNT(*) n FROM messages
                   WHERE kind='tool_use' AND tool_name IS NOT NULL
                   GROUP BY tool_name ORDER BY n DESC LIMIT 15"""
            ),
        })

    # -- projects ---------------------------------------------------------
    def _project_rows(self, q: dict) -> list[dict]:
        """One row per project, newest activity first.

        cwd is the directory of that project's most recent session: a project
        can be reached from more than one path over its life (moved, renamed,
        a worktree), and the latest one is the one worth opening.
        """
        clause, args = self._filters({k: v for k, v in q.items() if k != "project"})
        rows = self.rows(
            f"""SELECT project,
                       COUNT(*)                        sessions,
                       COALESCE(SUM(total_tokens),0)   tokens,
                       COALESCE(SUM(cost_usd),0)       cost_usd,
                       COALESCE(SUM(n_messages),0)     messages,
                       COALESCE(SUM(n_tool_calls),0)   tool_calls,
                       COALESCE(SUM(duration_s),0)     duration_s,
                       MIN(started_at)                 first_at,
                       MAX(started_at)                 last_at,
                       COUNT(DISTINCT agent)           n_agents,
                       GROUP_CONCAT(DISTINCT agent)    agents,
                       (SELECT s2.cwd FROM sessions s2
                         WHERE s2.project = sessions.project AND s2.cwd IS NOT NULL
                         ORDER BY s2.started_at DESC LIMIT 1) cwd
                FROM sessions{clause}{' AND' if clause else ' WHERE'}
                     project IS NOT NULL
                GROUP BY project
                ORDER BY last_at IS NULL, last_at DESC""",
            args,
        )
        for r in rows:
            r["agents"] = sorted((r.get("agents") or "").split(",")) if r.get("agents") else []
            cwd = r.get("cwd")
            r["exists"] = bool(cwd and os.path.isdir(cwd))
            r["parent"] = os.path.dirname(cwd) if cwd else ""
        return rows

    def api_projects(self, q: dict) -> None:
        rows = self._project_rows(q)
        self.json({
            "projects": rows,
            "total": len(rows),
            "launch": self.launch_info(),
        })

    def api_project(self, name: str) -> None:
        rows = [r for r in self._project_rows({}) if r["project"] == name]
        if not rows:
            return self.json({"error": "no such project"}, 404)
        proj = rows[0]
        proj["paths"] = self.rows(
            """SELECT cwd, COUNT(*) sessions, MAX(started_at) last_at
               FROM sessions WHERE project = ? AND cwd IS NOT NULL
               GROUP BY cwd ORDER BY last_at DESC""",
            (name,),
        )
        for p in proj["paths"]:
            p["exists"] = bool(p["cwd"] and os.path.isdir(p["cwd"]))
        proj["branches"] = self.rows(
            """SELECT git_branch, COUNT(*) sessions FROM sessions
               WHERE project = ? AND git_branch IS NOT NULL
               GROUP BY git_branch ORDER BY sessions DESC LIMIT 8""",
            (name,),
        )
        proj["by_day"] = self.rows(
            """SELECT day, COUNT(*) sessions, COALESCE(SUM(total_tokens),0) tokens
               FROM sessions WHERE project = ? AND day IS NOT NULL
               GROUP BY day ORDER BY day""",
            (name,),
        )
        proj["launch"] = self.launch_info()
        self.json(proj)

    # -- launching a terminal ---------------------------------------------
    def launch_info(self) -> dict:
        return {
            "token": LAUNCH_TOKEN,
            "terminals": launcher.available_terminals(),
            "commands": [{"key": k, "command": v[0], "label": v[1]}
                         for k, v in LAUNCH_COMMANDS.items()],
        }

    def api_launch(self) -> None:
        if not self._same_origin():
            return self.json({"error": "cross-origin request refused"}, 403)
        body = self._body()
        if body.get("token") != LAUNCH_TOKEN:
            return self.json({"error": "bad or missing launch token"}, 403)

        entry = LAUNCH_COMMANDS.get(body.get("command") or "claude")
        if not entry:
            return self.json({"error": "unknown command"}, 400)
        command = entry[0]
        if command == "$SHELL":
            command = os.environ.get("SHELL") or "/bin/sh"

        # The directory must be one this index has actually seen. A request
        # cannot name a path of its own choosing.
        cwd = body.get("cwd") or ""
        known = self.rows("SELECT 1 FROM sessions WHERE cwd = ? LIMIT 1", (cwd,))
        if not known:
            return self.json({"error": "that directory is not in the index"}, 400)

        try:
            result = launcher.launch(cwd, command, body.get("terminal"))
        except launcher.LaunchError as exc:
            return self.json({"error": str(exc)}, 400)
        self.json({"ok": True, **result})

    def api_sessions(self, q: dict) -> None:
        clause, args = self._filters(q)
        col = SORT_COLUMNS.get(q.get("sort", "started"), "started_at")
        order = "ASC" if q.get("order", "desc").lower() == "asc" else "DESC"
        limit = min(int(q.get("limit", 50)), 500)
        offset = max(int(q.get("offset", 0)), 0)
        total = self.rows(f"SELECT COUNT(*) n FROM sessions{clause}", args)[0]["n"]
        rows = self.rows(
            f"""SELECT key, agent, session_id, title, project, cwd, git_branch,
                       model, models, started_at, ended_at, duration_s,
                       n_messages, n_user, n_assistant, n_tool_calls,
                       input_tokens, output_tokens, cache_read, cache_write,
                       total_tokens, cost_usd, unpriced, file_size, first_prompt
                FROM sessions{clause}
                ORDER BY {col} IS NULL, {col} {order}
                LIMIT ? OFFSET ?""",
            (*args, limit, offset),
        )
        self.json({"total": total, "limit": limit, "offset": offset, "sessions": rows})

    def api_session(self, key: str) -> None:
        rows = self.rows("SELECT * FROM sessions WHERE key = ?", (key,))
        if not rows:
            return self.json({"error": "no such session"}, 404)
        sess = rows[0]
        sess["kinds"] = self.rows(
            "SELECT kind, COUNT(*) n FROM messages WHERE session_key=? "
            "GROUP BY kind ORDER BY n DESC",
            (key,),
        )
        sess["tools"] = self.rows(
            "SELECT tool_name, COUNT(*) n FROM messages WHERE session_key=? "
            "AND kind='tool_use' AND tool_name IS NOT NULL "
            "GROUP BY tool_name ORDER BY n DESC",
            (key,),
        )
        self.json(sess)

    def api_messages(self, key: str, q: dict) -> None:
        where, args = ["session_key = ?"], [key]
        if q.get("role"):
            where.append("role = ?")
            args.append(q["role"])
        if q.get("kind"):
            where.append("kind = ?")
            args.append(q["kind"])
        if q.get("q"):
            where.append("text LIKE ?")
            args.append(f"%{q['q']}%")
        clause = " WHERE " + " AND ".join(where)
        limit = min(int(q.get("limit", 200)), 1000)
        offset = max(int(q.get("offset", 0)), 0)
        total = self.rows(f"SELECT COUNT(*) n FROM messages{clause}", args)[0]["n"]
        rows = self.rows(
            f"""SELECT id, seq, ts, role, kind, tool_name, model, truncated,
                       sidechain, label, text
                FROM messages{clause} ORDER BY seq LIMIT ? OFFSET ?""",
            (*args, limit, offset),
        )
        self.json({"total": total, "limit": limit, "offset": offset, "messages": rows})

    def api_search(self, q: dict) -> None:
        raw = (q.get("q") or "").strip()
        if not raw:
            return self.json({"results": [], "total": 0})
        limit = min(int(q.get("limit", 60)), 300)
        agent = q.get("agent")

        if idx.has_fts(self.db):
            sql = """SELECT m.id, m.session_key, m.seq, m.role, m.kind, m.ts,
                            s.title, s.agent, s.project,
                            snippet(messages_fts, 0, '‹', '›', '…', 18) snip
                     FROM messages_fts
                     JOIN messages m ON m.id = messages_fts.rowid
                     JOIN sessions s ON s.key = m.session_key
                     WHERE messages_fts MATCH ?"""
            args = [_fts_query(raw)]
            if agent:
                sql += " AND s.agent = ?"
                args.append(agent)
            sql += " ORDER BY rank LIMIT ?"
            args.append(limit)
            try:
                return self.json({"results": self.rows(sql, args), "fts": True})
            except sqlite3.OperationalError:
                pass  # malformed MATCH expression: fall through to LIKE

        sql = """SELECT m.id, m.session_key, m.seq, m.role, m.kind, m.ts,
                        s.title, s.agent, s.project,
                        substr(m.text, 1, 240) snip
                 FROM messages m JOIN sessions s ON s.key = m.session_key
                 WHERE m.text LIKE ?"""
        args = [f"%{raw}%"]
        if agent:
            sql += " AND s.agent = ?"
            args.append(agent)
        sql += " LIMIT ?"
        args.append(limit)
        self.json({"results": self.rows(sql, args), "fts": False})


def serve(host: str, port: int, home: str) -> None:
    Handler.home = home
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.serve_forever()
