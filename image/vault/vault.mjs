// dot-vault — la seule porte de sortie du dot, et le seul endroit où vivent ses secrets.
//
// Les secrets sont une liste nom → valeur (config/vault.json), chacun avec les serveurs où il a le
// droit d'aller. Le dot ne connaît que les noms. Il écrit {{NOM}} là où il faut le secret, et
// envoie sa requête par le coffre, qui remplace au passage :
//
//   http://dot-vault:8080/https/api.example.com/…     relais vers https://api.example.com/…
//   Authorization: Basic {{basic:SERVICE_USER:SERVICE_PASSWORD}}
//   Authorization: Bearer {{MODEL_KEY}}
//
// Le remplacement se fait dans l'adresse et les en-têtes, et seulement si le serveur visé est dans
// les `hosts` du secret ; un secret `readOnly` n'accompagne que des lectures.
//
// Quand il manque un secret, le dot le demande (POST /_vault/request). Le coffre écrit alors à la
// personne sur Telegram, intercepte sa réponse avant qu'elle n'atteigne le dot (il est sur le
// chemin de la lecture des messages), l'enregistre, efface le message du fil, et prévient le dot
// par sa boîte de dépôt.
//
// Le reste du trafic (HTTPS_PROXY) passe par le proxy sortant : internet ouvert, adresses privées
// refusées sauf celles de `allow`.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { readMail } from "./imap.mjs";

const CONFIG_FILE = process.env.VAULT_CONFIG ?? "/vault/vault.json";
const LOGS = process.env.VAULT_LOGS ?? "/logs";
const INBOX = process.env.VAULT_INBOX ?? "/inbox";
const PORT = Number(process.env.VAULT_PORT ?? 8080);
const OWNER = Number(process.env.TELEGRAM_OWNER_ID);
const TELEGRAM_SECRET = "TELEGRAM_TOKEN";
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"]);
const NAME = /^[A-Z][A-Z0-9_]*$/;

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

// --- Les secrets ----------------------------------------------------------------------------------

let vault = { secrets: {}, allow: [] };

function load() {
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  vault = { secrets: raw.secrets ?? {}, allow: raw.allow ?? [] };
  for (const [name, secret] of Object.entries(vault.secrets)) {
    if (!NAME.test(name)) throw new Error(`nom de secret invalide : ${name} (MAJUSCULES_ET_CHIFFRES)`);
    if (!Array.isArray(secret.hosts) || !secret.hosts.length) throw new Error(`secret ${name} : « hosts » manquant (où il a le droit d'aller)`);
    if (secret.oauth && !secret.oauth.tokenUrl) throw new Error(`secret ${name} : oauth.tokenUrl manquant (adresse de renouvellement du jeton)`);
  }
}
function save() {
  // Écrit en place : le fichier est monté depuis la machine hôte (pas de renommage possible).
  writeFileSync(CONFIG_FILE, JSON.stringify(vault, null, 2) + "\n");
}

// Motifs de serveur : « api.example.com », « host:8080 », « *.example.com ».
function matches(pattern, host, port) {
  const p = pattern.toLowerCase();
  const [pHost, pPort] = p.split(":");
  if (pPort && Number(pPort) !== port) return false;
  if (pHost.startsWith("*.")) return host.endsWith(pHost.slice(1)) && host.length > pHost.length - 1;
  return host === pHost;
}
const allowedFor = (secret, host, port) => secret.hosts.some((pattern) => matches(pattern, host, port));
const isAllowed = (host, port) => vault.allow.some((pattern) => matches(pattern, host, port));

// --- Jetons OAuth : renouvelés par le coffre, une minute avant leur expiration --------------------

const accessTokens = new Map();

async function oauthToken(name, secret) {
  const cached = accessTokens.get(name);
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: secret.oauth.refreshToken,
    client_id: secret.oauth.clientId,
    client_secret: secret.oauth.clientSecret,
  });
  const res = await fetch(secret.oauth.tokenUrl, { method: "POST", body, signal: AbortSignal.timeout(20_000) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    log("oauth.error", { secret: name, status: res.status, error: json.error, detail: json.error_description });
    throw Object.assign(new Error(`renouvellement du jeton ${name} refusé (${json.error ?? res.status})`), { status: 502 });
  }
  accessTokens.set(name, { token: json.access_token, expires: Date.now() + Number(json.expires_in ?? 3600) * 1000 });
  log("oauth.refresh", { secret: name, expiresInS: json.expires_in });
  return json.access_token;
}

