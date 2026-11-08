// Le markdown de l'agent, converti pour Telegram (qui n'accepte qu'un petit HTML).
import { test } from "node:test";
import assert from "node:assert/strict";

const src = process.env.DOT_SRC ?? "/src";
const { markdownToHtml, splitMessage } = await import(`${src}/extensions/dot-telegram/markdown.ts`);

test("titres, gras, italique, code, liens", () => {
  assert.equal(markdownToHtml("## Brief du jour"), "<b>Brief du jour</b>");
  assert.equal(markdownToHtml("un **mot** et un *autre*"), "un <b>mot</b> et un <i>autre</i>");
  assert.equal(markdownToHtml("lance `a < b && c`"), "lance <code>a &lt; b &amp;&amp; c</code>");
  assert.equal(markdownToHtml("[doc](https://ex.com/?a=1&b=2)"), '<a href="https://ex.com/?a=1&amp;b=2">doc</a>');
});

test("le texte est échappé, les soulignés et les astérisques isolés restent tels quels", () => {
  assert.equal(markdownToHtml("3 < 5 & 7 > 2"), "3 &lt; 5 &amp; 7 &gt; 2");
  assert.equal(markdownToHtml("mon_fichier_test.py"), "mon_fichier_test.py");
  assert.equal(markdownToHtml("2 * 3 * 4"), "2 * 3 * 4");
  assert.equal(markdownToHtml("<script>"), "&lt;script&gt;");
});

test("listes, citations, blocs de code, tableaux", () => {
  assert.equal(markdownToHtml("- un\n- **deux**\n  - trois"), "• un\n• <b>deux</b>\n  • trois");
  assert.equal(markdownToHtml("- [ ] à faire\n- [x] fait"), "☐ à faire\n☑ fait");
  assert.equal(markdownToHtml("> une\n> citation"), "<blockquote>une\ncitation</blockquote>");
  assert.equal(markdownToHtml("```js\nif (a < b) **x**\n```"), '<pre><code class="language-js">if (a &lt; b) **x**</code></pre>');
  assert.equal(markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |"), "<pre>| a | b |\n| 1 | 2 |</pre>");
});

test("un long texte est découpé entre deux paragraphes, sans couper un bloc de code", () => {
  const para = "x".repeat(2000);
  assert.deepEqual(splitMessage(`${para}\n\n${para}`), [para, para]);
  const code = "```\n" + "ligne\n".repeat(200) + "```";
  const parts = splitMessage(`${"y".repeat(2500)}\n${code}`);
  assert.equal(parts.length, 2);
  assert.ok(parts[1].startsWith("```"));
  assert.ok(parts.every((p: string) => p.length <= 3500));
  assert.deepEqual(splitMessage("court"), ["court"]);
});
