// La découverte des modèles au démarrage : un faux serveur compatible OpenAI.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const src = process.env.DOT_SRC ?? "/src";
const { discover, tagRole } = await import(`${src}/discover-models.mjs`);

let auth = null;
const server = http.createServer((req, res) => {
  auth = req.headers.authorization ?? null;
  if (req.url === "/down/v1/models") return res.writeHead(503).end();
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      object: "list",
      data: [
        { id: "declare", meta: { name: "Nom du serveur", context: 50000 } },
        { id: "vision", meta: { name: "Modèle vision", context: 100000, vision: true } },
        { id: "nu" }, // un serveur qui ne donne que l'id
      ],
    }),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const declared = { id: "declare", name: "Mon nom", reasoning: true, input: ["text"], contextWindow: 8000, maxTokens: 4000 };

test("les modèles du serveur s'ajoutent, les déclarés gardent leur réglage", async () => {
  const config = { providers: { local: { baseUrl: `${base}/v1`, api: "openai-completions", apiKey: "{{MODEL_KEY}}", models: [declared] } } };
  const [r] = await discover(config);
  assert.deepEqual(r, { provider: "local", declared: 1, added: 2 });
  assert.equal(auth, "Bearer {{MODEL_KEY}}", "la clé part en marqueur : le coffre la remplit");
  const [first, vision, nu] = config.providers.local.models;
  assert.deepEqual(first, declared);
  assert.deepEqual([vision.name, vision.contextWindow, vision.input, vision.maxTokens], ["Modèle vision", 100000, ["text", "image"], 4000]);
  assert.deepEqual([nu.name, nu.contextWindow, nu.input], ["nu", 8000, ["text"]], "sans infos : celles du premier modèle déclaré");
});

test("serveur indisponible ou discover: false : la liste déclarée reste", async () => {
  const down = { providers: { local: { baseUrl: `${base}/down/v1`, api: "openai-completions", models: [declared] } } };
  const [r] = await discover(down);
  assert.match(r.error, /503/);
  assert.equal(down.providers.local.models.length, 1);
  const off = { providers: { local: { baseUrl: `${base}/v1`, api: "openai-completions", discover: false, models: [declared] } } };
  assert.deepEqual(await discover(off), []);
  assert.equal(off.providers.local.models.length, 1);
  assert.equal("discover" in off.providers.local, false, "l'option du dot ne part pas chez pi");
});

test("les fournisseurs qui passent par le coffre portent le rôle de l'appelant", () => {
  const config = {
    providers: {
      local: { baseUrl: "http://dot-vault:8080/http/host.docker.internal:4747/v1", models: [] },
      perso: { baseUrl: "http://dot-vault:8080/https/api.example.com/v1", headers: { "x-dot-role": "fixe", "x-autre": "1" }, models: [] },
      ailleurs: { baseUrl: "https://api.example.com/v1", models: [] },
    },
  };
  tagRole(config, "http://dot-vault:8080");
  assert.deepEqual(config.providers.local.headers, { "x-dot-role": "${DOT_ROLE}" });
  assert.deepEqual(config.providers.perso.headers, { "x-dot-role": "fixe", "x-autre": "1" }, "un en-tête déclaré à la main est gardé");
  assert.equal(config.providers.ailleurs.headers, undefined);
});
