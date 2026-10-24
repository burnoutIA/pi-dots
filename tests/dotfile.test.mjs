// Le fichier d'un dot (<nom>.dot) : lecture, extraction pour le dot, copie vierge, garde-fous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const src = process.env.DOT_SRC ?? "/src";
const lib = await import(`${src}/dotfile.mjs`);
const dir = mkdtempSync(join(tmpdir(), "dotfile-"));
const cli = (...args) => execFileSync(process.execPath, [`${src}/dotfile.mjs`, ...args], { encoding: "utf8" });

const sample = `---
name: travail
description: Mon assistant de travail.
---
# réglages
env:
  DOT_INTERFACE: rpc
  TELEGRAM_OWNER_ID: "42"
model:
  providers:
    local: { baseUrl: "http://dot-vault:8080/http/h:1/v1", apiKey: "{{MODEL_KEY}}" }
vault:
  secrets:
    MODEL_KEY: { value: sk-abc, hosts: [h:1] }
  allow: []
`;

test("un fichier .dot se lit : en-tête, env, model, vault", () => {
  const { meta, body } = lib.parse(sample);
  assert.equal(meta.name, "travail");
  assert.equal(body.toJS().env.DOT_INTERFACE, "rpc");
  assert.equal(lib.parse(sample).body.toJS().vault.secrets.MODEL_KEY.value, "sk-abc");
});

test("extract : le dot reçoit env et model, jamais le vault", () => {
  const f = join(dir, "travail.dot");
  writeFileSync(f, sample);
  lib.extract(f, join(dir, "run"));
  const env = readFileSync(join(dir, "run", "env"), "utf8");
  assert.match(env, /^DOT_INTERFACE=rpc$/m);
  assert.match(env, /^TELEGRAM_OWNER_ID=42$/m);
  const models = readFileSync(join(dir, "run", "models.json"), "utf8");
  assert.match(models, /\{\{MODEL_KEY\}\}/);
  assert.doesNotMatch(env + models, /sk-abc/, "aucune valeur secrète ne sort");
});

test("extract refuse un secret dans env ou une clé en clair dans model", () => {
  const leak = join(dir, "fuite.dot");
  writeFileSync(leak, sample.replace("DOT_INTERFACE: rpc", "OPENAI_API_KEY: sk-oups"));
  assert.throws(() => lib.extract(leak, join(dir, "run2")), /ressemblent à des secrets/);
  writeFileSync(leak, sample.replace('apiKey: "{{MODEL_KEY}}"', 'apiKey: "sk-abcdefghijklmnopqrstuvwxyz"'));
  assert.throws(() => lib.extract(leak, join(dir, "run3")), /clé d'API en clair/);
});

test("un nom invalide est refusé", () => {
  assert.throws(() => lib.parse(sample.replace("name: travail", "name: Pas Bon")), /name invalide/);
});

test("new : un fichier modèle valide, sans écraser un fichier existant", () => {
  const f = join(dir, "neuf.dot");
  cli("new", f, "neuf", "Un", "dot", "neuf");
  const { meta } = lib.read(f);
  assert.equal(meta.name, "neuf");
  assert.equal(meta.description, "Un dot neuf");
  assert.throws(() => cli("new", f, "neuf"));
});

test("blank : copie vierge, autre nom, sans Telegram, commentaires et secrets gardés", () => {
  const from = join(dir, "source.dot");
  writeFileSync(from, sample);
  const to = join(dir, "copie.dot");
  cli("blank", from, to, "copie");
  const text = readFileSync(to, "utf8");
  const { meta, body } = lib.read(to);
  assert.equal(meta.name, "copie");
  assert.equal(body.toJS().env.TELEGRAM_OWNER_ID, "");
  assert.equal(body.toJS().vault.secrets.MODEL_KEY.value, "sk-abc");
  assert.match(text, /# réglages/);
});

test("onclic : présent dans un nouveau fichier, transmis à la machine (chat par défaut)", () => {
  const f = join(dir, "clic.dot");
  cli("new", f, "clic");
  assert.equal(lib.read(f).meta.onclic, "chat");
  lib.extract(f, join(dir, "run-clic"));
  assert.equal(JSON.parse(readFileSync(join(dir, "run-clic", "meta.json"), "utf8")).onclic, "chat");
  const g = join(dir, "sans.dot");
  writeFileSync(g, sample);
  lib.extract(g, join(dir, "run-sans"));
  assert.equal(JSON.parse(readFileSync(join(dir, "run-sans", "meta.json"), "utf8")).onclic, "chat");
});
