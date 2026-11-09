// dot — extension pi : ce qui rend l'agent autonome et proactif.
//
// Le dot tourne dans deux rôles :
//
//   - la conversation (le pi de tmux, DOT_ROLE=conversation) : il parle avec la personne et fait battre le
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
//
// Ce fichier : le battement (événements, plan, runs) et le branchement sur pi. Le reste, par responsabilité :
//   common.ts    chemins, réglages, état (state.json), petits outils, objet partagé entre extensions
//   prompts.ts   les prompts des runs, et la mémoire / le tableau rappelés dans le prompt système
//   runs.ts      un run de travail (pi lancé à part), ses garde-fous et son point d'étape
//   tools.ts     les outils du dot (notify, objective, todo, schedule, watch, remember, budget…)
//   budget.ts    le budget de contexte : coût des outils déclarés, usage réel
//   channels.ts  les commandes proposées à la personne sur ses canaux
//   injection.ts les résultats d'outils venus du dehors, analysés avant le modèle
//   plan.ts, memory.ts, usage.ts, schedule.ts, outage.ts, live.ts, log.ts : la logique pure, testée seule

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { log, pruneLogs } from "./log.ts";
import { PROJECTS_DIR, skillProblems } from "./memory.ts";
import { record, usageFile } from "./usage.ts";
import { retryMinutes } from "./outage.ts";
import { nextAfter } from "./schedule.ts";
import { MEMORY, UNTIL_CHANGE, type Plan, newId, nextWork, now, readPlan, updatePlan } from "./plan.ts";
import { budgetSection, seedUsage } from "./budget.ts";
import { channelCommands, resourcesFingerprint } from "./channels.ts";
import { AUTONOMY, HOME, INBOX, INBOX_DONE, type Kind, LATE_SKIP_MS, MAX_RUNS, RECHECK_MINUTES, REVIEW_DAYS, SCHEDULES_FILE, TICK_MS, WATCHES_FILE, WORKER, changeState, cut, later, loadSchedules, loadState, loadWatches, local, shared, shell, stamp, writeJson } from "./common.ts";
import { eventPrompt, mcpDirectSection, memorySection, planPrompt, todoPrompt } from "./prompts.ts";
import { checkpoints, runWorker } from "./runs.ts";
import { registerTools } from "./tools.ts";
import { injections } from "./injection.ts";

