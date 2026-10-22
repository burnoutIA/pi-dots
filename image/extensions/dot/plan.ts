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
export type TodoStatus = "todo" | "doing" | "waiting" | "done" | "dropped";

export interface Objective {
  id: string;
  title: string;
  detail?: string;
  status: ObjectiveStatus;
  result?: string; // quand il est atteint ou abandonné
  idleUntil?: string; // pas de nouveau plan avant cette date (le dernier n'a rien changé)
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
    `### ${o.title} — ${OBJECTIVE_LABEL[o.status]} (${o.id})`,
    ...(o.detail ? [o.detail] : []),
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
  const active = plan.objectives.filter((o) => o.status === "active");
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
    if (objective.idleUntil && new Date(objective.idleUntil) > at) continue;
    if (!todosOf(objective).some((t) => OPEN.includes(t.status))) return { kind: "plan", objective };
  }
  return null;
}
