// Le fichier d'un dot : <nom>.dot, en YAML.
//
//   ---
//   name: travail
//   description: Ce que fait ce dot, en une ou deux phrases.
//   onclic: chat      (double-clic : le dot est lancé, puis chat = la conversation ; none = rien de plus)
//   ---
//   env:     ses réglages (variables d'environnement du dot)
//   model:   ses providers pour pi (l'ancien models.json)
//   vault:   ses secrets (lus et écrits par le coffre seul)
//
// Ce module sert au coffre (lire et mettre à jour `vault` en gardant les commentaires) et à la
// machine (extraire `env` et `model` pour le dot, qui ne voit jamais ce fichier).
//
//   node dotfile.mjs extract <fichier.dot> <dossier>   → env, models.json, meta.json
//   node dotfile.mjs secret <fichier.dot> NOM           → la valeur d'un secret (pour le veilleur)
//   node dotfile.mjs new <fichier.dot> <nom> [description]
//   node dotfile.mjs blank <source.dot> <cible.dot> <nom>   → copie vierge : autre nom, sans Telegram
//   node dotfile.mjs convert <.env> <models.json> <vault.json> <cible.dot> <nom>   → ancien format

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(process.env.DOT_NODE_MODULES ?? "/usr/local/lib/node_modules/");
const YAML = require("yaml");

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
// Ce qui ne doit jamais être dans env : le dot le verrait.
const SECRET_LIKE = /(API_KEY|TOKEN|SECRET|PASSWORD)/;

export function parse(text) {
  const docs = YAML.parseAllDocuments(text);
  if (docs.length !== 2) throw new Error("un fichier .dot a deux parties : l'en-tête (name, description) puis env, model, vault");
  for (const d of docs) if (d.errors.length) throw new Error(`YAML invalide : ${d.errors[0].message}`);
  const meta = docs[0].toJS() ?? {};
  if (!NAME.test(String(meta.name ?? ""))) throw new Error(`name invalide : « ${meta.name} » (minuscules, chiffres et tirets)`);
  return { meta, body: docs[1] };
}

export const read = (file) => parse(readFileSync(file, "utf8"));

function serialize(head, body) {
  // Un document relu garde son marqueur « --- » : on ne le répète pas.
  return `---\n${YAML.stringify(head, { lineWidth: 0 }).trimEnd()}\n---\n${body.toString({ lineWidth: 0 }).replace(/^---\n/, "")}`;
}

// Le coffre : son nœud vault, en objet.
export function readVault(file) {
  const vault = read(file).body.toJS()?.vault ?? {};
  return { secrets: vault.secrets ?? {}, allow: vault.allow ?? [], _pending: vault._pending };
}

// Le coffre écrit ses changements secret par secret : le reste du fichier (en-tête, env, model,
// commentaires, ordre) ne bouge pas.
export function writeVault(file, vault) {
  const text = readFileSync(file, "utf8");
  const docs = YAML.parseAllDocuments(text);
  const body = docs[1];
  const current = body.toJS()?.vault?.secrets ?? {};
  for (const name of Object.keys(current)) if (!(name in vault.secrets)) body.deleteIn(["vault", "secrets", name]);
  for (const [name, secret] of Object.entries(vault.secrets)) {
    if (JSON.stringify(current[name]) !== JSON.stringify(secret)) body.setIn(["vault", "secrets", name], body.createNode(secret, { flow: true }));
  }
  if (JSON.stringify(body.getIn(["vault", "allow"])?.toJSON?.() ?? []) !== JSON.stringify(vault.allow ?? [])) body.setIn(["vault", "allow"], vault.allow ?? []);
  if (vault._pending) body.setIn(["vault", "_pending"], vault._pending);
  else if (body.hasIn(["vault", "_pending"])) body.deleteIn(["vault", "_pending"]);
  // L'en-tête est recopié tel quel (de la première ligne --- à la seconde).
  const head = /^---\n[\s\S]*?\n---\n/.exec(text)?.[0] ?? "---\n---\n";
  const out = head + body.toString({ lineWidth: 0 }).replace(/^---\n/, "");
  // En place (le fichier est monté seul dans le coffre : pas de renommage possible).
  writeFileSync(file, out);
}

