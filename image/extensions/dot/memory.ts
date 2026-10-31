// La mémoire durable du dot, en deux niveaux :
//   - /dot/memory/MEMORY.md : la mémoire globale, lue au début de chaque session. Courte : la personne,
//     ses préférences et ses règles, les savoir-faire qui servent à plusieurs projets ;
//   - /dot/memory/projets/<id>.md : les notes d'un projet (un objectif). Lues dans les runs de ce
//     projet, et dans la conversation seulement quand on en parle (`objective` show).
// Une ligne par fait, datée. Un fait mis à jour remplace l'ancien (`replaces`).

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HEADER = "# Mémoire\n\nCe que le dot sait durablement : la personne, ses règles, ses savoir-faire communs. Le détail des projets est dans projets/.\n";
const MAX_CHARS = Number(process.env.DOT_MEMORY_CHARS ?? 8000);
const PROJECT_MAX_CHARS = Number(process.env.DOT_PROJECT_MEMORY_CHARS ?? 3000);

export const PROJECTS_DIR = "projets";
const fileOf = (project?: string) => (project ? join(PROJECTS_DIR, `${project}.md`) : "MEMORY.md");
const headerOf = (project?: string) => (project ? `# Notes du projet ${project}\n\nDécisions, méthode, sources, pièges : l'utile seulement.\n` : HEADER);
const maxOf = (project?: string) => (project ? PROJECT_MAX_CHARS : MAX_CHARS);

export function readMemory(dir: string, project?: string): string {
  try {
    return readFileSync(join(dir, fileOf(project)), "utf8");
  } catch {
    return headerOf(project);
  }
}

function write(dir: string, project: string | undefined, text: string) {
  if (project) mkdirSync(join(dir, PROJECTS_DIR), { recursive: true });
  writeFileSync(join(dir, fileOf(project)), text.startsWith("#") ? text : headerOf(project) + text);
}

const facts = (text: string) => text.split("\n").filter((l) => l.startsWith("- "));
const normalize = (s: string) => s.toLowerCase().replace(/_\(.*?\)_/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// replaces : un passage du fait que celui-ci remplace. Le nouveau prend sa place, au lieu de
// s'ajouter à côté d'un fait devenu faux (deux versions qui se contredisent, la vieille gagnant parfois).
// project : le fait va dans les notes de ce projet au lieu de la mémoire globale.
export function remember(dir: string, fact: string, date = new Date(), replaces = "", project?: string): { ok: boolean; message: string } {
  const clean = fact.replace(/\s+/g, " ").trim();
  if (!clean) return { ok: false, message: "Empty fact." };
  const text = readMemory(dir, project);
  const line = `- ${clean} _(${date.toLocaleDateString("fr-FR")})_`;
  const full = () => ({ ok: false, message: `${project ? `Notes of project ${project}` : "Memory"} full (${maxOf(project)} characters): forget or merge outdated facts first.` });
  if (replaces.trim()) {
    const needle = normalize(replaces);
    const hits = facts(text).filter((l) => normalize(l).includes(needle));
    if (hits.length !== 1) return { ok: false, message: hits.length ? `${hits.length} facts match \`replaces\`: be more precise.` : "No fact matches `replaces`: nothing was changed." };
    const next = text.split("\n").map((l) => (l === hits[0] ? line : l)).join("\n");
    if (next.length > maxOf(project)) return full();
    write(dir, project, next);
    return { ok: true, message: `Replaced: ${hits[0].slice(2)}` };
  }
  if (facts(text).some((l) => normalize(l) === normalize(clean))) return { ok: true, message: "Already in memory." };
  const next = `${text.trimEnd()}\n${line}\n`;
  if (next.length > maxOf(project)) return full();
  write(dir, project, next);
  return { ok: true, message: project ? `Remembered in the notes of project ${project}.` : "Remembered." };
}

export function forget(dir: string, match: string, project?: string): { ok: boolean; message: string } {
  const needle = normalize(match);
  if (!needle) return { ok: false, message: "Give a passage of the fact to forget." };
  const text = readMemory(dir, project);
  const hits = facts(text).filter((l) => normalize(l).includes(needle));
  if (hits.length !== 1) return { ok: false, message: hits.length ? `${hits.length} facts match: be more precise.` : "No fact matches." };
  write(dir, project, text.split("\n").filter((l) => l !== hits[0]).join("\n"));
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
