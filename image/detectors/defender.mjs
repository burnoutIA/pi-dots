// Détecteur StackOne Defender (https://github.com/StackOneHQ/defender, Apache-2.0) : des motifs connus,
// puis un petit classifieur livré avec le paquet, sur processeur, sans clé ni appel externe.
// Installé dans l'image sous /opt/dot-vendor/detectors/defender (voir le Containerfile).

import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = process.env.DOT_DETECTORS_VENDOR ?? "/opt/dot-vendor/detectors";

export async function create() {
  const require = createRequire(join(DIR, "defender", "package.json"));
  const { createPromptDefense } = await import(pathToFileURL(require.resolve("@stackone/defender")).href);
  // requireTier2 : sans son classifieur, Defender ne vaut que ses motifs ; mieux vaut le savoir.
  const defense = createPromptDefense({ blockHighRisk: true, requireTier2: true });
  return {
    name: "defender",
    async scan(text) {
      const r = await defense.defendToolResult(text, "tool");
      return {
        suspect: !r.allowed,
        score: Number(r.tier2Score ?? 0),
        level: r.riskLevel ?? (r.allowed ? "low" : "high"),
        detections: r.detections ?? [],
        excerpt: String(r.maxSentence ?? "").slice(0, 200),
      };
    },
  };
}
