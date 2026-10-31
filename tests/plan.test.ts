// Le plan, les échéances et la détection de panne : la logique qui décide sans le modèle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DOT_HOME = mkdtempSync(join(tmpdir(), "dot-plan-"));
const src = process.env.DOT_SRC ?? "/src";
const plan = await import(`${src}/extensions/dot/plan.ts`);
const { nextAfter } = await import(`${src}/extensions/dot/schedule.ts`);
const { modelUnavailable, retryMinutes } = await import(`${src}/extensions/dot/outage.ts`);

const objective = (id: string, extra = {}) => ({ id, title: id, status: "active", created: "", updated: "", ...extra });
const todo = (id: string, objectiveId: string, status: string, extra = {}) => ({ id, objective: objectiveId, text: id, status, runs: 0, created: "", updated: "", ...extra });

test("un todo en cours passe avant un todo prêt (reprise après arrêt)", () => {
  const w = plan.nextWork({ objectives: [objective("a"), objective("b")], todos: [todo("t1", "a", "todo"), todo("t2", "b", "doing")] });
  assert.equal(w.kind, "todo");
  assert.equal(w.todo.id, "t2");
  assert.equal(w.resume, true);
});

test("un todo « pas avant » une date future n'est pas pris", () => {
  const future = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(plan.nextWork({ objectives: [objective("a")], todos: [todo("t1", "a", "todo", { notBefore: future })] }), null);
});

test("un objectif sans todo ouvert demande un nouveau plan, sauf s'il est en attente de réexamen", () => {
  assert.equal(plan.nextWork({ objectives: [objective("a")], todos: [todo("t1", "a", "done")] }).kind, "plan");
  const later = new Date(Date.now() + 3600_000).toISOString();
  assert.equal(plan.nextWork({ objectives: [objective("a", { idleUntil: later })], todos: [] }), null);
});

test("tableau : une idée ne lance rien, un projet à valider fait ses todos sans replanifier", () => {
  assert.equal(plan.nextWork({ objectives: [objective("a", { stage: "idee" })], todos: [todo("t", "a", "todo")] }), null);
  assert.equal(plan.nextWork({ objectives: [objective("a", { stage: "a_valider" })], todos: [] }), null);
  assert.equal(plan.nextWork({ objectives: [objective("a", { stage: "a_valider" })], todos: [todo("t", "a", "todo")] }).todo.id, "t");
  assert.equal(plan.stageOf(objective("a")), "en_cours", "un objectif d'avant le tableau est en cours");
  assert.equal(plan.stageOf(objective("a", { status: "reached" })), "livre");
});

test("tableau : une carte par projet ouvert, avec la suite, le blocage et l'inactivité", () => {
  const at = new Date("2026-10-31T12:00:00Z");
  const p = {
    objectives: [
      objective("u", { title: "Outil URSSAF", stage: "a_valider", next: "corriger les 4 lignes", blocker: "avis de la personne", updated: "2026-10-26T10:00:00Z" }),
      objective("i", { title: "Veille jurisprudence", stage: "idee", updated: "2026-10-31T09:00:00Z" }),
      objective("x", { title: "Pappers", status: "dropped", updated: "2026-10-25T10:00:00Z" }),
    ],
    todos: [todo("t1", "u", "done", { updated: "2026-10-26T10:00:00Z" }), todo("t2", "u", "todo", { updated: "2026-10-26T10:00:00Z" })],
  };
  const b = plan.board(p, at);
  const lines = b.split("\n");
  assert.match(lines[0], /^- \[Idée\] Veille jurisprudence .*actif aujourd'hui/, "les cartes suivent l'ordre des étapes");
  assert.match(lines[1], /\[À valider\] Outil URSSAF \(u\) · todos 1\/2 · suite : corriger les 4 lignes · bloque : avis de la personne · inactif depuis 5 j/);
  assert.match(b, /1 abandonné/);
  assert.doesNotMatch(b, /Pappers/);
});

test("des todos qui attendent la personne ne déclenchent rien", () => {
  assert.equal(plan.nextWork({ objectives: [objective("a")], todos: [todo("t1", "a", "waiting")] }), null);
});

test("un objectif atteint, en pause ou abandonné ne déclenche rien", () => {
  for (const status of ["reached", "paused", "dropped"]) assert.equal(plan.nextWork({ objectives: [objective("a", { status })], todos: [todo("t", "a", "todo")] }), null);
});

test("updatePlan écrit plan.json et la vue PLAN.md", async () => {
  plan.updatePlan((p: any) => p.objectives.push(objective("x", { title: "Mon objectif" })));
  assert.equal(plan.readPlan().objectives[0].title, "Mon objectif");
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(process.env.DOT_HOME!, "memory", "PLAN.md"), "utf8"), /Mon objectif/);
});

