// Le plan du dot : objectifs et todos, dans /dot/memory/plan.json.
//
// Il est lu par le battement sans passer par le modèle, et modifié par l'agent avec les outils
// `objective` et `todo`. Deux processus pi peuvent l'écrire en même temps (la conversation et un
// run de travail) : chaque modification se fait sous verrou. PLAN.md en est une vue lisible,
// réécrite à chaque changement.

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type ObjectiveStatus = "active" | "paused" | "reached" | "dropped";
// L'étape d'un projet sur le tableau, de l'idée à la livraison. Le statut dit s'il est vivant ;
// l'étape dit où il en est.
export type Stage = "idee" | "cadrage" | "en_cours" | "a_valider" | "livre";
export const STAGES: Stage[] = ["idee", "cadrage", "en_cours", "a_valider", "livre"];
export const STAGE_LABEL: Record<Stage, string> = { idee: "Idée", cadrage: "Cadrage", en_cours: "En cours", a_valider: "À valider", livre: "Livré" };
export type TodoStatus = "todo" | "doing" | "waiting" | "done" | "dropped";

// Un plan qui n'a rien changé n'est réexaminé qu'au prochain changement du projet (carte modifiée,
// todo ajouté ou terminé) : chacun de ces changements efface idleUntil.
export const UNTIL_CHANGE = "9999-12-31T00:00:00.000Z";

export interface Objective {
  id: string;
  title: string;
  detail?: string;
  status: ObjectiveStatus;
  stage?: Stage;
  next?: string; // la prochaine étape, en une ligne
  blocker?: string; // ce qui bloque, et qui doit agir
  nudged?: string; // date de la relance de la personne (une seule par attente)
  result?: string; // quand il est atteint ou abandonné
  idleUntil?: string; // pas de nouveau plan avant cette date (le dernier n'a rien changé) ; UNTIL_CHANGE : jusqu'au prochain changement
  created: string;
  updated: string;
}

export interface Todo {
  id: string;
  objective: string;
  text: string;
  status: TodoStatus;
  notBefore?: string; // pas avant cette date
  reason?: string; // pourquoi il attend, ou pourquoi il est abandonné
  result?: string;
  runs: number; // runs passés dessus sans le terminer
  created: string;
  updated: string;
}

export interface Plan {
  objectives: Objective[];
  todos: Todo[];
}

const HOME = process.env.DOT_HOME ?? "/dot";
export const MEMORY = join(HOME, "memory");
const PLAN_FILE = join(MEMORY, "plan.json");
const PLAN_VIEW = join(MEMORY, "PLAN.md");
const LOCK = join(MEMORY, ".plan.lock");

export const OPEN: TodoStatus[] = ["todo", "doing", "waiting"];
export const newId = () => randomBytes(3).toString("hex");
export const now = () => new Date().toISOString();

export function readPlan(): Plan {
  try {
    const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
    return { objectives: plan.objectives ?? [], todos: plan.todos ?? [] };
  } catch {
    return { objectives: [], todos: [] };
  }
}

// Verrou par répertoire : mkdir est atomique. Un verrou de plus de 10 s est celui d'un processus mort.
function lock() {
  const until = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 10_000) rmSync(LOCK, { recursive: true, force: true });
      } catch {}
      if (Date.now() > until) throw new Error("plan.json est verrouillé");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function updatePlan<T>(change: (plan: Plan) => T): T {
  mkdirSync(MEMORY, { recursive: true });
  lock();
  try {
    const plan = readPlan();
    const result = change(plan);
    const tmp = `${PLAN_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(plan, null, 2) + "\n");
    renameSync(tmp, PLAN_FILE);
    writeFileSync(PLAN_VIEW, render(plan));
    return result;
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}

const OBJECTIVE_LABEL: Record<ObjectiveStatus, string> = { active: "actif", paused: "en pause", reached: "atteint", dropped: "abandonné" };
const TODO_BOX: Record<TodoStatus, string> = { todo: "[ ]", doing: "[~]", waiting: "[?]", done: "[x]", dropped: "[-]" };
const local = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export const stageOf = (o: Objective): Stage => o.stage ?? (o.status === "reached" ? "livre" : "en_cours");

const daysSince = (iso: string, at: Date) => Math.floor((at.getTime() - new Date(iso).getTime()) / 86_400_000);

// Une carte du tableau, sur une ligne : où il en est, la suite, ce qui bloque, la dernière activité.
export function boardLine(plan: Plan, o: Objective, at = new Date()): string {
  const todos = plan.todos.filter((t) => t.objective === o.id && t.status !== "dropped");
  const done = todos.filter((t) => t.status === "done").length;
  const waiting = todos.filter((t) => t.status === "waiting").map((t) => t.reason).filter(Boolean);
  const last = [o.updated, ...todos.map((t) => t.updated)].sort().at(-1) ?? o.updated;
  const idle = daysSince(last, at);
  return [
    `[${STAGE_LABEL[stageOf(o)]}${o.status === "paused" ? ", en pause" : ""}] ${o.title} (${o.id})`,
    ...(todos.length ? [`todos ${done}/${todos.length}`] : []),
    ...(o.next ? [`suite : ${o.next}`] : []),
    ...(o.blocker ? [`bloque : ${o.blocker}`] : waiting.length ? [`attend : ${waiting.join(" ; ")}`] : []),
    ...(o.nudged ? [`relancé le ${local(o.nudged)}`] : []),
    idle >= 1 ? `inactif depuis ${idle} j` : "actif aujourd'hui",
  ].join(" · ");
}

// La vue globale : les projets ouverts par étape, et le compte des projets clos.
export function board(plan: Plan, at = new Date()): string {
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const closed = plan.objectives.filter((o) => o.status === "reached" || o.status === "dropped");
  const lines = STAGES.flatMap((stage) => open.filter((o) => stageOf(o) === stage).map((o) => `- ${boardLine(plan, o, at)}`));
  return [
    ...(lines.length ? lines : ["- Aucun projet ouvert."]),
    ...(closed.length ? [`(${closed.filter((o) => o.status === "reached").length} livré(s), ${closed.filter((o) => o.status === "dropped").length} abandonné(s) : \`objective\` list)`] : []),
  ].join("\n");
}

