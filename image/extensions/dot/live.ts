// Le run en cours, vu de l'extérieur : /dot/channel/live.json, réécrit à chaque étape. Lu par
// ./dot suivre (machine) et /suivre (Telegram, chat local). Le texte est déjà mis en forme : tous
// les canaux affichent la même chose.

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LiveStep { t: string; label: string }
export interface Live {
  status: "running" | "done" | "failed";
  label: string;
  kind: string;
  started: string;
  ended?: string;
  turns: number;
  tokens: number;
  steps: LiveStep[];
  result?: string;
  text: string;
}

const short = (s: unknown, n = 80) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Un appel d'outil, dit en clair.
export function describeCall(name: string, args: any = {}): string {
  const a = args ?? {};
  switch (name) {
    case "bash":
      return `commande : ${short(a.command)}`;
    case "read":
      return `lit ${short(a.path, 70)}`;
    case "write":
      return `écrit ${short(a.path, 70)}`;
    case "edit":
      return `modifie ${short(a.path, 70)}`;
    case "notify":
      return `te prévient : « ${short(a.text, 60)} »`;
    case "todo":
      return `todo ${a.action ?? ""} ${short(a.text ?? a.id ?? "", 60)}`.trim();
    case "objective":
      return `objectif ${a.action ?? ""} ${short(a.title ?? a.id ?? "", 60)}`.trim();
    case "remember":
      return `retient : « ${short(a.fact, 60)} »`;
    case "secret":
      return `coffre : ${a.action ?? ""} ${(a.secrets ?? []).map((s: any) => s?.name ?? s).join(", ")}`.trim();
    case "tool_search":
      return `cherche un outil : ${short(a.query ?? JSON.stringify(a), 60)}`;
  }
  if (name.startsWith("mcp__")) {
    const [, server, tool] = name.split("__");
    const detail = a.query ?? a.url ?? a.urls ?? a.element ?? a.text ?? "";
    return `${server} · ${tool}${detail ? ` : ${short(Array.isArray(detail) ? detail.join(", ") : detail, 60)}` : ""}`;
  }
  const first = Object.values(a).find((v) => typeof v === "string");
  return `${name}${first ? ` : ${short(first, 60)}` : ""}`;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
function duration(fromIso: string, toIso?: string) {
  const s = Math.round(((toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime()) / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")}`;
}

export function render(live: Omit<Live, "text">, maxSteps = 12): string {
  const head = live.status === "running" ? "▶ En cours" : live.status === "done" ? "✅ Terminé" : "⚠️ Échoué";
  const steps = live.steps.slice(-maxSteps);
  const hidden = live.steps.length - steps.length;
  return [
    `${head} · ${live.label}`,
    `${duration(live.started, live.ended)} · ${live.turns} tour(s) · ${Math.round(live.tokens / 1000)}k jetons`,
    "",
    ...(hidden ? [`… ${hidden} étape(s) plus tôt`] : []),
    ...steps.map((s, i) => `${live.status === "running" && i === steps.length - 1 ? "⏳" : "·"} ${clock(s.t)} ${s.label}`),
    ...(!steps.length && live.status === "running" ? ["⏳ réfléchit…"] : []),
    ...(live.result ? ["", `→ ${short(live.result, 400)}`] : []),
  ].join("\n");
}

export function writeLive(file: string, live: Omit<Live, "text">) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...live, text: render(live) }) + "\n");
    renameSync(tmp, file);
  } catch {}
}
