// La mémoire durable du dot : /dot/memory/MEMORY.md, une ligne par fait, lue au début de chaque
// session (conversation et runs de travail). C'est ce qui relie les sessions entre elles : ce qu'un
// run apprend sur un objectif (comment marche un service, une décision de la personne) sert aux autres.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADER = "# Mémoire\n\nCe que le dot sait durablement : la personne, ses décisions, comment marchent ses services.\n";
const MAX_CHARS = Number(process.env.DOT_MEMORY_CHARS ?? 8000);

export function readMemory(dir: string): string {
  try {
    return readFileSync(join(dir, "MEMORY.md"), "utf8");
  } catch {
    return HEADER;
  }
}

const facts = (text: string) => text.split("\n").filter((l) => l.startsWith("- "));
const normalize = (s: string) => s.toLowerCase().replace(/_\(.*?\)_/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function remember(dir: string, fact: string, date = new Date()): { ok: boolean; message: string } {
  const clean = fact.replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, message: "Empty fact." };
  const text = readMemory(dir);
  if (facts(text).some((l) => normalize(l) === normalize(clean))) return { ok: true, message: "Already in memory." };
  const line = `- ${clean} _(${date.toLocaleDateString("fr-FR")})_`;
  const next = `${text.trimEnd()}\n${line}\n`;
  if (next.length > MAX_CHARS) return { ok: false, message: `Memory is full (${MAX_CHARS} characters): forget outdated facts first.` };
  writeFileSync(join(dir, "MEMORY.md"), next.startsWith("#") ? next : HEADER + next);
  return { ok: true, message: "Remembered." };
}

export function forget(dir: string, match: string): { ok: boolean; message: string } {
  const needle = normalize(match);
  if (!needle) return { ok: false, message: "Give a passage of the fact to forget." };
  const text = readMemory(dir);
  const hits = facts(text).filter((l) => normalize(l).includes(needle));
  if (hits.length !== 1) return { ok: false, message: hits.length ? `${hits.length} facts match: be more precise.` : "No fact matches." };
  writeFileSync(join(dir, "MEMORY.md"), text.split("\n").filter((l) => l !== hits[0]).join("\n"));
  return { ok: true, message: `Forgotten: ${hits[0].slice(2)}` };
}

// Skills que pi ne chargera pas : SKILL.md sans en-tête (name, description).
export function skillProblems(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  const problems: string[] = [];
  for (const name of readdirSync(skillsDir)) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const head = readFileSync(file, "utf8").slice(0, 600);
    const front = /^---\n([\s\S]*?)\n---/.exec(head)?.[1] ?? "";
    if (!/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front)) problems.push(name);
  }
  return problems;
}
