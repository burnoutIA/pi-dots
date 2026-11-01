// La file d'attente des appels au modèle (coffre) : un à la fois, la conversation d'abord.
import { test } from "node:test";
import assert from "node:assert/strict";

const src = process.env.DOT_SRC ?? "/src";
const { createGate } = await import(`${src}/vault/gate.mjs`);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("un appel à la fois, et la conversation passe devant les runs qui attendent", async () => {
  const gate = createGate({ graceMs: 0 });
  const order = [];
  const first = await gate.acquire("worker").promise;
  const run2 = gate.acquire("worker").promise.then((t) => (order.push("run2"), t));
  const talk = gate.acquire("conversation").promise.then((t) => (order.push("conversation"), t));
  await tick();
  assert.deepEqual(order, [], "la place est prise");
  first.release();
  (await talk).release();
  (await run2).release();
  assert.deepEqual(order, ["conversation", "run2"]);
});

test("juste après un appel de la conversation, un run attend la suite du tour", async () => {
  const gate = createGate({ graceMs: 150 });
  const talk = await gate.acquire("conversation").promise;
  let ran = false;
  const run = gate.acquire("worker").promise.then((t) => ((ran = true), t));
  talk.release();
  await tick(50);
  assert.equal(ran, false, "le run attend : la conversation va sans doute reprendre la main");
  const next = await gate.acquire("conversation").promise; // l'appel suivant du même tour passe tout de suite
  assert.equal(ran, false);
  next.release();
  const t = await run;
  assert.ok(t.waitedMs >= 140, `le run est passé après le délai (${t.waitedMs} ms)`);
  t.release();
});

test("un appel abandonné quitte la file ; un appel bloqué rend sa place", async () => {
  let expired = 0;
  const gate = createGate({ graceMs: 0, holdMs: 100, onHoldExpired: () => (expired += 1) });
  await gate.acquire("worker").promise; // jamais relâché
  const gone = gate.acquire("worker");
  gone.cancel();
  const later = await gate.acquire("conversation").promise;
  assert.equal(expired, 1, "la place est rendue au bout de holdMs");
  assert.deepEqual(gate.state().waiting, [], "l'appel abandonné n'est plus dans la file");
  later.release();
  later.release(); // deux fois : sans effet
  assert.equal(gate.state().busy, 0);
});
