/* Transcript rendering: markdown + syntax highlighting, no dependencies.
   Everything here escapes first and emits spans second, so source text can
   never leak into the DOM as markup. */

/* ---------- escaping ---------------------------------------------------- */

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- syntax highlighting ----------------------------------------- */
/* Token classes: c comment · s string · n number · k keyword · b builtin
   f function · a attribute · t tag · v variable · ins added · del removed
   · h hunk. Each spec's regex must use ONLY non-capturing groups, so the
   matched alternative can be identified by capture-group index. */

const KEYWORDS = {
  js: "const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|class|extends|super|new|this|typeof|instanceof|in|of|delete|void|yield|async|await|import|export|from|default|try|catch|finally|throw|static|get|set|null|undefined|true|false",
  ts: "interface|type|enum|implements|public|private|protected|readonly|abstract|declare|namespace|as|satisfies|keyof|infer|never|unknown|any",
  py: "def|class|return|if|elif|else|for|while|import|from|as|pass|break|continue|with|try|except|finally|raise|lambda|yield|global|nonlocal|assert|del|not|and|or|is|in|None|True|False|async|await|match|case|self",
  sh: "if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|readonly|declare|set|unset|source|shift|trap|exit|alias",
  sql: "select|from|where|insert|into|values|update|set|delete|create|table|view|drop|alter|add|column|index|join|left|right|inner|outer|full|on|group|by|order|asc|desc|limit|offset|having|union|all|as|distinct|and|or|not|null|is|in|like|between|case|when|then|end|primary|key|foreign|references|default|with|returning",
  go: "func|package|import|var|const|type|struct|interface|return|if|else|for|range|go|defer|chan|select|switch|case|break|continue|map|nil|true|false|make|new",
  rust: "fn|let|mut|const|static|struct|enum|impl|trait|use|pub|mod|match|if|else|for|while|loop|return|self|Self|crate|super|where|as|dyn|ref|move|async|await|true|false|Some|None|Ok|Err",
  java: "public|private|protected|class|interface|extends|implements|static|final|void|return|new|if|else|for|while|try|catch|finally|throw|throws|import|package|this|super|null|true|false|abstract|synchronized|enum|record",
};

const RX = {
  slashLine: "\\/\\/[^\\n]*",
  hashLine: "#[^\\n]*",
  dashLine: "--[^\\n]*",
  block: "\\/\\*[\\s\\S]*?\\*\\/",
  dq: '"(?:\\\\.|[^"\\\\])*"',
  sq: "'(?:\\\\.|[^'\\\\])*'",
  tick: "`(?:\\\\.|[^`\\\\])*`",
  pyTriple: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'',
  num: "\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b",
  fn: "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()",
};

const kw = (words) => `\\b(?:${words})\\b`;

function grammar(specs) {
  return {
    types: specs.map((s) => s[0]),
    source: specs.map((s) => `(${s[1]})`).join("|"),
  };
}

