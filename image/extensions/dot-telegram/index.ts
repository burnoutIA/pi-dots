// dot-telegram — extension pi : la personne parle au dot par un bot Telegram.
//
//   - ses messages (texte, photos, fichiers) sont transmis à l'agent ; la réponse finale lui
//     revient ;
//   - quand l'agent travaille de lui-même, rien ne part, sauf ce qu'il envoie avec `notify`
//     (l'extension `dot` passe par la fonction `send` posée ici) ;
//   - l'agent envoie un fichier de son dossier de travail avec `send_file` ;
//   - commandes : /new (nouvelle conversation), /status, /pause, /resume.
//
// Configuration : TELEGRAM_OWNER_ID (l'identifiant de la personne, seule écoutée). Le jeton du bot
// n'est pas dans l'environnement du dot : les appels passent par le coffre (DOT_VAULT), qui
// remplace {{TELEGRAM_TOKEN}} par sa valeur. Hors coffre, TELEGRAM_BOT_TOKEN marche aussi.
// Sans identifiant, l'extension ne fait rien.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "typebox";
import { log } from "../dot/log.ts";

interface Attachment {
  id: string;
  name: string;
  mime: string;
  bytes: number;
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
const VAULT = process.env.DOT_VAULT?.trim().replace(/\/$/, "") ?? "";
const OWNER = Number(process.env.TELEGRAM_OWNER_ID);
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : VAULT ? `${VAULT}/https/api.telegram.org/bot{{TELEGRAM_TOKEN}}` : "";
const FILE_API = TOKEN ? `https://api.telegram.org/file/bot${TOKEN}` : VAULT ? `${VAULT}/https/api.telegram.org/file/bot{{TELEGRAM_TOKEN}}` : "";
const HOME = process.env.DOT_HOME ?? "/dot";
const FILES = join(HOME, "workspace", "files");
const LOCK = join(process.env.PI_CODING_AGENT_DIR ?? HOME, "telegram.lock");
const NEW_COMMAND = "telegram-new";
const TYPING_EVERY_MS = 4000;
const TYPING_MAX_MS = 20 * 60_000;
const MAX_SEND_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

function attachmentOf(msg: any): Attachment | null {
  if (Array.isArray(msg?.photo) && msg.photo.length) {
    const photo = msg.photo[msg.photo.length - 1];
    return { id: photo.file_id, name: "photo.jpg", mime: "image/jpeg", bytes: photo.file_size ?? 0 };
  }
  for (const kind of ["document", "video", "audio", "voice", "animation", "video_note"]) {
    const file = msg?.[kind];
    if (file?.file_id) return { id: file.file_id, name: file.file_name ?? kind, mime: file.mime_type ?? "", bytes: file.file_size ?? 0 };
  }
  return null;
}

function fileName(dir: string, wanted: string, remotePath: string): string {
  const ext = (extname(wanted) || extname(remotePath)).replace(/[^.\w]/g, "").slice(0, 12);
  const stem = basename(wanted, extname(wanted)).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, 60) || "fichier";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  for (let n = 1; ; n += 1) {
    const name = `${stamp}-${stem}${n > 1 ? `-${n}` : ""}${ext}`;
    if (!existsSync(join(dir, name))) return name;
  }
}