export function todoLine(t: Todo): string {
  const extra = [
    t.notBefore && t.status === "todo" && new Date(t.notBefore) > new Date() ? `pas avant le ${local(t.notBefore)}` : "",
    t.status === "waiting" && t.reason ? `attend : ${t.reason}` : "",
    t.status === "dropped" && t.reason ? `abandonné : ${t.reason}` : "",
    t.status === "done" && t.result ? `→ ${t.result}` : "",
  ].filter(Boolean);
  return `${TODO_BOX[t.status]} ${t.id} · ${t.text}${extra.length ? ` (${extra.join(" ; ")})` : ""}`;
}

export function objectiveBlock(plan: Plan, o: Objective, withClosed = true): string {
  const todos = plan.todos.filter((t) => t.objective === o.id && (withClosed || OPEN.includes(t.status)));
  return [
    `### ${o.title} — ${OBJECTIVE_LABEL[o.status]}, ${STAGE_LABEL[stageOf(o)]} (${o.id})`,
    ...(o.detail ? [o.detail] : []),
    ...(o.next ? [`Suite : ${o.next}`] : []),
    ...(o.blocker ? [`Bloque : ${o.blocker}`] : []),
    ...(o.result ? [`Résultat : ${o.result}`] : []),
    ...(todos.length ? todos.map((t) => `- ${todoLine(t)}`) : ["- (aucun todo)"]),
  ].join("\n");
}

export function render(plan: Plan): string {
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const closed = plan.objectives.filter((o) => o.status === "reached" || o.status === "dropped");
  return [
    "# Plan du dot",
    "",
    "Vue générée depuis plan.json : ne pas modifier à la main.",
    "[ ] à faire · [~] en cours · [?] attend · [x] fait · [-] abandonné",
    "",
    "## Tableau",
    "",
    board(plan),
    "",
    "## Objectifs en cours",
    "",
    ...(open.length ? open.map((o) => objectiveBlock(plan, o) + "\n") : ["Aucun.", ""]),
    "## Objectifs terminés",
    "",
    ...(closed.length ? closed.map((o) => objectiveBlock(plan, o) + "\n") : ["Aucun.", ""]),
  ].join("\n");
}

// Le prochain travail, décidé sans le modèle. Dans l'ordre : un todo resté en cours (reprise),
// un todo prêt, puis un objectif actif qui n'a plus aucun todo ouvert (il faut refaire le plan).
// Un objectif dont les todos attendent tous la personne ne déclenche rien.
export type Work = { kind: "todo"; objective: Objective; todo: Todo; resume: boolean } | { kind: "plan"; objective: Objective };

export function nextWork(plan: Plan, at = new Date()): Work | null {
  // Une idée n'est pas lancée ; un projet à valider attend l'avis de la personne (ses todos de
  // correction tournent, mais on ne replanifie pas).
  const active = plan.objectives.filter((o) => o.status === "active" && stageOf(o) !== "idee");
  const todosOf = (o: Objective) => plan.todos.filter((t) => t.objective === o.id);
  for (const objective of active) {
    const todo = todosOf(objective).find((t) => t.status === "doing");
    if (todo) return { kind: "todo", objective, todo, resume: true };
  }
  for (const objective of active) {
    const todo = todosOf(objective).find((t) => t.status === "todo" && (!t.notBefore || new Date(t.notBefore) <= at));
    if (todo) return { kind: "todo", objective, todo, resume: false };
  }
  for (const objective of active) {
    if (stageOf(objective) === "a_valider") continue;
    if (objective.idleUntil && new Date(objective.idleUntil) > at) continue;
    if (!todosOf(objective).some((t) => OPEN.includes(t.status))) return { kind: "plan", objective };
  }
  return null;
}
