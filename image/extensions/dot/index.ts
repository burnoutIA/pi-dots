// dot — extension pi : ce qui rend l'agent autonome et proactif.
//
// Le dot tourne dans deux rôles :
//
//   - la conversation (le pi de tmux, DOT_ROLE vide) : il parle avec la personne et fait battre le
//     cœur. Le battement (toutes les 15 s, sans modèle) lit le plan et les événements ; quand il y a
//     quelque chose à faire, il lance un run de travail ;
//   - un run de travail (DOT_ROLE=worker) : un pi lancé à part, dans la session de l'objectif
//     concerné, qui fait une seule chose (un todo, un nouveau plan, un événement) puis s'arrête.
//
// Ce qui déclenche un run, dans l'ordre :
//   1. un événement : tâche planifiée échue (`schedule`), veille qui a changé (`watch`), fichier
//      posé dans /dot/inbox ;
//   2. un todo resté en cours (reprise après un arrêt) ou un todo prêt ;
//   3. un objectif actif sans todo ouvert : il faut constater qu'il est atteint, ou refaire le plan.
// Sinon, rien : le modèle n'est pas sollicité. Un run à la fois, et seulement quand la conversation
// est inactive. Chaque run terminé laisse un court compte-rendu dans la conversation.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { log, pruneLogs } from "./log.ts";
import { forget, readMemory, remember, skillProblems } from "./memory.ts";
import { type Exposure, PROTECTED, applyToMcp, declaredTokens, readLoadout, readUsage, record, setExposure, usageFile, uses } from "./usage.ts";
import { modelUnavailable, retryMinutes } from "./outage.ts";
import { type Schedule, nextAfter } from "./schedule.ts";
import { MEMORY, OPEN, type Plan, type Todo, type Work, newId, nextWork, now, objectiveBlock, readPlan, todoLine, updatePlan } from "./plan.ts";

const HOME = process.env.DOT_HOME ?? "/dot";
const WORKSPACE = join(HOME, "workspace");
const INBOX = join(HOME, "inbox");
const INBOX_DONE = join(INBOX, "traités");
const STATE_FILE = join(MEMORY, "state.json");
const SCHEDULES_FILE = join(MEMORY, "schedules.json");
const WATCHES_FILE = join(MEMORY, "watches.json");

const WORKER = process.env.DOT_ROLE === "worker";
const num = (name: string, fallback: number) => (process.env[name] && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
const RECHECK_MINUTES = num("DOT_RECHECK_MINUTES", num("DOT_HEARTBEAT_MINUTES", 60)); // objectif sans progrès : pas de nouveau plan avant
const RUN_MINUTES = num("DOT_RUN_MINUTES", 30); // durée maximale d'un run
const MAX_RUNS = num("DOT_MAX_RUNS", 3); // runs sur un même todo avant de demander de l'aide
const TICK_MS = num("DOT_TICK_MS", 15_000);
const LOOP_REPEATS = num("DOT_LOOP_REPEATS", 5); // même appel d'outil répété : boucle probable
const REVIEW_DAYS = num("DOT_REVIEW_DAYS", 7); // revue de son budget par le dot (0 = jamais)
const SKILLS_DIR = join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent"), "skills");
const LATE_SKIP_MS = 15 * 60_000;
const MAX_TEXT = 4000;

type Kind = "tâche" | "veille" | "boîte" | "revue";
interface DotEvent { id: string; kind: Kind; text: string; tries?: number }
interface State {
  paused?: boolean;
  lastAlive?: string;
  events: DotEvent[];
  running?: { label: string; since: string };
  backoffUntil?: string;
  modelDown?: { since: string; tries: number; error: string }; // le modèle ne répond plus
  nextReview?: string; // prochaine revue de budget
}
interface Watch { id: string; command: string; every: number; prompt: string; paused?: boolean; hash?: string; output?: string; nextCheck: string }

// --- Fichiers ----------------------------------------------------------------------------------

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, value: unknown) {
  mkdirSync(MEMORY, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}
const loadState = (): State => ({ events: [], ...readJson<Partial<State>>(STATE_FILE, {}) }) as State;
function changeState(change: (s: State) => void) {
  const state = loadState();
  change(state);
  writeJson(STATE_FILE, state);
}
const loadSchedules = () => readJson<Schedule[]>(SCHEDULES_FILE, []);
const loadWatches = () => readJson<Watch[]>(WATCHES_FILE, []);

// --- Petits outils ------------------------------------------------------------------------------

const local = (date: Date | string) => new Date(date).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const stamp = () => local(new Date());
const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} caractères coupés]` : text);
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });

function since(iso?: string): string {
  if (!iso) return "jamais";
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

function describeSchedule(s: Schedule): string {
  const when = s.once ? `une fois, le ${local(s.once)}` : s.every ? `toutes les ${s.every} min` : `à ${s.at}${s.days?.length ? ` (jours ${s.days.join(",")})` : " chaque jour"}`;
  return `${s.id} · ${when}${s.paused ? " · en pause" : ` · prochaine : ${local(s.nextRun)}`} · ${s.prompt}`;
}

function shell(command: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("bash", ["-lc", command], { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, cwd: WORKSPACE }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === "number" ? `\n[code de sortie ${(error as any).code}]` : error ? `\n[${error.message}]` : "";
      resolve(`${stdout}${stderr ? `\n${stderr}` : ""}${code}`.trim());
    });
  });
}

// --- Partagé entre extensions (et survit au rechargement de session) ---------------------------------

interface Shared {
  send?: (text: string) => void; // posé par dot-telegram
  setPaused: (paused: boolean) => void;
  status: () => string;
}
const shared = ((globalThis as any).__dot ??= {}) as Shared;

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

// --- Les prompts des runs ------------------------------------------------------------------------

function todoPrompt(plan: Plan, work: Extract<Work, { kind: "todo" }>): string {
  const { objective, todo, resume } = work;
  return [
    `[dot:todo] ${stamp()}`,
    `Objectif ${objective.id} : ${objective.title}`,
    "",
    "Plan actuel :",
    objectiveBlock(plan, objective),
    "",
    `Ton todo : ${todo.id} · ${todo.text}`,
    ...(resume ? ["Ce todo était déjà en cours (run interrompu ou pas terminé) : regarde où tu en étais, puis continue."] : []),
    "",
    "Fais ce todo, et seulement lui. Ensuite :",
    "- fini : `todo` done, avec le résultat ;",
    "- il te faut la personne (une information, une décision, un accès) : pose ta question avec `notify`, puis `todo` wait ;",
    "- il faut d'autres étapes : ajoute-les avec `todo` add.",
    "Si tu as appris quelque chose de durable (comment marche un service, une décision de la personne), note-le avec `remember`.",
    "Ta réponse finale est un compte-rendu de deux ou trois lignes.",
  ].join("\n");
}

function planPrompt(plan: Plan, work: Extract<Work, { kind: "plan" }>): string {
  const { objective } = work;
  return [
    `[dot:plan] ${stamp()}`,
    `L'objectif ${objective.id} n'a plus aucun todo ouvert.`,
    "",
    objectiveBlock(plan, objective),
    "",
    "Décide :",
    "- s'il est atteint : `objective` reached, avec le résultat ;",
    "- sinon : fais le plan des prochaines étapes avec `todo` add (petites, concrètes, vérifiables). Ne les exécute pas maintenant ;",
    "- si rien n'est possible pour l'instant : ne change rien et explique pourquoi en une ligne.",
  ].join("\n");
}

function eventPrompt(event: DotEvent): string {
  return `${event.text}\n\nSi cela demande un travail suivi, crée un objectif (\`objective\` add) ou des todos plutôt que de tout faire maintenant. Si tu as appris quelque chose de durable, note-le avec \`remember\`. Ta réponse finale est un compte-rendu de deux ou trois lignes.`;
}