const GRAMMARS = {
  clike: grammar([
    ["c", `${RX.block}|${RX.slashLine}`],
    ["s", `${RX.dq}|${RX.sq}|${RX.tick}`],
    ["k", kw(KEYWORDS.js + "|" + KEYWORDS.ts)],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  py: grammar([
    ["s", RX.pyTriple],
    ["c", RX.hashLine],
    ["s", `${RX.dq}|${RX.sq}`],
    ["a", "@[A-Za-z_][\\w.]*"],
    ["k", kw(KEYWORDS.py)],
    ["b", "\\b(?:print|len|range|str|int|float|dict|list|set|tuple|open|enumerate|zip|map|filter|sum|min|max|sorted|isinstance|type|super|Exception)\\b"],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  sh: grammar([
    ["c", RX.hashLine],
    ["s", `${RX.dq}|${RX.sq}`],
    ["v", "\\$(?:\\{[^}]*\\}|[A-Za-z_][\\w]*|[0-9@*#?$!])"],
    ["k", kw(KEYWORDS.sh)],
    ["a", "(?:^|\\s)--?[A-Za-z][\\w-]*"],
    ["n", RX.num],
  ]),
  json: grammar([
    ["a", '"(?:\\\\.|[^"\\\\])*"(?=\\s*:)'],
    ["s", RX.dq],
    ["k", "\\b(?:true|false|null)\\b"],
    ["n", RX.num],
  ]),
  sql: grammar([
    ["c", `${RX.dashLine}|${RX.block}`],
    ["s", `${RX.sq}|${RX.dq}`],
    ["k", `\\b(?:${KEYWORDS.sql})\\b`],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  go: grammar([
    ["c", `${RX.block}|${RX.slashLine}`],
    ["s", `${RX.dq}|${RX.tick}|${RX.sq}`],
    ["k", kw(KEYWORDS.go)],
    ["b", "\\b(?:string|int|int8|int16|int32|int64|uint|uint8|byte|rune|float32|float64|bool|error|any)\\b"],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  rust: grammar([
    ["c", `${RX.block}|${RX.slashLine}`],
    ["s", `${RX.dq}|${RX.sq}`],
    ["a", "#!?\\[[^\\]]*\\]"],
    ["k", kw(KEYWORDS.rust)],
    ["b", "\\b(?:String|str|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|bool|char|Vec|Option|Result|Box)\\b"],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  java: grammar([
    ["c", `${RX.block}|${RX.slashLine}`],
    ["s", `${RX.dq}|${RX.sq}`],
    ["a", "@[A-Za-z_][\\w.]*"],
    ["k", kw(KEYWORDS.java)],
    ["b", "\\b(?:int|long|double|float|boolean|char|byte|short|String|List|Map|Set|var)\\b"],
    ["n", RX.num],
    ["f", RX.fn],
  ]),
  css: grammar([
    ["c", RX.block],
    ["s", `${RX.dq}|${RX.sq}`],
    ["a", "(?:^|[;{\\s])--?[A-Za-z-][\\w-]*(?=\\s*:)"],
    ["t", "(?:^|\\})\\s*[^{};\\n]+(?=\\s*\\{)"],
    ["k", "@[A-Za-z-]+"],
    ["n", "\\b\\d+(?:\\.\\d+)?(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\\b|#[0-9a-fA-F]{3,8}\\b"],
  ]),
  html: grammar([
    ["c", "<!--[\\s\\S]*?-->"],
    ["t", "<\\/?[A-Za-z][\\w:-]*"],
    ["s", `${RX.dq}|${RX.sq}`],
    ["a", "\\b[A-Za-z-][\\w:-]*(?=\\s*=)"],
    ["t", "\\/?>"],
  ]),
  yaml: grammar([
    ["c", RX.hashLine],
    ["a", "^\\s*(?:-\\s*)?[A-Za-z_][\\w.-]*(?=\\s*:)"],
    ["s", `${RX.dq}|${RX.sq}`],
    ["k", "\\b(?:true|false|null|yes|no|on|off)\\b"],
    ["n", RX.num],
  ]),
  diff: grammar([
    ["h", "^@@[^\\n]*"],
    ["c", "^(?:diff|index|---|\\+\\+\\+)[^\\n]*"],
    ["ins", "^\\+[^\\n]*"],
    ["del", "^-[^\\n]*"],
  ]),
  default: grammar([
    ["c", `${RX.block}|${RX.slashLine}|${RX.hashLine}`],
    ["s", `${RX.dq}|${RX.sq}|${RX.tick}`],
    ["n", RX.num],
  ]),
};

// Compile lazily: a fresh RegExp per call keeps lastIndex state private.
const ALIASES = {
  js: "clike", jsx: "clike", ts: "clike", tsx: "clike", mjs: "clike",
  javascript: "clike", typescript: "clike", c: "clike", h: "clike",
  cpp: "clike", cc: "clike", hpp: "clike", cs: "clike", swift: "clike",
  kotlin: "clike", kt: "clike", scala: "clike", php: "clike", dart: "clike",
  python: "py", py: "py", rb: "py", ruby: "py",
  sh: "sh", bash: "sh", zsh: "sh", shell: "sh", console: "sh", fish: "sh",
  json: "json", jsonc: "json", json5: "json",
  sql: "sql", go: "go", golang: "go", rust: "rust", rs: "rust",
  java: "java", css: "css", scss: "css", less: "css",
  html: "html", xml: "html", svg: "html", vue: "html",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml", conf: "yaml",
  diff: "diff", patch: "diff",
};

function grammarFor(lang) {
  const key = ALIASES[String(lang || "").toLowerCase().trim()];
  return GRAMMARS[key] || GRAMMARS.default;
}

function highlight(code, lang) {
  const g = grammarFor(lang);
  const re = new RegExp(g.source, "gm");
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) out += escHtml(code.slice(last, m.index));
    let type = "p";
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) { type = g.types[i - 1]; break; }
    }
    out += `<span class="tok-${type}">${escHtml(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  return out + escHtml(code.slice(last));
}

/** Guess a language from a file path, for code we render outside a fence. */
function langFromPath(path) {
  const ext = String(path || "").split(/[\\/]/).pop().split(".").pop().toLowerCase();
  const name = String(path || "").split(/[\\/]/).pop().toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile")) return "sh";
  if (name === "makefile") return "sh";
  return ALIASES[ext] ? ext : "";
}

function codeBlock(code, lang, label) {
  const text = String(code ?? "").replace(/\s+$/, "");
  return (
    `<div class="codewrap">` +
    (label ? `<div class="codelabel">${escHtml(label)}</div>` : "") +
    `<pre class="code"><code>${highlight(text, lang)}</code></pre></div>`
  );
}

/* ---------- markdown ----------------------------------------------------- */

// Placeholder delimited by NUL (written as an escape, never a literal byte):
// it cannot occur in transcript text and survives HTML escaping untouched.
const MARK = (i) => `\u0000C${i}\u0000`;
const MARK_RE = /\u0000C(\d+)\u0000/g;

function inline(text) {
  // Pull code spans out first so their contents are never re-parsed.
  const spans = [];
  let s = String(text).replace(/(`+)([\s\S]*?)\1/g, (_m, _ticks, body) => {
    spans.push(body);
    return MARK(spans.length - 1);
  });

  s = escHtml(s);
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>")
       .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
       .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
       .replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // [label](url) then bare URLs; only safe schemes become links.
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, url) =>
    /^(https?:|mailto:|#|\/)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label || url}</a>`
      : m);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  MARK_RE.lastIndex = 0;
  return s.replace(MARK_RE, (_m, i) => `<code>${escHtml(spans[Number(i)])}</code>`);
}

const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+.-]*)\s*$/;
const RE_HEAD = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RE_HR = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const RE_UL = /^(\s*)[-*+]\s+(.*)$/;
const RE_OL = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:-]*-[\s|:-]*\|?\s*$/;

/** Minimal CommonMark-ish renderer: enough for what agents actually write. */
function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  let out = "";
  let i = 0;

  const paragraphBreak = (l) =>
    l.trim() === "" || RE_FENCE.test(l) || RE_HEAD.test(l) || RE_HR.test(l) ||
    RE_UL.test(l) || RE_OL.test(l) || RE_QUOTE.test(l);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") { i++; continue; }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const close = fence[1][0];
      const body = [];
      i++;
      while (i < lines.length &&
             !(lines[i].trimStart().startsWith(close.repeat(3)) &&
               RE_FENCE.test(lines[i]))) {
        body.push(lines[i]); i++;
      }
      i++; // closing fence
      out += codeBlock(body.join("\n"), fence[2]);
      continue;
    }

    const head = line.match(RE_HEAD);
    if (head) {
      const level = Math.min(head[1].length + 2, 6); // h1 in a message == h3 on page
      out += `<h${level}>${inline(head[2])}</h${level}>`;
      i++; continue;
    }

    if (RE_HR.test(line)) { out += "<hr>"; i++; continue; }

    if (RE_QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        body.push(lines[i].match(RE_QUOTE)[1]); i++;
      }
      out += `<blockquote>${renderMarkdown(body.join("\n"))}</blockquote>`;
      continue;
    }

    // GFM pipe table
    if (line.includes("|") && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1])) {
      const cells = (l) =>
        l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const cols = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(cells(lines[i])); i++;
      }
      out += `<div class="mdtable-scroll"><table class="mdtable"><thead><tr>` +
        cols.map((c) => `<th>${inline(c)}</th>`).join("") +
        `</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
        `</tbody></table></div>`;
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line);
      const items = [];
      while (i < lines.length && (RE_UL.test(lines[i]) || RE_OL.test(lines[i]))) {
        const m = lines[i].match(ordered ? RE_OL : RE_UL);
        if (!m) break;
        let body = ordered ? m[3] : m[2];
        i++;
        // Fold indented continuation lines into the item.
        while (i < lines.length && lines[i].trim() !== "" &&
               /^\s{2,}/.test(lines[i]) && !RE_UL.test(lines[i]) && !RE_OL.test(lines[i])) {
          body += "\n" + lines[i].trim(); i++;
        }
        items.push(`<li>${inline(body)}</li>`);
      }
      out += ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`;
      continue;
    }

    const para = [];
    while (i < lines.length && !paragraphBreak(lines[i])) { para.push(lines[i]); i++; }
    if (para.length) out += `<p>${inline(para.join("\n"))}</p>`;
  }
  return out;
}

