// Audit de la mémoire d'un dot (MEMORY.md) : ce qui mérite d'être revérifié, retiré ou fusionné.
// Un constat, pas une décision : le dot tranche à sa revue, et demande à la personne en cas de doute.

const STALE_DAYS = Number(process.env.DOT_MEMORY_STALE_DAYS ?? 60);

// Mots qui portent le sens d'un fait (on ignore les mots courts et les plus fréquents).
const fold = (text) => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
const STOP = new Set(["avec", "dans", "pour", "sans", "sont", "cette", "elle", "elles", "leur", "leurs", "plus", "tout", "tous", "mais", "comme", "être", "fait", "faire", "depuis", "entre", "aussi", "doit", "doivent", "personne", "about", "with", "from", "that", "this", "their"].map(fold));
const words = (text) =>
  new Set(
    fold(text)
      .replace(/_\(.*?\)_/g, "")
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOP.has(w)),
  );

// _(25/10/2026)_ en fin de fait : la date où il a été noté.
function noted(line) {
  const m = /_\((\d{1,2})\/(\d{1,2})\/(\d{4})\)_\s*$/.exec(line);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

// Ce qui ressemble à la valeur d'un secret : une adresse e-mail, un jeton, une clé.
const SECRET_LIKE = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "une adresse e-mail"],
  [/\b(?:sk|pk|ghp|gho|xox[bap])[-_][A-Za-z0-9_-]{10,}/, "une clé d'API"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/, "un token Telegram"],
  [/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{24,}\b/, "une longue chaîne aléatoire"],
];

// project : l'audit porte sur les notes de ce projet (pas de faits « propres à un projet » à déplacer).
export function auditMemory(text, plan = { objectives: [] }, now = new Date(), project = null) {
  const facts = text.split("\n").filter((l) => l.startsWith("- "));
  const short = (l) => l.slice(2, 90).replace(/\s+/g, " ") + (l.length > 92 ? "…" : "");

  const stale = facts.filter((l) => {
    const d = noted(l);
    return d && (now - d) / 86_400_000 > STALE_DAYS;
  });

  // Un fait qui partage au moins deux mots porteurs avec le titre d'un objectif abandonné ou atteint.
  const closed = (plan.objectives ?? []).filter((o) => o.status === "dropped" || o.status === "reached");
  const aboutClosed = [];
  for (const line of facts) {
    const w = words(line);
    const o = closed.find((obj) => [...words(obj.title ?? "")].filter((x) => w.has(x)).length >= 2);
    if (o) aboutClosed.push({ fact: line, objective: o });
  }

  // Un fait de la mémoire globale qui ne parle que d'un projet ouvert : sa place est dans ses notes.
  const open = project ? [] : (plan.objectives ?? []).filter((o) => o.status === "active" || o.status === "paused");
  const projectSpecific = [];
  for (const line of facts) {
    if (aboutClosed.some((a) => a.fact === line)) continue;
    const w = words(line);
    const o = open.find((obj) => [...words(obj.title ?? "")].filter((x) => w.has(x)).length >= 2);
    if (o) projectSpecific.push({ fact: line, objective: o });
  }

  // Quasi-doublons : beaucoup de mots en commun (indice de Jaccard).
  const duplicates = [];
  const sets = facts.map(words);
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = sets[i];
      const b = sets[j];
      if (a.size < 4 || b.size < 4) continue;
      const common = [...a].filter((x) => b.has(x)).length;
      if (common / (a.size + b.size - common) >= 0.5) duplicates.push([facts[i], facts[j]]);
    }
  }

  const secretLike = [];
  for (const line of facts) {
    const hit = SECRET_LIKE.find(([re]) => re.test(line.replace(/\{\{[^}]*\}\}/g, "")));
    if (hit) secretLike.push({ fact: line, what: hit[1] });
  }

  return {
    facts: facts.length,
    stale,
    aboutClosed,
    duplicates,
    secretLike,
    projectSpecific,
    // Une ligne par constat, pour doctor.
    lines: [
      ...secretLike.map((s) => ["❌", "mémoire : valeur sensible ?", `${s.what} dans « ${short(s.fact)} » : un secret n'a rien à faire en mémoire`]),
      ...aboutClosed.map((a) => ["⚠️", "mémoire : objectif clos", `« ${short(a.fact)} » parle de « ${a.objective.title} » (${a.objective.status === "dropped" ? "abandonné" : "atteint"}) : encore utile ?`]),
      ...projectSpecific.map((p) => ["⚠️", "mémoire : propre à un projet", `« ${short(p.fact)} » ne concerne que « ${p.objective.title} » : à déplacer dans ses notes (remember project: ${p.objective.id})`]),
      ...duplicates.map(([a, b]) => ["⚠️", "mémoire : doublon ?", `« ${short(a)} » / « ${short(b)} »`]),
      ...(stale.length ? [["⚠️", "mémoire : faits anciens", `${stale.length} noté(s) il y a plus de ${STALE_DAYS} jours : à revérifier, ou à demander à la personne`]] : []),
    ],
  };
}
