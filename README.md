# agent-sessions

Reads the transcripts your AI coding agents already write to disk — **Claude Code**
and **Codex** — indexes them into SQLite, and serves a local dashboard: usage over
time, token and cost breakdowns, a browsable session list, full transcripts, and
full-text search across everything.

Nothing leaves your machine. Python 3 standard library only — no pip install, no
Node, no network calls.

```sh
./agent-sessions            # index if needed, then open the dashboard
```

## Commands

| Command | What it does |
|---|---|
| `./agent-sessions` | Serve the dashboard (indexes first if the database is missing) |
| `./agent-sessions serve --reindex` | Refresh the index, then serve |
| `./agent-sessions index` | Scan transcripts into the database and exit |
| `./agent-sessions index --force` | Re-parse everything, ignoring the change check |
| `./agent-sessions stats` | Print summary tables to the terminal |
| `./agent-sessions stats --since 2026-08-01` | Same, limited to a date range |

Useful flags: `--port 9000`, `--host 0.0.0.0`, `--no-browser`,
`--home <dir>` (where the database lives; default `~/.agent-sessions`).

## What it reads

| Agent | Location | Notes |
|---|---|---|
| Claude Code | `~/.claude/projects/<encoded-cwd>/<session>.jsonl` | Plus every subagent transcript under `<session>/subagents/**` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | Titles come from `~/.codex/session_index.jsonl` when present |

Read-only: the tool never writes to, moves, or deletes an agent's own files.
Everything it produces lives in `~/.agent-sessions/`, and that directory can be
deleted at any time — the next run rebuilds it from the transcripts.

Indexing is incremental. A transcript whose size and mtime are unchanged is
skipped, so a refresh after a day's work takes a second or two.

## Three things it gets right that a naive parser gets wrong

These are the details that decide whether the numbers mean anything.

**1. Claude repeats `usage` on every content block.** Claude Code writes one JSONL
record per content block, and every record belonging to the same assistant turn
carries the same `message.id` *and the same `usage` object*. Summing usage across
records overcounts tokens by roughly the number of blocks per turn — about 2.2×
on real transcripts. Usage is counted once per distinct `message.id`.

**2. Codex reports cumulative token counts.** `event_msg/token_count` carries
`info.total_token_usage`, which is a running total for the whole session, not a
per-turn delta. Summing those records multiplies the true total by the number of
turns. The final (largest) snapshot is used instead. Its `input_tokens` is
inclusive of `cached_input_tokens`, so uncached input is the difference.

**3. Subagent spend belongs to the session that caused it.** Claude Code stores
Task subagents and workflow agents in separate files under
`<session>/subagents/`, each with its own real `usage` but the *parent's*
`sessionId`. Ignore those files and a session with 53 subagents reports a
fraction of what it actually cost. They are folded into the parent session and
their turns interleave into the transcript by timestamp, tagged with which
subagent produced them.

## Cost

Costs are an **estimate at published API list rates**, computed from the recorded
usage — not a bill. If you use Claude Code on a subscription plan, your tokens are
not billed per token at all; the figure answers "what would this usage have cost
through the API", which is the useful number for comparing sessions, projects and
models against each other.

Cache tokens are priced properly: reads at 0.1× the model's input rate, writes at
1.25× (5-minute TTL) or 2× (1-hour TTL), using the TTL split Claude records when
it is present. On long agent sessions cache reads are usually >95% of all tokens,
so treating them as ordinary input would overstate cost by roughly 10×.

Anthropic model prices ship built in. **OpenAI/Codex prices deliberately do not** —
rather than guess, those sessions are shown with full token counts and marked
"no price". Add them yourself and they start reporting cost:

```json
// ~/.agent-sessions/prices.json    — USD per million tokens
{
  "gpt-5.6-sol":   {"input": 1.25, "output": 10.0},
  "gpt-5.3-codex": {"input": 1.25, "output": 10.0}
}
```

Model ids match by longest prefix, so `claude-haiku-4-5-20251001` resolves to the
`claude-haiku-4-5` entry. Re-run `index --force` after editing prices.

## The dashboard

A warm dashboard UI — cream canvas, near-white cards, one orange accent, big
display figures. Navigation is a row of pill tabs in the top bar; the page
header carries the title plus an inline KPI strip with period-over-period
change. Sans-serif throughout; monospace only for code and raw transcript text.

- **Overview** — session/token/cost/tool-call tiles, daily activity stacked by
  agent (switchable between tokens, sessions and cost), token composition,
  hour-of-day histogram, and rankings by project, model and tool.
- **All sessions** — sortable table; click any row for the full transcript.
- **Session** — metadata, per-session token composition and tool usage, and the
  complete transcript: prompts, replies, thinking, tool calls and results, with
  subagent turns interleaved and labelled. Filter by message kind or by substring.
  **Raw text** switches the whole transcript back to exactly what is stored.
  **Export** writes the session out as Markdown, standalone HTML, or PDF, or
  copies it to the clipboard — see below.
- **Search** — SQLite FTS5 across every indexed message, with highlighted
  snippets that link back into the session.

