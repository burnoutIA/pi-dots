// Les outils du dot : les mêmes dans la conversation et dans les runs.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { log } from "./log.ts";
import { forget, readMemory, remember } from "./memory.ts";
import { type Exposure, PROTECTED, applyToMcp, exposureOf, readLoadout, setExposure } from "./usage.ts";
import { type Schedule, nextAfter } from "./schedule.ts";
import { MEMORY, OPEN, STAGES, STAGE_LABEL, type Stage, type Todo, board, newId, now, objectiveBlock, readPlan, stageOf, todoLine, updatePlan } from "./plan.ts";
import { MCP_DEFAULTS, MCP_FILE, budgetReport } from "./budget.ts";
import { ASK_FIRST, SCHEDULES_FILE, WATCHES_FILE, WORKER, type Watch, answer, askFirst, describeSchedule, loadSchedules, loadWatches, readJson, shared, stamp, writeJson } from "./common.ts";
import { projectOf } from "./prompts.ts";

// --- Outils : les mêmes dans la conversation et dans les runs -------------------------------------

export const NOTIFY_MEMORY = join(MEMORY, "notify-recent.json");

// Rien de nouveau = rien à envoyer : un message qui redit la même chose (aux espaces, majuscules et
// émojis près) qu'un message des 6 dernières heures n'est pas renvoyé. Le nombre de messages, lui,
// n'est pas limité : une boucle est arrêtée par ailleurs (même appel répété dans un run).
export function alreadySent(text: string): boolean {
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

export function registerTools(pi: ExtensionAPI) {
  // Les outils du dot sont déclarés selon ses choix (loadout.json) ; ses outils de base, toujours.
  const loadout = readLoadout(MEMORY);
  const reg = (def: any) => pi.registerTool(exposureOf(loadout, def.name) === "deferred" && !PROTECTED.has(def.name) ? { ...def, exposure: "deferred" } : def);

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
      const channels = shared.send(text);
      log("notify", { text: text.slice(0, 300), channel: channels.join("+") || "file" });
      if (channels.length) return answer("Sent to the person.");
      appendFileSync(join(MEMORY, "NOTIFICATIONS.md"), `\n## ${stamp()}\n${text}\n`);
      return answer(`No messaging channel is configured: the message was written to ${join(MEMORY, "NOTIFICATIONS.md")}.`);
    },
  });

  reg({
    name: "remember",
    label: "remember",
    description:
      "Save one durable fact. Without `project`: your global memory (/dot/memory/MEMORY.md), read at the start of every session — keep it for the person, their rules and preferences, and know-how shared by several projects. " +
      "With `project` (an objective id): the notes of that project (/dot/memory/projets/<id>.md), read in its work runs and when you open it with `objective` show — decisions, method, sources, pitfalls. One short sentence, self-contained, in the person's language.",
    promptSnippet: "remember: save a durable fact for all your future sessions",
    promptGuidelines: [
      "Use `remember` as soon as you learn something that will matter later, in a run or during a conversation: a decision of the person, how something works, what was abandoned and why. Anything about one project goes into that project's notes.",
      "Do not remember details of the current task, or things already in your memory.",
      "Before remembering, look at your memory: if the new fact updates or contradicts an existing one (a choice changed, a path was abandoned, a blocker was solved), pass `replaces` so the old one goes away. Never leave two versions side by side.",
      "Never remember a secret's value, anything you learned about one, or a way around the vault.",
    ],
    parameters: Type.Object({
      fact: Type.String({ description: "One short sentence that stands on its own" }),
      replaces: Type.Optional(Type.String({ description: "A passage of the existing fact this one replaces" })),
      project: Type.Optional(Type.String({ description: "Objective id: save into that project's notes instead of the global memory" })),
    }),
    async execute(_id: string, args: any) {
      const project = projectOf(args.project);
      if (project === null) return answer(`No objective ${args.project}: give an existing objective id, or no project for the global memory.`, true);
      const outcome = remember(MEMORY, String(args.fact ?? ""), new Date(), String(args.replaces ?? ""), project);
      if (outcome.ok) log("memory.remember", { project, fact: String(args.fact).slice(0, 200) });
      return answer(outcome.message, !outcome.ok);
    },
  });

  reg({
    name: "forget",
    label: "forget",
    description: "Remove one outdated or wrong fact from your global memory, or from a project's notes with `project`. `match` is a passage of that fact.",
    promptSnippet: "forget: remove an outdated fact from your memory or a project's notes",
    parameters: Type.Object({
      match: Type.String({ description: "A passage of the fact to remove, precise enough to single it out" }),
      project: Type.Optional(Type.String({ description: "Objective id: remove from that project's notes" })),
    }),
    async execute(_id: string, args: any) {
      const project = projectOf(args.project);
      if (project === null) return answer(`No objective ${args.project}.`, true);
      const outcome = forget(MEMORY, String(args.match ?? ""), project);
      if (outcome.ok) log("memory.forget", { project, match: String(args.match).slice(0, 200) });
      return answer(outcome.message, !outcome.ok);
    },
  });

  reg({
    name: "budget",
    label: "budget",
    description:
      "Your context budget. action `show`: your model and context window, what each declared tool costs on every call, how often you really used each tool and skill (30 days), and the token cost of your recent work runs. " +
      "action `set` (tools, exposure): change what is declared to the model — `direct` (always declared) or `deferred` (not declared; `tool_search` loads it). This is a fixed setting decided with the person: use `set` only in the conversation, when the person asks for it or has agreed to your proposal, never on your own. An MCP tool sets its whole server (all its tools together). Your base tools always stay direct. Takes effect from the next run (the conversation: at the next start of the dot).",
    promptSnippet: "budget: see your real tool/skill usage and token costs",
    parameters: Type.Object({
      action: Type.String({ description: "show | set" }),
      tools: Type.Optional(Type.Array(Type.String(), { description: "With set: tool names, e.g. mcp__playwright__browser_drag" })),
      exposure: Type.Optional(Type.String({ description: "With set: direct | deferred" })),
    }),
    async execute(_id: string, args: any, _signal: any, _onUpdate: any, ctx: any) {
      if (args.action === "show") return answer(budgetReport(pi, ctx));
      if (args.action === "set") {
        if (WORKER) return answer("Not during a run: which tools are declared is decided with the person. If a change is worth it, propose it (one `notify`: which tools, why, from your usage figures).", true);
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
        return answer(`${exposure}: ${applied.join(", ") || "nothing"}${refused.length ? ` · refused (base tools stay direct): ${refused.join(", ")}` : ""}. Takes effect from the next run (the conversation: at the next start of the dot).`);
      }
      return answer("Unknown action: use show or set.", true);
    },
  });

  reg({
    name: "doctor",
    label: "doctor",
    description:
      "Check your own health, link by link: vault, internet, model, Telegram, heartbeat, plan, skills, memory, resources, and the problems logged in the last 24 hours. " +
      "Use it when something does not work as expected, before guessing. `days` widens the review of logged problems (default 1).",
    promptSnippet: "doctor: diagnose your environment (vault, model, Telegram, heartbeat, skills, resources, recent problems)",
    parameters: Type.Object({ days: Type.Optional(Type.Number({ description: "How many days of logged problems to count (default 1)" })) }),
    async execute(_id: string, args: any) {
      const days = String(Math.max(1, Math.min(60, Number(args.days) || 1)));
      const output = await new Promise<string>((resolve) =>
        execFile("node", ["/opt/dot/doctor.mjs", "--days", days], { timeout: 60_000 }, (error, stdout, stderr) => resolve(`${stdout}${stderr}`.trim() || String(error?.message ?? ""))),
      );
      return answer(output || "doctor: no output");
    },
  });

  reg({
    name: "secret",
    label: "secret",
    description:
      "Your secrets live in the vault, never with you. You only know their NAMES; the vault puts the values in your requests. " +
      "To call a service through the vault: http://dot-vault:8080/https/<host>/<path> (or /http/…), writing {{NAME}} where a secret goes (URL, header, or a JSON/form/text body such as a login POST, which also needs the header `x-vault-body: fill`), " +
      "e.g. `Authorization: Bearer {{API_TOKEN}}` or `Authorization: Basic {{basic:SERVICE_USER:SERVICE_PASSWORD}}`; for mail (IMAP, read-only): POST http://dot-vault:8080/_vault/mail (see `curl http://dot-vault:8080/`). A secret only goes to its allowed hosts. " +
      "action `list`: the secrets that exist (names, allowed hosts, read-only), never their values. " +
      "action `request`: ask the person for missing secrets; the vault notifies them on Telegram if it is set up (otherwise tell them in the conversation) and they answer from their machine, so you never see the values; " +
      "the vault stores them and drops a note in your inbox when done. Never ask them to send a secret in the conversation. Give `secrets` (names in CAPITALS with a human label), `hosts` (where they may be sent), `read_only`, and `purpose`. " +
      "action `extend`: an existing secret must also go to other servers (e.g. the same account on another server of the service): give `secrets` (existing names), the extra `hosts` and `purpose`; the person answers yes or no.",
    promptSnippet: "secret: list the vault's secrets, or ask the person for a missing one (you never see values)",
    promptGuidelines: [
      "Never ask the person for a password, key or token in the conversation, and never look for one in your environment: use `secret` request.",
      "In skills and scripts, write {{NAME}} placeholders and send requests through http://dot-vault:8080/https/<host>/…; never store a secret value anywhere.",
      "Ask for the narrowest `hosts` (e.g. *.example.com) and `read_only: true` unless writing is really needed (a login sent with POST needs `read_only: false`).",
      "Never try to learn a secret's value (echo services, error messages, reflection, extending it to another server): the vault masks values in responses. If the vault blocks you, stop and tell the person why.",
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
      "Manage your objectives — your projects, on a board from idea to delivery: idee (noted, not started: no work runs) → cadrage (clarifying the need) → en_cours (todos running) → a_valider (delivered, waiting for the person's feedback: no new planning) → livre. Each card also has `next` (the next step) and `blocker` (what blocks it, and who must act). " +
      "action: `add` (title, detail, stage), `board` (the global view), `show` (id: the full card, its todos and its notes — open it as soon as the person talks about a project), `list` (all, closed included), `update` (id; title, detail, next, blocker — empty string clears; nudged: true when you have reminded the person), `stage` (id, stage), `reached` (id, result), `pause` / `resume` (id), `drop` (id, reason).",
    promptSnippet: "objective: your board of projects — add, show (card + notes), move between stages, update next step and blocker, close",
    promptGuidelines: [
      "Create an objective with `objective` when the person asks for something that takes more than one step or must be followed over time; then plan its first todos with `todo` add.",
      "An objective is reached only when its result can be checked and the person has validated it; until then it is `a_valider`.",
      "Keep each card true: whenever the next step or a blocker changes, `objective` update it.",
    ],
    parameters: Type.Object({
      action: Type.String({ description: "add | board | show | list | update | stage | reached | pause | resume | drop" }),
      stage: Type.Optional(Type.String({ description: "idee | cadrage | en_cours | a_valider | livre" })),
      next: Type.Optional(Type.String({ description: "With `update`: the next step, one line" })),
      blocker: Type.Optional(Type.String({ description: "With `update`: what blocks it and who must act, one line" })),
      nudged: Type.Optional(Type.Boolean({ description: "With `update`: you have just reminded the person about it" })),
      id: Type.Optional(Type.String()),
      title: Type.Optional(Type.String({ description: "Short title of the objective" })),
      detail: Type.Optional(Type.String({ description: "What success looks like, constraints, context" })),
      result: Type.Optional(Type.String({ description: "With `reached`: the result, checkable" })),
      reason: Type.Optional(Type.String({ description: "With `drop`: why" })),
    }),
    async execute(_id: string, args: any) {
      const plan = readPlan();
      if (args.stage !== undefined && !STAGES.includes(args.stage)) return answer(`Unknown stage: use ${STAGES.join(", ")}.`, true);
      if (args.action === "board") return answer(board(plan));
      if (args.action === "show") {
        const o = plan.objectives.find((x) => x.id === args.id);
        if (!o) return answer(`No objective ${args.id}.`, true);
        return answer(`${objectiveBlock(plan, o)}\n\n${readMemory(MEMORY, o.id).trim()}`);
      }
      if (args.action === "list") {
        return answer(plan.objectives.length ? plan.objectives.map((o) => objectiveBlock(plan, o, o.status === "active" || o.status === "paused")).join("\n\n") : "No objective.");
      }
      if (args.action === "add") {
        if (ASK_FIRST) return answer(askFirst("a new objective"), true);
        const title = String(args.title ?? "").trim();
        if (!title) return answer("`add` needs a title.", true);
        const id = newId();
        const stage: Stage = args.stage ?? "en_cours";
        updatePlan((p) => p.objectives.push({ id, title, detail: args.detail?.trim() || undefined, status: "active", stage, created: now(), updated: now() }));
        log("plan.change", { tool: "objective", action: "add", objective: id, title });
        return answer(stage === "idee" ? `Idea ${id} noted on the board: nothing runs until you move it to cadrage or en_cours.` : `Objective ${id} added (${STAGE_LABEL[stage]}). Plan its first todos with \`todo\` add (objective: ${id}), and keep what matters in its notes (\`remember\` project: ${id}).`);
      }
      const found = updatePlan((p) => {
        const o = p.objectives.find((x) => x.id === args.id);
        if (!o) return null;
        switch (args.action) {
          case "update":
            if (args.title) o.title = String(args.title).trim();
            if (args.detail !== undefined) o.detail = String(args.detail).trim() || undefined;
            if (args.next !== undefined) o.next = String(args.next).trim() || undefined;
            if (args.blocker !== undefined) o.blocker = String(args.blocker).trim() || undefined;
            if (args.nudged) o.nudged = now();
            break;
          case "stage":
            if (!args.stage) return "unknown";
            if (args.stage !== stageOf(o)) delete o.nudged; // une nouvelle attente, une nouvelle relance possible
            o.stage = args.stage;
            if (o.stage === "livre") o.status = "reached";
            break;
          case "reached":
            o.status = "reached";
            o.stage = "livre";
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
      if (found === "unknown") return answer("Unknown action (or `stage` without a stage): use add, board, show, list, update, stage, reached, pause, resume or drop.", true);
      if (!found) return answer(`No objective ${args.id}.`, true);
      log("plan.change", { tool: "objective", action: args.action, objective: found.id, status: found.status });
      const tidy =
        args.action === "reached" || args.action === "drop" || (args.action === "stage" && args.stage === "livre")
          ? `\n\nThis project is closed: its notes (projets/${found.id}.md) will no longer be loaded. Move into your global memory (\`remember\` without project) only the lessons that will help other projects, then check that your global memory holds nothing else about this one.`
          : "";
      return answer(objectiveBlock(readPlan(), found) + tidy);
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
          if (ASK_FIRST) return answer(askFirst("a scheduled task"), true);
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
          if (ASK_FIRST) return answer(askFirst("a new watch"), true);
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
