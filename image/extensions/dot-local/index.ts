// dot-local — extension pi : la personne parle au dot depuis sa machine (./dot ask, ./dot chat).
//
// Le canal passe par des fichiers dans /dot/channel (state/channel sur la machine) : pas de réseau,
// le même fonctionnement sur tous les systèmes. Il fait ce que fait Telegram :
//   - in/<id>.json   : un message ou une commande de la personne ({ text } ou { command }) ;
//   - out/<id>.json  : la réponse du dot à ce message ;
//   - notifications.jsonl : ce que le dot envoie de lui-même (`notify`).
// Les secrets, eux, ne passent jamais par ici : ./dot chat les remet directement au coffre.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.DOT_HOME ?? "/dot";
const CHANNEL = join(HOME, "channel");
const IN = join(CHANNEL, "in");
const OUT = join(CHANNEL, "out");
const NOTIFICATIONS = join(CHANNEL, "notifications.jsonl");
const NEW_COMMAND = "local-new";
const WORKER = process.env.DOT_ROLE === "worker";

const dot = ((globalThis as any).__dot ??= {}) as { senders?: Record<string, (text: string) => void>; setPaused?: (p: boolean) => void; status?: () => string };

function writeOut(id: string, reply: string) {
  mkdirSync(OUT, { recursive: true });
  const tmp = join(OUT, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ id, reply, t: new Date().toISOString() }) + "\n");
  renameSync(tmp, join(OUT, `${id}.json`));
}

function assistantText(m: any): string {
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return typeof m?.content === "string" ? m.content : "";
  return m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  // Les notifications du dot vont aussi vers la machine, que ce soit la conversation ou un run.
  (dot.senders ??= {}).local = (text: string) => {
    mkdirSync(CHANNEL, { recursive: true });
    appendFileSync(NOTIFICATIONS, JSON.stringify({ t: new Date().toISOString(), text }) + "\n");
  };
  if (WORKER) return;

  let waiting: string[] = []; // messages de la personne auxquels la réponse en cours répondra
  let lastTurnText = "";
  pi.on("turn_end", (event: any) => {
    const text = assistantText(event?.message);
    if (text) lastTurnText = text;
  });
  pi.on("agent_settled", () => {
    for (const id of waiting) writeOut(id, lastTurnText || "Je n'ai pas pu répondre. Le détail est dans le journal du dot.");
    waiting = [];
    lastTurnText = "";
  });

  pi.registerCommand(NEW_COMMAND, {
    description: "Nouvelle conversation (demandée depuis la machine)",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const result = await ctx.newSession();
      writeOut(args.trim(), result.cancelled ? "La conversation en cours n'a pas pu être fermée." : "Nouvelle conversation.");
    },
  });

  function handle(id: string, msg: any) {
    const command = String(msg.command ?? "").replace(/^\//, "");
    if (command === "status") return writeOut(id, dot.status?.() ?? "État indisponible.");
    if (command === "pause" || command === "resume") {
      dot.setPaused?.(command === "pause");
      return writeOut(id, command === "pause" ? "Autonomie en pause : je ne travaille plus de moi-même. Je réponds toujours à tes messages." : "Autonomie reprise.");
    }
    if (command === "new") return pi.sendUserMessage(`/${NEW_COMMAND} ${id}`, { expandPromptTemplates: true });
    if (command) return writeOut(id, `Commande inconnue : /${command}`);
    const text = String(msg.text ?? "").trim();
    if (!text) return writeOut(id, "Message vide.");
    waiting.push(id);
    pi.sendUserMessage(`[depuis la machine de la personne]\n${text}`, { deliverAs: "followUp" });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  function poll() {
    if (!existsSync(IN)) return;
    for (const name of readdirSync(IN).sort()) {
      if (!name.endsWith(".json")) continue;
      const file = join(IN, name);
      if (Date.now() - statSync(file).mtimeMs < 200) continue; // en cours d'écriture
      let msg: any = null;
      try {
        msg = JSON.parse(readFileSync(file, "utf8"));
      } catch {}
      rmSync(file, { force: true });
      if (msg) handle(String(msg.id ?? name.replace(/\.json$/, "")), msg);
    }
  }

  // Toujours présente (et pas seulement quand un message arrive) : le début du prompt reste stable.
  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      local_channel:
        "Messages marked [depuis la machine de la personne] come from their own computer, in a terminal: your final reply is shown to them there. " +
        "To give them a file, put it in /dot/livrables (they see that folder on their computer) and tell them its name.",
    };
  });

  pi.on("session_start", () => {
    mkdirSync(IN, { recursive: true });
    if (!timer) timer = setInterval(poll, 1000);
  });
  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
