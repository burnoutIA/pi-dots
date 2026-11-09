// Les commandes proposées à la personne sur ses canaux (Telegram, chat local).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render as renderLive } from "./live.ts";
import { objectiveBlock, readPlan } from "./plan.ts";
import { budgetReport } from "./budget.ts";
import { type ChannelCommand, HOME, LIVE_FILE, logEvents, shared, since } from "./common.ts";

// --- Commandes pour les canaux -------------------------------------------------------------------

export const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent");
export const MANAGED_EXTENSIONS = new Set(["dot", "dot-telegram", "dot-local", "ctx-optimizer"]);
// Commandes internes, jamais proposées à la personne.
export const INTERNAL_COMMANDS = new Set(["telegram-new", "local-new", "dot-status", "dot-pause", "dot-resume", "dot-reload", "goal", "ctx", "llama", "mcp"]);
export const LIVRABLES = join(HOME, "livrables");

// Empreinte des skills et des extensions du dot (fichiers et dates de modification).
export function resourcesFingerprint(): string {
  const parts: string[] = [];
  const walk = (dir: string, depth = 0) => {
    if (!existsSync(dir) || depth > 3) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path, depth + 1);
      else parts.push(`${path}:${info.mtimeMs}`);
    }
  };
  walk(join(AGENT_DIR, "skills"));
  if (existsSync(join(AGENT_DIR, "extensions"))) {
    for (const name of readdirSync(join(AGENT_DIR, "extensions"))) if (!MANAGED_EXTENSIONS.has(name)) walk(join(AGENT_DIR, "extensions", name));
  }
  return parts.sort().join("|");
}

export const channelName = (name: string) => name.replace(/^skill:/, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function journalToday(): string {
  const today = new Date().toDateString();
  const events = logEvents(2).filter((e) => new Date(e.t).toDateString() === today);
  const runs = events.filter((e) => e.type === "run.end");
  const failed = runs.filter((e) => !e.ok && !e.modelUnavailable);
  const lines = runs.slice(-8).map((e) => `${hhmm(e.t)} ${e.ok ? "✅" : "⚠️"} ${String(e.label ?? e.kind).slice(0, 70)} (${Math.round((e.durationS ?? 0) / 60)} min)`);
  return [
    `Aujourd'hui : ${runs.length} run(s), ${failed.length} en échec, ${events.filter((e) => e.type === "notify").length} message(s) envoyé(s).`,
    ...(lines.length ? ["", "Derniers runs :", ...lines] : []),
  ].join("\n");
}

export const PROBLEM_TYPES: Record<string, string> = {
  "loop.suspect": "boucle arrêtée",
  "run.capped": "run arrêté (plafond de jetons)",
  "todo.stuck": "todo bloqué",
  "model.down": "modèle injoignable",
  "pi.exit": "arrêt de pi",
  "net.denied": "refus du coffre",
  "heartbeat.error": "erreur du battement",
  "notify.blocked": "message bloqué",
  "telegram.conflict": "conflit Telegram",
  "oauth.error": "jeton non renouvelé",
  "skills.broken": "skill non chargé",
  "injection.suspect": "contenu suspect",
  "injection.detector": "détecteur d'injection indisponible",
  "injection.held": "changement mis de côté",
  "injection.signal": "coffre non prévenu d'une exposition",
};
export function problems(): string {
  const since = Date.now() - 24 * 3600_000;
  const found = logEvents(2).filter((e) => new Date(e.t).getTime() >= since && (PROBLEM_TYPES[e.type] || (e.type === "run.end" && !e.ok && !e.modelUnavailable)));
  if (!found.length) return "Aucun problème ces dernières 24 heures.";
  return [
    `${found.length} problème(s) ces dernières 24 heures. Les derniers :`,
    ...found.slice(-10).map((e) => `${hhmm(e.t)} ${PROBLEM_TYPES[e.type] ?? "run en échec"} · ${String(e.label ?? e.excerpt ?? (e.type === "injection.held" ? `${e.tool} ${e.input ?? ""}` : undefined) ?? e.error ?? e.reason ?? e.host ?? e.call ?? "").slice(0, 90)}`),
  ].join("\n");
}

// Le run en cours (ou le dernier), tel que l'affichent /suivre et ./dot suivre.
export function liveSnapshot(): string {
  try {
    const live = JSON.parse(readFileSync(LIVE_FILE, "utf8"));
    if (live.status !== "running") return `Aucun run en cours. Le dernier :\n\n${renderLive(live)}`;
    return renderLive(live);
  } catch {
    return "Aucun run pour l'instant.";
  }
}

export function livrables(): string[] {
  if (!existsSync(LIVRABLES)) return [];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      statSync(path).isDirectory() ? walk(path) : files.push(path);
    }
  };
  walk(LIVRABLES);
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