const megabytes = (bytes: number) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1000))} Ko` : `${(bytes / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo`);

// Un bot n'a qu'un lecteur : un second pi sur le même dossier n'écoute pas.
function takeLock(): boolean {
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    // Le verrou ne compte que s'il désigne un pi vivant : après un redémarrage, son numéro peut
    // être repris par un tout autre processus.
    if (pid && pid !== process.pid) {
      try {
        if (/(^|\/)pi(\0|$)/.test(readFileSync(`/proc/${pid}/cmdline`, "utf8"))) return false;
      } catch {}
    }
  } catch {}
  writeFileSync(LOCK, String(process.pid));
  return true;
}
function releaseLock() {
  try {
    if (Number(readFileSync(LOCK, "utf8")) === process.pid) rmSync(LOCK, { force: true });
  } catch {}
}

// Survit au remplacement de session (/new recharge l'extension, pas le processus).
const shared = ((globalThis as any).__dotTelegram ??= { offset: 0, chat: 0 }) as { offset: number; chat: number };
const dot = ((globalThis as any).__dot ??= {}) as { send?: (text: string) => void; setPaused?: (p: boolean) => void; status?: () => string };

function assistantText(m: any): string {
  if (m?.role !== "assistant") return "";
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
}

export default function (pi: ExtensionAPI) {
  if (!API || !Number.isInteger(OWNER) || !process.env.TELEGRAM_OWNER_ID) return;
  const api = API;

  // Chaque appel a une limite de temps : une connexion coupée sans prévenir (le coffre relancé,
  // le réseau qui tombe) ne doit pas bloquer la lecture des messages pour toujours.
  async function tg(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const limit = AbortSignal.timeout(method === "getUpdates" ? 70_000 : 30_000);
    const res = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    const json: any = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
    return json.result;
  }

  const chatId = () => shared.chat || OWNER;

  let sendQueue: Promise<unknown> = Promise.resolve();
  function sendText(chat: number, text: string) {
    for (let i = 0; i < text.length; i += 4000) {
      const part = text.slice(i, i + 4000);
      sendQueue = sendQueue.then(() => tg("sendMessage", { chat_id: chat, text: part, disable_web_page_preview: true }).catch(() => {}));
    }
  }
  dot.send = (text: string) => sendText(chatId(), text);

  // Dans un run de travail, on peut écrire à la personne (`notify`, `send_file`), mais seul le
  // pi de la conversation écoute le bot et lui renvoie ses réponses.
  const WORKER = process.env.DOT_ROLE === "worker";

  function deliver(file: string, caption = ""): Promise<void> {
    const photo = /\.(png|jpe?g|webp)$/i.test(file);
    const sent = sendQueue.then(async () => {
      const form = new FormData();
      form.set("chat_id", String(chatId()));
      if (caption) form.set("caption", caption.slice(0, 1000));
      form.set(photo ? "photo" : "document", new Blob([readFileSync(file)]), basename(file));
      const res = await fetch(`${api}/${photo ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
      const json: any = await res.json();
      if (!json.ok) throw new Error(json.description);
    });
    sendQueue = sent.catch(() => {});
    return sent;
  }

  pi.on("before_agent_start", (event: any) => {
    event.systemPromptOptions.sections = {
      ...(event.systemPromptOptions.sections ?? {}),
      telegram: WORKER
        ? "The person is reachable on Telegram, but nothing of this run reaches them unless you call `notify` (a message) or `send_file` (a file of your working directory)."
        : "The person talks to you through Telegram, from their phone. When they write to you, they receive only the text of your final reply: they do not see this terminal, your tool calls, or any file. " +
          "Reading an image with `read` shows it to you, never to them: to show or give them a file, call `send_file`.",
    };
  });

  pi.registerTool({
    name: "send_file",
    label: "send_file",
    description: "Send a file from your working directory to the person on Telegram. Images (png, jpg, webp) are displayed in the chat; other files arrive as documents.",
    promptSnippet: "send_file: show an image or send a file to the person on Telegram",
    parameters: Type.Object({
      path: Type.String({ description: "Path of the file, inside your working directory" }),
      caption: Type.Optional(Type.String({ description: "Short text shown under the image or file" })),
    }),
    async execute(_id: string, args: any) {
      const answer = (text: string, isError = false) => ({ content: [{ type: "text" as const, text }], details: undefined, isError });
      const file = resolve(process.cwd(), String(args.path ?? ""));
      const inside = relative(process.cwd(), file);
      if (!inside || inside.startsWith("..") || isAbsolute(inside)) return answer("Only files inside your working directory can be sent.", true);
      if (!existsSync(file) || !statSync(file).isFile()) return answer(`No such file: ${inside}`, true);
      if (statSync(file).size > MAX_SEND_BYTES) return answer(`File too large for Telegram (${megabytes(statSync(file).size)}, limit ${megabytes(MAX_SEND_BYTES)}).`, true);
      try {
        await deliver(file, typeof args.caption === "string" ? args.caption : "");
        return answer(`Sent to the person on Telegram: ${inside}`);
      } catch (error: any) {
        return answer(`Telegram refused the file: ${error.message}`, true);
      }
    },
  });

  if (WORKER) return;

  // --- « écrit… » tant qu'un run demandé par la personne est en cours ---
  let typing: ReturnType<typeof setInterval> | null = null;
  function stopTyping() {
    if (typing) clearInterval(typing);
    typing = null;
  }
  function startTyping() {
    if (typing) return;
    const since = Date.now();
    const beat = () => {
      if (Date.now() - since > TYPING_MAX_MS) return stopTyping();
      tg("sendChatAction", { chat_id: chatId(), action: "typing" }).catch(() => {});
    };
    beat();
    typing = setInterval(beat, TYPING_EVERY_MS);
  }

  // --- Sortie : la réponse finale, seulement pour un run qui vient de la personne ---
  let lastTurnText = "";
  let asked = false;
  pi.on("turn_end", (event: any) => {
    const text = assistantText(event?.message);
    if (text) lastTurnText = text;
  });
  pi.on("agent_settled", () => {
    stopTyping();
    if (asked) sendText(chatId(), lastTurnText || "Je n'ai pas pu répondre. Le détail est dans le terminal du dot.");
    lastTurnText = "";
    asked = false;
  });

  pi.registerCommand(NEW_COMMAND, {
    description: "Nouvelle conversation (demandée depuis Telegram)",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      const result = await ctx.newSession();
      sendText(chatId(), result.cancelled ? "La conversation en cours n'a pas pu être fermée." : "Nouvelle conversation.");
    },
  });

  // --- Fichiers reçus ---
  let vision = false;
  const sees = (model: any) => Array.isArray(model?.input) && model.input.includes("image");
  pi.on("model_select", (event: any) => {
    vision = sees(event?.model);
  });

  async function receive(file: Attachment, signal: AbortSignal): Promise<{ note: string; image?: { type: "image"; data: string; mimeType: string } }> {
    if (file.bytes > MAX_FILE_BYTES) throw new Error(`il pèse ${megabytes(file.bytes)}, et Telegram ne laisse pas un bot télécharger plus de ${megabytes(MAX_FILE_BYTES)}`);
    const remote = await tg("getFile", { file_id: file.id }, signal);
    const res = await fetch(`${FILE_API}/${remote.file_path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (!res.ok) throw new Error(`Telegram a répondu ${res.status}`);
    const data = Buffer.from(await res.arrayBuffer());
    mkdirSync(FILES, { recursive: true });
    const saved = join(FILES, fileName(FILES, file.name, remote.file_path ?? ""));
    writeFileSync(saved, data);
    const image = IMAGE_TYPES.has(file.mime);
    const note = `[Fichier reçu par Telegram, enregistré dans ${saved} (${file.mime || "type inconnu"}, ${megabytes(data.length)})${image && !vision ? ". C'est une image, mais le modèle actuel ne sait pas voir : dis-le si on te demande de la regarder" : ""}]`;
    return image && vision ? { note, image: { type: "image", data: data.toString("base64"), mimeType: file.mime } } : { note };
  }

  async function contentOf(msg: any, signal: AbortSignal): Promise<string | any[]> {
    const text = String(msg.text ?? msg.caption ?? "").trim();
    const file = attachmentOf(msg);
    if (!file) return text;
    try {
      const { note, image } = await receive(file, signal);
      const full = text ? `${text}\n\n${note}` : note;
      return image ? [{ type: "text", text: full }, image] : full;
    } catch (error: any) {
      if (signal.aborted) throw error;
      sendText(msg.chat.id, `Je n'ai pas pu récupérer votre fichier : ${error.message}.`);
      return text;
    }
  }

  function allowed(msg: any): boolean {
    const text = msg?.text ?? msg?.caption;
    if (!msg?.chat || msg.from?.is_bot || !((typeof text === "string" && text.trim()) || attachmentOf(msg))) return false;
    return msg.chat.type === "private" ? msg.chat.id === OWNER : msg.from?.id === OWNER;
  }

  const COMMANDS = [
    { command: "new", description: "Nouvelle conversation" },
    { command: "status", description: "Ce que fait le dot : tâches, veilles, autonomie" },
    { command: "pause", description: "Mettre l'autonomie en pause" },
    { command: "resume", description: "Reprendre l'autonomie" },
  ];

  // --- Entrée : la file du bot, lue en continu ---
  let stop: AbortController | null = null;
  let lastConflict = 0;
  async function poll(signal: AbortSignal) {
    await tg("setMyCommands", { commands: COMMANDS }, signal).catch(() => {});
    while (!signal.aborted) {
      try {
        const updates: any[] = await tg("getUpdates", { offset: shared.offset, timeout: 50, allowed_updates: ["message"] }, signal);
        for (const update of updates) {
          shared.offset = update.update_id + 1;
          const msg = update.message;
          if (!allowed(msg)) continue;
          shared.chat = msg.chat.id;
          const command = /^\/(\w+)(?:@\w+)?\s*$/.exec(String(msg.text ?? "").trim())?.[1];
          if (command === "start") {
            sendText(msg.chat.id, "Bonjour. Écrivez-moi. /status pour voir ce que je fais, /new pour une nouvelle conversation.");
          } else if (command === "new") {
            pi.sendUserMessage(`/${NEW_COMMAND}`, { expandPromptTemplates: true });
          } else if (command === "status") {
            sendText(msg.chat.id, dot.status?.() ?? "État indisponible.");
          } else if (command === "pause" || command === "resume") {
            dot.setPaused?.(command === "pause");
            sendText(msg.chat.id, command === "pause" ? "Autonomie en pause : je ne travaille plus de moi-même. Je réponds toujours à vos messages." : "Autonomie reprise.");
          } else {
            startTyping();
            const content = await contentOf(msg, signal);
            if (!content.length) continue;
            asked = true;
            pi.sendUserMessage(content, { expandPromptTemplates: true, deliverAs: "followUp" });
          }
        }
      } catch (error: any) {
        // 409 Conflict : un autre programme lit le même bot (un autre agent avec le même jeton).
        // Les messages de la personne partent alors chez l'un ou chez l'autre.
        if (/conflict/i.test(String(error?.message)) && Date.now() - lastConflict > 10 * 60_000) {
          lastConflict = Date.now();
          log("telegram.conflict", { error: String(error.message).slice(0, 200) });
        }
        if (!signal.aborted) await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  pi.on("session_start", (_event, ctx: any) => {
    vision = sees(ctx?.model);
    if (stop) return;
    if (!takeLock()) return ctx.ui.notify("Telegram : ce bot est déjà suivi par un autre pi.", "warning");
    stop = new AbortController();
    void poll(stop.signal);
  });
  pi.on("session_shutdown", () => {
    stop?.abort();
    stop = null;
    stopTyping();
    releaseLock();
  });
}
