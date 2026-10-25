// dot-vault — la seule porte de sortie du dot, et le seul endroit où vivent ses secrets.
//
// Les secrets sont une liste nom → valeur (le nœud vault du fichier .dot), chacun avec les serveurs où il a le
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
// Quand il manque un secret, le dot le demande (POST /_vault/request). Le coffre prévient la
// personne sur Telegram, mais elle répond toujours depuis sa machine (./dot secret), par une porte
// que le dot ne peut pas joindre : la conversation Telegram reste au dot, et une valeur ne passe
// jamais par elle. Le coffre enregistre, puis prévient le dot par sa boîte de dépôt.
//
// Le reste du trafic (HTTPS_PROXY) passe par le proxy sortant : internet ouvert, adresses privées
// refusées sauf celles de `allow`.

import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { join } from "node:path";
import { patchVault, readVault } from "../dotfile.mjs";
import { readMail } from "./imap.mjs";

const CONFIG_FILE = process.env.VAULT_CONFIG ?? "/vault/dot.dot";
// Le même fichier, vu de la machine : pour dire à la personne où il est.
const DOT_FILE = process.env.DOT_FILE ?? "";
const LOGS = process.env.VAULT_LOGS ?? "/logs";
const INBOX = process.env.VAULT_INBOX ?? "/inbox";
const PORT = Number(process.env.VAULT_PORT ?? 8080);
const OWNER = Number(process.env.TELEGRAM_OWNER_ID);
const TELEGRAM_SECRET = "TELEGRAM_TOKEN";
// Adresse de l'API Telegram (réglable pour les tests, qui utilisent un faux Telegram).
const TELEGRAM_API = (process.env.VAULT_TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"]);
const NAME = /^[A-Z][A-Z0-9_]*$/;
// Pour dire à la personne quelle commande lancer (./dot @nom secret).
const DOT_NAME = process.env.DOT_NAME ?? "";
const SECRET_COMMAND = `./dot ${DOT_NAME ? `@${DOT_NAME} ` : ""}secret`;

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

// Les secrets vivent dans le nœud `vault` du fichier du dot (<nom>.dot) ; le coffre est le seul à le lire.
// Lit et vérifie ce nœud ; une erreur dit ce qui ne va pas.
function parseVault() {
  const raw = readVault(CONFIG_FILE);
  const next = { secrets: raw.secrets ?? {}, allow: raw.allow ?? [] };
  for (const [name, secret] of Object.entries(next.secrets)) {
    if (!NAME.test(name)) throw new Error(`nom de secret invalide : ${name} (MAJUSCULES_ET_CHIFFRES)`);
    if (!secret || typeof secret !== "object") throw new Error(`secret ${name} : { value: "…", hosts: [ … ] } attendu`);
    if (!Array.isArray(secret.hosts) || !secret.hosts.length) throw new Error(`secret ${name} : « hosts » manquant (où il a le droit d'aller)`);
    if (secret.oauth && !secret.oauth.tokenUrl) throw new Error(`secret ${name} : oauth.tokenUrl manquant (adresse de renouvellement du jeton)`);
  }
  return { next, pending: raw._pending ?? null };
}
function load() {
  const read = parseVault();
  vault = read.next;
  pending = read.pending;
  seenStamp = fileStamp();
}

// Le coffre n'écrit que ce qu'il change (les secrets nommés, sa demande en cours) : ce que la
// personne a écrit à la main est gardé.
function save(names = []) {
  const before = fileStamp();
  patchVault(CONFIG_FILE, { secrets: Object.fromEntries(names.map((n) => [n, vault.secrets[n]])), pending: pending ?? null });
  // Notre propre écriture n'est pas un changement à relire, sauf si la personne a écrit juste avant.
  if (before === seenStamp) seenStamp = fileStamp();
}

// Une ligne pas encore remplie (value: "") n'est pas un secret utilisable.
const filled = (secret) => !!secret && (!!secret.oauth || String(secret.value ?? "") !== "");
const valueKey = (secret) => JSON.stringify(secret?.oauth ?? secret?.value ?? null);

// --- Le fichier, relu quand la personne le modifie ------------------------------------------------

let seenStamp = "";
let lastReadError = "";
function fileStamp() {
  try {
    const s = statSync(CONFIG_FILE);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "";
  }
}

async function reload() {
  const stamp = fileStamp();
  if (!stamp || stamp === seenStamp) return;
  seenStamp = stamp;
  let next;
  try {
    next = parseVault().next;
  } catch (error) {
    // Peut-être en cours d'écriture : on garde la version précédente, et on le dit une fois.
    if (error.message !== lastReadError) {
      lastReadError = error.message;
      log("vault.config.error", { error: error.message });
      await notify(`⚠️ Le coffre ne peut pas relire ${fileLabel()} : ${error.message}\nIl garde la version précédente jusqu'à ce que le fichier soit corrigé.`);
    }
    return;
  }
  lastReadError = "";
  const before = vault.secrets;
  vault = next;
  // Les secrets remplis ou changés à la main (les noms seulement, jamais les valeurs).
  const changed = Object.keys(next.secrets).filter((n) => filled(next.secrets[n]) && valueKey(before[n]) !== valueKey(next.secrets[n]));
  for (const name of changed) accessTokens.delete(name);
  log("vault.reload", { secrets: Object.keys(next.secrets), changed });
  await byHand(changed);
}

// La demande en cours a peut-être été faite à la main, dans le fichier.
async function byHand(changed) {
  if (!pending) return;
  if (pending.type === "extend") {
    const done = pending.names.every((n) => pending.hosts.every((h) => vault.secrets[n]?.hosts?.map(String).map((x) => x.toLowerCase()).includes(h)));
    if (done) await finish("saved", { byHand: true });
    return;
  }
  const wanted = pending.fields.map((f) => f.name);
  const hand = changed.filter((n) => wanted.includes(n));
  if (!hand.length) return;
  pending.byHand = [...new Set([...(pending.byHand ?? []), ...hand])];
  advance();
  if (pending.index >= pending.fields.length) return finish("saved", { byHand: true });
  save();
}

// Passe les secrets déjà remplis à la main : la machine ne les redemande pas.
function advance() {
  while (pending.index < pending.fields.length && pending.byHand?.includes(pending.fields[pending.index].name)) pending.index += 1;
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
  if (!filled(secret)) throw Object.assign(new Error(`secret ${name} pas encore rempli par la personne`), { status: 400 });
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

function forward(req, res, target, headers, address, { onStatus } = {}) {
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
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
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

  forward(req, res, target, headers, address, {
    onStatus: (status) => {
      if (status === 401) for (const name of used) accessTokens.delete(name);
      if (status >= 500) log("net.error", { host, status, secrets: [...used] });
    },
  });
}

// --- Demandes de secrets ------------------------------------------------------------------------

// La demande en cours (une à la fois). Elle est gardée dans le fichier du dot : un redémarrage du
// coffre ne la perd pas. Deux sortes :
//   - values : la personne envoie une valeur par secret ;
//   - extend : la personne répond oui ou non pour élargir les serveurs d'un secret existant.
let pending = null; // { id, type, fields, index, values, hosts, readOnly, purpose, names, created }
const PENDING_MINUTES = Number(process.env.VAULT_PENDING_MINUTES ?? 30);

async function telegram(method, params) {
  const token = vault.secrets[TELEGRAM_SECRET]?.value;
  if (!token || !Number.isInteger(OWNER)) throw new Error("Telegram n'est pas configuré dans le coffre");
  const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} : ${json.description}`);
  return json.result;
}

const telegramReady = () => !!vault.secrets[TELEGRAM_SECRET] && Number.isInteger(OWNER);
const notify = (text) => (telegramReady() ? telegram("sendMessage", { chat_id: OWNER, text }).catch(() => {}) : Promise.resolve());
const fileLabel = () => (DOT_FILE ? DOT_FILE : "le fichier .dot du dot");
const html = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Les lignes à coller dans le fichier, prêtes à remplir.
const yamlHost = (h) => (/^[a-z0-9.-]+(:\d+)?$/.test(h) ? h : `"${h}"`);
const yamlHosts = (hosts) => `[ ${hosts.map(yamlHost).join(", ")} ]`;
function yamlLines(request) {
  if (request.type === "extend") {
    return request.names.map((n) => `    ${n}: { …, hosts: ${yamlHosts([...new Set([...(vault.secrets[n]?.hosts ?? []), ...request.hosts])])} }`);
  }
  const width = Math.max(...request.fields.map((f) => f.name.length));
  return request.fields.map((f) => `    ${`${f.name}:`.padEnd(width + 1)} { value: "", hosts: ${yamlHosts(request.hosts)}${request.readOnly ? ", readOnly: true" : ""} }  # ${f.label}`);
}

// Prévient la personne sur Telegram (s'il est configuré). Ce n'est qu'une notification : elle
// répond depuis sa machine, avec ./dot secret ou en écrivant dans le fichier du dot.
function ask(resumed = false) {
  if (!telegramReady()) return Promise.resolve();
  const intro = resumed ? ["<i>(Le coffre a redémarré : la demande est toujours en cours.)</i>"] : [];
  const extend = pending.type === "extend";
  const lines = extend
    ? [
        "🔐 <b>Le dot demande d'élargir un accès.</b>",
        `Pour : ${html(pending.purpose)}`,
        `Secrets : ${html(pending.names.join(", "))}`,
        `Aujourd'hui autorisés vers : ${html([...new Set(pending.names.flatMap((n) => vault.secrets[n]?.hosts ?? []))].join(", "))}`,
        `Demandé en plus : ${html(pending.hosts.join(", "))}`,
      ]
    : [
        "🔐 <b>Le dot demande un accès.</b>",
        `Pour : ${html(pending.purpose)}`,
        `Secrets : ${html(pending.fields.map((f) => `${f.label} (${f.name})${vault.secrets[f.name] ? ", remplace la valeur enregistrée" : ""}`).join(" ; "))}`,
        `Envoyés uniquement à : ${html(pending.hosts.join(", "))}`,
        pending.readOnly ? "Lecture seule : oui" : "Lecture seule : non (lecture et écriture)",
      ];
  const how = [
    "",
    "<b>N'envoie aucune valeur ici</b> : cette conversation est lue par le dot. Pour répondre, au choix :",
    `1. sur ta machine : <code>${html(SECRET_COMMAND)}</code>${extend ? " (oui ou non)" : ""}`,
    extend
      ? `2. ou dans <code>${html(fileLabel())}</code>, sous <code>vault</code> → <code>secrets</code>, mets ces serveurs dans <code>hosts</code> :`
      : `2. ou dans <code>${html(fileLabel())}</code>, sous <code>vault</code> → <code>secrets</code>, colle ${pending.fields.length > 1 ? "ces lignes" : "cette ligne"} et remplis <code>value</code> :`,
    `<pre>${html(yamlLines(pending).join("\n"))}</pre>`,
    "Le coffre voit la modification tout seul, sans redémarrage.",
  ];
  return telegram("sendMessage", { chat_id: OWNER, text: [...intro, ...lines, ...how].join("\n"), parse_mode: "HTML" });
}

function tellDot(id, text) {
  try {
    mkdirSync(INBOX, { recursive: true });
    writeFileSync(join(INBOX, `coffre-${id}.txt`), `[message du coffre, pas de la personne]\n${text}\n`);
  } catch {}
}

// outcome : saved | cancelled | expired. byHand : la personne l'a fait elle-même dans le fichier.
async function finish(outcome, { byHand = false } = {}) {
  const request = pending;
  pending = null;
  const names = request.type === "extend" ? request.names : request.fields.map((f) => f.name);
  const how = byHand ? " (dans le fichier)" : "";
  if (outcome !== "saved") {
    save();
    const why = outcome === "expired" ? `sans réponse depuis ${PENDING_MINUTES} min` : "refusée par la personne";
    log(outcome === "expired" ? "secret.expired" : "secret.cancelled", { request: request.id, type: request.type, names });
    tellDot(request.id, `La demande (${request.type === "extend" ? "élargir" : "secrets"} ${names.join(", ")} — ${request.purpose}) est ${why}. Ne la répète pas sans que la personne te le demande.`);
    await telegram("sendMessage", { chat_id: OWNER, text: outcome === "expired" ? "Demande expirée : rien n'a été enregistré." : "Demande annulée : rien n'a été enregistré." }).catch(() => {});
    return;
  }
  if (request.type === "extend") {
    for (const name of names) {
      const secret = vault.secrets[name];
      if (secret) secret.hosts = [...new Set([...secret.hosts, ...request.hosts])];
    }
    save(byHand ? [] : names);
    log("secret.extended", { request: request.id, names, hosts: request.hosts, byHand: byHand || undefined });
    tellDot(request.id, `La personne a accepté : ${names.join(", ")} peuvent maintenant aussi aller vers ${request.hosts.join(", ")}.`);
    await telegram("sendMessage", { chat_id: OWNER, text: `✅ Accès élargi${how} : ${names.join(", ")} → ${request.hosts.join(", ")}.` }).catch(() => {});
    return;
  }
  // Les valeurs données par la machine ; celles écrites à la main sont déjà dans le fichier.
  const given = request.fields.filter((f) => f.name in request.values).map((f) => f.name);
  for (const name of given) {
    vault.secrets[name] = { value: request.values[name], hosts: request.hosts, ...(request.readOnly ? { readOnly: true } : {}) };
  }
  save(given);
  log("secret.saved", { request: request.id, names, hosts: request.hosts, readOnly: request.readOnly, byHand: request.byHand });
  tellDot(
    request.id,
    `Les secrets ${names.join(", ")} sont disponibles dans le coffre (pour ${request.hosts.join(", ")}${request.readOnly ? ", lecture seule" : ""}). Demande d'origine : ${request.purpose}. Utilise-les avec {{NOM}} dans tes requêtes par le coffre.`,
  );
  await telegram("sendMessage", { chat_id: OWNER, text: `✅ Enregistré dans le coffre${how} : ${names.join(", ")}.` }).catch(() => {});
}

const expired = () => pending && Date.now() - new Date(pending.created).getTime() > PENDING_MINUTES * 60_000;

// Une réponse de la personne à la demande en cours (depuis sa machine, par la porte d'administration).
// Renvoie ce qu'il faut lui dire ensuite.
async function answer(text) {
  if (!pending) return "Aucune demande en cours.";
  if (/^\/annuler\b/i.test(text)) {
    await finish("cancelled");
    return "Demande annulée : rien n'a été enregistré.";
  }
  if (pending.type === "extend") {
    if (/^(oui|o|yes|y|ok)\b/i.test(text)) {
      await finish("saved");
      return "Accès élargi.";
    }
    if (/^(non|n|no)\b/i.test(text)) {
      await finish("cancelled");
      return "Refusé : rien n'a changé.";
    }
    return "Réponds oui ou non (ou /annuler).";
  }
  pending.values[pending.fields[pending.index].name] = text;
  pending.index += 1;
  advance();
  if (pending.index < pending.fields.length) {
    save();
    return "Valeur reçue.";
  }
  const names = pending.fields.map((f) => f.name);
  await finish("saved");
  return `Enregistré dans le coffre : ${names.join(", ")}.`;
}

// La demande en cours, telle que la personne la voit (sans aucune valeur).
function question() {
  if (!pending) return null;
  if (pending.type === "extend") {
    return { id: pending.id, type: "extend", purpose: pending.purpose, names: pending.names, hosts: pending.hosts };
  }
  const field = pending.fields[pending.index];
  return { id: pending.id, type: "values", purpose: pending.purpose, hosts: pending.hosts, readOnly: pending.readOnly, step: `${pending.index + 1}/${pending.fields.length}`, name: field.name, label: field.label, replaces: !!vault.secrets[field.name] };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Pas de joker trop large : « *.example.com » oui, « * » ou « *.com » non.
const HOST = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$|^[a-z0-9-]+(\.[a-z0-9-]+)*:\d+$/;
const HOSTS_HELP = "hosts : les serveurs où ces secrets auront le droit d'aller (ex. *.example.com, api.example.com, host.docker.internal:8080)";

async function startRequest(res, request) {
  if (pending) {
    const what = pending.type === "extend" ? pending.names : pending.fields.map((f) => f.name);
    return reply(res, 409, `une demande est déjà en cours (${what.join(", ")}) : attends sa réponse`);
  }
  pending = { id: randomBytes(3).toString("hex"), created: new Date().toISOString(), ...request };
  try {
    await ask();
  } catch (error) {
    pending = null;
    return reply(res, 502, `message à la personne impossible : ${error.message}`);
  }
  save();
  log("secret.requested", { request: pending.id, type: pending.type, names: pending.names ?? pending.fields.map((f) => f.name), hosts: pending.hosts, readOnly: pending.readOnly, purpose: pending.purpose });
  return reply(res, 202, { id: pending.id, status: "demandé à la personne (prévenue sur Telegram, elle répond depuis sa machine) ; tu seras prévenu par ta boîte de dépôt" });
}

// Ce que le dot peut demander et consulter (jamais les valeurs).
async function control(req, res, path) {
  if (req.method === "GET" && path === "secrets") {
    const list = Object.entries(vault.secrets).filter(([, s]) => filled(s)).map(([name, s]) => ({ name, hosts: s.hosts, readOnly: !!s.readOnly, kind: s.oauth ? "oauth" : "valeur" }));
    const waiting = pending ? { id: pending.id, type: pending.type, names: pending.names ?? pending.fields.map((f) => f.name) } : null;
    return reply(res, 200, { secrets: list, pending: waiting });
  }
  if (req.method === "POST" && (path === "request" || path === "extend")) {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return reply(res, 400, "corps JSON attendu");
    }
    const hosts = (body.hosts ?? []).map((h) => String(h).toLowerCase().trim()).filter(Boolean);
    if (!hosts.length || hosts.some((h) => !HOST.test(h))) return reply(res, 400, HOSTS_HELP);
    if (!body.purpose) return reply(res, 400, "purpose : à quoi serviront ces secrets, en une phrase pour la personne");
    const purpose = String(body.purpose).slice(0, 300);

    if (path === "extend") {
      const names = (body.secrets ?? []).map((f) => (typeof f === "string" ? f : f?.name));
      const missing = names.filter((n) => !vault.secrets[n]);
      if (!names.length || missing.length) return reply(res, 400, `secrets : des noms de secrets existants${missing.length ? ` (inconnus : ${missing.join(", ")})` : ""}`);
      if (names.includes(TELEGRAM_SECRET)) return reply(res, 400, `${TELEGRAM_SECRET} ne s'élargit pas`);
      return startRequest(res, { type: "extend", names, hosts, purpose });
    }

    const fields = (body.secrets ?? []).map((f) => (typeof f === "string" ? { name: f, label: f } : { name: f?.name, label: f?.label || f?.name }));
    if (!fields.length || fields.some((f) => !NAME.test(String(f.name)))) return reply(res, 400, "secrets : une liste de noms en MAJUSCULES (ex. SERVICE_USER), chacun avec un label lisible");
    if (fields.some((f) => f.name === TELEGRAM_SECRET)) return reply(res, 400, `${TELEGRAM_SECRET} ne se demande pas par Telegram`);
    return startRequest(res, { type: "values", fields, index: 0, values: {}, hosts, readOnly: body.readOnly !== false, purpose });
  }
  if (req.method === "POST" && path === "mail") return mail(req, res);
  return reply(res, 404, "GET /_vault/secrets, POST /_vault/request, POST /_vault/extend, POST /_vault/mail");
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
        'Élargir un secret à d\'autres serveurs : POST http://dot-vault:8080/_vault/extend {"secrets": ["NOM"], "hosts": ["…"], "purpose": "…"}',
        'Lire des mails (IMAP, lecture seule) : POST http://dot-vault:8080/_vault/mail',
        '  {"server": "imap.example.com:993", "user": "{{MAIL_USER}}", "password": "{{MAIL_PASSWORD}}", "action": "folders|search|fetch",',
        '   "folder": "INBOX", "query": {"since": "2026-10-23", "from": "…", "subject": "…", "text": "…", "unseen": true}, "limit": 20, "uids": [123]}',
        '  {"secrets": [{"name": "SERVICE_USER", "label": "Identifiant du service"}], "hosts": ["*.example.com"], "readOnly": true, "purpose": "…"}',
        "",
        "Secrets disponibles :",
        ...Object.entries(vault.secrets).filter(([, s]) => filled(s)).map(([n, s]) => `- ${n} → ${s.hosts.join(", ")}${s.readOnly ? " (lecture seule)" : ""}`),
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
server.listen(PORT, "0.0.0.0", () => {
  log("vault.start", { port: PORT, secrets: Object.keys(vault.secrets), allow: vault.allow, pending: pending?.id });
  // Une demande en cours avant le redémarrage : on la reprend (ou on la clôt si elle a expiré).
  if (pending) (expired() ? finish("expired") : ask(true)).catch(() => {});
});
setInterval(() => expired() && finish("expired").catch(() => {}), 60_000).unref();
// La personne peut écrire dans le fichier à tout moment : il est relu dès qu'il change.
setInterval(() => reload().catch((error) => log("vault.config.error", { error: error.message })), Number(process.env.VAULT_RELOAD_MS ?? 2000)).unref();

// Porte d'administration, pour la personne depuis sa machine (./dot chat, ./dot secret) : elle
// n'écoute que sur l'interface interne du coffre, que le dot ne peut pas joindre. La machine y
// accède en entrant dans le conteneur du coffre. Une réponse n'y passe jamais par les fichiers du dot.
const ADMIN_PORT = Number(process.env.VAULT_ADMIN_PORT ?? 8081);
http
  .createServer(async (req, res) => {
    try {
      if (expired()) await finish("expired");
      if (req.method === "GET" && req.url === "/pending") return reply(res, 200, { pending: question() });
      if (req.method === "POST" && req.url === "/answer") {
        const body = await readBody(req);
        if (!pending || body.id !== pending.id) return reply(res, 409, { message: "Cette demande n'est plus en cours.", pending: question() });
        const message = await answer(String(body.text ?? "").trim());
        return reply(res, 200, { message, pending: question() });
      }
      return reply(res, 404, "GET /pending, POST /answer");
    } catch (error) {
      reply(res, 500, error.message);
    }
  })
  .listen(ADMIN_PORT, "127.0.0.1");

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => (log("vault.stop"), process.exit(0)));
