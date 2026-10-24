// Lecture de mails en IMAP, pour le coffre : lecture seule par construction.
//
// Le coffre ne parle IMAP qu'avec ces commandes : LOGIN, LIST, EXAMINE (ouvre un dossier en
// consultation, sans rien pouvoir y changer), UID SEARCH, UID FETCH avec BODY.PEEK (lit sans
// marquer comme lu), LOGOUT. Aucune commande d'écriture n'existe ici : ni STORE, ni COPY, ni MOVE,
// ni EXPUNGE, ni APPEND. Connexion chiffrée (TLS) seulement.

import tls from "node:tls";

const TIMEOUT_MS = 30_000;
const MAX_MESSAGE = 2 * 1024 * 1024;

const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// Date IMAP : 23-Oct-2026
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function imapDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error(`date invalide : ${value}`), { status: 400 });
  return `${d.getDate()}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

class Session {
  constructor(host, port, address) {
    this.buffer = Buffer.alloc(0);
    this.waiting = null;
    this.tag = 0;
    this.socket = tls.connect({ host: address, port, servername: host });
    this.socket.setTimeout(TIMEOUT_MS, () => this.socket.destroy(new Error("délai dépassé")));
    this.socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.pump();
    });
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => this.fail(new Error("connexion fermée par le serveur")));
  }

  fail(error) {
    const w = this.waiting;
    this.waiting = null;
    w?.reject(error);
  }

  // Lit une réponse complète : lignes et littéraux {n}, jusqu'à la ligne étiquetée (ou le salut).
  pump() {
    const w = this.waiting;
    if (!w) return;
    for (;;) {
      if (w.literal !== null) {
        if (this.buffer.length < w.literal) return;
        w.current.literals.push(this.buffer.subarray(0, w.literal).toString("utf8"));
        w.current.text += "\u0000";
        this.buffer = this.buffer.subarray(w.literal);
        w.literal = null;
        continue;
      }
      const nl = this.buffer.indexOf("\r\n");
      if (nl < 0) return;
      const line = this.buffer.subarray(0, nl).toString("utf8");
      this.buffer = this.buffer.subarray(nl + 2);
      w.current.text += line;
      const lit = /\{(\d+)\}$/.exec(line);
      if (lit) {
        const size = Number(lit[1]);
        if (size > MAX_MESSAGE) return this.socket.destroy(new Error("message trop gros"));
        w.literal = size;
        continue;
      }
      const done = w.current;
      w.current = { text: "", literals: [] };
      if (w.tag === null || done.text.startsWith(`${w.tag} `)) {
        this.waiting = null;
        if (w.tag !== null && !/^\S+ OK/i.test(done.text)) return w.reject(Object.assign(new Error(`le serveur a refusé : ${done.text.replace(/^\S+ /, "")}`), { status: 502 }));
        return w.resolve(w.untagged);
      }
      w.untagged.push(done);
    }
  }

  read(tag) {
    return new Promise((resolve, reject) => {
      this.waiting = { tag, resolve, reject, untagged: [], current: { text: "", literals: [] }, literal: null };
      this.pump();
    });
  }

  greeting() {
    return this.read(null);
  }

  command(text) {
    const tag = `d${++this.tag}`;
    const answer = this.read(tag);
    this.socket.write(`${tag} ${text}\r\n`);
    return answer;
  }

  close() {
    try {
      this.socket.write(`d${++this.tag} LOGOUT\r\n`);
    } catch {}
    this.socket.end();
  }
}

function fetchFields(response) {
  const t = response.text;
  return {
    uid: Number(/UID (\d+)/.exec(t)?.[1]),
    flags: /FLAGS \(([^)]*)\)/.exec(t)?.[1]?.split(" ").filter(Boolean) ?? [],
    date: /INTERNALDATE "([^"]+)"/.exec(t)?.[1],
    size: Number(/RFC822\.SIZE (\d+)/.exec(t)?.[1] ?? 0),
    literal: response.literals[0] ?? "",
  };
}

// action : folders | search | fetch. Renvoie des données brutes (en-têtes, message RFC 822) :
// le décodage (MIME, encodages) est laissé à l'appelant.
export async function readMail({ host, port, address, user, password, action, folder = "INBOX", query = {}, uids = [], limit = 20 }) {
  const session = new Session(host, port, address);
  try {
    await session.greeting();
    await session.command(`LOGIN ${quote(user)} ${quote(password)}`);

    if (action === "folders") {
      const lines = await session.command(`LIST "" "*"`);
      return { folders: lines.map((l) => /"([^"]*)"\s*$/.exec(l.text)?.[1] ?? l.text.split(" ").pop()).filter(Boolean) };
    }

    await session.command(`EXAMINE ${quote(folder)}`);

    if (action === "search") {
      const criteria = [];
      if (query.since) criteria.push(`SINCE ${imapDate(query.since)}`);
      if (query.before) criteria.push(`BEFORE ${imapDate(query.before)}`);
      if (query.from) criteria.push(`FROM ${quote(query.from)}`);
      if (query.subject) criteria.push(`SUBJECT ${quote(query.subject)}`);
      if (query.text) criteria.push(`TEXT ${quote(query.text)}`);
      if (query.unseen) criteria.push("UNSEEN");
      const found = (await session.command(`UID SEARCH ${criteria.join(" ") || "ALL"}`))
        .flatMap((l) => (/^\* SEARCH/i.test(l.text) ? l.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/).filter(Boolean).map(Number) : []));
      const chosen = found.slice(-Math.max(1, Math.min(Number(limit) || 20, 200)));
      if (!chosen.length) return { folder, total: 0, messages: [] };
      const lines = await session.command(`UID FETCH ${chosen.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])`);
      const messages = lines.filter((l) => /FETCH \(/i.test(l.text)).map(fetchFields).map(({ literal, ...m }) => ({ ...m, headers: literal.trim() }));
      return { folder, total: found.length, messages: messages.sort((a, b) => b.uid - a.uid) };
    }

    if (action === "fetch") {
      const list = uids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 20);
      if (!list.length) throw Object.assign(new Error("fetch : donne des uids (numéros renvoyés par search)"), { status: 400 });
      const lines = await session.command(`UID FETCH ${list.join(",")} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])`);
      return { folder, messages: lines.filter((l) => /FETCH \(/i.test(l.text)).map(fetchFields).map(({ literal, ...m }) => ({ ...m, raw: literal })) };
    }

    throw Object.assign(new Error("action : folders, search ou fetch"), { status: 400 });
  } finally {
    session.close();
  }
}