/* ---------- tool calls --------------------------------------------------- */

const PARAM_ONLY = new Set([
  "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite",
  "TaskCreate", "TaskUpdate", "ToolSearch", "Skill",
]);

function paramList(obj, skip = []) {
  const rows = Object.entries(obj)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<div class="param"><span class="pk">${escHtml(k)}</span>` +
             `<span class="pv">${escHtml(val.length > 400 ? val.slice(0, 400) + "…" : val)}</span></div>`;
    });
  return rows.length ? `<div class="params">${rows.join("")}</div>` : "";
}

/** Render a tool invocation the way a reader wants it, not as raw JSON. */
function renderToolUse(name, raw) {
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return codeBlock(raw, "json");
  }
  if (!args || typeof args !== "object") return codeBlock(raw, "json");

  const tool = String(name || "");

  // Shell commands read best as shell.
  if (typeof args.command === "string" && /bash|shell|exec|run/i.test(tool || "bash")) {
    return (args.description ? `<div class="toolnote">${escHtml(args.description)}</div>` : "") +
      codeBlock(args.command, "sh");
  }

  // File writes: show the path, then the content as code.
  if (typeof args.content === "string" && typeof args.file_path === "string") {
    return paramList(args, ["content"]) +
      codeBlock(args.content, langFromPath(args.file_path), args.file_path);
  }

  // Edits: the replacement is the point — show both sides.
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    const lang = langFromPath(args.file_path);
    return paramList(args, ["old_string", "new_string"]) +
      codeBlock(args.old_string, lang, "replace") +
      codeBlock(args.new_string, lang, "with");
  }

  if (PARAM_ONLY.has(tool)) {
    const list = paramList(args);
    if (list) return list;
  }
  return codeBlock(JSON.stringify(args, null, 2), "json");
}

/** System records: unwrap the CLI's own markup so it reads as plain text. */
function renderSystem(text) {
  const s = String(text ?? "")
    .replace(/<command-name>\s*([\s\S]*?)\s*<\/command-name>/g, "$1")
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, "")
    .replace(/<command-args>\s*([\s\S]*?)\s*<\/command-args>/g, " $1")
    .replace(/<\/?(?:local-command-stdout|local-command-caveat|system-reminder)>/g, "")
    .trim();
  return renderMarkdown(s);
}

/** Tool output: detect diffs, otherwise plain monospace. */
function renderToolResult(text) {
  const s = String(text ?? "");
  const isDiff = /^(?:diff --git|@@ )/m.test(s) ||
    (/^\+/m.test(s) && /^-/m.test(s) && /^(?:---|\+\+\+)/m.test(s));
  return codeBlock(s, isDiff ? "diff" : "");
}

/* ---------- export ------------------------------------------------------- */

/** A fence long enough that the content can never terminate it early. */
function fenceFor(text) {
  let longest = 0;
  for (const run of String(text).match(/`+/g) || []) {
    longest = Math.max(longest, run.length);
  }
  return "`".repeat(Math.max(3, longest + 1));
}

