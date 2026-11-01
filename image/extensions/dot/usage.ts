// Usage des outils et des skills, et choix de ce qui est déclaré au modèle.
//
// Chaque outil déclaré au modèle coûte des jetons à chaque appel, qu'il serve ou non. Le dot mesure
// ce qu'il utilise vraiment (usage.json : nombre d'appels par jour, 60 jours gardés). Ce qui reste
// déclaré (`direct`) ou n'est chargé qu'à la demande (`deferred`, trouvé par tool_search) est un
// réglage fixe (loadout.json), changé avec la personne, jamais en cours de travail : un modèle local
// travaille mieux avec des outils prévisibles qu'avec un jeu qu'il déplace lui-même.
//
// Un serveur MCP se règle en entier (clé mcp__<serveur>__*) : la moitié d'un navigateur déclarée et
// l'autre à chercher, c'est l'état mixte qui égare le modèle. Ses outils de base restent toujours déclarés.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Exposure = "direct" | "deferred";
type Daily = Record<string, number>; // AAAA-MM-JJ → appels
export interface Usage { tools: Record<string, Daily>; skills: Record<string, Daily> }

// Toujours déclarés : sans eux, le dot ne peut plus travailler ni se corriger.
export const PROTECTED = new Set(["read", "bash", "edit", "write", "notify", "todo", "objective", "secret", "remember", "forget", "budget", "tool_search"]);

const KEEP_DAYS = 60;
const day = (d = new Date()) => d.toISOString().slice(0, 10);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export const usageFile = (dir: string) => join(dir, "usage.json");
export const loadoutFile = (dir: string) => join(dir, "loadout.json");
export const readUsage = (dir: string): Usage => ({ tools: {}, skills: {}, ...readJson<Partial<Usage>>(usageFile(dir), {}) });
export const readLoadout = (dir: string): Record<string, Exposure> => readJson(loadoutFile(dir), {});

// Le skill touché par un appel : lecture de son SKILL.md, ou commande qui lance un de ses fichiers.
export function skillOf(input: unknown): string | null {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return /\/skills\/([\w.-]+)\//.exec(text)?.[1] ?? null;
}

export function record(dir: string, tool: string, input: unknown, at = new Date()) {
  const usage = readUsage(dir);
  const bump = (bucket: Record<string, Daily>, name: string) => {
    const d = (bucket[name] ??= {});
    d[day(at)] = (d[day(at)] ?? 0) + 1;
  };
  bump(usage.tools, tool);
  const skill = skillOf(input);
  if (skill) bump(usage.skills, skill);
  // Ménage : au-delà de 60 jours, l'usage ne compte plus.
  const limit = day(new Date(at.getTime() - KEEP_DAYS * 86_400_000));
  for (const bucket of [usage.tools, usage.skills]) for (const daily of Object.values(bucket)) for (const d of Object.keys(daily)) if (d < limit) delete daily[d];
  writeFileSync(usageFile(dir), JSON.stringify(usage) + "\n");
}

export function uses(daily: Daily | undefined, days = 30, at = new Date()): { count: number; last?: string } {
  if (!daily) return { count: 0 };
  const limit = day(new Date(at.getTime() - days * 86_400_000));
  const dates = Object.keys(daily).sort();
  return { count: dates.filter((d) => d >= limit).reduce((n, d) => n + daily[d], 0), last: dates.at(-1) };
}

const MCP_TOOL = /^mcp__(.+?)__/;
// La clé de réglage d'un outil : lui-même, ou tout son serveur pour un outil MCP.
export const keyOf = (name: string) => {
  const server = MCP_TOOL.exec(name)?.[1];
  return server ? `mcp__${server}__*` : name;
};
export const exposureOf = (loadout: Record<string, Exposure>, name: string): Exposure | undefined => loadout[keyOf(name)] ?? loadout[name];

// Un ancien réglage outil par outil d'un serveur MCP (état mixte) est retiré : le serveur redevient
// entièrement déclaré, comme dans la configuration d'origine. Renvoie les serveurs remis à plat.
export function normalizeLoadout(loadout: Record<string, Exposure>): { loadout: Record<string, Exposure>; reset: string[] } {
  const out: Record<string, Exposure> = {};
  const reset = new Set<string>();
  for (const [name, exposure] of Object.entries(loadout)) {
    const server = MCP_TOOL.exec(name)?.[1];
    if (server && !name.endsWith("__*")) reset.add(server);
    else out[name] = exposure;
  }
  return { loadout: out, reset: [...reset] };
}

// Applique un réglage ; renvoie les clés réglées et les refus (outils de base).
export function setExposure(dir: string, names: string[], exposure: Exposure): { applied: string[]; refused: string[] } {
  const loadout = normalizeLoadout(readLoadout(dir)).loadout;
  const applied = new Set<string>();
  const refused: string[] = [];
  for (const name of names) {
    if (PROTECTED.has(name)) refused.push(name);
    else {
      const key = keyOf(name);
      if (exposure === "direct") delete loadout[key];
      else loadout[key] = exposure;
      applied.add(key);
    }
  }
  writeFileSync(loadoutFile(dir), JSON.stringify(loadout, null, 2) + "\n");
  return { applied: [...applied], refused };
}

// Report du choix dans la configuration MCP de pi : un serveur différé passe en exposure « deferred ».
// Part toujours de la configuration d'origine du dépôt, dont les réglages (ex. « hidden ») restent prioritaires.
export function applyToMcp(base: any, loadout: Record<string, Exposure>): any {
  const mcp = JSON.parse(JSON.stringify(base));
  for (const [server, conf] of Object.entries<any>(mcp.mcpServers ?? {})) {
    const chosen = loadout[`mcp__${server}__*`] ?? loadout[`mcp__${server.replace(/-/g, "_")}__*`];
    if (chosen === "deferred" && conf.exposure !== "hidden") conf.exposure = "deferred";
  }
  return mcp;
}

// Jetons qu'un outil déclaré coûte à chaque appel (estimation : 1 jeton ≈ 3,6 caractères).
export const declaredTokens = (tool: { name: string; description?: string; parameters?: unknown; promptGuidelines?: string[] }) =>
  Math.round((tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters ?? {}).length + (tool.promptGuidelines ?? []).join(" ").length) / 3.6);
