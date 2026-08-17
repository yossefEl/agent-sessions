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

console.log(fail
  ? `\n${pass} passed, ${fail} FAILED`
  : `\nall ${pass} assertions passed`);
process.exit(fail ? 1 : 0);
