// Markdown → HTML de Telegram. Les réponses de l'agent sont écrites en markdown (l'app le rend) ;
// Telegram n'en comprend pas la syntaxe courante (** pour le gras, ## pour les titres), mais
// accepte un petit HTML : <b>, <i>, <s>, <code>, <pre>, <a href>, <blockquote>.
//
//   - titres → gras ; listes → puces « • » ; tableaux → bloc à chasse fixe ;
//   - **gras**, __gras__, *italique*, ~~barré~~, `code`, ```bloc```, [texte](lien), > citation ;
//   - _x_ n'est pas pris pour de l'italique : trop de noms_avec_soulignés.
// Tout le reste est échappé (<, >, &). Si Telegram refuse quand même, l'appelant renvoie le brut.

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const attr = (s: string) => escape(s).replace(/"/g, "&quot;");

function inline(text: string): string {
  // Le code d'abord, mis de côté : rien ne se formate à l'intérieur.
  const kept: string[] = [];
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`;
  let s = text.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${escape(code)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) => keep(`<a href="${attr(url)}">${inline(label)}</a>`));
  s = escape(s);
  s = s.replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, "<b>$1</b>");
  s = s.replace(/__(?=\S)([^\n]*?\S)__/g, "<b>$1</b>");
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, "<s>$1</s>");
  s = s.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<i>$2</i>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
}

export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i += 1; i < lines.length && !lines[i].trim().startsWith(fence[1]); i += 1) body.push(lines[i]);
      const lang = fence[2] ? ` class="language-${attr(fence[2])}"` : "";
      out.push(`<pre><code${lang}>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i += 1) {
        if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim());
      }
      i -= 1;
      out.push(`<pre>${escape(rows.join("\n"))}</pre>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i += 1) quoted.push(lines[i].replace(/^\s*>\s?/, ""));
      i -= 1;
      out.push(`<blockquote>${quoted.map(inline).join("\n")}</blockquote>`);
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1])}</b>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("──────────");
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      const task = /^\[([ xX])\]\s+(.*)$/.exec(bullet[2]);
      const mark = task ? (task[1] === " " ? "☐" : "☑") : "•";
      out.push(`${bullet[1]}${mark} ${inline(task ? task[2] : bullet[2])}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join("\n");
}

// Découpe un texte trop long pour un seul message, de préférence entre deux paragraphes, puis
// entre deux lignes, et sans couper un bloc de code ``` (sauf s'il est à lui seul trop long).
export function splitMessage(text: string, max = 3500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = head.lastIndexOf("\n\n");
    if (cut < max / 2) cut = head.lastIndexOf("\n");
    if (cut < max / 4) cut = max;
    // Une coupe au milieu d'un bloc de code : on recule avant son ouverture, si c'est possible.
    if ((head.slice(0, cut).match(/^\s*```/gm) ?? []).length % 2 === 1) {
      const open = head.slice(0, cut).search(/^\s*```[^\n]*\n(?![\s\S]*^\s*```)/m);
      if (open > 0) cut = open;
    }
    parts.push(rest.slice(0, cut).replace(/\s+$/, ""));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}