function mdCode(text, lang = "") {
  const body = String(text ?? "").replace(/\s+$/, "");
  const f = fenceFor(body);
  return `${f}${lang}\n${body}\n${f}\n`;
}

function speakerOf(m) {
  if (m.kind === "tool_use") return `Tool call — ${m.tool_name || "tool"}`;
  if (m.kind === "tool_result") return "Tool result";
  if (m.kind === "thinking") return "Thinking";
  if (m.role === "system") return "System";
  return m.role === "user" ? "User" : "Assistant";
}

function stamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return isNaN(d) ? "" : d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

/** Arguments of a tool call, as the code it actually represents. */
function toolCallMarkdown(m) {
  let args;
  try {
    args = JSON.parse(m.text || "");
  } catch {
    return mdCode(m.text || "", "json");
  }
  if (!args || typeof args !== "object") return mdCode(m.text || "", "json");

  if (typeof args.command === "string") {
    return (args.description ? `_${args.description}_\n\n` : "") +
           mdCode(args.command, "sh");
  }
  if (typeof args.content === "string" && typeof args.file_path === "string") {
    return `\`${args.file_path}\`\n\n` +
           mdCode(args.content, langFromPath(args.file_path));
  }
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    const lang = langFromPath(args.file_path);
    return `\`${args.file_path || ""}\`\n\nReplace:\n\n` + mdCode(args.old_string, lang) +
           `\nWith:\n\n` + mdCode(args.new_string, lang);
  }
  return mdCode(JSON.stringify(args, null, 2), "json");
}