async function valueOf(name) {
  const secret = vault.secrets[name];
  if (!secret) throw Object.assign(new Error(`secret inconnu : ${name}. Demande-le avec POST /_vault/request.`), { status: 400 });
  return secret.oauth ? oauthToken(name, secret) : String(secret.value ?? "");
}

// {{NOM}} et {{basic:USER:PASS}}, écrits tels quels ou encodés dans une adresse (%7B%7B…%7D%7D).
const PLACEHOLDER = /(?:\{\{|%7B%7B)\s*([A-Za-z0-9_:]+?)\s*(?:\}\}|%7D%7D)/gi;

async function substitute(text, used) {
  const found = [...text.matchAll(PLACEHOLDER)];
  if (!found.length) return text;
  const values = [];
  for (const match of found) {
    const parts = match[1].split(":");
    if (parts[0].toLowerCase() === "basic" && parts.length === 3) {
      used.add(parts[1]).add(parts[2]);
      values.push(Buffer.from(`${await valueOf(parts[1])}:${await valueOf(parts[2])}`).toString("base64"));
    } else {
      used.add(parts[0]);
      values.push(await valueOf(parts[0]));
    }
  }
  let i = 0;
  return text.replace(PLACEHOLDER, () => values[i++]);
}

// --- Adresses privées -------------------------------------------------------------------------------

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivate(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || /^fe[89ab]/.test(v6);
}

// Résout puis vérifie ; la connexion se fait à l'adresse vérifiée (pas de changement entre-temps).
async function resolveAllowed(host, port, explicitlyAllowed = false) {
  const { address } = await lookup(host);
  if (isPrivate(address) && !explicitlyAllowed && !isAllowed(host, port)) {
    throw Object.assign(new Error(`adresse privée refusée : ${host} (${address})`), { status: 403, denied: true });
  }
  return address;
}

// --- Proxy sortant : CONNECT (HTTPS) --------------------------------------------------------------

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

// --- Transmission ---------------------------------------------------------------------------------

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

function forward(req, res, target, headers, address, { transform, onStatus } = {}) {
  const out = { ...headers, host: target.host };
  const lib = target.protocol === "https:" ? https : http;
  const upstream = lib.request(
    {
      protocol: target.protocol,
      hostname: address ?? target.hostname,
      servername: net.isIP(target.hostname) ? undefined : target.hostname, // TLS : certificat vérifié pour le vrai nom
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      method: req.method,
      path: target.pathname + target.search,
      headers: out,
    },
    (answer) => {
      onStatus?.(answer.statusCode ?? 502);
      if (!transform) {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        return answer.pipe(res);
      }
      // Réponse à modifier (lecture des messages Telegram) : lue en entier, puis réécrite.
      const chunks = [];
      answer.on("data", (c) => chunks.push(c));
      answer.on("end", async () => {
        let body = Buffer.concat(chunks);
        try {
          body = Buffer.from(await transform(body.toString("utf8")));
        } catch {}
        const h = { ...answer.headers, "content-length": String(body.length) };
        delete h["content-encoding"];
        delete h["transfer-encoding"];
        res.writeHead(answer.statusCode ?? 502, h);
        res.end(body);
      });
    },
  );
  upstream.on("error", (error) => {
    log("net.error", { host: target.hostname, error: error.message });
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`${error.message}\n`);
  });
  req.on("aborted", () => upstream.destroy());
  req.pipe(upstream);
}

function reply(res, status, body) {
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(typeof body === "string" ? `${body}\n` : JSON.stringify(body, null, 2));
}

