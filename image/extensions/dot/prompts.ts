// Ce que lisent le modèle et les runs : les prompts des runs et le rappel des fichiers persistants
// (mémoire, tableau, journal) dans le prompt système.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMemory } from "./memory.ts";
import { MEMORY, type Plan, type Work, board, objectiveBlock, readPlan } from "./plan.ts";
import { AUTONOMY, type DotEvent, stamp } from "./common.ts";

// La section mcp_servers de pi liste comme « non déclaré, à charger avec tool_search » tout serveur
// qui a des outils deferred, même quand d'autres de ses outils sont déjà déclarés. Les modèles en
// concluent que ces outils manquent (tool_search ne renvoie pas un outil déjà chargé) : on les nomme.
export function mcpDirectSection(pi: ExtensionAPI): string {
  const direct = ((pi as any).getActiveTools?.() ?? []).filter((name: string) => name.startsWith("mcp__"));
  if (!direct.length) return "";
  return `These MCP tools are already declared to you: call them directly, without tool_search (which never returns a tool that is already loaded): ${direct.join(", ")}. Only the other tools of these servers need tool_search.`;
}

// --- Les prompts des runs ------------------------------------------------------------------------

export function todoPrompt(plan: Plan, work: Extract<Work, { kind: "todo" }>): string {
  const { objective, todo, resume } = work;
  return [
    `[dot:todo] ${stamp()}`,
    `Objectif ${objective.id} : ${objective.title}`,
    "",
    "Plan actuel :",
    objectiveBlock(plan, objective),
    "",
    `Ton todo : ${todo.id} · ${todo.text}`,
    ...(resume ? ["Ce todo était déjà en cours (run interrompu ou pas terminé) : regarde où tu en étais, puis continue."] : []),
    "",
    "Fais ce todo, et seulement lui. Ensuite :",
    "- fini : `todo` done, avec le résultat ;",
    "- il te faut la personne (une information, une décision, un accès) : pose ta question avec `notify`, puis `todo` wait ;",
    "- il faut d'autres étapes : ajoute-les avec `todo` add.",
    `Avant de finir, tiens le projet à jour : dans ses notes (\`remember\` avec project: ${objective.id}, et \`replaces\` pour ce qui a changé), ce que tu as décidé, appris ou trouvé et qui servira aux prochains runs ; sur sa carte (\`objective\` update), la suite et ce qui bloque. Retire des notes ce qui n'est plus vrai.`,
    "Une leçon qui sert au-delà de ce projet (comment marche un service, une préférence de la personne) va dans ta mémoire globale (`remember` sans project).",
    "Ta réponse finale est un compte-rendu de deux ou trois lignes.",
  ].join("\n");
}

export function planPrompt(plan: Plan, work: Extract<Work, { kind: "plan" }>): string {
  const { objective } = work;
  return [
    `[dot:plan] ${stamp()}`,
    `L'objectif ${objective.id} n'a plus aucun todo ouvert.`,
    "",
    objectiveBlock(plan, objective),
    "",
    "Décide :",
    "- si le résultat est livré mais que la personne ne l'a pas encore validé : `objective` stage a_valider, avec en blocker ce qu'elle doit regarder, et demande-lui son avis en une question courte dans ton `notify` ;",
    "- s'il est atteint et validé : `objective` reached, avec le résultat ;",
    "- sinon : fais le plan des prochaines étapes avec `todo` add (petites, concrètes, vérifiables). Ne les exécute pas maintenant ;",
    "- si rien n'est possible pour l'instant : ne change rien et explique pourquoi en une ligne.",
  ].join("\n");
}

export function eventPrompt(event: DotEvent): string {
  const followUp =
    AUTONOMY === "libre"
      ? "Si cela demande un travail suivi, crée un objectif (`objective` add) ou des todos plutôt que de tout faire maintenant."
      : "Si cela demande un travail suivi : des todos dans un projet existant (`todo` add) ; un nouveau projet, une tâche récurrente ou une veille, propose-les à la personne avec `notify`, sans les créer toi-même.";
  return `${event.text}\n\n${followUp} Si tu as appris quelque chose de durable, note-le avec \`remember\`. Ta réponse finale est un compte-rendu de deux ou trois lignes.`;
}


// L'id de projet donné à remember/forget : undefined (mémoire globale), l'id s'il existe, null sinon.
export function projectOf(id: unknown): string | undefined | null {
  const text = String(id ?? "").trim();
  if (!text) return undefined;
  return readPlan().objectives.some((o) => o.id === text) ? text : null;
}

export function memorySection(objectiveId = ""): string {
  const read = (name: string) => {
    try {
      return readFileSync(join(MEMORY, name), "utf8").trim();
    } catch {
      return "";
    }
  };
  const plan = readPlan();
  const journal = read("JOURNAL.md").split("\n").filter(Boolean).slice(-8).join("\n");
  const project = plan.objectives.find((o) => o.id === objectiveId);
  return [
    `## MEMORY.md (mémoire globale)\n${readMemory(MEMORY).trim()}`,
    `## Tableau des projets\n${board(plan)}`,
    ...(project
      ? [`## Ce projet\n${objectiveBlock(plan, project, false)}`, `## Notes du projet ${project.id}\n${readMemory(MEMORY, project.id).trim()}`]
      : ["Les notes de chaque projet ne sont pas chargées : ouvre celles d'un projet (`objective` show) dès que la personne en parle."]),
    `## JOURNAL.md (fin)\n${journal}`,
  ].join("\n\n");
}