test("échéances : intervalle, heure fixe, jours, tâche unique", () => {
  const from = new Date(2026, 9, 24, 10, 0); // samedi 24/10, 10:00
  assert.equal(nextAfter({ id: "a", prompt: "", nextRun: "", every: 30 }, from).getTime(), from.getTime() + 30 * 60_000);
  const at = nextAfter({ id: "b", prompt: "", nextRun: "", at: "07:30" }, from);
  assert.equal(at.getDate(), 25);
  assert.equal(at.getHours(), 7);
  assert.equal(nextAfter({ id: "c", prompt: "", nextRun: "", at: "07:30", days: [1] }, from).getDay(), 1);
  assert.equal(nextAfter({ id: "d", prompt: "", nextRun: "", once: "2026-10-30T09:00", lastRun: "x" }, from), null);
});

test("panne du modèle : reconnue sur une erreur de connexion, pas sur un vrai échec du travail", () => {
  assert.equal(modelUnavailable({ ok: false, tokensOut: 0, toolCalls: 0, error: "502 connect ECONNREFUSED 169.254.1.2:4748" }), true);
  assert.equal(modelUnavailable({ ok: false, tokensOut: 0, toolCalls: 0, error: "Connection error." }), true);
  assert.equal(modelUnavailable({ ok: false, tokensOut: 120, toolCalls: 2, error: "ECONNREFUSED" }), false); // le modèle a répondu
  assert.equal(modelUnavailable({ ok: false, tokensOut: 0, toolCalls: 0, error: "run arrêté : boucle" }), false);
  assert.deepEqual([1, 2, 3, 4, 9].map(retryMinutes), [2, 4, 8, 15, 15]);
});

test("mémoire : remember ajoute une fois, forget retire, la taille est bornée", async () => {
  const { remember, forget, readMemory } = await import(`${src}/extensions/dot/memory.ts`);
  const { mkdtempSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "dot-mem-"));
  assert.equal(remember(d, "Les mails passent par iCloud.").ok, true);
  assert.equal(remember(d, "les mails passent par icloud").message, "Already in memory.");
  assert.match(readMemory(d), /- Les mails passent par iCloud\. _\(/);
  assert.equal(forget(d, "passent par").ok, true);
  assert.doesNotMatch(readMemory(d), /iCloud/);
  assert.equal(remember(d, "x".repeat(9000)).ok, false);
  // replaces : le nouveau fait prend la place de l'ancien, sans doublon
  remember(d, "Les entreprises se cherchent sur pappers.fr.");
  assert.match(remember(d, "Les entreprises se cherchent par l'API RNE de l'INPI.", new Date(), "pappers").message, /^Replaced/);
  assert.doesNotMatch(readMemory(d), /pappers/);
  assert.match(readMemory(d), /API RNE/);
  assert.equal(remember(d, "autre", new Date(), "introuvable").ok, false);
  assert.doesNotMatch(readMemory(d), /autre/);
});

test("notes de projet : séparées de la mémoire globale, plafonnées", async () => {
  const { remember, forget, readMemory } = await import(`${src}/extensions/dot/memory.ts`);
  const { mkdtempSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "dot-proj-"));
  assert.equal(remember(d, "La personne veut des rapports courts.").ok, true);
  assert.match(remember(d, "Les dates viennent de l'API RNE.", new Date(), "", "abc123").message, /project abc123/);
  assert.doesNotMatch(readMemory(d), /RNE/, "rien du projet dans la mémoire globale");
  assert.match(readMemory(d, "abc123"), /^# Notes du projet abc123[\s\S]*API RNE/);
  assert.match(remember(d, "Les dates viennent du BODACC.", new Date(), "API RNE", "abc123").message, /^Replaced/);
  assert.equal(forget(d, "BODACC", "abc123").ok, true);
  assert.equal(remember(d, "x".repeat(3500), new Date(), "", "abc123").ok, false);
});

test("audit de la mémoire : anciens, objectif clos, doublons, valeurs sensibles", async () => {
  const { auditMemory } = await import(`${src}/memory-audit.mjs`);
  const memory = [
    "# Mémoire",
    "- Les dates des dirigeants viennent de pappers.fr, section Dirigeants _(25/10/2026)_",
    "- Le login INPI_USER est moi@example.com _(25/10/2026)_",
    "- La personne préfère les rapports courts en français _(01/01/2026)_",
    "- La personne préfère des rapports courts, rédigés en français _(20/10/2026)_",
    "- CSV livré dans /dot/livrables/URSSAF-2025_direction-parts_2026-10-26.csv _(26/10/2026)_",
    "- Les secrets passent par {{MODEL_KEY}} _(26/10/2026)_",
  ].join("\n");
  const plan = { objectives: [{ id: "a", title: "Scraper pappers.fr pour les dirigeants", status: "dropped" }] };
  const a = auditMemory(memory, plan, new Date(2026, 9, 31));
  assert.equal(a.facts, 6);
  assert.deepEqual(a.secretLike.map((s) => s.what), ["une adresse e-mail"]);
  assert.match(a.aboutClosed[0].fact, /pappers/);
  assert.equal(a.duplicates.length, 1);
  assert.match(a.stale[0], /préfère/);
});

