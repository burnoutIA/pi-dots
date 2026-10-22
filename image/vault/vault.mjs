// dot-vault — la seule porte de sortie du dot, et le seul endroit où vivent ses secrets.
//
// Le dot est sur un réseau interne, sans accès direct à quoi que ce soit. Il passe par le coffre :
//
//   1. proxy sortant (HTTP_PROXY / HTTPS_PROXY = http://dot-vault:8080) : internet est ouvert,
//      mais les adresses privées (réseau local, machine hôte, loopback) sont refusées, sauf
//      celles listées dans `allow` ;
//   2. relais à secrets (http://dot-vault:8080/<route>/...) : le coffre ajoute lui-même les
//      en-têtes secrets (clé d'API…) et transmet à l'adresse réelle. Le dot connaît le nom de la
//      route, jamais la clé.
//
// Configuration : /vault/vault.json (config/vault.json sur la machine hôte, monté seulement ici).
// Journal : /logs/AAAA-MM-JJ.jsonl, au même format que celui du dot (refus, erreurs, sorties).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";

const CONFIG_FILE = process.env.VAULT_CONFIG ?? "/vault/vault.json";
const LOGS = process.env.VAULT_LOGS ?? "/logs";
const PORT = Number(process.env.VAULT_PORT ?? 8080);

// --- Configuration ------------------------------------------------------------------------------

function loadConfig() {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const routes = { ...(raw.routes ?? {}) };
  // Raccourci Telegram : le jeton fait partie de l'adresse de l'API, d'où deux routes.
  if (raw.telegram?.token) {
    routes.telegram ??= { upstream: `https://api.telegram.org/bot${raw.telegram.token}` };
    routes["telegram-file"] ??= { upstream: `https://api.telegram.org/file/bot${raw.telegram.token}` };
  }
  for (const [name, route] of Object.entries(routes)) {
    if (!/^[\w-]+$/.test(name)) throw new Error(`nom de route invalide : ${name}`);
    route.url = new URL(route.upstream);
    route.headers ??= {};
  }
  return { routes, allow: new Set((raw.allow ?? []).map((x) => x.toLowerCase())) };
}

const config = loadConfig();

// --- Journal ----------------------------------------------------------------------------------

function day(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function log(type, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), role: "coffre", type, ...data });
  try {
    mkdirSync(LOGS, { recursive: true });
    appendFileSync(join(LOGS, `${day()}.jsonl`), line + "\n");
  } catch {}
  if (type !== "net.out") console.log(line);
}

// --- Adresses privées -------------------------------------------------------------------------------

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivate(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb");
}

// Résout le nom puis vérifie l'adresse obtenue ; la connexion se fait ensuite à cette adresse-là,
// pour qu'un nom ne puisse pas changer d'adresse entre la vérification et la connexion.
async function resolveAllowed(host, port) {
  const key = `${host}:${port}`.toLowerCase();
  const { address } = await lookup(host);
  if (isPrivate(address) && !config.allow.has(key) && !config.allow.has(host.toLowerCase())) {
    const error = new Error(`adresse privée refusée : ${host} (${address})`);
    error.denied = true;
    throw error;
  }
  return address;
}

// --- 1. Proxy sortant : CONNECT (HTTPS) --------------------------------------------------------

function onConnect(req, client, head) {
  const [host, portText] = String(req.url).split(":");
  const port = Number(portText || 443);
  resolveAllowed(host, port)
    .then((address) => {
      const upstream = net.connect(port, address, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      log("net.out", { method: "CONNECT", host, port });
    })
    .catch((error) => {
      log(error.denied ? "net.denied" : "net.error", { method: "CONNECT", host, port, error: error.message });
      client.end(`HTTP/1.1 ${error.denied ? "403 Forbidden" : "502 Bad Gateway"}\r\ncontent-type: text/plain\r\n\r\n${error.message}\n`);
    });
}

// --- Requêtes HTTP : proxy sortant (URL absolue) ou relais à secrets (/route/...) -----------------

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function forward(req, res, target, extraHeaders, address, logData) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
  // Un relais à secrets remplace toujours l'authentification : celle du dot n'est qu'un leurre.
  if (Object.keys(extraHeaders).length) for (const name of Object.keys(headers)) if (name === "authorization" || name === "x-api-key") delete headers[name];
  Object.assign(headers, extraHeaders, { host: target.host });
  const lib = target.protocol === "https:" ? https : http;
  const upstream = lib.request(
    {
      protocol: target.protocol,
      hostname: address ?? target.hostname,
      servername: target.hostname, // TLS : le certificat est vérifié pour le vrai nom
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
      if ((answer.statusCode ?? 500) >= 500) log("net.error", { ...logData, status: answer.statusCode });
    },
  );
  upstream.on("error", (error) => {
    log("net.error", { ...logData, error: error.message });
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`${error.message}\n`);
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

async function onRequest(req, res) {
  try {
    // Proxy sortant en HTTP clair : l'URL est absolue.
    if (/^https?:\/\//i.test(req.url ?? "")) {
      const target = new URL(req.url);
      const port = Number(target.port || 80);
      const address = await resolveAllowed(target.hostname, port);
      log("net.out", { method: req.method, host: target.hostname, port });
      return forward(req, res, target, {}, address, { method: req.method, host: target.hostname });
    }

    // Relais à secrets : /<route>/<reste du chemin>
    const url = new URL(req.url ?? "/", "http://vault");
    const [, name, ...rest] = url.pathname.split("/");
    if (!name) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end(`dot-vault. Routes : ${Object.keys(config.routes).join(", ") || "aucune"}\n`);
    }
    const route = config.routes[name];
    if (!route) {
      log("net.denied", { route: name, error: "route inconnue" });
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end(`route inconnue : ${name}\n`);
    }
    const base = route.url.pathname.replace(/\/$/, "");
    const target = new URL(route.url.href);
    target.pathname = `${base}/${rest.join("/")}`;
    target.search = url.search;
    // Les routes sont choisies par la personne : une adresse privée y est permise.
    return forward(req, res, target, route.headers, undefined, { route: name, method: req.method });
  } catch (error) {
    log(error.denied ? "net.denied" : "net.error", { method: req.method, url: String(req.url).slice(0, 200), error: error.message });
    if (!res.headersSent) res.writeHead(error.denied ? 403 : 502, { "content-type": "text/plain" });
    res.end(`${error.message}\n`);
  }
}

const server = http.createServer(onRequest);
server.on("connect", onConnect);
server.headersTimeout = 0;
server.requestTimeout = 0; // les réponses en flux (modèles, long polling Telegram) peuvent être longues
server.listen(PORT, "0.0.0.0", () => log("vault.start", { port: PORT, routes: Object.keys(config.routes), allow: [...config.allow] }));

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (log("vault.stop"), process.exit(0)));