export function extract(file, dir) {
  const { meta, body } = read(file);
  const data = body.toJS() ?? {};
  const env = data.env ?? {};
  const leaks = Object.keys(env).filter((k) => SECRET_LIKE.test(k) && String(env[k] ?? "") !== "");
  if (leaks.length) throw new Error(`ces réglages ressemblent à des secrets : ${leaks.join(", ")}. Le dot les verrait : mets-les dans vault.`);
  const model = JSON.stringify(data.model ?? {});
  if (/"apiKey"\s*:\s*"(sk-|[A-Za-z0-9_-]{24,})/.test(model)) throw new Error("model contient une clé d'API en clair : mets-la dans vault et écris apiKey: \"{{NOM}}\".");
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v === null || v === undefined ? "" : String(v).replace(/\n/g, " ")}`);
  writeFileSync(join(dir, "env"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "models.json"), JSON.stringify(data.model ?? { providers: {} }, null, 2) + "\n");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ name: meta.name, description: meta.description ?? "", onclic: meta.onclic ?? "chat" }) + "\n");
}

const TEMPLATE = (name, description) => `---
name: ${name}
description: ${description || "Ce que fait ce dot, en une ou deux phrases."}
onclic: chat      # double-clic sur ce fichier : le dot est lancé, puis chat (la conversation) ou none
---
# Réglages du dot : il les reçoit comme variables d'environnement. Aucun secret ici (voir vault).
env:
  DOT_PROVIDER: local
  DOT_MODEL: mon-modele
  DOT_THINKING: medium
  DOT_INTERFACE: tui          # tui (terminal, dot attach) ou rpc (socket, dot rpc)
  TELEGRAM_OWNER_ID: ""       # ton identifiant Telegram ; vide : pas de Telegram
  DOT_RECHECK_MINUTES: 60
  DOT_RUN_MINUTES: 30
  DOT_MAX_RUNS: 3
  DOT_MEMORY: 8g
  DOT_CPUS: 4
  DOT_PIDS: 2048
  TZ: Europe/Paris

# Les providers de pi (facultatif). baseUrl passe par le coffre, apiKey est un {{NOM}} du vault.
model:
  providers:
    local:
      baseUrl: http://dot-vault:8080/http/host.docker.internal:8080/v1
      api: openai-completions
      apiKey: "{{MODEL_KEY}}"
      models:
        - id: mon-modele
          name: Mon modèle local
          reasoning: true
          input: [text]
          contextWindow: 131072
          maxTokens: 32768

# Les secrets : lus par le coffre seul. hosts : les seuls serveurs où chacun a le droit d'aller.
vault:
  secrets:
    MODEL_KEY: { value: "", hosts: [host.docker.internal:8080] }
  allow: []
`;

function blank(src, dst, name) {
  const text = readFileSync(src, "utf8");
  const docs = YAML.parseAllDocuments(text);
  const head = docs[0].toJS() ?? {};
  head.name = name;
  if (docs[1].hasIn(["env", "TELEGRAM_OWNER_ID"])) docs[1].setIn(["env", "TELEGRAM_OWNER_ID"], "");
  writeFileSync(dst, serialize(head, docs[1]), { mode: 0o600 });
}

function convert(envFile, modelsFile, vaultFile, dst, name) {
  const env = {};
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  let model = null;
  try {
    model = JSON.parse(readFileSync(modelsFile, "utf8"));
  } catch {}
  const vault = JSON.parse(readFileSync(vaultFile, "utf8"));
  const body = new YAML.Document({ env, ...(model ? { model } : {}), vault });
  body.commentBefore = null;
  for (const name of Object.keys(vault.secrets ?? {})) {
    const node = body.getIn(["vault", "secrets", name], true);
    if (node) node.flow = true;
  }
  writeFileSync(dst, serialize({ name, description: "Ce que fait ce dot, en une ou deux phrases.", onclic: "chat" }, body), { mode: 0o600 });
}

// --- Ligne de commande ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "extract") extract(args[0], args[1]);
    else if (command === "secret") process.stdout.write(String(readVault(args[0]).secrets?.[args[1]]?.value ?? ""));
    else if (command === "new") {
      if (!NAME.test(args[1] ?? "")) throw new Error("nom invalide (minuscules, chiffres et tirets)");
      writeFileSync(args[0], TEMPLATE(args[1], args.slice(2).join(" ")), { mode: 0o600, flag: "wx" });
    } else if (command === "blank") blank(args[0], args[1], args[2]);
    else if (command === "convert") convert(args[0], args[1], args[2], args[3], args[4]);
    else throw new Error("commandes : extract, secret, new, blank, convert");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
