// Journal technique du dot : une ligne JSON par événement, un fichier par jour dans /dot/logs.
//
// But : pouvoir dire après coup « tel jour, de telle heure à telle heure, le dot a tourné en rond
// sur tel todo ». On y trouve les runs (début, fin, durée, résultat, outils appelés), les
// événements reçus, les changements du plan, les blocages, les pauses et les redémarrages.
// Lisible depuis la machine hôte avec `./dot journal`.

import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.DOT_HOME ?? "/dot";
export const LOGS = join(HOME, "logs");
const KEEP_DAYS = Number(process.env.DOT_LOG_DAYS ?? 30);
const ROLE = process.env.DOT_ROLE === "worker" ? "run" : "conversation";

// Date locale (fuseau TZ) : le fichier du jour correspond à la journée vécue par la personne.
function day(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function log(type: string, data: Record<string, unknown> = {}) {
  try {
    mkdirSync(LOGS, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), role: ROLE, pid: process.pid, type, ...data });
    appendFileSync(join(LOGS, `${day()}.jsonl`), line + "\n");
  } catch {}
}

// Les journaux de plus de KEEP_DAYS jours sont supprimés.
export function pruneLogs() {
  try {
    const limit = day(new Date(Date.now() - KEEP_DAYS * 86_400_000));
    for (const name of readdirSync(LOGS)) {
      if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < limit) rmSync(join(LOGS, name), { force: true });
    }
  } catch {}
}