// --- Un run de travail : un pi à part, dans la session donnée ------------------------------------

// Le run est journalisé de bout en bout : début, fin, durée, tours, outils appelés, jetons, et
// « loop.suspect » dès qu'un même appel d'outil (même nom, mêmes arguments) se répète
// LOOP_REPEATS fois de suite.
interface RunInfo { label: string; kind: string; session: string; objective?: string; todo?: string }

interface RunResult { ok: boolean; text: string; unavailable: boolean }

function runWorker(prompt: string, info: RunInfo): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    log("run.start", { ...info });
    const child = spawn("pi", ["-p", "--mode", "json", "--session-id", info.session, "--", prompt], {
      cwd: WORKSPACE,
      env: { ...process.env, DOT_ROLE: "worker" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let buffer = "";
    let errors = "";
    let timedOut = false;
    const stats = { turns: 0, toolCalls: 0, tools: {} as Record<string, number>, tokensIn: 0, tokensOut: 0, maxRepeat: 0 };
    const seen = new Map<string, number>(); // appel (nom + arguments) → nombre de fois dans ce run
    let loopStopped = false;

    function onEvent(event: any) {
      if (event.type === "turn_end") stats.turns += 1;
      const m = event.type === "message_end" ? event.message : null;
      if (m?.role !== "assistant") return;
      stats.tokensIn += Number(m.usage?.input ?? 0) + Number(m.usage?.cacheRead ?? 0);
      stats.tokensOut += Number(m.usage?.output ?? 0);
      const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (t) text = t;
      if (m.errorMessage) errors = String(m.errorMessage);
      for (const call of (m.content ?? []).filter((c: any) => c.type === "toolCall")) {
        stats.toolCalls += 1;
        stats.tools[call.name] = (stats.tools[call.name] ?? 0) + 1;
        // Même appel répété dans le run, à la suite ou non (A, B, A, B…) : c'est une boucle, le run
        // est arrêté. Le travail n'est pas perdu : un todo reste en cours, un événement en file.
        const signature = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
        const repeat = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, repeat);
        stats.maxRepeat = Math.max(stats.maxRepeat, repeat);
        if (repeat >= LOOP_REPEATS && !loopStopped) {
          loopStopped = true;
          log("loop.suspect", { ...info, repeat, call: signature.slice(0, 300), sinceStartS: Math.round((Date.now() - started) / 1000), stopped: true });
          errors = `run arrêté : boucle (${call.name} répété ${repeat} fois)`;
          child.kill("SIGTERM");
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          onEvent(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (errors = (errors + String(chunk)).slice(-2000)));
    const timer = setTimeout(() => {
      timedOut = true;
      errors = `run arrêté après ${RUN_MINUTES} min`;
      child.kill("SIGTERM");
    }, RUN_MINUTES * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0 && !!text && !loopStopped;
      // SIGKILL sans dépassement de durée : en général, le noyau a tué pi faute de mémoire.
      const killed = signal === "SIGKILL" && !timedOut ? "tué par le système (mémoire ?)" : undefined;
      const result = text || killed || errors.trim() || `pi s'est arrêté (code ${code})`;
      const unavailable = modelUnavailable({ ok, tokensOut: stats.tokensOut, toolCalls: stats.toolCalls, error: errors });
      log("run.end", {
        ...info,
        ok,
        code,
        signal: signal ?? undefined,
        timedOut: timedOut || undefined,
        loopStopped: loopStopped || undefined,
        durationS: Math.round((Date.now() - started) / 1000),
        ...stats,
        error: ok ? undefined : (killed ?? errors.trim().slice(0, 500)) || undefined,
        report: text.slice(0, 300) || undefined,
        modelUnavailable: unavailable || undefined,
      });
      resolve({ ok, text: result, unavailable });
    });
  });
}

// --- Rappel des fichiers persistants dans le prompt système ---------------------------------------

function memorySection(): string {
  const read = (name: string) => {
    try {
      return readFileSync(join(MEMORY, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const plan = readPlan();
  const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
  const journal = read("JOURNAL.md").split("\n").slice(-25).join("\n");
  return [
    `## MEMORY.md\n${readMemory(MEMORY).trim()}`,
    `## Objectifs en cours\n${open.length ? open.map((o) => objectiveBlock(plan, o, false)).join("\n\n") : "Aucun."}`,
    `## JOURNAL.md (fin)\n${journal}`,
  ].join("\n\n");
}

// --- L'extension -----------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let atStart = "";
  let brokenSkills: string[] = [];
  let budgetNote = "";
  let lastCtx: any = null;
  // Chaque appel d'outil est compté (et le skill qu'il touche) : c'est sur cet usage réel que le
  // dot décide ce qui reste déclaré au modèle.
  pi.on("tool_call", (event: any) => {
    try {
      record(MEMORY, event.toolName, event.input ?? event.args);
    } catch {}
  });
  pi.on("session_start", (_event: any, context: any) => {
    mkdirSync(MEMORY, { recursive: true });
    if (!existsSync(usageFile(MEMORY))) seedUsage();
    atStart = memorySection();
    lastCtx = context;
    budgetNote = ""; // calculée au premier appel, quand les outils MCP sont connectés
    brokenSkills = skillProblems(join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent"), "skills"));
    if (brokenSkills.length) log("skills.broken", { skills: brokenSkills });
  });
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      dot_role: WORKER
        ? "This is a work run: you were started on your own, on one precise job (described in the message). Nobody reads this run live. Do the job, keep the plan up to date with `todo` / `objective`, use `notify` only for what the person must know, and finish with a short report."
        : "This is your conversation with the person. Your work on objectives runs separately (one session per objective); its reports reach this conversation as `[dot:compte-rendu]` messages. To start some work, create an objective or todos: the work runs will take them up.",
      dot_memory: `Your persistent state, as it was when this session started (read /dot/memory again for the current version):\n\n${atStart}`,
      dot_budget: (budgetNote ||= budgetSection(pi, lastCtx)),
      ...(brokenSkills.length
        ? {
            dot_skills: `These skills of yours are NOT loaded, because their SKILL.md does not start with the required header: ${brokenSkills.join(", ")}. Fix each one now: the file must start with\n---\nname: <folder name>\ndescription: <what it does and when to use it, one sentence>\n---`,
          }
        : {}),
    };
  });

  registerTools(pi);
  if (WORKER) return;

  // ===== Conversation : le battement ==========================================================

  let ctx: any = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const checking = new Set<string>();

  const enqueue = (kind: Kind, text: string, detail: Record<string, unknown> = {}) => {
    const id = newId();
    changeState((s) => s.events.push({ id, kind, text }));
    log("event.queued", { event: id, kind, ...detail });
  };

  function dueSchedules(at: Date) {
    const schedules = loadSchedules();
    let changed = false;
    for (const s of [...schedules]) {
      if (s.paused || at < new Date(s.nextRun)) continue;
      const late = at.getTime() - new Date(s.nextRun).getTime();
      if (s.catchUp !== false || late <= LATE_SKIP_MS) {
        const missed = late > LATE_SKIP_MS ? ` (prévue le ${local(s.nextRun)}, lancée en retard : l'environnement était éteint)` : "";
        enqueue("tâche", `[dot:tâche] ${stamp()}\nTâche planifiée ${s.id}${missed} :\n${s.prompt}`, { schedule: s.id, lateMin: Math.round(late / 60_000) });
      } else {
        log("schedule.skipped", { schedule: s.id, lateMin: Math.round(late / 60_000) });
      }
      s.lastRun = at.toISOString();
      const next = nextAfter(s, at);
      if (next) s.nextRun = next.toISOString();
      else schedules.splice(schedules.indexOf(s), 1);
      changed = true;
    }
    if (changed) writeJson(SCHEDULES_FILE, schedules);
  }

  function dueWatches(at: Date) {
    for (const w of loadWatches()) {
      if (w.paused || checking.has(w.id) || at < new Date(w.nextCheck)) continue;
      checking.add(w.id);
      void shell(w.command).then((output) => {
        checking.delete(w.id);
        const watches = loadWatches();
        const current = watches.find((x) => x.id === w.id);
        if (!current) return;
        const hash = createHash("sha256").update(output).digest("hex");
        if (current.hash && current.hash !== hash) {
          enqueue("veille", `[dot:veille] ${stamp()}\nLa veille ${w.id} a changé.\nCe qu'elle surveille : ${w.prompt}\nCommande : ${w.command}\n\nAvant :\n${cut(current.output ?? "", 1500)}\n\nMaintenant :\n${cut(output, 2500)}`, { watch: w.id });
        }
        current.hash = hash;
        current.output = cut(output);
        current.nextCheck = later(current.every);
        writeJson(WATCHES_FILE, watches);
      });
    }
  }

  function inbox() {
    if (!existsSync(INBOX)) return;
    for (const name of readdirSync(INBOX)) {
      if (name.startsWith(".")) continue;
      const file = join(INBOX, name);
      const info = statSync(file);
      if (!info.isFile() || Date.now() - info.mtimeMs < 2000) continue;
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {}
      mkdirSync(INBOX_DONE, { recursive: true });
      renameSync(file, join(INBOX_DONE, `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`));
      const who = name.startsWith("coffre-") ? "Le coffre t'a laissé" : "La personne a déposé";
      enqueue("boîte", `[dot:boîte] ${stamp()}\n${who} « ${name} » dans la boîte :\n${cut(text)}`, { file: name });
    }
  }

  // Revue de budget : régulièrement, le dot regarde ce qu'il utilise vraiment et ajuste ce qui est
  // déclaré au modèle. Ses choix sont réversibles (un outil différé reste utilisable et son usage est
  // compté) : la première revue a lieu dès le lendemain.
  function dueReview(at: Date) {
    if (REVIEW_DAYS <= 0) return;
    const state = loadState();
    if (!state.nextReview) return changeState((s) => (s.nextReview = later(24 * 60)));
    if (at < new Date(state.nextReview)) return;
    changeState((s) => (s.nextReview = later(REVIEW_DAYS * 24 * 60)));
    enqueue(
      "revue",
      [
        `[dot:revue] ${stamp()}`,
        "Revue de ton budget de contexte. Lance `budget` show, puis :",
        "- passe en `deferred` les outils déclarés lourds et peu utilisés ces 30 jours ; remets en `direct` ceux que tu as dû chercher souvent ;",
        "- allège tes skills trop longs (l'essentiel dans SKILL.md, les détails dans des fichiers à part) et ceux que tu n'utilises plus, supprime-les ;",
        "- note avec `remember` ce que tu as changé et pourquoi.",
        "Ne préviens la personne que si tu as changé quelque chose qui la concerne.",
      ].join("\n"),
    );
  }

  // Compte-rendu d'un run, ajouté à la conversation sans relancer le modèle.
  function report(label: string, text: string) {
    const content = `[dot:compte-rendu] ${stamp()} · ${label}\n${cut(text, 1500)}`;
    try {
      pi.sendMessage({ customType: "dot-run", content, display: true }, ctx?.isIdle?.() ? {} : { deliverAs: "nextTurn" });
    } catch {}
    appendFileSync(join(MEMORY, "JOURNAL.md"), `\n- ${stamp()} · ${label} — ${text.split("\n")[0].slice(0, 300)}\n`);
  }

  // Panne du modèle : rien n'est compté comme un échec, le travail attend. La personne est prévenue
  // une fois, puis au retour du modèle.
  function onModelDown(error: string) {
    let first = false;
    changeState((s) => {
      first = !s.modelDown;
      s.modelDown = { since: s.modelDown?.since ?? now(), tries: (s.modelDown?.tries ?? 0) + 1, error: error.slice(0, 200) };
      s.backoffUntil = later(retryMinutes(s.modelDown.tries));
    });
    const state = loadState();
    log("model.down", { tries: state.modelDown?.tries, retryInMin: retryMinutes(state.modelDown?.tries ?? 1), error: error.slice(0, 200) });
    if (first) shared.send?.(`⚠️ Je n'arrive plus à joindre mon modèle (${error.slice(0, 120)}). Mon travail attend, rien n'est perdu : je réessaie régulièrement et je te préviens quand il revient.`);
  }
  function onModelUp() {
    const down = loadState().modelDown;
    if (!down) return;
    changeState((s) => delete s.modelDown);
    const minutes = Math.round((Date.now() - new Date(down.since).getTime()) / 60_000);
    log("model.up", { downForMin: minutes, tries: down.tries });
    shared.send?.(`✅ Mon modèle répond de nouveau (coupure d'environ ${minutes} min). Je reprends le travail en attente.`);
  }

  // Un todo que le run n'a pas conclu reste en cours ; au-delà de MAX_RUNS, on demande de l'aide.
  function afterTodo(todoId: string, ok: boolean, text: string) {
    const stuck = updatePlan((plan) => {
      const todo = plan.todos.find((t) => t.id === todoId);
      if (!todo || !["todo", "doing"].includes(todo.status)) return null;
      todo.runs += 1;
      todo.updated = now();
      if (todo.runs >= MAX_RUNS) {
        todo.status = "waiting";
        todo.reason = `pas terminé après ${todo.runs} runs${ok ? "" : ` (${text.slice(0, 200)})`}`;
        return todo;
      }
      todo.status = "doing";
      return null;
    });
    if (stuck) {
      log("todo.stuck", { objective: stuck.objective, todo: stuck.id, runs: stuck.runs, reason: stuck.reason });
      shared.send?.(`Je bloque sur « ${stuck.text} » (${stuck.reason}). Peux-tu m'aider ou me dire comment continuer ?`);
    }
  }

  async function work(): Promise<void> {
    const state = loadState();
    // 1. Événements
    const event = state.events[0];
    if (event) {
      const label = `événement (${event.kind})`;
      changeState((s) => (s.running = { label, since: now() }));
      const result = await runWorker(eventPrompt(event), { label, kind: `event:${event.kind}`, session: "dot-evenements" });
      if (result.unavailable) {
        changeState((s) => delete s.running);
        return onModelDown(result.text);
      }
      onModelUp();
      changeState((s) => {
        delete s.running;
        const e = s.events.find((x) => x.id === event.id);
        if (!e) return;
        e.tries = (e.tries ?? 0) + 1;
        if (result.ok || e.tries >= 3) s.events = s.events.filter((x) => x.id !== event.id);
        if (!result.ok) s.backoffUntil = later(2);
      });
      report(label, result.text);
      return;
    }

    // 2 et 3. Le plan
    const plan = readPlan();
    const next = nextWork(plan);
    if (!next) return;
    const objective = next.objective;
    const sessionId = `dot-objectif-${objective.id}`;

    if (next.kind === "todo") {
      updatePlan((p) => {
        const t = p.todos.find((x) => x.id === next.todo.id);
        if (t) Object.assign(t, { status: "doing", updated: now() });
      });
      const label = `${objective.title} · ${next.todo.text}`;
      changeState((s) => (s.running = { label, since: now() }));
      const result = await runWorker(todoPrompt(readPlan(), next), {
        label,
        kind: next.resume ? "todo:reprise" : "todo",
        session: sessionId,
        objective: objective.id,
        todo: next.todo.id,
      });
      if (result.unavailable) {
        changeState((s) => delete s.running);
        return onModelDown(result.text); // le todo reste « en cours » : il sera repris
      }
      onModelUp();
      changeState((s) => {
        delete s.running;
        if (!result.ok) s.backoffUntil = later(2);
      });
      afterTodo(next.todo.id, result.ok, result.text);
      report(label, result.text);
      return;
    }

    // Nouveau plan : s'il ne change rien, l'objectif n'est réexaminé qu'après RECHECK_MINUTES.
    const fingerprint = (p: Plan) => JSON.stringify([p.objectives.find((o) => o.id === objective.id)?.status, p.todos.filter((t) => t.objective === objective.id).map((t) => [t.id, t.status])]);
    const before = fingerprint(plan);
    const label = `${objective.title} · plan`;
    changeState((s) => (s.running = { label, since: now() }));
    const result = await runWorker(planPrompt(plan, next), { label, kind: "plan", session: sessionId, objective: objective.id });
    if (result.unavailable) {
      changeState((s) => delete s.running);
      return onModelDown(result.text);
    }
    onModelUp();
    changeState((s) => {
      delete s.running;
      if (!result.ok) s.backoffUntil = later(2);
    });
    const unchanged = updatePlan((p) => {
      const o = p.objectives.find((x) => x.id === objective.id);
      if (!o || fingerprint(p) !== before) return false;
      o.idleUntil = later(RECHECK_MINUTES);
      return true;
    });
    if (unchanged) log("plan.unchanged", { objective: objective.id, recheckInMin: RECHECK_MINUTES });
    report(label, result.text);
  }

  function tick() {
    const at = new Date();
    changeState((s) => (s.lastAlive = at.toISOString()));
    dueSchedules(at);
    dueWatches(at);
    inbox();
    dueReview(at);

    const state = loadState();
    if (running || state.paused) return;
    if (state.backoffUntil && new Date(state.backoffUntil) > at) return;
    if (ctx?.isIdle?.() !== true) return; // la personne d'abord
    running = true;
    work()
      .catch((error) => {
        log("heartbeat.error", { error: String(error?.stack ?? error).slice(0, 1000) });
        report("erreur du battement", String(error?.message ?? error));
      })
      .finally(() => (running = false));
  }

  pi.on("session_start", (_event, context: any) => {
    ctx = context;
    mkdirSync(INBOX, { recursive: true });
    pruneLogs();
    // Un run coupé par un arrêt : son todo est resté « en cours » et sera repris au premier battement.
    const state = loadState();
    const doing = readPlan().todos.filter((t) => t.status === "doing").map((t) => t.id);
    log("conversation.start", { interrupted: state.running?.label, todosInProgress: doing.length ? doing : undefined, paused: state.paused || undefined });
    changeState((s) => delete s.running);
    if (!timer) timer = setInterval(tick, TICK_MS);
  });
  pi.on("session_shutdown", () => {
    log("conversation.stop");
    if (timer) clearInterval(timer);
    timer = null;
    ctx = null;
  });

  pi.registerCommand("dot-status", {
    description: "État du dot : objectifs, run en cours, tâches, veilles",
    handler: async (_args, context: any) => context.ui.notify(shared.status(), "info"),
  });
  pi.registerCommand("dot-pause", {
    description: "Mettre l'autonomie en pause (plus aucun run de travail)",
    handler: async (_args, context: any) => {
      shared.setPaused(true);
      context.ui.notify("Autonomie en pause.", "info");
    },
  });
  pi.registerCommand("dot-resume", {
    description: "Reprendre l'autonomie",
    handler: async (_args, context: any) => {
      shared.setPaused(false);
      context.ui.notify("Autonomie reprise.", "info");
    },
  });
}

// --- Budget de contexte ------------------------------------------------------------------------------

const LOGS_DIR = join(HOME, "logs");
const MCP_DEFAULTS = "/opt/dot/defaults/mcp.json";
const MCP_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent"), "mcp.json");

function logEvents(days: number): any[] {
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

// Premier démarrage avec le comptage : l'usage passé est repris du journal (outils appelés par les runs).
function seedUsage() {
  const usage: any = { tools: {}, skills: {} };
  for (const e of logEvents(60)) {
    if (e.type !== "run.end" || !e.tools) continue;
    const d = String(e.t).slice(0, 10);
    for (const [name, n] of Object.entries<number>(e.tools)) {
      const daily = (usage.tools[name] ??= {});
      daily[d] = (daily[d] ?? 0) + n;
    }
  }
  writeJson(usageFile(MEMORY), usage);
}

function declared(pi: ExtensionAPI) {
  const active = new Set((pi as any).getActiveTools?.() ?? []);
  return pi.getAllTools().filter((t: any) => active.has(t.name));
}

// Outils mis en différé mais rechargés souvent ces 7 derniers jours : le choix est à revoir.
function reloaded(pi: ExtensionAPI): string[] {
  const usage = readUsage(MEMORY);
  const deferredNow = Object.entries(readLoadout(MEMORY)).filter(([, e]) => e === "deferred").map(([n]) => n);
  const often = deferredNow.filter((n) => uses(usage.tools[n], 7).count >= 3);
  return often.length ? [`You deferred these tools but used them often in the last 7 days: ${often.join(", ")}. Consider making them direct again (\`budget\` set).`] : [];
}

// Une note fixe pour la session (le début du contexte reste identique d'un appel à l'autre).
function budgetSection(pi: ExtensionAPI, ctx: any): string {
  const model = ctx?.model;
  const window = model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  const tools = declared(pi);
  const toolTokens = tools.reduce((n: number, t: any) => n + declaredTokens(t), 0);
  return [
    `Your context budget: model ${model ? `${model.provider}/${model.id}` : "unknown"}${window ? `, context window ${window} tokens` : ""}.`,
    `Before you do anything, your instructions and the ${tools.length} tools declared to you take thousands of tokens (tools alone ≈ ${toolTokens}), on every single call. Every token costs time, and the model may run on the person's own hardware.`,
    "Be frugal: keep skills short (the essentials in SKILL.md, details in separate files read only when needed), make scripts print only what you need, never paste large outputs, and keep rarely used tools deferred (`tool_search` loads them when needed).",
    "`budget` shows what you really use (tools, skills, runs) and lets you choose what stays declared.",
    ...reloaded(pi),
  ].join("\n");
}

function budgetReport(pi: ExtensionAPI, ctx: any): string {
  const usage = readUsage(MEMORY);
  const loadout = readLoadout(MEMORY);
  const model = ctx?.model;
  const ctxUsage = ctx?.getContextUsage?.();
  const active = new Set((pi as any).getActiveTools?.() ?? []);
  const rows = pi
    .getAllTools()
    .filter((t: any) => t.exposure !== "hidden")
    .map((t: any) => ({ name: t.name, exposure: active.has(t.name) ? "direct" : loadout[t.name] ?? t.exposure, tokens: declaredTokens(t), ...uses(usage.tools[t.name]) }))
    .sort((a: any, b: any) => b.tokens - a.tokens);
  const declaredRows = rows.filter((r: any) => r.exposure === "direct");
  const skills = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR)
        .filter((n) => existsSync(join(SKILLS_DIR, n, "SKILL.md")))
        .map((n) => ({ name: n, tokens: Math.round(statSync(join(SKILLS_DIR, n, "SKILL.md")).size / 3.6), ...uses(usage.skills[n]) }))
    : [];
  const runs = logEvents(7).filter((e) => e.type === "run.end");
  const tokens = (e: any) => (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
  const biggest = runs.slice().sort((a, b) => tokens(b) - tokens(a))[0];
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return [
    `Model: ${model ? `${model.provider}/${model.id}` : "?"} · context window ${ctxUsage?.contextWindow ?? model?.contextWindow ?? "?"} · now used: ${ctxUsage?.tokens ?? "?"} tokens${ctxUsage?.percent != null ? ` (${Math.round(ctxUsage.percent)}%)` : ""}`,
    `Declared tools: ${declaredRows.length}, ≈ ${declaredRows.reduce((n: number, r: any) => n + r.tokens, 0)} tokens on every call.`,
    "",
    "Tools (≈tokens when declared · calls in 30 days · last used):",
    ...rows.map((r: any) => `- ${r.name} · ${r.exposure}${PROTECTED.has(r.name) ? " (base)" : ""} · ${r.tokens} · ${r.count} · ${r.last ?? "never"}`),
    "",
    `Skills (≈tokens of SKILL.md · uses in 30 days · last used):`,
    ...(skills.length ? skills.map((r) => `- ${r.name} · ${r.tokens} · ${r.count} · ${r.last ?? "never"}`) : ["- none"]),
    "",
    `Work runs, last 7 days: ${runs.length}${runs.length ? `, ${k(runs.reduce((n, e) => n + tokens(e), 0) / runs.length)} tokens on average, biggest ${k(tokens(biggest))} (${String(biggest.label ?? "").slice(0, 80)})` : ""}`,
  ].join("\n");
}

// --- Outils : les mêmes dans la conversation et dans les runs -------------------------------------

const NOTIFY_MEMORY = join(MEMORY, "notify-recent.json");

// Rien de nouveau = rien à envoyer : un message qui redit la même chose (aux espaces, majuscules et
// émojis près) qu'un message des 6 dernières heures n'est pas renvoyé. Le nombre de messages, lui,
// n'est pas limité : une boucle est arrêtée par ailleurs (même appel répété dans un run).
function alreadySent(text: string): boolean {
  const same = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const hash = createHash("sha256").update(same).digest("hex");
  const limit = Date.now() - 6 * 3600_000;
  const recent = readJson<Record<string, number>>(NOTIFY_MEMORY, {});
  for (const [h, t] of Object.entries(recent)) if (t < limit) delete recent[h];
  const seen = !!recent[hash];
  if (!seen) recent[hash] = Date.now();
  writeJson(NOTIFY_MEMORY, recent);
  return seen;
}

function registerTools(pi: ExtensionAPI) {
  // Les outils du dot sont déclarés selon ses choix (loadout.json) ; ses outils de base, toujours.
  const loadout = readLoadout(MEMORY);
  const reg = (def: any) => pi.registerTool(loadout[def.name] === "deferred" && !PROTECTED.has(def.name) ? { ...def, exposure: "deferred" } : def);

  reg({
    name: "notify",
    label: "notify",
    description:
      "Send a message to the person (on Telegram when configured), when you work on your own and have something NEW and useful for them: a result, a question that blocks you, a decision they must take. " +
      "If there is nothing new or relevant, send nothing: never a message to say that nothing happened, that all is fine, or to repeat what they already know. Group what you have into one message. A message that repeats a recent one is not sent.",
    promptSnippet: "notify: send a message to the person while you work on your own",
    parameters: Type.Object({ text: Type.String({ description: "The message, short and self-contained" }) }),
    async execute(_id: string, args: any) {
      const text = String(args.text ?? "").trim();
      if (!text) return answer("Empty message.", true);
      if (alreadySent(text)) {
        log("notify.blocked", { reason: "déjà envoyé", text: text.slice(0, 120) });
        return answer("Not sent: this says the same as a message sent to the person recently. Nothing new: do not send it again.", true);
      }
      log("notify", { text: text.slice(0, 300), channel: shared.send ? "telegram" : "file" });
      if (shared.send) {
        shared.send(text);
        return answer("Sent to the person.");
      }
      appendFileSync(join(MEMORY, "NOTIFICATIONS.md"), `\n## ${stamp()}\n${text}\n`);
      return answer(`No messaging channel is configured: the message was written to ${join(MEMORY, "NOTIFICATIONS.md")}.`);
    },
  });

  reg({
    name: "remember",
    label: "remember",
    description:
      "Save one durable fact to your memory (/dot/memory/MEMORY.md), which every future session reads at start: the conversation and all your work runs. " +
      "This is the only way what you learn in one session reaches the others. One short sentence, self-contained, in the person's language.",
    promptSnippet: "remember: save a durable fact for all your future sessions",
    promptGuidelines: [
      "Use `remember` as soon as you learn something that will matter later: a decision or preference of the person, how one of their services works for you (which skill, which secret names, which server), what was abandoned and why.",
      "Do not remember details of the current task, or things already in your memory. When a fact becomes wrong, `forget` it and remember the new one.",
    ],
    parameters: Type.Object({ fact: Type.String({ description: "One short sentence that stands on its own" }) }),
    async execute(_id: string, args: any) {
      const outcome = remember(MEMORY, String(args.fact ?? ""));
      if (outcome.ok) log("memory.remember", { fact: String(args.fact).slice(0, 200) });
      return answer(outcome.message, !outcome.ok);
    },
  });

  reg({
    name: "forget",
    label: "forget",
    description: "Remove one outdated or wrong fact from your memory. `match` is a passage of that fact.",
    promptSnippet: "forget: remove an outdated fact from your memory",
    parameters: Type.Object({ match: Type.String({ description: "A passage of the fact to remove, precise enough to single it out" }) }),
    async execute(_id: string, args: any) {
      const outcome = forget(MEMORY, String(args.match ?? ""));
      if (outcome.ok) log("memory.forget", { match: String(args.match).slice(0, 200) });
      return answer(outcome.message, !outcome.ok);
    },
  });

  reg({
    name: "budget",
    label: "budget",
    description:
      "Your context budget. action `show`: your model and context window, what each declared tool costs on every call, how often you really used each tool and skill (30 days), and the token cost of your recent work runs. " +
      "action `set` (tools, exposure): choose what is declared to the model — `direct` (always declared) or `deferred` (not declared; `tool_search` loads it when you need it). Decide from real usage: defer heavy tools you rarely use, keep direct those you use often. Your base tools always stay direct. Takes effect from your next run.",
    promptSnippet: "budget: see your real tool/skill usage and token costs, choose which tools stay declared",
    parameters: Type.Object({
      action: Type.String({ description: "show | set" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "With set: tool names, e.g. mcp__playwright__browser_drag" })),
      exposure: Type.Optional(Type.String({ description: "With set: direct | deferred" })),
    }),
    async execute(_id: string, args: any, _signal: any, _onUpdate: any, ctx: any) {
      if (args.action === "show") return answer(budgetReport(pi, ctx));
      if (args.action === "set") {
        const exposure = args.exposure as Exposure;
        if (exposure !== "direct" && exposure !== "deferred") return answer("exposure: direct or deferred.", true);
        const known = new Set(pi.getAllTools().map((t: any) => t.name));
        const names = (args.tools ?? []).map(String);
        const unknown = names.filter((n: string) => !known.has(n));
        if (!names.length || unknown.length) return answer(`tools: names from \`budget\` show${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}.`, true);
        const { applied, refused } = setExposure(MEMORY, names, exposure);
        try {
          if (existsSync(MCP_DEFAULTS)) writeFileSync(MCP_FILE, JSON.stringify(applyToMcp(JSON.parse(readFileSync(MCP_DEFAULTS, "utf8")), readLoadout(MEMORY)), null, 2) + "\n");
        } catch {}
        log("budget.set", { exposure, tools: applied, refused: refused.length ? refused : undefined });
        return answer(`${exposure}: ${applied.join(", ") || "nothing"}${refused.length ? ` · refused (base tools stay direct): ${refused.join(", ")}` : ""}. Takes effect from your next run.`);
      }
      return answer("Unknown action: use show or set.", true);
    },
  });

  reg({
    name: "doctor",
    label: "doctor",
    description:
      "Check your own health, link by link: vault, internet, model, Telegram, heartbeat, plan, skills, memory, resources, and the problems logged in the last 24 hours. " +
      "Use it when something does not work as expected, before guessing.",
    promptSnippet: "doctor: diagnose your environment (vault, model, Telegram, heartbeat, skills, resources, recent problems)",
    parameters: Type.Object({}),
    async execute() {
      const output = await new Promise<string>((resolve) =>
        execFile("node", ["/opt/dot/doctor.mjs"], { timeout: 60_000 }, (error, stdout, stderr) => resolve(`${stdout}${stderr}`.trim() || String(error?.message ?? ""))),
      );
      return answer(output || "doctor: no output");
    },
  });

  reg({
    name: "secret",
    label: "secret",
    description:
      "Your secrets live in the vault, never with you. You only know their NAMES; the vault puts the values in your requests. " +
      "To call a service through the vault: http://dot-vault:8080/https/<host>/<path> (or /http/…), writing {{NAME}} where a secret goes (URL or header), " +
      "e.g. `Authorization: Bearer {{API_TOKEN}}` or `Authorization: Basic {{basic:SERVICE_USER:SERVICE_PASSWORD}}`; for mail (IMAP, read-only): POST http://dot-vault:8080/_vault/mail (see `curl http://dot-vault:8080/`). A secret only goes to its allowed hosts. " +
      "action `list`: the secrets that exist (names, allowed hosts, read-only), never their values. " +
      "action `request`: ask the person for missing secrets; the vault asks them on Telegram, catches their answers before they reach you, stores them, " +
      "and drops a note in your inbox when done. Give `secrets` (names in CAPITALS with a human label), `hosts` (where they may be sent), `read_only`, and `purpose`. " +
      "action `extend`: an existing secret must also go to other servers (e.g. the same account on another server of the service): give `secrets` (existing names), the extra `hosts` and `purpose`; the person answers yes or no.",
    promptSnippet: "secret: list the vault's secrets, or ask the person for a missing one (you never see values)",
    promptGuidelines: [
      "Never ask the person for a password, key or token in the conversation, and never look for one in your environment: use `secret` request.",
      "In skills and scripts, write {{NAME}} placeholders and send requests through http://dot-vault:8080/https/<host>/…; never store a secret value anywhere.",
      "Ask for the narrowest `hosts` (e.g. *.example.com) and `read_only: true` unless writing is really needed.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "list | request | extend" }),
      secrets: Type.Optional(Type.Array(Type.Object({ name: Type.String({ description: "NAME_IN_CAPITALS" }), label: Type.Optional(Type.String({ description: "What it is, for the person (e.g. Identifiant du service)" })) }))),
      hosts: Type.Optional(Type.Array(Type.String(), { description: "Servers the secrets may be sent to, e.g. *.example.com, api.example.com" })),
      read_only: Type.Optional(Type.Boolean({ description: "Only read requests may carry these secrets (default true)" })),
      purpose: Type.Optional(Type.String({ description: "What they are for, one sentence the person will read" })),
    }),
    async execute(_id: string, args: any) {
      const vault = (process.env.DOT_VAULT ?? "http://dot-vault:8080").replace(/\/$/, "");
      try {
        if (args.action === "list") {
          const res = await fetch(`${vault}/_vault/secrets`, { signal: AbortSignal.timeout(10_000) });
          return answer(await res.text(), !res.ok);
        }
        if (args.action === "request" || args.action === "extend") {
          const res = await fetch(`${vault}/_vault/${args.action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ secrets: args.secrets, hosts: args.hosts, readOnly: args.read_only !== false, purpose: args.purpose }),
            signal: AbortSignal.timeout(30_000),
          });
          const text = await res.text();
          log("secret.request", { status: res.status, names: (args.secrets ?? []).map((s: any) => s?.name), hosts: args.hosts });
          return answer(res.ok ? `${text}\nMark the todo that needs it as waiting; you will get a [dot:boîte] note when the person has answered.` : text, !res.ok);
        }
        return answer("Unknown action: use list, request or extend.", true);
      } catch (error: any) {
        return answer(`Vault unreachable: ${error.message}`, true);
      }
    },
  });

  reg({
    name: "objective",
    label: "objective",
    description:
      "Manage your objectives: the lasting things you work towards, on your own, across restarts. Each active objective is worked on through its todos; when it has no open todo left, you are asked to check whether it is reached or to plan the next todos. " +
      "action: `add` (title, detail), `list`, `update` (id, title and/or detail), `reached` (id, result), `pause` / `resume` (id), `drop` (id, reason).",
    promptSnippet: "objective: add, update, close or list your lasting objectives",
    promptGuidelines: [
      "Create an objective with `objective` when the person asks for something that takes more than one step or must be followed over time; then plan its first todos with `todo` add.",
      "An objective is reached only when its result can be checked; mark it `reached` with that result.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "add | list | update | reached | pause | resume | drop" }),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ description: "Short title of the objective" })),
      detail: Type.Optional(Type.String({ description: "What success looks like, constraints, context" })),
      result: Type.Optional(Type.String({ description: "With `reached`: the result, checkable" })),
      reason: Type.Optional(Type.String({ description: "With `drop`: why" })),
    }),
    async execute(_id: string, args: any) {
      const plan = readPlan();
      if (args.action === "list") {
        return answer(plan.objectives.length ? plan.objectives.map((o) => objectiveBlock(plan, o, o.status === "active" || o.status === "paused")).join("\n\n") : "No objective.");
      }
      if (args.action === "add") {
        const title = String(args.title ?? "").trim();
        if (!title) return answer("`add` needs a title.", true);
        const id = newId();
        updatePlan((p) => p.objectives.push({ id, title, detail: args.detail?.trim() || undefined, status: "active", created: now(), updated: now() }));
        log("plan.change", { tool: "objective", action: "add", objective: id, title });
        return answer(`Objective ${id} added. Plan its first todos with \`todo\` add (objective: ${id}).`);
      }
      const found = updatePlan((p) => {
        const o = p.objectives.find((x) => x.id === args.id);
        if (!o) return null;
        switch (args.action) {
          case "update":
            if (args.title) o.title = String(args.title).trim();
            if (args.detail !== undefined) o.detail = String(args.detail).trim() || undefined;
            break;
          case "reached":
            o.status = "reached";
            o.result = String(args.result ?? "").trim() || undefined;
            break;
          case "pause":
            o.status = "paused";
            break;
          case "resume":
            o.status = "active";
            break;
          case "drop":
            o.status = "dropped";
            o.result = String(args.reason ?? "").trim() || undefined;
            for (const t of p.todos) if (t.objective === o.id && OPEN.includes(t.status)) Object.assign(t, { status: "dropped", reason: "objectif abandonné", updated: now() });
            break;
          default:
            return "unknown";
        }
        o.updated = now();
        delete o.idleUntil; // un objectif modifié mérite d'être réexaminé
        return o;
      });
      if (found === "unknown") return answer("Unknown action: use add, list, update, reached, pause, resume or drop.", true);
      if (!found) return answer(`No objective ${args.id}.`, true);
      log("plan.change", { tool: "objective", action: args.action, objective: found.id, status: found.status });
      return answer(objectiveBlock(readPlan(), found));
    },
  });

  reg({
    name: "todo",
    label: "todo",
    description:
      "Manage the todos of an objective: the concrete steps that lead to it. Each ready todo is taken up by a work run, one at a time. " +
      "action: `add` (objective, text, optional not_before), `list` (optional objective), `done` (id, result), `wait` (id, reason: you need the person or something external), `reopen` (id, optional text: e.g. after the person answered), `drop` (id, reason).",
    promptSnippet: "todo: add, complete, block, reopen or list the steps of an objective",
    promptGuidelines: [
      "Keep todos small, concrete and checkable. Add the next ones as soon as you know them.",
      "When the person answers a question a todo was waiting for, `reopen` it with what they said.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "add | list | done | wait | reopen | drop" }),
      id: Type.Optional(Type.String({ description: "Todo id" })),
      objective: Type.Optional(Type.String({ description: "Objective id (for add, or to filter list)" })),
      text: Type.Optional(Type.String({ description: "The step, as an action (for add, or to rewrite it on reopen)" })),
      not_before: Type.Optional(Type.String({ description: "With add: do not start before this local date-time (ISO, 2026-10-23T09:00)" })),
      result: Type.Optional(Type.String({ description: "With done: what was done or found" })),
      reason: Type.Optional(Type.String({ description: "With wait or drop: why" })),
    }),
    async execute(_id: string, args: any) {
      const plan = readPlan();
      if (args.action === "list") {
        const todos = plan.todos.filter((t) => !args.objective || t.objective === args.objective);
        return answer(todos.length ? todos.map((t) => `${todoLine(t)} [objective ${t.objective}]`).join("\n") : "No todo.");
      }
      if (args.action === "add") {
        const text = String(args.text ?? "").trim();
        if (!text) return answer("`add` needs text.", true);
        if (!plan.objectives.some((o) => o.id === args.objective)) return answer(`No objective ${args.objective}. Create it first with \`objective\` add.`, true);
        if (args.not_before && Number.isNaN(new Date(args.not_before).getTime())) return answer("`not_before` is not a valid date.", true);
        const todo: Todo = { id: newId(), objective: args.objective, text, status: "todo", runs: 0, created: now(), updated: now() };
        if (args.not_before) todo.notBefore = new Date(args.not_before).toISOString();
        updatePlan((p) => {
          p.todos.push(todo);
          const o = p.objectives.find((x) => x.id === todo.objective);
          if (o) delete o.idleUntil;
        });
        log("plan.change", { tool: "todo", action: "add", objective: todo.objective, todo: todo.id, text: todo.text.slice(0, 200) });
        return answer(`Todo ${todo.id} added: ${todo.text}`);
      }
      const found = updatePlan((p) => {
        const t = p.todos.find((x) => x.id === args.id);
        if (!t) return null;
        switch (args.action) {
          case "done":
            t.status = "done";
            t.result = String(args.result ?? "").trim() || undefined;
            break;
          case "wait":
            t.status = "waiting";
            t.reason = String(args.reason ?? "").trim() || undefined;
            break;
          case "reopen":
            t.status = "todo";
            t.runs = 0;
            delete t.reason;
            if (args.text) t.text = String(args.text).trim();
            break;
          case "drop":
            t.status = "dropped";
            t.reason = String(args.reason ?? "").trim() || undefined;
            break;
          default:
            return "unknown";
        }
        t.updated = now();
        const o = p.objectives.find((x) => x.id === t.objective);
        if (o) delete o.idleUntil;
        return t;
      });
      if (found === "unknown") return answer("Unknown action: use add, list, done, wait, reopen or drop.", true);
      if (!found) return answer(`No todo ${args.id}.`, true);
      log("plan.change", { tool: "todo", action: args.action, objective: found.objective, todo: found.id, status: found.status, reason: found.reason });
      return answer(todoLine(found));
    },
  });

  reg({
    name: "schedule",
    label: "schedule",
    description:
      "Manage scheduled tasks. When a task is due, a work run receives its prompt as a `[dot:tâche]` message. " +
      "action: `add` (prompt and exactly one of every_minutes, at, once), `list`, `remove`, `pause`, `resume` (id). " +
      "Tasks survive restarts; a task due while the environment was off runs at the next start unless catch_up is false.",
    promptSnippet: "schedule: run a prompt later, at a fixed time, or on a recurring basis",
    parameters: Type.Object({
      action: Type.String({ description: "add | list | remove | pause | resume" }),
      id: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String({ description: "What to do when the task is due, written for yourself" })),
      every_minutes: Type.Optional(Type.Number({ description: "Repeat every N minutes" })),
      at: Type.Optional(Type.String({ description: "Local time HH:MM, every day (or on `days`)" })),
      days: Type.Optional(Type.Array(Type.Number(), { description: "With `at`: days of the week, 0 = Sunday … 6 = Saturday" })),
      once: Type.Optional(Type.String({ description: "Run once at this local date-time, ISO (2026-10-23T09:00)" })),
      catch_up: Type.Optional(Type.Boolean({ description: "Run at next start if missed while off (default true)" })),
    }),
    async execute(_id: string, args: any) {
      const schedules = loadSchedules();
      const find = () => schedules.find((s) => s.id === args.id);
      switch (args.action) {
        case "list":
          return answer(schedules.length ? schedules.map(describeSchedule).join("\n") : "No scheduled task.");
        case "add": {
          const prompt = String(args.prompt ?? "").trim();
          const kinds = [args.every_minutes, args.at, args.once].filter((v) => v !== undefined && v !== "");
          if (!prompt || kinds.length !== 1) return answer("`add` needs a prompt and exactly one of every_minutes, at, once.", true);
          if (args.at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(args.at)) return answer("`at` must be HH:MM.", true);
          if (args.every_minutes !== undefined && !(args.every_minutes >= 1)) return answer("`every_minutes` must be at least 1.", true);
          if (args.once && Number.isNaN(new Date(args.once).getTime())) return answer("`once` is not a valid date.", true);
          const s: Schedule = { id: newId(), prompt, nextRun: "" };
          if (args.every_minutes !== undefined) s.every = Number(args.every_minutes);
          if (args.at) s.at = args.at;
          if (Array.isArray(args.days) && args.days.length) s.days = args.days.map(Number).filter((d: number) => d >= 0 && d <= 6);
          if (args.once) s.once = new Date(args.once).toISOString();
          if (args.catch_up === false) s.catchUp = false;
          const next = nextAfter(s, new Date());
          if (!next) return answer("This task would never run.", true);
          s.nextRun = next.toISOString();
          schedules.push(s);
          writeJson(SCHEDULES_FILE, schedules);
          return answer(`Scheduled: ${describeSchedule(s)}`);
        }
        case "remove": {
          const s = find();
          if (!s) return answer(`No task ${args.id}.`, true);
          schedules.splice(schedules.indexOf(s), 1);
          writeJson(SCHEDULES_FILE, schedules);
          return answer(`Removed ${s.id}.`);
        }
        case "pause":
        case "resume": {
          const s = find();
          if (!s) return answer(`No task ${args.id}.`, true);
          s.paused = args.action === "pause";
          if (!s.paused) {
            const next = nextAfter(s, new Date());
            if (next) s.nextRun = next.toISOString();
          }
          writeJson(SCHEDULES_FILE, schedules);
          return answer(describeSchedule(s));
        }
        default:
          return answer("Unknown action: use add, list, remove, pause or resume.", true);
      }
    },
  });

  reg({
    name: "watch",
    label: "watch",
    description:
      "Watch something by running a shell command regularly inside your environment (no model involved). When its output changes, a work run receives a `[dot:veille]` message with the old and new output. " +
      "The first run only records a baseline. action: `add` (command, every_minutes, prompt), `list`, `remove` / `pause` / `resume` (id). " +
      "Make the command print only what matters (a title, a count, a version), so harmless noise does not trigger a run.",
    promptSnippet: "watch: trigger a run when the output of a command changes",
    parameters: Type.Object({
      action: Type.String({ description: "add | list | remove | pause | resume" }),
      id: Type.Optional(Type.String()),
      command: Type.Optional(Type.String({ description: "Shell command (bash) whose output is watched" })),
      every_minutes: Type.Optional(Type.Number({ description: "How often to run it, in minutes (at least 1)" })),
      prompt: Type.Optional(Type.String({ description: "What this watch is for and what to do when it changes, written for yourself" })),
    }),
    async execute(_id: string, args: any) {
      const watches = loadWatches();
      const find = () => watches.find((w) => w.id === args.id);
      const show = (w: Watch) => `${w.id} · every ${w.every} min${w.paused ? " · paused" : ""} · ${w.command} · ${w.prompt}`;
      switch (args.action) {
        case "list":
          return answer(watches.length ? watches.map(show).join("\n") : "No watch.");
        case "add": {
          const command = String(args.command ?? "").trim();
          const prompt = String(args.prompt ?? "").trim();
          const every = Number(args.every_minutes);
          if (!command || !prompt || !(every >= 1)) return answer("`add` needs command, prompt and every_minutes (≥ 1).", true);
          const w: Watch = { id: newId(), command, every, prompt, nextCheck: now() };
          watches.push(w);
          writeJson(WATCHES_FILE, watches);
          return answer(`Watching: ${show(w)}`);
        }
        case "remove": {
          const w = find();
          if (!w) return answer(`No watch ${args.id}.`, true);
          watches.splice(watches.indexOf(w), 1);
          writeJson(WATCHES_FILE, watches);
          return answer(`Removed ${w.id}.`);
        }
        case "pause":
        case "resume": {
          const w = find();
          if (!w) return answer(`No watch ${args.id}.`, true);
          w.paused = args.action === "pause";
          writeJson(WATCHES_FILE, watches);
          return answer(show(w));
        }
        default:
          return answer("Unknown action: use add, list, remove, pause or resume.", true);
      }
    },
  });
}
