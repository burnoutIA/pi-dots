// De bout en bout : le vrai hub, le vrai pi et la vraie extension du dot, face à un faux serveur
// compatible OpenAI. On vérifie ce que les tests unitaires ne voient pas : quelle session et quel
// modèle sont repris après un redémarrage, pour la conversation comme pour un run autonome.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = process.env.DOT_SRC ?? "/src";
const HOME = mkdtempSync(join(tmpdir(), "dot-e2e-"));
const AGENT = join(HOME, "agent");
const WORKSPACE = join(HOME, "workspace");
const MEMORY = join(HOME, "memory");
const SOCKET = join(HOME, "rpc.sock");
for (const d of [AGENT, WORKSPACE, join(MEMORY, "projets")]) mkdirSync(d, { recursive: true });

// --- Faux serveur : garde chaque requête (modèle, messages de l'utilisateur), répond en flux ---
const requests = [];
let stubborn = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "modele-a" }, { id: "modele-b" }] }));
    const r = JSON.parse(body || "{}");
    const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));
    const users = (r.messages ?? []).filter((m) => m.role === "user").map(text);
    // Le todo en cours : le dernier donné (la session de l'objectif garde aussi les précédents).
    const todoNow = users.filter((u) => u.includes("Ton todo :")).at(-1) ?? "";
    requests.push({ model: r.model, role: req.headers["x-dot-role"], users, all: (r.messages ?? []).map(text) });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: r.model, ...o })}\n\n`);
    // Le todo « obstine » : un modèle qui s'acharne, une commande qui échoue chaque fois un peu différente.
    if (todoNow.includes("Ton todo : obstine")) {
      stubborn += 1;
      const call = { index: 0, id: `c${stubborn}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `ls /introuvable-${stubborn}` }) } };
      chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 300, completion_tokens: 20, total_tokens: 320 } });
      return res.end("data: [DONE]\n\n");
    }
    // Le todo « propose » : le modèle veut créer seul une tâche récurrente, puis conclut.
    if (todoNow.includes("Ton todo : propose") && r.messages.at(-1)?.role !== "tool") {
      const call = { index: 0, id: "s1", type: "function", function: { name: "schedule", arguments: JSON.stringify({ action: "add", prompt: "relancer chaque lundi", at: "09:00" }) } };
      chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] });
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
      return res.end("data: [DONE]\n\n");
    }
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: `réponse de ${r.model}` }, finish_reason: null }] });
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
    res.end("data: [DONE]\n\n");
  });
});

const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000 });

// --- Le dot : ce que fait son démarrage (réglages, models.json), puis le hub ---
let hub;
async function startDot(dotModel) {
  writeFileSync(join(AGENT, "models.json"), JSON.stringify({ providers: { fake: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "x", headers: { "x-dot-role": "${DOT_ROLE}" }, models: [model("modele-a"), model("modele-b")] } } }));
  // Comme entrypoint.sh : le défaut des réglages suit DOT_MODEL.
  writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: dotModel, quietStartup: "header" }));
  hub = spawn(process.execPath, [`${src}/hub.mjs`], {
    env: {
      ...process.env,
      DOT_HOME: HOME,
      PI_CODING_AGENT_DIR: AGENT,
      HUB_SOCKET: SOCKET,
      HUB_CWD: WORKSPACE,
      DOT_PI_EXTENSIONS: `-e ${src}/extensions/dot`,
      DOT_PROVIDER: "fake",
      DOT_MODEL: dotModel,
      DOT_TICK_MS: "500",
      DOT_REVIEW_DAYS: "0",
      DOT_MAX_RUNS: "1",
      DOT_RUN_TOKENS: "1000",
      DOT_FAIL_STREAK: "2",
      DOT_ROLE: "conversation",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      http_proxy: "",
      https_proxy: "",
    },
    stdio: "ignore",
    detached: true, // son propre groupe : on arrête le hub et son pi d'un coup
  });
  await until(() => existsSync(SOCKET), 20_000, "le hub ne démarre pas");
}
async function stopDot() {
  const exited = new Promise((r) => hub.once("exit", r));
  hub.kill("SIGTERM");
  await exited;
  await until(() => !existsSync(SOCKET), 10_000, "le socket du hub reste");
}

async function until(check, ms, message) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(message);
}

// Envoie un message à la conversation et attend la fin du tour.
async function say(message) {
  const socket = net.connect(SOCKET);
  await new Promise((r, e) => socket.once("connect", r).once("error", e));
  let buf = "";
  let settled = false;
  socket.on("data", (c) => {
    buf += c;
    if (/"type":"agent_settled"/.test(buf)) settled = true;
  });
  socket.write(JSON.stringify({ id: "t", type: "prompt", message }) + "\n");
  await until(() => settled, 60_000, `pas de fin de tour pour « ${message} »`);
  socket.end();
}

const conversationRequests = (marker) => requests.filter((r) => r.users.some((u) => u.includes(marker)));
const state = () => JSON.parse(readFileSync(join(MEMORY, "state.json"), "utf8"));
const writePlan = (todos) =>
  writeFileSync(
    join(MEMORY, "plan.json"),
    JSON.stringify({
      // À valider : ses todos tournent, mais aucun run de planification ne vient s'intercaler.
      objectives: [{ id: "o1", title: "Projet test", status: "active", stage: "a_valider", created: new Date().toISOString(), updated: new Date().toISOString() }],
      todos: todos.map((id) => ({ id, objective: "o1", text: `faire ${id}`, status: "todo", runs: 0, created: new Date().toISOString(), updated: new Date().toISOString() })),
    }),
  );