// pi --continue reprend la conversation avec le modèle qu'elle avait, pas le défaut des réglages :
// un DOT_MODEL changé dans le .dot est donc imposé une fois (un /model ultérieur reste respecté).
// (Les runs autonomes, eux, reçoivent DOT_MODEL en option : voir runWorker.)
function applyDotModel(pi: ExtensionAPI, context: any) {
  const id = process.env.DOT_MODEL;
  if (!id || loadState().appliedModel === id) return;
  const provider = process.env.DOT_PROVIDER ?? context.model?.provider;
  const model = provider ? context.modelRegistry?.find(provider, id) : undefined;
  if (!model) return log("model.apply", { model: id, error: "modèle inconnu" });
  const done = () => changeState((s) => (s.appliedModel = id));
  if (context.model?.id === id && context.model?.provider === model.provider) return done();
  pi.setModel(model).then((ok: boolean) => {
    log("model.apply", { model: id, from: context.model?.id, ok });
    if (ok) done();
  });
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
    atStart = memorySection(WORKER ? process.env.DOT_OBJECTIVE ?? "" : "");
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
        : "This is your conversation with the person. You start with the global view (your board of projects); each project's notes are loaded only when needed: as soon as the person talks about a project, open its notes with `objective` show before answering. Your work on objectives runs separately (one session per objective); its reports reach this conversation as `[dot:compte-rendu]` messages. To start some work, create an objective or todos: the work runs will take them up.",
      dot_memory: `Your persistent state, as it was when this session started (read /dot/memory again for the current version):\n\n${atStart}`,
      dot_budget: (budgetNote ||= budgetSection(pi, lastCtx)),
      ...(brokenSkills.length
        ? {
            dot_skills: `These skills of yours are NOT loaded, because their SKILL.md does not start with the required header: ${brokenSkills.join(", ")}. Fix each one now: the file must start with\n---\nname: <folder name>\ndescription: <what it does and when to use it, one sentence>\n---`,
          }
        : {}),
    };
    // Lue quand pi assemble le prompt, après tous les gestionnaires : celui de pi qui attend la
    // connexion des serveurs MCP passe après celui-ci, leurs outils ne sont pas encore là.
    Object.defineProperty(event.systemPromptOptions.sections, "dot_mcp_direct", { enumerable: true, configurable: true, get: () => mcpDirectSection(pi) });
  });

  registerTools(pi);
  injections(pi); // conversation et runs : tout résultat venu du dehors est analysé
  if (WORKER) {
    checkpoints(pi);
    return;
  }

  // ===== Conversation : le battement ==========================================================

  let ctx: any = null;
  let timer: ReturnType<typeof setInterval> | null = null;
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

  // Skills et extensions du dot : s'ils ont changé (création, modification, suppression), on recharge
  // pi dès qu'il est inactif, pour que les nouvelles commandes soient disponibles tout de suite.
  let resourcesPrint = resourcesFingerprint();
  let lastResourcesCheck = 0;
  function watchResources() {
    if (Date.now() - lastResourcesCheck < 30_000) return;
    lastResourcesCheck = Date.now();
    const now = resourcesFingerprint();
    if (now === resourcesPrint || shared.running || ctx?.isIdle?.() !== true) return;
    resourcesPrint = now;
    log("resources.changed");
    try {
      // expandPromptTemplates : pour que pi l'exécute comme une commande, sans passer par le modèle.
      pi.sendUserMessage("/dot-reload", { expandPromptTemplates: true });
    } catch {}
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
        `Ton bilan des ${REVIEW_DAYS} derniers jours, pour t'améliorer. Dans l'ordre :`,
        "1. Avant/après : relis ta mémoire. Pour chaque changement noté à ta revue précédente, regarde s'il a tenu ses promesses (moins de jetons, moins d'échecs, un retour positif). Sinon, reviens dessus.",
        `2. Échecs : lance \`doctor\` avec days=${REVIEW_DAYS}, puis regarde dans /dot/logs ce qui s'est mal passé (boucles, todos bloqués, runs en échec, refus du coffre). Corrige la cause : le skill, le script ou la méthode en question.`,
        "3. Retours de la personne : relis ce qu'elle t'a dit de ton travail (ta mémoire, ta conversation). Tiens-en compte.",
        "4. Ta mémoire et tes consignes : pars des lignes « mémoire » et « notes » de `doctor` (faits anciens, liés à un objectif clos, doublons, valeur sensible), puis reprends MEMORY.md fait par fait. Chacun est-il encore vrai ? Compare avec ton plan, tes livrables et ce que la personne a dit depuis. Retire (`forget`) ou remplace (`remember` avec `replaces`) ce qui est périmé, contredit, en double, ou qui contient la valeur d'un secret. Fais de même pour les fichiers de consignes que tu lis (AGENTS.md, tes skills) : une consigne qui renvoie à un fichier absent ou décrit une méthode abandonnée, corrige-la. Pour un fait dont tu n'es pas sûr qu'il tienne encore, ne le supprime pas au hasard : pose la question à la personne (un seul `notify` qui regroupe tes doutes).",
        "5. Ton tableau : chaque projet est-il à la bonne étape, avec sa suite et ce qui bloque ? Un projet « À valider » qui attend la personne depuis plus de 3 jours : relance-la une seule fois (`notify` qui regroupe ces projets, puis `objective` update nudged), puis laisse-le en attente sans insister. Une idée oubliée depuis longtemps : demande-lui si elle tient toujours.",
        "6. Budget : lance `budget` show. Les outils déclarés sont un réglage fixe : tu ne le changes pas toi-même. Si un serveur lourd ne sert jamais, ou si tu as dû recharger souvent un outil différé, propose le changement à la personne (dans le même `notify` que tes autres questions, chiffres d'usage à l'appui). Allège les skills trop longs, supprime ceux qui ne servent plus.",
        "7. Note avec `remember` chaque changement, avec la mesure de départ (ex. « 24/10 : skill X allégé, 60k jetons par run avant »), pour pouvoir comparer à la prochaine revue.",
        "Ne préviens la personne que si tu as changé quelque chose qui la concerne, ou si tu as besoin de son avis.",
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
      // Le titre dit de quoi il s'agit : la 2e ligne de l'événement (la 1re est son en-tête daté).
      const what = event.text.split("\n")[1]?.replace(/\s+/g, " ").trim().slice(0, 70);
      const label = `${event.kind}${what ? ` · ${what}` : ""}`;
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

    // Nouveau plan : s'il ne change rien, l'objectif attend un changement (prudent) ou RECHECK_MINUTES (libre).
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
      o.idleUntil = AUTONOMY === "libre" ? later(RECHECK_MINUTES) : UNTIL_CHANGE;
      return true;
    });
    if (unchanged) log("plan.unchanged", { objective: objective.id, recheckInMin: AUTONOMY === "libre" ? RECHECK_MINUTES : null });
    report(label, result.text);
  }

  // Une fois : un dot d'avant les notes par projet répartit sa mémoire globale.
  function dueProjectsMigration() {
    const state = loadState();
    if (state.projectsMigrated) return;
    changeState((s) => (s.projectsMigrated = true));
    const plan = readPlan();
    if (existsSync(join(MEMORY, PROJECTS_DIR)) || !plan.objectives.length) return;
    enqueue(
      "revue",
      [
        `[dot:revue] ${stamp()}`,
        "Ta mémoire change d'organisation : une mémoire globale courte, et des notes par projet (un projet = un objectif), chargées seulement quand tu travailles dessus ou que la personne en parle.",
        "1. Lis /dot/memory/MEMORY.md et ton tableau (`objective` list).",
        "2. Chaque fait propre à un seul projet : recopie-le dans les notes de ce projet (`remember` avec project), en plus court si possible, puis retire-le de la mémoire globale (`forget`). Ne garde au global que la personne, ses règles et préférences, et les savoir-faire qui servent à plusieurs projets.",
        "3. Range chaque projet ouvert à sa vraie étape (`objective` stage : idee, cadrage, en_cours, a_valider, livre) et renseigne sa suite et ce qui le bloque (`objective` update next, blocker). Corrige un titre qui ne correspond plus au projet.",
        "4. Ne préviens la personne que si tu as un doute sur un projet : regroupe tes questions en un seul `notify`.",
      ].join("\n"),
    );
  }

  function tick() {
    const at = new Date();
    changeState((s) => (s.lastAlive = at.toISOString()));
    dueSchedules(at);
    dueWatches(at);
    inbox();
    dueReview(at);
    dueProjectsMigration();
    watchResources();

    const state = loadState();
    if (shared.running || state.paused) return;
    if (state.backoffUntil && new Date(state.backoffUntil) > at) return;
    if (ctx?.isIdle?.() !== true) return; // la personne d'abord
    shared.running = true;
    work()
      .catch((error) => {
        log("heartbeat.error", { error: String(error?.stack ?? error).slice(0, 1000) });
        report("erreur du battement", String(error?.message ?? error));
      })
      .finally(() => (shared.running = false));
  }

  pi.on("session_start", (_event, context: any) => {
    ctx = context;
    mkdirSync(INBOX, { recursive: true });
    pruneLogs();
    // Un run coupé par un arrêt : son todo est resté « en cours » et sera repris au premier battement.
    // Après un simple rechargement des extensions, le run tourne toujours : rien n'est coupé.
    const state = loadState();
    const doing = readPlan().todos.filter((t) => t.status === "doing").map((t) => t.id);
    if (shared.running) log("conversation.start", { runStillGoing: state.running?.label });
    else {
      log("conversation.start", { interrupted: state.running?.label, todosInProgress: doing.length ? doing : undefined, paused: state.paused || undefined });
      changeState((s) => delete s.running);
    }
    applyDotModel(pi, context);
    // La session de la conversation, dite explicitement : au redémarrage, le hub la reprend telle
    // quelle au lieu de deviner d'après les dates des fichiers.
    const sessionFile = context.sessionManager?.getSessionFile?.();
    if (sessionFile && loadState().conversationSession !== sessionFile) changeState((s) => (s.conversationSession = sessionFile));
    // Un seul battement par processus, même après un rechargement des extensions.
    if (shared.tickTimer) clearInterval(shared.tickTimer);
    timer = shared.tickTimer = setInterval(tick, TICK_MS);
    shared.lastCtx = context;
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

  // Rechargement à chaud : quand le dot a créé ou modifié un skill ou une extension, pi les recharge
  // (dès qu'il est inactif). Les nouvelles commandes apparaissent alors sur les canaux.
  pi.registerCommand("dot-reload", {
    description: "Recharger skills et extensions (automatique quand ils changent)",
    handler: async (_args, context: any) => {
      await context.waitForIdle();
      await context.reload();
      log("resources.reload");
    },
  });
  shared.channelCommands = () => channelCommands(pi);
}