// Relais : /https/<serveur[:port]>/<chemin> — c'est là que les secrets sont remplacés.
async function relay(req, res, scheme, rest, search) {
  const [hostPort, ...path] = rest;
  const target = new URL(`${scheme}://${hostPort}/${path.join("/")}${search}`);
  const host = target.hostname.toLowerCase();
  const port = Number(target.port || (scheme === "https" ? 443 : 80));
  const used = new Set();

  target.pathname = await substitute(target.pathname, used);
  target.search = await substitute(target.search, used);
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP.has(name)) continue;
    headers[name] = Array.isArray(value) ? value : await substitute(String(value), used);
  }

  for (const name of used) {
    const secret = vault.secrets[name];
    if (!allowedFor(secret, host, port)) {
      throw Object.assign(new Error(`le secret ${name} n'a pas le droit d'aller vers ${host}:${port} (autorisé : ${secret.hosts.join(", ")})`), { status: 403, denied: true, secret: name });
    }
    if (secret.readOnly && !READ_METHODS.has(String(req.method).toUpperCase())) {
      throw Object.assign(new Error(`le secret ${name} est en lecture seule : ${req.method} refusé`), { status: 403, denied: true, secret: name });
    }
  }
  // Un serveur privé (la machine hôte, le réseau local) est permis s'il est nommé par un secret utilisé.
  const named = [...used].some((name) => vault.secrets[name].hosts.some((p) => !p.startsWith("*") && matches(p, host, port)));
  const address = await resolveAllowed(host, port, named);
  if (!used.size) log("net.out", { method: req.method, host, port, relay: true });

  const isUpdates = host === "api.telegram.org" && target.pathname.endsWith("/getUpdates");
  forward(req, res, target, headers, address, {
    // Toujours relue : la réponse de la personne peut arriver pendant une attente déjà commencée.
    transform: isUpdates ? intercept : undefined,
    onStatus: (status) => {
      if (status === 401) for (const name of used) accessTokens.delete(name);
      if (status >= 500) log("net.error", { host, status, secrets: [...used] });
    },
  });
}

// --- Demandes de secrets, par Telegram ----------------------------------------------------------

let pending = null; // { id, fields: [{ name, label }], index, values, hosts, readOnly, purpose }

async function telegram(method, params) {
  const token = vault.secrets[TELEGRAM_SECRET]?.value;
  if (!token || !Number.isInteger(OWNER)) throw new Error("Telegram n'est pas configuré dans le coffre");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} : ${json.description}`);
  return json.result;
}

function ask() {
  const field = pending.fields[pending.index];
  const head =
    pending.index === 0
      ? [
          "🔐 Le dot demande un accès. Tes réponses sont lues par le coffre, pas par le dot, puis effacées de ce fil.",
          `Pour : ${pending.purpose}`,
          `Envoyé uniquement à : ${pending.hosts.join(", ")}`,
          pending.readOnly ? "Lecture seule : oui" : "Lecture seule : non (lecture et écriture)",
          "",
        ]
      : [];
  const replace = vault.secrets[field.name] ? " — remplace la valeur déjà enregistrée" : "";
  const text = [...head, `${pending.index + 1}/${pending.fields.length} · ${field.label} (${field.name})${replace}`, "Envoie la valeur, ou /annuler."].join("\n");
  return telegram("sendMessage", { chat_id: OWNER, text });
}

function tellDot(id, text) {
  try {
    mkdirSync(INBOX, { recursive: true });
    writeFileSync(join(INBOX, `coffre-${id}.txt`), `[message du coffre, pas de la personne]\n${text}\n`);
  } catch {}
}

async function finish(cancelled) {
  const request = pending;
  pending = null;
  const names = request.fields.map((f) => f.name);
  if (cancelled) {
    log("secret.cancelled", { request: request.id, names });
    tellDot(request.id, `La personne a refusé la demande de secrets ${names.join(", ")} (${request.purpose}). Ne la répète pas sans qu'elle te le demande.`);
    await telegram("sendMessage", { chat_id: OWNER, text: "Demande annulée : rien n'a été enregistré." }).catch(() => {});
    return;
  }
  for (const field of request.fields) {
    vault.secrets[field.name] = { value: request.values[field.name], hosts: request.hosts, ...(request.readOnly ? { readOnly: true } : {}) };
  }
  save();
  log("secret.saved", { request: request.id, names, hosts: request.hosts, readOnly: request.readOnly });
  tellDot(
    request.id,
    `Les secrets ${names.join(", ")} sont disponibles dans le coffre (pour ${request.hosts.join(", ")}${request.readOnly ? ", lecture seule" : ""}). Demande d'origine : ${request.purpose}. Utilise-les avec {{NOM}} dans tes requêtes par le coffre.`,
  );
  await telegram("sendMessage", { chat_id: OWNER, text: `✅ Enregistré dans le coffre : ${names.join(", ")}. Tes messages ont été effacés de ce fil.` }).catch(() => {});
}

