// Le coffre, de bout en bout : un vrai coffre, un faux service et un faux Telegram, en local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = process.env.DOT_SRC ?? "/src";
const dir = mkdtempSync(join(tmpdir(), "dot-vault-"));
const CONFIG = join(dir, "vault.json");
const INBOX = join(dir, "inbox");
const OWNER = 42;

// --- Faux service : renvoie ce qu'il reçoit ---
let servicePort;
const service = http.createServer((req, res) => res.end(JSON.stringify({ method: req.method, url: req.url, auth: req.headers.authorization ?? null })));

// --- Faux Telegram : garde les messages envoyés, renvoie les mises à jour qu'on lui donne ---
let telegramPort;
const sent = [];
const deleted = [];
let updates = [];
const telegram = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const params = body ? JSON.parse(body) : {};
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/sendMessage")) sent.push(params.text);
    if (req.url.endsWith("/deleteMessage")) deleted.push(params.message_id);
    if (req.url.endsWith("/getUpdates")) {
      const result = updates;
      updates = [];
      return res.end(JSON.stringify({ ok: true, result }));
    }
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});

let vault;
let vaultPort;
const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));

before(async () => {
  servicePort = await listen(service);
  telegramPort = await listen(telegram);
  vaultPort = 20000 + Math.floor(Math.random() * 20000);
  writeFileSync(
    CONFIG,
    JSON.stringify({
      secrets: {
        KEY: { value: "s3cret-key", hosts: [`127.0.0.1:${servicePort}`] },
        USER: { value: "moi", hosts: [`127.0.0.1:${servicePort}`], readOnly: true },
        PASS: { value: "mdp", hosts: [`127.0.0.1:${servicePort}`], readOnly: true },
        ELSEWHERE: { value: "x", hosts: ["*.example.com"] },
        TELEGRAM_TOKEN: { value: "tg-token", hosts: [`127.0.0.1:${telegramPort}`] },
      },
      allow: [],
    }),
  );
  vault = spawn(process.execPath, [`${src}/vault/vault.mjs`], {
    env: { ...process.env, VAULT_CONFIG: CONFIG, VAULT_LOGS: join(dir, "logs"), VAULT_INBOX: INBOX, VAULT_PORT: String(vaultPort), TELEGRAM_OWNER_ID: String(OWNER), VAULT_TELEGRAM_API: `http://127.0.0.1:${telegramPort}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${vaultPort}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("le coffre ne démarre pas");
});

after(() => {
  vault?.kill();
  service.close();
  telegram.close();
});

const call = (path, init = {}) => fetch(`http://127.0.0.1:${vaultPort}${path}`, init);
const svc = (path) => `/http/127.0.0.1:${servicePort}${path}`;

test("les marqueurs sont remplacés dans les en-têtes et l'adresse", async () => {
  const a = await (await call(svc("/v1"), { headers: { authorization: "Bearer {{KEY}}" } })).json();
  assert.equal(a.auth, "Bearer s3cret-key");
  const b = await (await call(svc("/bot%7B%7BKEY%7D%7D/x"))).json();
  assert.equal(b.url, "/bots3cret-key/x");
  const c = await (await call(svc("/"), { method: "PROPFIND", headers: { authorization: "Basic {{basic:USER:PASS}}" } })).json();
  assert.equal(c.auth, `Basic ${Buffer.from("moi:mdp").toString("base64")}`);
});

test("un secret ne part que vers ses serveurs", async () => {
  const res = await call(svc("/"), { headers: { authorization: "Bearer {{ELSEWHERE}}" } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /n'a pas le droit d'aller/);
});

test("un secret en lecture seule refuse une écriture", async () => {
  assert.equal((await call(svc("/x"), { method: "PUT", body: "x", headers: { authorization: "Basic {{basic:USER:PASS}}" } })).status, 403);
  assert.equal((await call(svc("/x"), { method: "DELETE", headers: { authorization: "Basic {{basic:USER:PASS}}" } })).status, 403);
});

test("un secret inconnu est signalé, une adresse privée sans secret est refusée", async () => {
  assert.equal((await call(svc("/"), { headers: { authorization: "Bearer {{NOPE}}" } })).status, 400);
  assert.equal((await call(svc("/"))).status, 403);
});

test("la liste des secrets ne montre jamais les valeurs", async () => {
  const text = await (await call("/_vault/secrets")).text();
  assert.match(text, /"KEY"/);
  assert.doesNotMatch(text, /s3cret-key|mdp|tg-token/);
});

test("une demande mal formée est refusée", async () => {
  const ask = (body) => call("/_vault/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await ask({ secrets: [{ name: "minuscule" }], hosts: ["a.example.com"], purpose: "x" })).status, 400);
  assert.equal((await ask({ secrets: [{ name: "OK_NAME" }], hosts: ["*"], purpose: "x" })).status, 400);
  assert.equal((await ask({ secrets: [{ name: "OK_NAME" }], hosts: ["*.com"], purpose: "x" })).status, 400);
  assert.equal((await ask({ secrets: [{ name: "OK_NAME" }], hosts: ["a.example.com"] })).status, 400);
  assert.equal((await ask({ secrets: [{ name: "TELEGRAM_TOKEN" }], hosts: ["a.example.com"], purpose: "x" })).status, 400);
});

// La lecture des messages par le dot, à travers le coffre.
const poll = async () => (await call(`/http/127.0.0.1:${telegramPort}/bot{{TELEGRAM_TOKEN}}/getUpdates`, { method: "POST", body: "{}" })).json();
const fromOwner = (id, text) => ({ update_id: id, message: { message_id: 100 + id, chat: { id: OWNER, type: "private" }, from: { id: OWNER }, text } });

test("demande de secret : la réponse est interceptée, enregistrée, effacée, et le dot prévenu", async () => {
  const res = await call("/_vault/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secrets: [{ name: "NEW_USER", label: "Identifiant" }, { name: "NEW_PASS", label: "Mot de passe" }], hosts: ["api.example.com"], readOnly: true, purpose: "test" }),
  });
  assert.equal(res.status, 202);
  assert.match(sent.at(-1), /api\.example\.com/);
  assert.match(sent.at(-1), /Identifiant/);

  // Une deuxième demande en même temps est refusée.
  assert.equal((await call("/_vault/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["OTHER"], hosts: ["a.example.com"], purpose: "x" }) })).status, 409);

  updates = [fromOwner(1, "alice")];
  const first = await poll();
  assert.equal(first.result[0].update_id, 1);
  assert.equal(first.result[0].message, undefined, "le dot ne doit pas voir la réponse");
  assert.match(sent.at(-1), /Mot de passe/);

  updates = [fromOwner(2, "p4ss")];
  const second = await poll();
  assert.equal(second.result[0].message, undefined);
  await new Promise((r) => setTimeout(r, 200));

  assert.deepEqual(deleted.slice(-2), [101, 102], "les messages sont effacés du fil");
  const saved = JSON.parse(readFileSync(CONFIG, "utf8")).secrets;
  assert.equal(saved.NEW_USER.value, "alice");
  assert.equal(saved.NEW_PASS.value, "p4ss");
  assert.deepEqual(saved.NEW_PASS.hosts, ["api.example.com"]);
  assert.equal(saved.NEW_PASS.readOnly, true);
  assert.match(sent.at(-1), /Enregistré/);
  const notes = readdirSync(INBOX).map((f) => readFileSync(join(INBOX, f), "utf8")).join("\n");
  assert.match(notes, /NEW_USER/);
  assert.doesNotMatch(notes, /alice|p4ss/, "la note au dot ne contient pas les valeurs");
});

test("hors demande, les messages arrivent normalement au dot", async () => {
  updates = [fromOwner(3, "bonjour")];
  assert.equal((await poll()).result[0].message.text, "bonjour");
});

test("/annuler annule la demande sans rien enregistrer", async () => {
  await call("/_vault/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["CANCELLED"], hosts: ["a.example.com"], purpose: "x" }) });
  updates = [fromOwner(4, "/annuler")];
  assert.equal((await poll()).result[0].message, undefined);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(JSON.parse(readFileSync(CONFIG, "utf8")).secrets.CANCELLED, undefined);
  assert.match(sent.at(-1), /annulée/);
});

test("élargir un secret : oui ajoute le serveur, et rien ne fuit vers le dot", async () => {
  const res = await call("/_vault/extend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["KEY"], hosts: ["api.example.com"], purpose: "autre serveur du service" }) });
  assert.equal(res.status, 202);
  assert.match(sent.at(-1), /oui ou non/);
  updates = [fromOwner(5, "peut-être")];
  assert.equal((await poll()).result[0].message, undefined);
  assert.match(sent.at(-1), /oui ou non/);
  updates = [fromOwner(6, "oui")];
  await poll();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(JSON.parse(readFileSync(CONFIG, "utf8")).secrets.KEY.hosts, [`127.0.0.1:${servicePort}`, "api.example.com"]);
  assert.match(sent.at(-1), /élargi/);
});

test("élargir un secret inconnu est refusé ; non n'ajoute rien", async () => {
  assert.equal((await call("/_vault/extend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["NOPE"], hosts: ["a.example.com"], purpose: "x" }) })).status, 400);
  await call("/_vault/extend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["USER"], hosts: ["b.example.com"], purpose: "x" }) });
  updates = [fromOwner(7, "non")];
  await poll();
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!JSON.parse(readFileSync(CONFIG, "utf8")).secrets.USER.hosts.includes("b.example.com"));
});

test("pendant une demande, les commandes du bot passent au dot", async () => {
  await call("/_vault/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["CMD_TEST"], hosts: ["a.example.com"], purpose: "x" }) });
  updates = [fromOwner(8, "/status")];
  assert.equal((await poll()).result[0].message.text, "/status");
  updates = [fromOwner(9, "/annuler")];
  await poll();
  await new Promise((r) => setTimeout(r, 200));
});

test("une demande en cours survit à un redémarrage du coffre", async () => {
  await call("/_vault/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secrets: ["PERSIST_A", "PERSIST_B"], hosts: ["a.example.com"], purpose: "redémarrage" }) });
  updates = [fromOwner(10, "valeur-a")];
  await poll();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(JSON.parse(readFileSync(CONFIG, "utf8"))._pending.index, 1);
  // Redémarrage : nouveau coffre sur le même fichier.
  vault.kill();
  await new Promise((r) => setTimeout(r, 300));
  vault = spawn(process.execPath, [`${src}/vault/vault.mjs`], {
    env: { ...process.env, VAULT_CONFIG: CONFIG, VAULT_LOGS: join(dir, "logs"), VAULT_INBOX: INBOX, VAULT_PORT: String(vaultPort), TELEGRAM_OWNER_ID: String(OWNER), VAULT_TELEGRAM_API: `http://127.0.0.1:${telegramPort}` },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      await fetch(`http://127.0.0.1:${vaultPort}/`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.match(sent.at(-1), /redémarré/);
  updates = [fromOwner(11, "valeur-b")];
  await poll();
  await new Promise((r) => setTimeout(r, 200));
  const saved = JSON.parse(readFileSync(CONFIG, "utf8"));
  assert.equal(saved.secrets.PERSIST_A.value, "valeur-a");
  assert.equal(saved.secrets.PERSIST_B.value, "valeur-b");
  assert.equal(saved._pending, undefined);
});
