// Le budget de contexte : ce que coûtent les outils déclarés, ce que le dot utilise vraiment.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED, declaredTokens, exposureOf, readLoadout, readUsage, usageFile, uses } from "./usage.ts";
import { MEMORY } from "./plan.ts";
import { HOME, SKILLS_DIR, logEvents, writeJson } from "./common.ts";

// --- Budget de contexte ------------------------------------------------------------------------------

export const MCP_DEFAULTS = "/opt/dot/defaults/mcp.json";
export const MCP_FILE = join(process.env.PI_CODING_AGENT_DIR ?? join(HOME, "agent"), "mcp.json");


// Premier démarrage avec le comptage : l'usage passé est repris du journal (outils appelés par les runs).
export function seedUsage() {
  const usage: any = { tools: {}, skills: {} };
  for (const e of logEvents(60)) {
    if (e.type !== "run.end" || !e.tools) continue;
    const d = String(e.t).slice(0, 10);
    for (const [name, n] of Object.entries<number>(e.tools)) {
      const daily = (usage.tools[name] ??= {});
      daily[d] = (daily[d] ?? 0) + n;
    }
  }
  writeJson(usageFile(MEMORY), usage);
}

export function declared(pi: ExtensionAPI) {
  const active = new Set((pi as any).getActiveTools?.() ?? []);
  return pi.getAllTools().filter((t: any) => active.has(t.name));
}

// Une note fixe pour la session (le début du contexte reste identique d'un appel à l'autre).
export function budgetSection(pi: ExtensionAPI, ctx: any): string {
  const model = ctx?.model;
  const window = model?.contextWindow ?? ctx?.getContextUsage?.()?.contextWindow;
  const tools = declared(pi);
  const toolTokens = tools.reduce((n: number, t: any) => n + declaredTokens(t), 0);
  return [
    `Your context budget: model ${model ? `${model.provider}/${model.id}` : "unknown"}${window ? `, context window ${window} tokens` : ""}.`,
    `Before you do anything, your instructions and the ${tools.length} tools declared to you take thousands of tokens (tools alone ≈ ${toolTokens}), on every single call. Every token costs time, and the model may run on the person's own hardware.`,
    "Be frugal: keep skills short (the essentials in SKILL.md, details in separate files read only when needed), make scripts print only what you need, never paste large outputs.",
    "Which tools are declared is a fixed setting: deferred tools are found with `tool_search`. You never change it while working; `budget` shows your real usage, and you propose a change to the person if one is worth it.",
  ].join("\n");
}

export function budgetReport(pi: ExtensionAPI, ctx: any): string {
  const usage = readUsage(MEMORY);
  const loadout = readLoadout(MEMORY);
  const model = ctx?.model;
  const ctxUsage = ctx?.getContextUsage?.();
  const active = new Set((pi as any).getActiveTools?.() ?? []);
  const rows = pi
    .getAllTools()
    .filter((t: any) => t.exposure !== "hidden")
    .map((t: any) => ({ name: t.name, exposure: active.has(t.name) ? "direct" : exposureOf(loadout, t.name) ?? t.exposure, tokens: declaredTokens(t), ...uses(usage.tools[t.name]) }))
    .sort((a: any, b: any) => b.tokens - a.tokens);
  const declaredRows = rows.filter((r: any) => r.exposure === "direct");
  const skills = existsSync(SKILLS_DIR)
    ? readdirSync(SKILLS_DIR)
        .filter((n) => existsSync(join(SKILLS_DIR, n, "SKILL.md")))
        .map((n) => ({ name: n, tokens: Math.round(statSync(join(SKILLS_DIR, n, "SKILL.md")).size / 3.6), ...uses(usage.skills[n]) }))
    : [];
  const runs = logEvents(7).filter((e) => e.type === "run.end");
  const tokens = (e: any) => (e.tokensIn ?? 0) + (e.tokensOut ?? 0);
  const biggest = runs.slice().sort((a, b) => tokens(b) - tokens(a))[0];
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return [
    `Model: ${model ? `${model.provider}/${model.id}` : "?"} · context window ${ctxUsage?.contextWindow ?? model?.contextWindow ?? "?"} · now used: ${ctxUsage?.tokens ?? "?"} tokens${ctxUsage?.percent != null ? ` (${Math.round(ctxUsage.percent)}%)` : ""}`,
    `Declared tools: ${declaredRows.length}, ≈ ${declaredRows.reduce((n: number, r: any) => n + r.tokens, 0)} tokens on every call.`,
    "",
    "Tools (≈tokens when declared · calls in 30 days · last used):",
    ...rows.map((r: any) => `- ${r.name} · ${r.exposure}${PROTECTED.has(r.name) ? " (base)" : ""} · ${r.tokens} · ${r.count} · ${r.last ?? "never"}`),
    "",
    `Skills (≈tokens of SKILL.md · uses in 30 days · last used):`,
    ...(skills.length ? skills.map((r) => `- ${r.name} · ${r.tokens} · ${r.count} · ${r.last ?? "never"}`) : ["- none"]),
    "",
    `Work runs, last 7 days: ${runs.length}${runs.length ? `, ${k(runs.reduce((n, e) => n + tokens(e), 0) / runs.length)} tokens on average, biggest ${k(tokens(biggest))} (${String(biggest.label ?? "").slice(0, 80)})` : ""}`,
  ].join("\n");
}
