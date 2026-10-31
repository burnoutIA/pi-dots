// Au démarrage : demande à chaque fournisseur la liste de ses modèles (GET <baseUrl>/models, la route
// commune aux API compatibles OpenAI) et complète models.json avec ceux qui n'y sont pas déclarés.
// Le modèle par défaut reste celui du fichier du dot (DOT_MODEL) ; les autres deviennent
// sélectionnables ensuite (/model, ou le menu de l'application).
//
// Un modèle déclaré à la main garde son réglage. Un fournisseur avec `discover: false` est laissé tel
// quel. Si le serveur ne répond pas, la liste déclarée reste, et le dot démarre quand même.
//
//   node discover-models.mjs <models.json>

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const OPENAI_LIKE = new Set(["openai-completions", "openai-responses"]);
const TIMEOUT_MS = Number(process.env.DOT_DISCOVER_TIMEOUT_MS ?? 8000);

// Un modèle découvert, réglé d'après ce que le serveur en dit (harn, LM Studio, vLLM… donnent souvent
// le contexte), et à défaut d'après le premier modèle déclaré du même fournisseur.
function describe(entry, template = {}) {
  const meta = entry.meta ?? {};
  const context = Number(meta.context ?? entry.context_length ?? entry.max_model_len ?? entry.context_window ?? template.contextWindow ?? 131072);
  const vision = meta.vision ?? (Array.isArray(entry.input_modalities) ? entry.input_modalities.includes("image") : undefined);
  return {
    id: entry.id,
    name: meta.name ?? entry.name ?? entry.id,
    reasoning: template.reasoning ?? true,
    input: vision === undefined ? (template.input ?? ["text"]) : vision ? ["text", "image"] : ["text"],
    contextWindow: context,
    maxTokens: Math.min(template.maxTokens ?? 32768, Math.floor(context / 2)),
    cost: template.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}

export async function discover(config, fetchImpl = fetch) {
  const report = [];
  for (const [name, provider] of Object.entries(config.providers ?? {})) {
    const enabled = provider.discover !== false;
    delete provider.discover; // option du dot, inconnue de pi
    if (!enabled || !provider.baseUrl || (provider.api && !OPENAI_LIKE.has(provider.api))) continue;
    const declared = provider.models ?? [];
    try {
      const headers = { ...(provider.headers ?? {}) };
      if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
      const res = await fetchImpl(`${provider.baseUrl.replace(/\/$/, "")}/models`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const entries = (Array.isArray(body) ? body : (body.data ?? body.models ?? [])).filter((e) => e && typeof e.id === "string");
      const known = new Set(declared.map((m) => m.id));
      const added = entries.filter((e) => !known.has(e.id)).map((e) => describe(e, declared[0]));
      provider.models = [...declared, ...added];
      report.push({ provider: name, declared: declared.length, added: added.length });
    } catch (error) {
      report.push({ provider: name, declared: declared.length, error: String(error?.message ?? error) });
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const file = process.argv[2];
  const config = JSON.parse(readFileSync(file, "utf8"));
  const report = await discover(config);
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  for (const r of report) {
    console.log(r.error ? `modèles ${r.provider} : liste du serveur indisponible (${r.error}), ${r.declared} déclaré(s) gardé(s)` : `modèles ${r.provider} : ${r.declared} déclaré(s) + ${r.added} trouvé(s) sur le serveur`);
  }
}
