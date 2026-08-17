/* Tests for the transcript renderer.  Run:  node test_render.js
   No test framework — the renderer has no dependencies and neither does this. */

require("./agent_sessions/web/render.js");
const R = globalThis.AS_RENDER;

let pass = 0;
let fail = 0;

function t(name, got, want) {
  const ok = want instanceof RegExp ? want.test(got) : String(got).includes(want);
  if (ok) { pass++; return; }
  fail++;
  console.log(`FAIL  ${name}`);
  console.log(`      got: ${JSON.stringify(String(got)).slice(0, 300)}`);
}

/* --- escaping & injection: transcripts contain arbitrary attacker-ish text --- */
t("escapes html in prose", R.renderMarkdown("<script>alert(1)</script>"), "&lt;script&gt;");
t("escapes html in fenced code", R.renderMarkdown("```\n<img onerror=x>\n```"), "&lt;img");
t("escapes inline code", R.renderMarkdown("use `<b>x</b>`"), "<code>&lt;b&gt;x&lt;/b&gt;</code>");
t("never emits a script tag", R.renderMarkdown("<script>x</script>"), /^(?!.*<script)/s);
t("escapes quotes in strings", R.highlight('var s = "hi";', "js"), "&quot;hi&quot;");
t("blocks javascript: links", R.renderMarkdown("[x](javascript:alert(1))"), /^(?!.*<a href)/s);
t("allows https links", R.renderMarkdown("[x](https://a.com)"), '<a href="https://a.com"');

