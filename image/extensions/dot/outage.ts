// Panne du modèle : un run qui échoue sans que le modèle ait pu produire quoi que ce soit, sur une
// erreur de connexion ou de service indisponible. Ce n'est pas un échec du travail : on ne compte
// pas l'essai, on met en pause et on réessaie de plus en plus espacé.

const UNAVAILABLE = /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|Connection error|connect(ion)? (refused|timed out)|\b50[234]\b|service unavailable|bad gateway|overloaded/i;

export interface RunOutcome {
  ok: boolean;
  tokensOut: number;
  toolCalls: number;
  error?: string;
}

export function modelUnavailable(run: RunOutcome): boolean {
  return !run.ok && run.tokensOut === 0 && run.toolCalls === 0 && UNAVAILABLE.test(run.error ?? "");
}

// 2, 4, 8 puis 15 minutes entre deux essais.
export function retryMinutes(tries: number): number {
  return Math.min(15, 2 ** Math.max(1, tries));
}
