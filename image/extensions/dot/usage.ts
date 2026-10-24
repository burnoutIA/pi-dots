// Usage des outils et des skills, et choix de ce qui est déclaré au modèle.
//
// Chaque outil déclaré au modèle coûte des jetons à chaque appel, qu'il serve ou non. Le dot mesure
// donc ce qu'il utilise vraiment (usage.json : nombre d'appels par jour, 60 jours gardés) et décide
// lui-même ce qui reste déclaré (`direct`) et ce qui n'est chargé qu'à la demande (`deferred`, trouvé
// par tool_search) : loadout.json. Ses outils de base restent toujours déclarés.

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

// Ce que le dot demande ; renvoie les refus (outils de base).
export function setExposure(dir: string, names: string[], exposure: Exposure): { applied: string[]; refused: string[] } {
  const loadout = readLoadout(dir);
  const applied: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    if (PROTECTED.has(name)) refused.push(name);
    else {
      if (exposure === "direct") delete loadout[name];
      else loadout[name] = exposure;
      applied.push(name);
    }
  }
  writeFileSync(loadoutFile(dir), JSON.stringify(loadout, null, 2) + "\n");
  return { applied, refused };
}

// Report du choix dans la configuration MCP de pi (toolExposure par serveur), pour les outils
// mcp__<serveur>__<outil>. Part toujours de la configuration d'origine du dépôt, dont les réglages
// (ex. « hidden ») restent prioritaires.
export function applyToMcp(base: any, loadout: Record<string, Exposure>): any {
  const mcp = JSON.parse(JSON.stringify(base));
  for (const [server, conf] of Object.entries<any>(mcp.mcpServers ?? {})) {
    const prefixes = [`mcp__${server}__`, `mcp__${server.replace(/-/g, "_")}__`];
    const chosen: Record<string, string> = {};
    for (const [name, exposure] of Object.entries(loadout)) {
      const prefix = prefixes.find((p) => name.startsWith(p));
      if (prefix && exposure === "deferred") chosen[name.slice(prefix.length)] = exposure;
    }
    if (Object.keys(chosen).length) conf.toolExposure = { ...chosen, ...(conf.toolExposure ?? {}) };
  }
  return mcp;
}

// Jetons qu'un outil déclaré coûte à chaque appel (estimation : 1 jeton ≈ 3,6 caractères).
export const declaredTokens = (tool: { name: string; description?: string; parameters?: unknown; promptGuidelines?: string[] }) =>
  Math.round((tool.name.length + (tool.description?.length ?? 0) + JSON.stringify(tool.parameters ?? {}).length + (tool.promptGuidelines ?? []).join(" ").length) / 3.6);