// La lecture des messages par le dot passe ici : les réponses de la personne à la demande en cours
// sont retirées (le dot ne reçoit que le numéro du message), enregistrées, puis effacées du fil.
async function intercept(body) {
  const json = JSON.parse(body);
  if (!json.ok || !Array.isArray(json.result)) return body;
  for (const update of json.result) {
    const msg = update.message;
    if (!pending || !msg || msg.chat?.type !== "private" || msg.from?.id !== OWNER || typeof msg.text !== "string") continue;
    delete update.message;
    telegram("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id }).catch(() => {});
    if (/^\/annuler\b/i.test(msg.text.trim())) {
      await finish(true);
      continue;
    }
    pending.values[pending.fields[pending.index].name] = msg.text.trim();
    pending.index += 1;
    if (pending.index < pending.fields.length) await ask().catch(() => {});
    else await finish(false);
  }
  return JSON.stringify(json);
}

// Ce que le dot peut demander et consulter (jamais les valeurs).
async function control(req, res, path) {
  if (req.method === "GET" && path === "secrets") {
    const list = Object.entries(vault.secrets).map(([name, s]) => ({ name, hosts: s.hosts, readOnly: !!s.readOnly, kind: s.oauth ? "oauth" : "valeur" }));
    return reply(res, 200, { secrets: list, pending: pending ? { id: pending.id, names: pending.fields.map((f) => f.name) } : null });
  }
  if (req.method === "POST" && path === "request") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(res, 400, "corps JSON attendu");
    }
    const fields = (body.secrets ?? []).map((f) => (typeof f === "string" ? { name: f, label: f } : { name: f?.name, label: f?.label || f?.name }));
    const hosts = (body.hosts ?? []).map((h) => String(h).toLowerCase().trim()).filter(Boolean);
    if (!fields.length || fields.some((f) => !NAME.test(String(f.name)))) return reply(res, 400, "secrets : une liste de noms en MAJUSCULES (ex. SERVICE_USER), chacun avec un label lisible");
    if (fields.some((f) => f.name === TELEGRAM_SECRET)) return reply(res, 400, `${TELEGRAM_SECRET} ne se demande pas par Telegram`);
    // Pas de joker trop large : « *.example.com » oui, « * » ou « *.com » non.
    const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$|^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+$/;
    if (!hosts.length || hosts.some((h) => !HOST.test(h))) {
      return reply(res, 400, "hosts : les serveurs où ces secrets auront le droit d'aller (ex. *.example.com, api.example.com, host.docker.internal:8080)");
    }
    if (!body.purpose) return reply(res, 400, "purpose : à quoi serviront ces secrets, en une phrase pour la personne");
    if (pending) return reply(res, 409, `une demande est déjà en cours (${pending.fields.map((f) => f.name).join(", ")}) : attends sa réponse`);
    if (!vault.secrets[TELEGRAM_SECRET] || !Number.isInteger(OWNER)) {
      return reply(res, 503, "le coffre ne peut pas joindre la personne (Telegram non configuré) : demande-lui d'ajouter ces secrets dans config/vault.json");
    }
    pending = { id: randomBytes(3).toString("hex"), fields, index: 0, values: {}, hosts, readOnly: body.readOnly !== false, purpose: String(body.purpose).slice(0, 300) };
    try {
      await ask();
    } catch (error) {
      pending = null;
      return reply(res, 502, `message à la personne impossible : ${error.message}`);
    }
    log("secret.requested", { request: pending.id, names: fields.map((f) => f.name), hosts, readOnly: pending.readOnly, purpose: pending.purpose });
    return reply(res, 202, { id: pending.id, status: "demandé à la personne sur Telegram ; tu seras prévenu par ta boîte de dépôt" });
  }
  if (req.method === "POST" && path === "mail") return mail(req, res);
  return reply(res, 404, "GET /_vault/secrets, POST /_vault/request, POST /_vault/mail");
}

