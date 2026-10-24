// Diagnostic du dot, vu de l'intérieur de son environnement : chaque maillon, du coffre au modèle.
// Lancé par `./dot doctor` (depuis la machine hôte) ou par l'outil `doctor` du dot lui-même.
// Sortie : une ligne par vérification (✅ ok · ⚠️ à surveiller · ❌ en panne), puis un résumé.

import { existsSync, readdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.DOT_HOME ?? "/dot";
const AGENT = process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent");
const MEMORY = join(HOME, "memory");
const VAULT = (process.env.DOT_VAULT ?? "http://dot-vault:8080").replace(/\/$/, "");
const RUN_MINUTES = Number(process.env.DOT_RUN_MINUTES || 30);
// Période du bilan des problèmes du journal : --days N (1 par défaut).
const DAYS = Math.max(1, Number(process.argv[process.argv.indexOf("--days") + 1]) || 1);

const results = [];
const ok = (what, detail = "") => results.push(["✅", what, detail]);
const warn = (what, detail = "") => results.push(["⚠️", what, detail]);
const fail = (what, detail = "") => results.push(["❌", what, detail]);

const json = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};
const ago = (iso) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 60_000) : Infinity);
async function get(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, text: await res.text() };
}

// --- Le coffre et le réseau ---
let secrets = [];
try {
  const r = await get(`${VAULT}/_vault/secrets`);
  secrets = JSON.parse(r.text).secrets ?? [];
  const waiting = JSON.parse(r.text).pending;
  ok("coffre joignable", `${secrets.length} secrets${waiting ? ` · demande en cours : ${waiting.names.join(", ")}` : ""}`);
} catch (e) {
  fail("coffre injoignable", e.message);
}
try {
  const r = await get("https://example.com", { method: "HEAD" });
  r.status < 500 ? ok("internet par le coffre") : warn("internet par le coffre", `HTTP ${r.status}`);
} catch (e) {
  fail("internet par le coffre", e.cause?.code ?? e.message);
}

// --- Le modèle ---
const settings = json(join(AGENT, "settings.json"), {});
const provider = settings.defaultProvider;
const custom = json(join(AGENT, "models.json"), {}).providers?.[provider];
if (!provider) warn("modèle", "aucun provider par défaut dans settings.json");
else if (custom?.baseUrl) {
  try {
    const r = await get(`${custom.baseUrl.replace(/\/$/, "")}/models`, { headers: custom.apiKey ? { authorization: `Bearer ${custom.apiKey}` } : {} });
    r.status === 200 ? ok("modèle joignable", `${provider}/${settings.defaultModel}`) : fail("modèle", `${provider} répond HTTP ${r.status} : ${r.text.slice(0, 120).trim()}`);
  } catch (e) {
    fail("modèle injoignable", `${provider} : ${e.cause?.code ?? e.message}`);
  }
} else ok("modèle", `${provider}/${settings.defaultModel} (provider intégré à pi : non testé ici)`);

// --- Telegram ---
if (process.env.TELEGRAM_OWNER_ID) {
  try {
    const r = await get(`${VAULT}/https/api.telegram.org/bot%7B%7BTELEGRAM_TOKEN%7D%7D/getWebhookInfo`);
    const info = JSON.parse(r.text).result ?? {};
    if (r.status !== 200) fail("Telegram", r.text.slice(0, 120).trim());
    else if (info.pending_update_count > 0) warn("Telegram", `${info.pending_update_count} message(s) en attente : le dot ne lit peut-être plus le bot`);
    else ok("Telegram joignable", "aucun message en attente");
  } catch (e) {
    fail("Telegram injoignable", e.message);
  }
} else warn("Telegram", "TELEGRAM_OWNER_ID absent : pas de canal avec la personne");

// --- Le cœur : battement, file, run en cours, pannes ---
const state = json(join(MEMORY, "state.json"), { events: [] });
const alive = ago(state.lastAlive);
alive <= 1 ? ok("battement actif") : fail("battement arrêté", `dernier signe de vie il y a ${alive === Infinity ? "jamais" : `${alive} min`}`);
if (state.paused) warn("autonomie en pause", "/resume pour reprendre");
if (state.modelDown) fail("modèle signalé en panne", `depuis ${ago(state.modelDown.since)} min, ${state.modelDown.tries} essais`);
if (state.running) {
  const minutes = ago(state.running.since);
  minutes > RUN_MINUTES ? fail("run bloqué", `${state.running.label} depuis ${minutes} min`) : ok("run en cours", `${state.running.label} (${minutes} min)`);
}
state.events?.length > 3 ? warn("événements en attente", `${state.events.length}`) : null;

