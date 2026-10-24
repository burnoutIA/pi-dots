// Échéances des tâches planifiées (outil `schedule`), calculées sans le modèle.

export interface Schedule {
  id: string;
  prompt: string;
  every?: number; // minutes
  at?: string; // HH:MM, heure locale
  days?: number[]; // 0 = dimanche … 6 = samedi, avec `at`
  once?: string; // date ISO
  catchUp?: boolean; // échue pendant un arrêt : lancée au démarrage (par défaut oui)
  paused?: boolean;
  lastRun?: string;
  nextRun: string;
}

// Prochaine échéance strictement après `from` ; null quand il n'y en a plus (tâche unique faite).
export function nextAfter(s: Schedule, from: Date): Date | null {
  if (s.once) return s.lastRun ? null : new Date(s.once);
  if (s.every) return new Date(from.getTime() + s.every * 60_000);
  if (s.at) {
    const [h, m] = s.at.split(":").map(Number);
    const candidate = new Date(from);
    candidate.setHours(h, m, 0, 0);
    for (let i = 0; i < 8; i += 1) {
      if (candidate > from && (!s.days?.length || s.days.includes(candidate.getDay()))) return candidate;
      candidate.setDate(candidate.getDate() + 1);
    }
  }
  return null;
}