// Lecture des mails (IMAP, lecture seule) : l'identifiant et le mot de passe sont des {{NOM}}.
async function mail(req, res) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply(res, 400, "corps JSON attendu");
  }
  const [hostText, portText] = String(body.server ?? "").toLowerCase().split(":");
  const host = hostText;
  const port = Number(portText || 993);
  if (!host) return reply(res, 400, 'server : le serveur IMAP, ex. "imap.example.com:993" (connexion chiffrée)');
  if (port === 143) return reply(res, 400, "connexion non chiffrée refusée : utilise le port 993");
  const used = new Set();
  const user = await substitute(String(body.user ?? ""), used);
  const password = await substitute(String(body.password ?? ""), used);
  if (!used.size) return reply(res, 400, "user et password doivent être des {{NOM}} du coffre, pas des valeurs");
  for (const name of used) {
    const secret = vault.secrets[name];
    if (!allowedFor(secret, host, port)) {
      log("net.denied", { secret: name, host, port, error: "serveur non autorisé pour ce secret" });
      return reply(res, 403, `le secret ${name} n'a pas le droit d'aller vers ${host}:${port} (autorisé : ${secret.hosts.join(", ")})`);
    }
  }
  const named = [...used].some((name) => vault.secrets[name].hosts.some((p) => !p.startsWith("*") && matches(p, host, port)));
  const address = await resolveAllowed(host, port, named);
  const result = await readMail({ host, port, address, user, password, action: body.action, folder: body.folder, query: body.query ?? {}, uids: body.uids ?? [], limit: body.limit });
  log("mail.read", { host, action: body.action, folder: body.folder ?? "INBOX", count: result.messages?.length ?? result.folders?.length ?? 0 });
  return reply(res, 200, result);
}

// --- Aiguillage ---------------------------------------------------------------------------------

async function onRequest(req, res) {
  try {
    // Proxy sortant en HTTP clair (URL absolue) : pas de secrets ici.
    if (/^https?:\/\//i.test(req.url ?? "")) {
      const target = new URL(req.url);
      const port = Number(target.port || 80);
      const address = await resolveAllowed(target.hostname, port);
      log("net.out", { method: req.method, host: target.hostname, port });
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) if (!HOP.has(name)) headers[name] = value;
      return forward(req, res, target, headers, address);
    }
    const url = new URL(req.url ?? "/", "http://vault");
    const [, first, ...rest] = url.pathname.split("/");
    if (first === "https" || first === "http") return await relay(req, res, first, rest, url.search);
    if (first === "_vault") return await control(req, res, rest.join("/"));
    return reply(
      res,
      200,
      [
        "dot-vault — tes secrets, sans leurs valeurs.",
        "",
        "Relais : http://dot-vault:8080/https/<serveur>/<chemin> (ou /http/…), avec {{NOM}} dans l'adresse ou les en-têtes,",
        "         et {{basic:USER:PASS}} pour un en-tête Authorization: Basic.",
        "Secrets : GET http://dot-vault:8080/_vault/secrets",
        "Demander un secret : POST http://dot-vault:8080/_vault/request",
        'Lire des mails (IMAP, lecture seule) : POST http://dot-vault:8080/_vault/mail',
        '  {"server": "imap.example.com:993", "user": "{{MAIL_USER}}", "password": "{{MAIL_PASSWORD}}", "action": "folders|search|fetch",',
        '   "folder": "INBOX", "query": {"since": "2026-10-23", "from": "…", "subject": "…", "text": "…", "unseen": true}, "limit": 20, "uids": [123]}',
        '  {"secrets": [{"name": "SERVICE_USER", "label": "Identifiant du service"}], "hosts": ["*.example.com"], "readOnly": true, "purpose": "…"}',
        "",
        "Secrets disponibles :",
        ...Object.entries(vault.secrets).map(([n, s]) => `- ${n} → ${s.hosts.join(", ")}${s.readOnly ? " (lecture seule)" : ""}`),
      ].join("\n"),
    );
  } catch (error) {
    log(error.denied ? "net.denied" : "net.error", { method: req.method, url: String(req.url).replace(PLACEHOLDER, "{{…}}").slice(0, 200), secret: error.secret, error: error.message });
    if (!res.headersSent) reply(res, error.status ?? 502, error.message);
    else res.end();
  }
}

load();
const server = http.createServer(onRequest);
server.on("connect", onConnect);
server.headersTimeout = 0;
server.requestTimeout = 0; // les réponses en flux (modèles, long polling Telegram) peuvent être longues
server.listen(PORT, "0.0.0.0", () => log("vault.start", { port: PORT, secrets: Object.keys(vault.secrets), allow: vault.allow }));

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (log("vault.stop"), process.exit(0)));