// --- Le plan ---
const plan = json(join(MEMORY, "plan.json"), { objectives: [], todos: [] });
const waiting = plan.todos.filter((t) => t.status === "waiting");
const active = plan.objectives.filter((o) => o.status === "active").length;
waiting.length ? warn("todos en attente de la personne", waiting.map((t) => `${t.text.slice(0, 60)} (${t.reason ?? "?"})`).join(" ; ")) : ok("plan", `${active} objectif(s) actif(s), aucun todo bloqué`);

// --- Skills, mémoire ---
const skillsDir = join(AGENT, "skills");
if (existsSync(skillsDir)) {
  const broken = readdirSync(skillsDir).filter((n) => {
    const f = join(skillsDir, n, "SKILL.md");
    if (!existsSync(f)) return false;
    const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, "utf8").slice(0, 600))?.[1] ?? "";
    return !/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front);
  });
  const all = readdirSync(skillsDir).filter((n) => existsSync(join(skillsDir, n, "SKILL.md")));
  broken.length ? warn("skills non chargés (en-tête manquant)", broken.join(", ")) : ok("skills", `${all.length} chargé(s)`);
}
const memorySize = existsSync(join(MEMORY, "MEMORY.md")) ? statSync(join(MEMORY, "MEMORY.md")).size : 0;
const facts = existsSync(join(MEMORY, "MEMORY.md")) ? readFileSync(join(MEMORY, "MEMORY.md"), "utf8").split("\n").filter((l) => l.startsWith("- ")).length : 0;
memorySize > 7000 ? warn("mémoire presque pleine", `${memorySize} caractères`) : ok("mémoire", `${facts} fait(s) retenu(s)`);

// --- Ressources ---
const read = (f) => {
  try {
    return readFileSync(f, "utf8").trim();
  } catch {
    return null;
  }
};
const memCur = Number(read("/sys/fs/cgroup/memory.current"));
const memMax = Number(read("/sys/fs/cgroup/memory.max"));
if (memCur && memMax) {
  const pct = Math.round((memCur / memMax) * 100);
  (pct > 85 ? warn : ok)("mémoire vive", `${Math.round(memCur / 2 ** 20)} Mo / ${Math.round(memMax / 2 ** 20)} Mo (${pct} %)`);
}
const oom = /oom_kill (\d+)/.exec(read("/sys/fs/cgroup/memory.events") ?? "")?.[1];
if (Number(oom) > 0) warn("processus tués faute de mémoire", `${oom} depuis le démarrage`);
try {
  const fs = statfsSync(HOME);
  const freeGo = (fs.bavail * fs.bsize) / 2 ** 30;
  (freeGo < 5 ? warn : ok)("disque", `${freeGo.toFixed(1)} Go libres`);
} catch {}

// --- Le journal : les problèmes des dernières 24 h ---
const PROBLEMS = { "loop.suspect": "boucles", "todo.stuck": "todos bloqués", "model.down": "pannes du modèle", "pi.exit": "arrêts de pi", "net.denied": "refus du coffre", "heartbeat.error": "erreurs du battement", "notify.blocked": "messages bloqués", "telegram.conflict": "conflits Telegram (un autre programme lit le bot)", "oauth.error": "jetons non renouvelés" };
const since = Date.now() - DAYS * 24 * 3600_000;
const counts = {};
try {
  for (const f of readdirSync(join(HOME, "logs")).filter((f) => f.endsWith(".jsonl")).sort().slice(-(DAYS + 1))) {
    for (const line of readFileSync(join(HOME, "logs", f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (PROBLEMS[e.type] && new Date(e.t).getTime() >= since) counts[e.type] = (counts[e.type] ?? 0) + 1;
        if (e.type === "run.end" && !e.ok && !e.modelUnavailable && new Date(e.t).getTime() >= since) counts["run.failed"] = (counts["run.failed"] ?? 0) + 1;
      } catch {}
    }
  }
} catch {}
const summary = Object.entries(counts).map(([k, n]) => `${n} ${PROBLEMS[k] ?? "runs en échec"}`);
const period = DAYS === 1 ? "dernières 24 h" : `${DAYS} derniers jours`;
summary.length ? warn(`journal, ${period}`, summary.join(" · ")) : ok(`journal, ${period}`, "aucun problème");

// --- Sortie ---
for (const [icon, what, detail] of results) console.log(`${icon} ${what}${detail ? ` — ${detail}` : ""}`);
const bad = results.filter((r) => r[0] === "❌").length;
const notes = results.filter((r) => r[0] === "⚠️").length;
console.log(`\n${bad ? `${bad} en panne` : "rien en panne"}${notes ? `, ${notes} à surveiller` : ""}.`);
process.exitCode = bad ? 1 : 0;