before(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
});
after(async () => {
  // Même après un échec : ni hub ni pi orphelin, ni connexion qui retiendrait le test.
  try {
    process.kill(-hub.pid, "SIGKILL");
  } catch {}
  server.closeAllConnections();
  server.close();
});

test("premier démarrage : la conversation et un run utilisent le modèle du .dot", { timeout: 120_000 }, async () => {
  await startDot("modele-a");
  await say("bonjour 1");
  assert.equal(conversationRequests("bonjour 1").at(-1).model, "modele-a");
  await until(() => existsSync(state().conversationSession ?? "/nope"), 10_000, "la session de conversation n'est pas enregistrée");

  writePlan(["t1"]);
  await until(() => conversationRequests("Ton todo : t1").length, 60_000, "le run du todo t1 n'a pas eu lieu");
  assert.equal(conversationRequests("Ton todo : t1")[0].model, "modele-a");
  // L'étiquette que le coffre lit pour la file d'attente : pi la remplit d'après DOT_ROLE.
  assert.equal(conversationRequests("bonjour 1").at(-1).role, "conversation");
  assert.equal(conversationRequests("Ton todo : t1")[0].role, "worker");
  await until(() => !state().running, 30_000, "le run ne se termine pas");
  await stopDot();
});

test("redémarrage avec un autre modèle : même conversation, même session de run, nouveau modèle", { timeout: 180_000 }, async () => {
  // Un piège : une session de run plus récente que la conversation (ce que choisissait pi --continue).
  const sessions = join(AGENT, "sessions", `--${WORKSPACE.replace(/^\//, "").replace(/\//g, "-")}--`);
  writeFileSync(
    join(sessions, "2099-01-01T00-00-00-000Z_dot-objectif-leurre.jsonl"),
    [
      { type: "session", version: 3, id: "dot-objectif-leurre", timestamp: new Date().toISOString(), cwd: WORKSPACE },
      { type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "message du run leurre", timestamp: Date.now() } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n",
  );

  await startDot("modele-b");
  await say("bonjour 2");
  const last = conversationRequests("bonjour 2").at(-1);
  assert.equal(last.model, "modele-b", "le modèle du .dot s'impose à la conversation reprise");
  assert.ok(last.users.some((u) => u.includes("bonjour 1")), "la conversation d'avant est reprise");
  assert.ok(!last.users.some((u) => u.includes("leurre")), "pas la session d'un run");

  writePlan(["t2"]);
  await until(() => conversationRequests("Ton todo : t2").length, 60_000, "le run du todo t2 n'a pas eu lieu");
  const run = conversationRequests("Ton todo : t2")[0];
  assert.equal(run.model, "modele-b", "la session nommée du run ne garde pas son ancien modèle");
  assert.ok(run.users.some((u) => u.includes("Ton todo : t1")), "le run reprend la session de son objectif");
  await stopDot();
});

test("un run qui s'acharne : point d'étape après les échecs, puis arrêt au plafond de jetons", { timeout: 120_000 }, async () => {
  await startDot("modele-b");
  writePlan(["obstine"]);
  await until(() => readFileSync(join(MEMORY, "plan.json"), "utf8").includes('"waiting"'), 60_000, "le todo ne passe pas en attente");
  const run = requests.filter((r) => r.users.some((u) => u.includes("Ton todo : obstine")));
  assert.ok(run.some((r) => r.all.some((m) => m.includes("[dot:point d'étape]") && m.includes("ont échoué"))), "le point d'étape arrive au modèle après les échecs");
  const logs = readdirSync(join(HOME, "logs")).map((f) => readFileSync(join(HOME, "logs", f), "utf8")).join("");
  assert.match(logs, /"type":"run.capped"/);
  assert.ok(run.length < 8, `le run est arrêté tôt (${run.length} requêtes)`);
  const plan = JSON.parse(readFileSync(join(MEMORY, "plan.json"), "utf8"));
  assert.match(plan.todos[0].reason, /plafond/);
  await stopDot();
});

test("autonomie prudente : un run ne crée pas seul une tâche planifiée, il la propose", { timeout: 120_000 }, async () => {
  // Le run arrêté au plafond du test précédent laisse un délai avant le run suivant : on l'efface.
  const st = state();
  delete st.backoffUntil;
  writeFileSync(join(MEMORY, "state.json"), JSON.stringify(st));
  await startDot("modele-b");
  writePlan(["propose"]);
  const run = () => requests.filter((r) => r.users.some((u) => u.includes("Ton todo : propose")));
  await until(() => run().some((r) => r.all.some((m) => m.includes("Not on your own"))), 60_000, "le refus n'arrive pas au modèle");
  assert.ok(!existsSync(join(MEMORY, "schedules.json")) || JSON.parse(readFileSync(join(MEMORY, "schedules.json"), "utf8")).length === 0, "aucune tâche créée");
  await until(() => !state().running, 30_000, "le run ne se termine pas");
  await stopDot();
});
