// Le hub : le pi de conversation du dot en mode RPC, joignable par un socket.
//
// Utilisé quand DOT_INTERFACE=rpc (à la place du terminal tmux). Le protocole est celui de
// `pi --mode rpc`, inchangé : un client qui sait piloter pi en RPC sait piloter un dot.
//
//   - pi est lancé (`pi --mode rpc --continue`) et relancé s'il s'arrête ;
//   - plusieurs clients peuvent se connecter au socket en même temps ;
//   - une commande d'un client est renumérotée : sa réponse ne revient qu'à lui ;
//   - les événements (texte, outils, runs) sont diffusés à tous les clients ;
//   - une demande à l'interface (confirmation, choix…) est envoyée à tous, la première réponse
//     l'emporte ; sans client, le hub répond « annulé » pour que pi ne reste jamais bloqué.

import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";

const HOME = process.env.DOT_HOME ?? "/dot";
const SOCKET = process.env.HUB_SOCKET ?? join(HOME, "channel", "rpc.sock");
// Les extensions du dépôt arrivent en options (-e …), préparées par le démarrage du dot.
const EXTENSIONS = (process.env.DOT_PI_EXTENSIONS ?? "").trim().split(/\s+/).filter(Boolean);
const PI_CMD = process.env.HUB_PI_CMD ? JSON.parse(process.env.HUB_PI_CMD) : ["pi", ...EXTENSIONS, "--mode", "rpc", "--continue"];
const CWD = process.env.HUB_CWD ?? join(HOME, "workspace");
const LOGS = join(HOME, "logs");
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

function log(type, data = {}) {
  try {
    mkdirSync(LOGS, { recursive: true });
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    appendFileSync(join(LOGS, `${day}.jsonl`), JSON.stringify({ t: d.toISOString(), role: "hub", type, ...data }) + "\n");
  } catch {}
}

// Découpe un flux en enregistrements JSONL, uniquement sur LF (pas sur U+2028/U+2029).
function lines(onLine) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let nl;
    while ((nl = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(nl + 1);
      if (line.trim()) onLine(line);
    }
  };
}

// --- Les clients ---
const clients = new Map(); // numéro → socket
let nextClient = 1;
const send = (socket, record) => {
  if (!socket.destroyed) socket.write(JSON.stringify(record) + "\n");
};
const broadcast = (record) => {
  for (const socket of clients.values()) send(socket, record);
};

// --- pi ---
let pi = null;
const answeredUi = new Set(); // demandes à l'interface déjà tranchées

function startPi() {
  pi = spawn(PI_CMD[0], PI_CMD.slice(1), { cwd: CWD, env: process.env, stdio: ["pipe", "pipe", "inherit"] });
  const started = Date.now();
  log("hub.pi.start", { pid: pi.pid });
  pi.stdout.on(
    "data",
    lines((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return;
      }
      // Réponse (ou sortie de bash) à la commande d'un client : rendue à lui seul, avec son id d'origine.
      const routed = typeof record.id === "string" && /^c(\d+):/.exec(record.id);
      if (routed && record.type !== "extension_ui_request") {
        const socket = clients.get(Number(routed[1]));
        record.id = record.id.slice(routed[0].length);
        if (socket) send(socket, record);
        return;
      }
      if (record.type === "extension_ui_request" && DIALOGS.has(record.method) && clients.size === 0) {
        // Personne pour répondre : on annule, pi continue.
        writePi({ type: "extension_ui_response", id: record.id, cancelled: true });
        return;
      }
      broadcast(record);
    }),
  );
  pi.on("exit", (code, signal) => {
    log("hub.pi.exit", { code, signal, uptimeS: Math.round((Date.now() - started) / 1000) });
    broadcast({ type: "hub_pi_restarting", code, signal });
    pi = null;
    setTimeout(startPi, 3000);
  });
}

function writePi(record) {
  if (pi?.stdin.writable) pi.stdin.write(JSON.stringify(record) + "\n");
}

// --- Le socket ---
mkdirSync(dirname(SOCKET), { recursive: true });
rmSync(SOCKET, { force: true });
const server = net.createServer((socket) => {
  const id = nextClient++;
  clients.set(id, socket);
  log("hub.client.connect", { client: id, clients: clients.size });
  socket.on(
    "data",
    lines((line) => {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        return send(socket, { type: "response", command: "parse", success: false, error: "JSON invalide" });
      }
      if (record.type === "extension_ui_response") {
        // La première réponse l'emporte ; les autres clients sont prévenus que c'est tranché.
        if (answeredUi.has(record.id)) return;
        answeredUi.add(record.id);
        if (answeredUi.size > 500) answeredUi.delete(answeredUi.values().next().value);
        writePi(record);
        for (const [other, s] of clients) if (other !== id) send(s, { type: "hub_ui_answered", id: record.id });
        return;
      }
      if (record.id !== undefined) record.id = `c${id}:${record.id}`;
      writePi(record);
    }),
  );
  const bye = () => {
    if (!clients.delete(id)) return;
    log("hub.client.disconnect", { client: id, clients: clients.size });
  };
  socket.on("close", bye);
  socket.on("error", bye);
});
server.listen(SOCKET, () => {
  try {
    chmodSync(SOCKET, 0o600); // l'utilisateur de la machine seulement
  } catch {}
  log("hub.start", { socket: SOCKET });
  startPi();
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    log("hub.stop");
    server.close();
    rmSync(SOCKET, { force: true });
    pi?.removeAllListeners("exit");
    pi?.stdin.end();
    setTimeout(() => {
      pi?.kill("SIGTERM");
      process.exit(0);
    }, 3000).unref();
  });
}
