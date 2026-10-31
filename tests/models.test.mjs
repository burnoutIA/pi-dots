// La découverte des modèles au démarrage : un faux serveur compatible OpenAI.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const src = process.env.DOT_SRC ?? "/src";
const { discover } = await import(`${src}/discover-models.mjs`);

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
