// Détecteurs d'injection : interchangeables, choisis par DOT_INJECTION_DETECTOR (défaut : defender ;
// none : aucun).
//
// Un détecteur est un fichier <nom>.mjs de ce dossier qui exporte :
//
//   export async function create(): Promise<{ name: string, scan(text: string): Promise<Verdict> }>
//   Verdict = { suspect: boolean, score: number (0 à 1), level: "low" | "medium" | "high",
//               detections: string[], excerpt: string }
//
// `scan` reçoit un morceau de texte de taille raisonnable (le découpage est fait par l'appelant).
// Pour changer de détecteur : écrire son fichier ici, installer ce qu'il lui faut dans l'image
// (Containerfile), et le nommer dans DOT_INJECTION_DETECTOR.

const NAME = /^[a-z0-9-]+$/;

export async function loadDetector(name = process.env.DOT_INJECTION_DETECTOR ?? "defender") {
  if (!name || name === "none") return null;
  if (!NAME.test(name)) throw new Error(`détecteur inconnu : ${name}`);
  const mod = await import(new URL(`./${name}.mjs`, import.meta.url).href);
  return mod.create();
}

// Découpe un long texte en morceaux qui se chevauchent : un détecteur ne lit bien qu'un texte court,
// et une injection coupée entre deux morceaux reste entière dans l'un d'eux.
export function chunks(text, size = 4000, overlap = 300) {
  if (text.length <= size) return [text];
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (cut > start + size / 2) end = cut;
    }
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}