/* --- markdown blocks --- */
t("heading is demoted to h3", R.renderMarkdown("# Title"), "<h3>Title</h3>");
t("bullet list", R.renderMarkdown("- one\n- two"), "<ul><li>one</li><li>two</li></ul>");
t("ordered list", R.renderMarkdown("1. a\n2. b"), "<ol><li>a</li>");
t("bold", R.renderMarkdown("**b**"), "<strong>b</strong>");
t("emphasis", R.renderMarkdown("*i*"), "<em>i</em>");
t("blockquote", R.renderMarkdown("> quoted"), "<blockquote>");
t("gfm table", R.renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |"), "<th>a</th>");
t("horizontal rule", R.renderMarkdown("---"), "<hr>");
t("paragraph", R.renderMarkdown("hello world"), "<p>hello world</p>");

/* --- syntax highlighting --- */
t("js keyword", R.highlight("const x = 1;", "js"), 'tok-k">const<');
t("js comment", R.highlight("// note", "js"), 'tok-c">// note<');
t("py comment", R.highlight("# note\nx=1", "py"), 'tok-c"># note<');
t("py keyword", R.highlight("def f():", "py"), 'tok-k">def<');
t("json key vs value", R.highlight('{"a": "b"}', "json"), 'tok-a">&quot;a&quot;<');
t("shell variable", R.highlight("echo $HOME", "sh"), 'tok-v">$HOME<');
t("sql keyword", R.highlight("select * from t", "sql"), 'tok-k">select<');
t("diff hunk", R.highlight("@@ -1 +1 @@", "diff"), 'tok-h">@@ -1 +1 @@<');
t("diff added line", R.highlight("+new", "diff"), 'tok-ins">+new<');
t("unknown language falls back", R.highlight('x = "s"', "wat"), "tok-s");
t("language from path", R.langFromPath("/a/b/c.py"), "py");

/* --- tool calls --- */
t("bash renders as shell", R.renderToolUse("Bash", '{"command":"ls -la","description":"list"}'), "toolnote");
t("write shows path label", R.renderToolUse("Write", '{"file_path":"/a/b.py","content":"def f():\\n  pass"}'), "codelabel");
t("edit shows both sides", R.renderToolUse("Edit", '{"file_path":"a.js","old_string":"a","new_string":"b"}'), "with");
t("read renders params", R.renderToolUse("Read", '{"file_path":"/x/y.txt"}'), 'class="param"');
t("malformed json still renders", R.renderToolUse("X", "{not json"), "codewrap");
t("diff output detected", R.renderToolResult("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y"), "tok-h");

/* --- system records: CLI markup unwrapped, not shown raw --- */
t("slash command unwrapped",
  R.renderSystem("<command-name>/mcp</command-name>\n<command-message>mcp</command-message>"),
  "<p>/mcp</p>");
t("stdout unwrapped",
  R.renderSystem("<local-command-stdout>done</local-command-stdout>"), "<p>done</p>");
t("no leftover command tags",
  R.renderSystem("<command-name>/x</command-name><command-args>a</command-args>"),
  /^(?!.*command-)/s);

/* --- pathological input --- */
t("unclosed fence", R.renderMarkdown("```js\nconst a=1"), "tok-k");
t("empty string", R.renderMarkdown(""), "");
t("null-ish input", R.renderMarkdown(null), "");
t("very long line", R.renderMarkdown("x".repeat(50000)).length > 50000, "true");
t("nested backticks", R.renderMarkdown("``a ` b``"), "<code>");

/* --- export: markdown, standalone html, filenames --- */
const SESSION = {
  key: "claude:abc", session_id: "abc12345", title: "Fix the login bug",
  agent: "claude", model: "claude-opus-5", project: "my-app", cwd: "/w/my-app",
  started_at: "2026-08-17T09:14:00Z", n_messages: 6, n_tool_calls: 2,
  n_subagents: 1, total_tokens: 1234567, cost_usd: 12.5,
};
const MSGS = [
  { role: "user", kind: "text", ts: "2026-08-17T09:14:00Z", text: "Fix the **login** bug" },
  { role: "assistant", kind: "thinking", ts: "2026-08-17T09:14:10Z", text: "Checking auth" },
  { role: "assistant", kind: "tool_use", tool_name: "Bash", ts: "2026-08-17T09:14:20Z",
    text: JSON.stringify({ command: "grep -rn login src/", description: "Find it" }) },
  { role: "tool", kind: "tool_result", ts: "2026-08-17T09:14:21Z",
    text: "output with ``` a fence ``` in it" },
  { role: "assistant", kind: "tool_use", tool_name: "Write", ts: "2026-08-17T09:14:30Z",
    text: JSON.stringify({ file_path: "src/auth.py", content: "def login():\n    return True" }) },
  { role: "assistant", kind: "text", ts: "2026-08-17T09:15:00Z",
    sidechain: true, label: "agent-a1", text: "Done" },
];
const MD = R.sessionToMarkdown(SESSION, MSGS);
const HTML = R.sessionToHtml(SESSION, MSGS);

t("md has title", MD, "# Fix the login bug");
t("md has metadata", MD, "**Model:** claude-opus-5");
t("md tags subagent turns", MD, "subagent agent-a1");
t("md renders bash as shell", MD, "```sh\ngrep -rn login src/");
t("md picks lang from file path", MD, "```py\ndef login():");
t("md quotes thinking", MD, "> Checking auth");
// Wrapped tool output must not be able to terminate its own fence.
t("md widens fence past nested backticks", MD, "````\noutput with ``` a fence");
t("md keeps prose fences untouched", R.sessionToMarkdown(SESSION,
  [{ role: "assistant", kind: "text", text: "a ```js\nx\n``` b" }]), "```js");

t("html is a standalone document", HTML, /^<!doctype html>/);
t("html inlines its stylesheet", HTML, "<style>");
t("html carries syntax colours", HTML, ".tok-k");
t("html highlights code", HTML, 'class="tok-');
t("html has print rules", HTML, "@media print");
t("html escapes untrusted text", R.sessionToHtml(
  { ...SESSION, title: "<script>x</script>" }, []), /^(?!.*<script>x)/s);
t("filename is slugged", R.exportFilename(SESSION, "md"), "fix-the-login-bug-abc12345.md");
t("filename survives an empty title",
  R.exportFilename({ title: "", session_id: "" }, "html"), "session.html");

console.log(fail
  ? `\n${pass} passed, ${fail} FAILED`
  : `\nall ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