The KPI strip's delta compares the last 30 days with the 30 before, computed
from the daily series. It is **omitted entirely when there is no comparable
earlier window** rather than shown against an invented baseline, and a change
past a doubling is written as a multiplier (`21.0x`) because `+2000%` is
technically correct and practically unreadable.

Light and dark themes both ship; the toggle overrides your OS setting and
persists. Chart colours are a CVD-validated categorical palette, and every ink
and syntax colour clears WCAG AA (≥4.5:1) on every surface it sits on — the
palette is re-validated whenever the surfaces change, not assumed.

### Keyboard

| Key | Does |
|---|---|
| `⌘K` / `Ctrl-K` | Command palette — fuzzy jump to any session, or run a command |
| `/` | Open the command palette |
| `1` `2` `3` | Overview / All sessions / Search |
| `t` | Toggle light / dark |
| `r` | Refresh the index |
| `esc` | Close the palette, or leave the current field |

### Export

The **Export** menu on a session offers:

| Option | Result |
|---|---|
| Copy as Markdown | The whole session on the clipboard, ready to paste into an issue or a doc |
| Download Markdown | `.md` file — prose as written, tool calls as fenced code in their real language |
| Download HTML | A single self-contained `.html` file: inline CSS, syntax highlighting, no network needed |
| Print / Save as PDF | The same HTML, print-styled, handed to the browser's PDF writer |

Two things worth knowing:

- **Exports contain the entire session, not the part you have scrolled to.** The
  transcript view loads 150 messages at a time; the exporter paginates the whole
  session first, so a 5,000-message session exports all 5,000.
- **PDF goes through the browser's print dialog** rather than a bundled PDF
  engine. That keeps the zero-dependency promise; choose "Save as PDF" as the
  destination. The `@media print` rules avoid splitting a message across pages.

Markdown output keeps tool calls readable rather than dumping JSON: a `Bash`
call becomes a shell block, a `Write` becomes the file path plus its content
fenced in the language its extension implies, an `Edit` becomes before/after
blocks. Fences are widened when the content itself contains backticks, so
wrapped output can never terminate its own code block.

### Transcript formatting

Messages are rendered rather than dumped as raw text, by message kind:

| Kind | Rendered as |
|---|---|
| user / assistant / thinking | Markdown — headings, lists, tables, quotes, links, inline code, fenced code blocks with syntax highlighting |
| `tool_use` | The call in the form it was written: `Bash` as a shell block with its description, `Write` as the file path plus its content highlighted by extension, `Edit` as before/after blocks, read-only tools as a parameter list, anything else as pretty-printed JSON |
| `tool_result` | Monospace block; unified diffs are detected and highlighted |
| system | The CLI's own wrapper markup (`<command-name>`, `<local-command-stdout>`) unwrapped to plain text |

The markdown renderer and highlighter are hand-written (`web/render.js`, ~350
lines, no dependencies) and cover js/ts, python, shell, json, sql, go, rust,
java, css, html, yaml and diff, falling back to a generic grammar otherwise.

Two things it is careful about, since transcripts contain arbitrary text:

- **Everything is escaped before any markup is emitted**, so a message
  containing `<script>` or a `javascript:` link renders as literal text and
  never as live markup. `node test_render.js` asserts this (41 assertions,
  including the injection cases).
- **A rendering failure never hides a message** — if the renderer throws, that
  message falls back to plain text instead of disappearing.

Syntax colours are their own light/dark token set; every one clears WCAG AA
(≥4.5:1) against the code surface in both themes, comments being the floor at
4.80 light / 5.44 dark.

## Layout

```
agent-sessions            launcher
test_render.js            renderer tests — node test_render.js
agent_sessions/
  cli.py                  index / serve / stats
  discovery.py            find transcripts, group sessions with their subagents
  index.py                SQLite schema + incremental indexing
  server.py               JSON API + static file serving
  pricing.py              model price table and cost estimation
  parsers/
    base.py               shared shapes, text caps, prompt cleaning
    claude.py             Claude Code JSONL
    codex.py              Codex rollout JSONL
  web/
    index.html            page shell
    style.css             tokens, layout, chart + syntax colours
    render.js             markdown renderer + syntax highlighter
    app.js                routing, charts, views
```

## Notes and limits

- Message text is capped in the index — 16 KB per message, 4 KB per tool result.
  Anything longer is marked "truncated in the index"; the original transcript on
  disk is untouched and complete.
- Records with no text are not indexed. Recent Claude models return `thinking`
  blocks with empty content unless the request sets `display: "summarized"`, and
  those accounted for ~17% of all raw records — they are dropped rather than
  filling the transcript with blank rows. Thinking still shows up in the token
  and cost figures, which are computed from `usage`, not from message bodies.
- **Wall clock** sums each session's first-to-last-record span. Sessions that
  overlap in time are counted twice, and an idle session left open still counts,
  so read it as "elapsed time sessions were open", not time spent working.
- The database is roughly a sixth the size of the transcripts it indexes
  (~110 MB for ~640 MB of transcripts), most of it the full-text search index.
- If your SQLite lacks FTS5, search silently falls back to substring matching.