export function channelCommands(pi: ExtensionAPI): ChannelCommand[] {
  const text = (t: string) => Promise.resolve({ text: t });
  const builtins: ChannelCommand[] = [
    { name: "aide", description: "Toutes les commandes", run: () => text(channelCommands(pi).map((c) => `/${c.name} — ${c.description}`).join("\n")) },
    { name: "status", description: "Ce que fait le dot : objectifs, tâches, veilles", run: () => text(shared.status()) },
    { name: "plan", description: "Objectifs et todos en cours", run: () => {
      const plan = readPlan();
      const open = plan.objectives.filter((o) => o.status === "active" || o.status === "paused");
      return text(open.length ? open.map((o) => objectiveBlock(plan, o, false)).join("\n\n") : "Aucun objectif en cours.");
    } },
    { name: "journal", description: "Ce qu'il a fait aujourd'hui", run: () => text(journalToday()) },
    { name: "problemes", description: "Les problèmes des dernières 24 heures", run: () => text(problems()) },
    { name: "doctor", description: "Diagnostic complet", run: () => new Promise((resolve) => execFile("node", ["/opt/dot/doctor.mjs"], { timeout: 60_000 }, (error, stdout, stderr) => resolve({ text: `${stdout}${stderr}`.trim() || String(error?.message ?? "") }))) },
    { name: "budget", description: "Son budget de contexte : outils, skills, coût des runs", run: () => {
      const full = budgetReport(pi, shared.lastCtx).split("\n");
      const tools = full.filter((l) => l.startsWith("- ") && / · (direct|deferred)/.test(l));
      const rest = full.filter((l) => !tools.includes(l));
      return text([...rest.slice(0, 3), ...tools.slice(0, 8), tools.length > 8 ? `… et ${tools.length - 8} autres outils` : "", ...rest.slice(3)].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n"));
    } },
    { name: "livrables", description: "Ses derniers livrables", run: () => {
      const files = livrables().slice(0, 10);
      return text(files.length ? ["Derniers livrables (/livrable nom pour le recevoir) :", ...files.map((f) => `${new Date(statSync(f).mtimeMs).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })} · ${relative(LIVRABLES, f)}`)].join("\n") : "Aucun livrable pour l'instant.");
    } },
    { name: "livrable", description: "Recevoir un livrable : /livrable nom", run: (args) => {
      const wanted = args.trim().toLowerCase();
      const file = wanted ? livrables().find((f) => relative(LIVRABLES, f).toLowerCase().includes(wanted)) : livrables()[0];
      return Promise.resolve(file ? { text: relative(LIVRABLES, file), files: [file] } : { text: "Livrable introuvable : /livrables pour la liste." });
    } },
    { name: "suivre", description: "Voir le run en cours, en direct", run: () => text(liveSnapshot()) },
    { name: "pause", description: "Mettre son autonomie en pause", run: () => (shared.setPaused(true), text("Autonomie en pause : je ne travaille plus de moi-même. Je réponds toujours à tes messages.")) },
    { name: "resume", description: "Reprendre son autonomie", run: () => (shared.setPaused(false), text("Autonomie reprise.")) },
  ];
  // Les commandes de pi du moment : celles des extensions et des skills que le dot s'est écrits.
  const taken = new Set(builtins.map((c) => c.name).concat(["new", "allumer", "eteindre", "start", "secret"]));
  const dynamic: ChannelCommand[] = [];
  for (const c of pi.getCommands()) {
    if (INTERNAL_COMMANDS.has(c.name)) continue;
    const name = channelName(c.name);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    dynamic.push({ name, description: (c.description ?? (c.source === "skill" ? "skill" : "commande")).slice(0, 200), pi: c.name });
  }
  return [...builtins, ...dynamic];
}
