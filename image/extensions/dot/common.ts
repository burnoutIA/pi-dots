// Le socle partagé par les modules du dot : chemins, réglages, état, petits outils, et l'objet
// partagé entre extensions (globalThis.__dot).

import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./log.ts";
import { type Schedule } from "./schedule.ts";
import { MEMORY, objectiveBlock, readPlan } from "./plan.ts";

export const HOME = process.env.DOT_HOME ?? "/dot";
export const WORKSPACE = join(HOME, "workspace");
export const INBOX = join(HOME, "inbox");
export const INBOX_DONE = join(INBOX, "traités");
export const STATE_FILE = join(MEMORY, "state.json");
export const SCHEDULES_FILE = join(MEMORY, "schedules.json");
export const WATCHES_FILE = join(MEMORY, "watches.json");

export const WORKER = process.env.DOT_ROLE === "worker";
export const num = (name: string, fallback: number) => (process.env[name] && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
export const RECHECK_MINUTES = num("DOT_RECHECK_MINUTES", num("DOT_HEARTBEAT_MINUTES", 60)); // objectif sans progrès : pas de nouveau plan avant (autonomie libre)
// L'autonomie du dot quand personne n'est là (runs : todos, plans, tâches, veilles, boîte, revues).
//   prudent (par défaut) : un run ne crée de lui-même ni objectif, ni tâche planifiée, ni veille ; il
//     les propose à la personne, et c'est la conversation qui les crée. Un plan qui ne change rien
//     n'est réexaminé qu'au prochain changement du projet, jamais sur minuterie.
//   libre : le run crée ce qu'il juge utile ; un plan inchangé est réexaminé après DOT_RECHECK_MINUTES.
export const AUTONOMY = process.env.DOT_AUTONOMY === "libre" ? "libre" : "prudent";
export const ASK_FIRST = WORKER && AUTONOMY === "prudent";
export const askFirst = (what: string) =>
  `Not on your own: ${what} is decided with the person (autonomy: prudent). If it is worth it, propose it in a \`notify\` (what, why, how often); once they agree, it is created in the conversation.`;
export const RUN_MINUTES = num("DOT_RUN_MINUTES", 30); // durée maximale d'un run
export const MAX_RUNS = num("DOT_MAX_RUNS", 3); // runs sur un même todo avant de demander de l'aide
export const TICK_MS = num("DOT_TICK_MS", 15_000);
export const LOOP_REPEATS = num("DOT_LOOP_REPEATS", 5); // même appel d'outil répété : boucle probable
export const RUN_TOKENS = num("DOT_RUN_TOKENS", 3_000_000); // jetons (entrée + sortie, cumulés) au-delà desquels un run est arrêté
export const CHECKPOINT_TURNS = num("DOT_CHECKPOINT_TURNS", 12); // point d'étape dans un run, tous les N tours
export const FAIL_STREAK = num("DOT_FAIL_STREAK", 4); // échecs d'outil d'affilée : point d'étape tout de suite
export const REVIEW_DAYS = num("DOT_REVIEW_DAYS", 7); // revue de son budget par le dot (0 = jamais)
export const SKILLS_DIR = join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent"), "skills");
export const LATE_SKIP_MS = 15 * 60_000;
export const MAX_TEXT = 4000;

export type Kind = "tâche" | "veille" | "boîte" | "revue";
export interface DotEvent { id: string; kind: Kind; text: string; tries?: number; source?: string }
export interface State {
  paused?: boolean;
  lastAlive?: string;
  events: DotEvent[];
  running?: { label: string; since: string };
  backoffUntil?: string;
  modelDown?: { since: string; tries: number; error: string }; // le modèle ne répond plus
  nextReview?: string; // prochaine revue de budget
  projectsMigrated?: boolean; // la mémoire a été répartie en notes par projet
  appliedModel?: string; // dernier DOT_MODEL imposé à la conversation reprise
  conversationSession?: string; // le fichier de session de la conversation, que le hub reprend au redémarrage
}
export interface Watch { id: string; command: string; every: number; prompt: string; paused?: boolean; hash?: string; output?: string; nextCheck: string }

// --- Fichiers ----------------------------------------------------------------------------------

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
export function writeJson(file: string, value: unknown) {
  mkdirSync(MEMORY, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}
export const loadState = (): State => ({ events: [], ...readJson<Partial<State>>(STATE_FILE, {}) }) as State;
export function changeState(change: (s: State) => void) {
  const state = loadState();
  change(state);
  writeJson(STATE_FILE, state);
}
export const loadSchedules = () => readJson<Schedule[]>(SCHEDULES_FILE, []);
export const loadWatches = () => readJson<Watch[]>(WATCHES_FILE, []);

// --- Petits outils ------------------------------------------------------------------------------

export const local = (date: Date | string) => new Date(date).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
export const stamp = () => local(new Date());
export const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} caractères coupés]` : text);
export const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
export const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });

export function since(iso?: string): string {
  if (!iso) return "jamais";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

export function describeSchedule(s: Schedule): string {
  const when = s.once ? `une fois, le ${local(s.once)}` : s.every ? `toutes les ${s.every} min` : `à ${s.at}${s.days?.length ? ` (jours ${s.days.join(",")})` : " chaque jour"}`;
  return `${s.id} · ${when}${s.paused ? " · en pause" : ` · prochaine : ${local(s.nextRun)}`} · ${s.prompt}`;
}

export function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, cwd: WORKSPACE }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === "number" ? `\n[code de sortie ${(error as any).code}]` : error ? `\n[${error.message}]` : "";
      resolve(`${stdout}${stderr ? `\n${stderr}` : ""}${code}`.trim());
    });
  });
}

// --- Partagé entre extensions (et survit au rechargement de session) ---------------------------------

export interface Shared {
  senders?: Record<string, (text: string) => void>; // canaux vers la personne : telegram, local…
  send: (text: string) => string[]; // envoie sur tous les canaux, renvoie leurs noms
  setPaused: (paused: boolean) => void;
  status: () => string;
  channelCommands?: () => ChannelCommand[]; // le registre des commandes, pour Telegram et le chat local
  reply?: (text: string) => void; // posé par le canal qui a lancé une commande du dot
  lastCtx?: any;
  tickTimer?: ReturnType<typeof setInterval>;
  running?: boolean; // un run tourne : survit au rechargement des extensions, comme le run lui-même
}

// Une commande proposée à la personne sur ses canaux. `run` : instantanée, sans le modèle.
// `pi` : une commande de pi (extension du dot, skill…), transmise telle quelle.
export interface ChannelCommand {
  name: string; // nom côté canal : [a-z0-9_], 32 caractères au plus (contrainte de Telegram)
  description: string;
  run?: (args: string) => Promise<{ text: string; files?: string[] }>;
  pi?: string;
}
export const shared = ((globalThis as any).__dot ??= {}) as Shared;

shared.send = (text) => {
  const channels = Object.entries(shared.senders ?? {});
  for (const [, send] of channels) {
    try {
      send(text);
    } catch {}
  }
  return channels.map(([name]) => name);
};

shared.setPaused = (paused) => {
  changeState((s) => (s.paused = paused));
  log(paused ? "autonomy.pause" : "autonomy.resume");
};
shared.status = () => {
  const state = loadState();
  const plan = readPlan();
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const schedules = loadSchedules();
  const watches = loadWatches();
  return [
    state.paused ? "⏸ Autonomie en pause (/resume pour reprendre)." : "▶ Autonomie active.",
    ...(state.modelDown ? [`⚠️ Modèle injoignable depuis ${since(state.modelDown.since)} (${state.modelDown.tries} essais) : le travail attend.`] : []),
    state.running ? `En cours : ${state.running.label} (depuis ${since(state.running.since)}).` : "Aucun run en cours.",
    ...(state.events.length ? [`Événements en attente : ${state.events.map((e) => e.kind).join(", ")}.`] : []),
    "",
    `Objectifs (${open.length}) :`,
    ...(open.length ? open.map((o) => objectiveBlock(plan, o, false)) : ["aucun"]),
    "",
    `Tâches planifiées (${schedules.length}) :`,
    ...(schedules.length ? schedules.map((s) => `- ${describeSchedule(s)}`) : ["- aucune"]),
    `Veilles (${watches.length}) :`,
    ...(watches.length ? watches.map((w) => `- ${w.id} · toutes les ${w.every} min${w.paused ? " · en pause" : ""} · ${w.prompt}`) : ["- aucune"]),
  ].join("\n");
};


// --- Journal ---

export const LOGS_DIR = join(HOME, "logs");
export const LIVE_FILE = join(HOME, "channel", "live.json");

export function logEvents(days: number): any[] {
  try {
    return readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .slice(-days)
      .flatMap((f) => readFileSync(join(LOGS_DIR, f), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }))
      .filter(Boolean);
  } catch {
    return [];
  }
}