test("audit : un fait global qui ne concerne qu'un projet ouvert est à déplacer", async () => {
  const { auditMemory } = await import(`${src}/memory-audit.mjs`);
  const memory = "# Mémoire\n- Le CSV URSSAF des congés payés a 185 lignes _(26/10/2026)_\n- La personne préfère le tutoiement _(26/10/2026)_";
  const p = { objectives: [{ id: "u", title: "Contrôle URSSAF des congés payés", status: "active" }] };
  const a = auditMemory(memory, p, new Date(2026, 9, 31));
  assert.equal(a.projectSpecific.length, 1);
  assert.match(a.projectSpecific[0].fact, /CSV/);
  assert.equal(auditMemory(memory, p, new Date(2026, 9, 31), "u").projectSpecific.length, 0, "dans les notes du projet, c'est leur place");
});

test("skills : un SKILL.md sans en-tête name/description est signalé", async () => {
  const { skillProblems } = await import(`${src}/extensions/dot/memory.ts`);
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "dot-skills-"));
  mkdirSync(join(d, "bon"));
  writeFileSync(join(d, "bon", "SKILL.md"), "---\nname: bon\ndescription: fait quelque chose\n---\n# Bon\n");
  mkdirSync(join(d, "mauvais"));
  writeFileSync(join(d, "mauvais", "SKILL.md"), "# Mauvais\nPas d'en-tête.\n");
  assert.deepEqual(skillProblems(d), ["mauvais"]);
});

test("usage : appels comptés par jour, skill reconnu, fenêtre de 30 jours", async () => {
  const u = await import(`${src}/extensions/dot/usage.ts`);
  const { mkdtempSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "dot-usage-"));
  const now = new Date("2026-10-24T10:00:00Z");
  u.record(d, "bash", { command: "python3 /dot/agent/skills/mail/bin/x.py list" }, now);
  u.record(d, "read", { path: "/dot/agent/skills/mail/SKILL.md" }, now);
  u.record(d, "bash", { command: "ls" }, new Date("2026-09-01T10:00:00Z"));
  const usage = u.readUsage(d);
  assert.equal(u.uses(usage.tools.bash, 30, now).count, 1);
  assert.equal(u.uses(usage.skills.mail, 30, now).count, 2);
  assert.equal(u.skillOf({ command: "echo bonjour" }), null);
});

test("loadout : les outils de base restent déclarés ; le différé est reporté dans la config MCP", async () => {
  const u = await import(`${src}/extensions/dot/usage.ts`);
  const { mkdtempSync } = await import("node:fs");
  const d = mkdtempSync(join(tmpdir(), "dot-loadout-"));
  const r = u.setExposure(d, ["bash", "mcp__playwright__browser_drag", "watch"], "deferred");
  assert.deepEqual(r.refused, ["bash"]);
  assert.deepEqual(u.readLoadout(d), { mcp__playwright__browser_drag: "deferred", watch: "deferred" });
  const base = { mcpServers: { playwright: { command: "x" }, ketch: { command: "k", toolExposure: { crawl: "hidden" } } } };
  const mcp = u.applyToMcp(base, u.readLoadout(d));
  assert.deepEqual(mcp.mcpServers.playwright.toolExposure, { browser_drag: "deferred" });
  assert.deepEqual(mcp.mcpServers.ketch.toolExposure, { crawl: "hidden" });
  assert.equal(base.mcpServers.playwright.toolExposure, undefined, "la config d'origine n'est pas modifiée");
  u.setExposure(d, ["watch"], "direct");
  assert.deepEqual(u.readLoadout(d), { mcp__playwright__browser_drag: "deferred" });
});

test("suivi en direct : appels décrits en clair, étapes et résultat mis en forme", async () => {
  const { describeCall, render } = await import(`${src}/extensions/dot/live.ts`);
  assert.equal(describeCall("bash", { command: "ls -la /dot" }), "commande : ls -la /dot");
  assert.equal(describeCall("read", { path: "/dot/memory/PLAN.md" }), "lit /dot/memory/PLAN.md");
  assert.equal(describeCall("mcp__ketch__search", { query: "météo Lyon" }), "ketch · search : météo Lyon");
  const t = new Date().toISOString();
  const running = render({ status: "running", label: "Objectif · todo", kind: "todo", started: t, turns: 2, tokens: 12000, steps: [{ t, label: "lit a" }, { t, label: "commande : b" }] });
  assert.match(running, /▶ En cours · Objectif · todo/);
  assert.match(running, /⏳ .* commande : b/);
  const done = render({ status: "done", label: "x", kind: "todo", started: t, ended: t, turns: 1, tokens: 0, steps: Array.from({ length: 20 }, (_, i) => ({ t, label: `étape ${i}` })), result: "fini" });
  assert.match(done, /✅ Terminé/);
  assert.match(done, /… 8 étape\(s\) plus tôt/);
  assert.match(done, /→ fini/);
});
