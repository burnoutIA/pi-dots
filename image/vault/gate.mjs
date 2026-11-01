// La file d'attente des appels au modèle. La conversation et les runs du dot passent tous par le coffre :
// c'est ici qu'ils se rencontrent, sans avoir à coopérer. Un serveur local ne sert vraiment bien
// qu'un contexte à la fois ; deux appels en parallèle se disputent son cache et ralentissent tout.
//
//   - un appel à la fois (slots), les autres attendent leur tour ;
//   - la conversation passe avant les runs : la personne attend, un run peut attendre ;
//   - juste après un appel de la conversation, son appel suivant (le tour continue après un outil)
//     garde la priorité quelques secondes (graceMs) : un run ne s'intercale pas au milieu d'un tour ;
//   - un appel qui ne rend pas la main (flux bloqué) libère sa place au bout de holdMs.
//
// Le rôle vient de l'en-tête x-dot-role que pi ajoute aux appels (DOT_ROLE : « worker » pour un run).

export function createGate({ slots = 1, graceMs = 4000, holdMs = 15 * 60_000, onHoldExpired = () => {} } = {}) {
  let busy = 0;
  let lastConversation = 0;
  let timer = null;
  const queue = [];
  const isRun = (role) => role === "worker";

  function pump() {
    while (busy < slots && queue.length) {
      let i = queue.findIndex((w) => !isRun(w.role));
      if (i < 0) {
        const wait = lastConversation + graceMs - Date.now();
        if (wait > 0) {
          if (!timer) timer = setTimeout(() => ((timer = null), pump()), wait);
          return;
        }
        i = 0;
      }
      const [waiter] = queue.splice(i, 1);
      start(waiter);
    }
  }

  function start(waiter) {
    busy += 1;
    let done = false;
    const hold = setTimeout(() => {
      onHoldExpired(waiter.role);
      release();
    }, holdMs);
    hold.unref?.();
    function release() {
      if (done) return;
      done = true;
      clearTimeout(hold);
      busy -= 1;
      if (!isRun(waiter.role)) lastConversation = Date.now();
      pump();
    }
    waiter.resolve({ release, waitedMs: Date.now() - waiter.since, ahead: waiter.ahead });
  }

  // Attend une place. Rend { release, waitedMs, ahead } ; cancel() retire de la file un appel abandonné.
  function acquire(role = "") {
    let waiter;
    const promise = new Promise((resolve) => {
      waiter = { role, since: Date.now(), ahead: busy + queue.length, resolve };
      queue.push(waiter);
    });
    const cancel = () => {
      const i = queue.indexOf(waiter);
      if (i >= 0) queue.splice(i, 1);
    };
    pump();
    return { promise, cancel };
  }

  return { acquire, enabled: slots > 0, state: () => ({ busy, waiting: queue.map((w) => w.role || "conversation") }) };
}
