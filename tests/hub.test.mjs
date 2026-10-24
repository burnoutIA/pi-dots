// Le hub RPC, avec un faux pi : routage des réponses, diffusion des événements, demandes à l'interface.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const src = process.env.DOT_SRC ?? "/src";
const dir = mkdtempSync(join(tmpdir(), "dot-hub-"));
const SOCKET = join(dir, "rpc.sock");
const SEEN = join(dir, "seen.jsonl"); // ce que le faux pi a reçu

// Faux pi : répond aux commandes, émet un événement après chaque prompt, et pose une question à
// l'interface au démarrage (avant tout client) puis sur la commande ask_ui.
const FAKE = join(dir, "fake-pi.mjs");
writeFileSync(
  FAKE,
  `import { appendFileSync } from "node:fs";
const out = (r) => process.stdout.write(JSON.stringify(r) + "\\n");
setTimeout(() => out({ type: "extension_ui_request", id: "ui-boot", method: "confirm", title: "?" }), 200);
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const r = JSON.parse(line);
    appendFileSync(${JSON.stringify(SEEN)}, line + "\\n");
    if (r.type === "prompt") { out({ id: r.id, type: "response", command: "prompt", success: true }); out({ type: "agent_settled" }); }
    if (r.type === "ask_ui") out({ type: "extension_ui_request", id: "ui-2", method: "confirm", title: "Vraiment ?" });
  }
});`,
);

let hub;
before(async () => {
  hub = spawn(process.execPath, [`${src}/hub.mjs`], {
    env: { ...process.env, DOT_HOME: dir, HUB_SOCKET: SOCKET, HUB_CWD: dir, HUB_PI_CMD: JSON.stringify([process.execPath, FAKE]) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50 && !existsSync(SOCKET); i += 1) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 600)); // le temps que la question de démarrage soit tranchée
});
after(() => hub?.kill("SIGTERM"));

function client() {
  const socket = net.connect(SOCKET);
  const records = [];
  let buf = "";
  socket.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      records.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  return {
    records,
    send: (r) => socket.write(JSON.stringify(r) + "\n"),
    close: () => socket.end(),
    ready: new Promise((r) => socket.on("connect", r)),
  };
}
const seen = () => readFileSync(SEEN, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const pause = (ms = 300) => new Promise((r) => setTimeout(r, ms));

test("sans client, une demande à l'interface est annulée : pi n'attend pas", () => {
  const answer = seen().find((r) => r.id === "ui-boot");
  assert.deepEqual(answer, { type: "extension_ui_response", id: "ui-boot", cancelled: true });
});

test("chaque client reçoit seulement ses réponses, avec son id ; les événements vont à tous", async () => {
  const a = client();
  const b = client();
  await Promise.all([a.ready, b.ready]);
  a.send({ id: "1", type: "prompt", message: "de a" });
  b.send({ id: "1", type: "prompt", message: "de b" });
  await pause();
  assert.equal(a.records.filter((r) => r.type === "response").length, 1);
  assert.equal(b.records.filter((r) => r.type === "response").length, 1);
  assert.equal(a.records.find((r) => r.type === "response").id, "1");
  assert.equal(a.records.filter((r) => r.type === "agent_settled").length, 2, "les événements des deux prompts arrivent à a");
  assert.equal(b.records.filter((r) => r.type === "agent_settled").length, 2);
  a.close();
  b.close();
});

test("une demande à l'interface va à tous ; la première réponse l'emporte", async () => {
  const a = client();
  const b = client();
  await Promise.all([a.ready, b.ready]);
  a.send({ type: "ask_ui" });
  await pause();
  assert.ok(a.records.some((r) => r.type === "extension_ui_request" && r.id === "ui-2"));
  assert.ok(b.records.some((r) => r.type === "extension_ui_request" && r.id === "ui-2"));
  b.send({ type: "extension_ui_response", id: "ui-2", confirmed: true });
  await pause(100);
  a.send({ type: "extension_ui_response", id: "ui-2", confirmed: false });
  await pause();
  const answers = seen().filter((r) => r.type === "extension_ui_response" && r.id === "ui-2");
  assert.deepEqual(answers, [{ type: "extension_ui_response", id: "ui-2", confirmed: true }]);
  assert.ok(a.records.some((r) => r.type === "hub_ui_answered" && r.id === "ui-2"), "a apprend que c'est tranché");
  a.close();
  b.close();
});