/** Whole session as Markdown — the format that also feeds "copy". */
function sessionToMarkdown(session, messages) {
  const meta = [
    ["Agent", session.agent],
    ["Model", session.model],
    ["Project", session.project],
    ["Branch", session.git_branch],
    ["Started", stamp(session.started_at)],
    ["Messages", session.n_messages],
    ["Tool calls", session.n_tool_calls],
    ["Subagents", session.n_subagents || null],
    ["Tokens", session.total_tokens ? session.total_tokens.toLocaleString() : null],
    ["Est. cost", session.unpriced && !session.cost_usd ? "not priced"
      : session.cost_usd != null ? "$" + Number(session.cost_usd).toFixed(2) : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const out = [`# ${session.title || "Untitled session"}\n`];
  if (session.cwd) out.push(`\`${session.cwd}\`\n`);
  out.push(meta.map(([k, v]) => `- **${k}:** ${v}`).join("\n") + "\n");
  out.push("\n---\n");

  for (const m of messages) {
    const who = speakerOf(m);
    const when = stamp(m.ts);
    const side = m.sidechain ? ` · subagent ${m.label || ""}`.trimEnd() : "";
    out.push(`\n## ${who}${when ? ` — ${when}` : ""}${side}\n`);

    if (m.kind === "tool_use") out.push(toolCallMarkdown(m));
    else if (m.kind === "tool_result") out.push(mdCode(m.text || ""));
    else if (m.kind === "thinking") {
      out.push(String(m.text || "").split("\n").map((l) => `> ${l}`).join("\n") + "\n");
    } else out.push(String(m.text || "") + "\n");

    if (m.truncated) out.push("\n_(truncated in the index)_\n");
  }
  out.push(`\n---\n\nExported from agent-sessions on ${stamp(new Date().toISOString())}.\n`);
  return out.join("");
}

/* Standalone stylesheet for the HTML export: light-only, print-friendly, and
   inlined so the file works with no network and no sibling assets. */
const EXPORT_CSS = `
:root{--ink:#1c1917;--ink2:#57534e;--muted:#726960;--line:#e7ded2;--inset:#f4f0ea;
--accent:#b4441f;--wash:#fbeade;--user:#2a78d6;
--tok-c:#6b6a65;--tok-s:#0a6b2e;--tok-n:#9a4a00;--tok-k:#6d28d9;--tok-b:#0b6b6b;
--tok-f:#1c5cab;--tok-a:#9a3412;--tok-t:#a02020;--tok-p:#52514e}
*{box-sizing:border-box}
body{margin:0 auto;padding:44px 32px 72px;max-width:900px;background:#fff;color:var(--ink);
font:15px/1.65 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
-webkit-font-smoothing:antialiased}
h1{font-size:27px;letter-spacing:-.03em;margin:0 0 8px}
.cwd{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);margin-bottom:18px}
.meta{display:flex;flex-wrap:wrap;gap:8px 22px;font-size:13px;color:var(--muted);
padding-bottom:20px;border-bottom:1px solid var(--line);margin-bottom:8px}
.meta b{color:var(--ink);font-weight:600}
.msg{padding:16px 0;border-bottom:1px solid #f1ece5;page-break-inside:avoid}
.who{font-size:12.5px;font-weight:700;color:var(--ink2);margin-bottom:7px;
display:flex;gap:9px;align-items:baseline}
.who .t{font-weight:400;color:var(--muted)}
.who .sub{color:var(--accent);font-weight:600}
.msg.user{background:var(--wash);border-radius:10px;padding:16px 18px;border-bottom:0;margin:8px 0}
.msg.user .who{color:var(--user)}
.msg.thinking .body{color:var(--muted)}
.body>:first-child{margin-top:0}.body>:last-child{margin-bottom:0}
p{margin:0 0 10px;white-space:pre-wrap}
ul,ol{margin:0 0 10px;padding-left:22px}li{margin:3px 0;white-space:pre-wrap}
h3,h4,h5,h6{margin:16px 0 7px;line-height:1.35}
blockquote{margin:0 0 10px;padding:2px 0 2px 14px;border-left:2px solid #d9cfc1;color:var(--ink2)}
a{color:var(--accent)}
code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--inset);
border-radius:5px;padding:2px 5px}
.codewrap{margin:0 0 10px}
.codelabel{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted);
padding:6px 12px;background:var(--inset);border-radius:8px 8px 0 0;border-bottom:1px solid #e9e2d8}
.codelabel+.code{border-radius:0 0 8px 8px}
pre.code{margin:0;padding:12px 14px;background:var(--inset);border-radius:8px;
font:12.5px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
pre.code code{background:none;padding:0;font:inherit}
.params{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.param{display:flex;gap:12px;font-size:13px}
.param .pk{color:var(--muted);min-width:104px}
.param .pv{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.toolnote{font-size:13.5px;color:var(--ink2);margin-bottom:8px}
table{border-collapse:collapse;font-size:13px;margin-bottom:10px}
th,td{border:1px solid var(--line);padding:6px 10px}th{background:var(--inset)}
hr{border:0;border-top:1px solid var(--line);margin:16px 0}
.foot{margin-top:32px;padding-top:16px;border-top:1px solid var(--line);
font-size:12px;color:var(--muted)}
.tok-c{color:var(--tok-c);font-style:italic}.tok-s{color:var(--tok-s)}
.tok-n{color:var(--tok-n)}.tok-k{color:var(--tok-k);font-weight:600}
.tok-b{color:var(--tok-b)}.tok-f{color:var(--tok-f)}.tok-a{color:var(--tok-a)}
.tok-t{color:var(--tok-t)}.tok-v{color:var(--tok-b)}.tok-p{color:var(--tok-p)}
.tok-ins{color:var(--tok-s)}.tok-del{color:var(--tok-t)}.tok-h{color:var(--tok-k);font-weight:600}
@media print{
  body{padding:0;max-width:none;font-size:11.5pt}
  .msg{border-bottom:1px solid #eee}
  pre.code{background:#f6f4f1;border:1px solid #eee}
  a{text-decoration:none}
  @page{margin:16mm}
}`;

/** Whole session as a standalone HTML document (also what "PDF" prints). */
function sessionToHtml(session, messages) {
  const meta = [
    ["Agent", session.agent], ["Model", session.model],
    ["Project", session.project], ["Branch", session.git_branch],
    ["Started", stamp(session.started_at)],
    ["Messages", session.n_messages], ["Tool calls", session.n_tool_calls],
    ["Subagents", session.n_subagents || null],
    ["Tokens", session.total_tokens ? session.total_tokens.toLocaleString() : null],
    ["Est. cost", session.unpriced && !session.cost_usd ? "not priced"
      : session.cost_usd != null ? "$" + Number(session.cost_usd).toFixed(2) : null],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "");

  const body = messages.map((m) => {
    let inner;
    if (m.kind === "tool_use") inner = renderToolUse(m.tool_name, m.text || "");
    else if (m.kind === "tool_result") inner = renderToolResult(m.text || "");
    else if (m.role === "system") inner = renderSystem(m.text || "");
    else inner = renderMarkdown(m.text || "");
    const cls = m.kind === "thinking" ? "thinking" : m.role;
    const sub = m.sidechain
      ? ` <span class="sub">subagent ${escHtml(m.label || "")}</span>` : "";
    return `<div class="msg ${escHtml(cls)}">` +
      `<div class="who">${escHtml(speakerOf(m))}` +
      `<span class="t">${escHtml(stamp(m.ts))}</span>${sub}</div>` +
      `<div class="body">${inner}</div></div>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(session.title || "Session")}</title>
<style>${EXPORT_CSS}</style></head><body>
<h1>${escHtml(session.title || "Untitled session")}</h1>
${session.cwd ? `<div class="cwd">${escHtml(session.cwd)}</div>` : ""}
<div class="meta">${meta.map(([k, v]) =>
    `<div>${escHtml(k)} <b>${escHtml(v)}</b></div>`).join("")}</div>
${body}
<div class="foot">Exported from agent-sessions on ${escHtml(stamp(new Date().toISOString()))}.</div>
</body></html>`;
}

/** Filesystem-safe basename for a downloaded export. */
function exportFilename(session, ext) {
  const slug = String(session.title || "session")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)
    || "session";
  const id = String(session.session_id || "").slice(0, 8);
  return `${slug}${id ? "-" + id : ""}.${ext}`;
}

// globalThis so the same file can be exercised from node in a test harness.
(typeof window !== "undefined" ? window : globalThis).AS_RENDER = {
  escHtml, highlight, renderMarkdown, codeBlock,
  renderToolUse, renderToolResult, renderSystem, langFromPath,
  sessionToMarkdown, sessionToHtml, exportFilename,
};
