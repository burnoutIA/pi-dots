// Les runs de travail : un pi lancé à part, et le point d'étape qui l'empêche de s'acharner.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { describeCall, writeLive } from "./live.ts";
import { log } from "./log.ts";
import { modelUnavailable } from "./outage.ts";
import { CHECKPOINT_TURNS, FAIL_STREAK, LIVE_FILE, LOOP_REPEATS, RUN_MINUTES, RUN_TOKENS, WORKSPACE } from "./common.ts";

// --- Un run de travail : un pi à part, dans la session donnée ------------------------------------

// Le run est journalisé de bout en bout : début, fin, durée, tours, outils appelés, jetons, et
// « loop.suspect » dès qu'un même appel d'outil (même nom, mêmes arguments) se répète
// LOOP_REPEATS fois de suite.
// exposed : le run part de quelque chose venu d'une session exposée (voir injection.ts) ; il démarre exposé.
export interface RunInfo { label: string; kind: string; session: string; objective?: string; todo?: string; exposed?: string }

export interface RunResult { ok: boolean; text: string; unavailable: boolean }

export function runWorker(prompt: string, info: RunInfo): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    log("run.start", { ...info });
    // Le tableau de bord du run, pour ./dot suivre et /suivre.
    const live: any = { status: "running", label: info.label, kind: info.kind, started: new Date(started).toISOString(), turns: 0, tokens: 0, steps: [] };
    writeLive(LIVE_FILE, live);
    const extensions = (process.env.DOT_PI_EXTENSIONS ?? "").trim().split(/\s+/).filter(Boolean);
    // La session nommée garde son ancien modèle : celui du .dot est passé explicitement.
    const model = [...(process.env.DOT_PROVIDER ? ["--provider", process.env.DOT_PROVIDER] : []), ...(process.env.DOT_MODEL ? ["--model", process.env.DOT_MODEL] : [])];
    const child = spawn("pi", [...extensions, ...model, "-p", "--mode", "json", "--session-id", info.session, "--", prompt], {
      cwd: WORKSPACE,
      env: { ...process.env, DOT_ROLE: "worker", DOT_OBJECTIVE: info.objective ?? "", DOT_SESSION: info.session, DOT_EXPOSED: info.exposed ?? "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let buffer = "";
    let errors = "";
    let timedOut = false;
    const stats = { turns: 0, toolCalls: 0, tools: {} as Record<string, number>, tokensIn: 0, tokensOut: 0, maxRepeat: 0 };
    const seen = new Map<string, number>(); // appel (nom + arguments) → nombre de fois dans ce run
    let loopStopped = false;
    let capped = false; // plafond de jetons atteint

    function onEvent(event: any) {
      if (event.type === "turn_end") {
        stats.turns += 1;
        live.turns = stats.turns;
        writeLive(LIVE_FILE, live);
      }
      const m = event.type === "message_end" ? event.message : null;
      if (m?.role !== "assistant") return;
      stats.tokensIn += Number(m.usage?.input ?? 0) + Number(m.usage?.cacheRead ?? 0);
      stats.tokensOut += Number(m.usage?.output ?? 0);
      live.tokens = stats.tokensIn + stats.tokensOut;
      // Plafond de jetons : la durée seule laisse filer une impasse coûteuse (beaucoup de tours sur un
      // gros contexte) et coupe à tort un travail long mais sobre.
      if (live.tokens > RUN_TOKENS && !capped && !loopStopped) {
        capped = true;
        log("run.capped", { ...info, tokens: live.tokens, limit: RUN_TOKENS, turns: stats.turns });
        errors = `run arrêté : plafond de ${RUN_TOKENS} jetons atteint (${stats.turns} tours)`;
        child.kill("SIGTERM");
      }
      for (const call of (m.content ?? []).filter((c: any) => c.type === "toolCall")) live.steps.push({ t: new Date().toISOString(), label: describeCall(call.name, call.arguments) });
      live.steps = live.steps.slice(-60);
      writeLive(LIVE_FILE, live);
      const t = (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n").trim();
      if (t) text = t;
      if (m.errorMessage) errors = String(m.errorMessage);
      for (const call of (m.content ?? []).filter((c: any) => c.type === "toolCall")) {
        stats.toolCalls += 1;
        stats.tools[call.name] = (stats.tools[call.name] ?? 0) + 1;
        // Même appel répété dans le run, à la suite ou non (A, B, A, B…) : c'est une boucle, le run
        // est arrêté. Le travail n'est pas perdu : un todo reste en cours, un événement en file.
        const signature = `${call.name} ${JSON.stringify(call.arguments ?? {})}`;
        const repeat = (seen.get(signature) ?? 0) + 1;
        seen.set(signature, repeat);
        stats.maxRepeat = Math.max(stats.maxRepeat, repeat);
        if (repeat >= LOOP_REPEATS && !loopStopped) {
          loopStopped = true;
          log("loop.suspect", { ...info, repeat, call: signature.slice(0, 300), sinceStartS: Math.round((Date.now() - started) / 1000), stopped: true });
          errors = `run arrêté : boucle (${call.name} répété ${repeat} fois)`;
          child.kill("SIGTERM");
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          onEvent(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (errors = (errors + String(chunk)).slice(-2000)));
    const timer = setTimeout(() => {
      timedOut = true;
      errors = `run arrêté après ${RUN_MINUTES} min`;
      child.kill("SIGTERM");
    }, RUN_MINUTES * 60_000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const ok = code === 0 && !!text && !loopStopped && !capped;
      // SIGKILL sans dépassement de durée : en général, le noyau a tué pi faute de mémoire.
      const killed = signal === "SIGKILL" && !timedOut ? "tué par le système (mémoire ?)" : undefined;
      const result = capped || loopStopped ? `${errors}${text ? `\nDernier état : ${text}` : ""}` : text || killed || errors.trim() || `pi s'est arrêté (code ${code})`;
      const unavailable = modelUnavailable({ ok, tokensOut: stats.tokensOut, toolCalls: stats.toolCalls, error: errors });
      log("run.end", {
        ...info,
        ok,
        code,
        signal: signal ?? undefined,
        timedOut: timedOut || undefined,
        loopStopped: loopStopped || undefined,
        capped: capped || undefined,
        durationS: Math.round((Date.now() - started) / 1000),
        ...stats,
        error: ok ? undefined : (killed ?? errors.trim().slice(0, 500)) || undefined,
        report: text.slice(0, 300) || undefined,
        modelUnavailable: unavailable || undefined,
      });
      Object.assign(live, { status: ok ? "done" : "failed", ended: new Date().toISOString(), result: result.slice(0, 400) });
      writeLive(LIVE_FILE, live);
      resolve({ ok, text: result, unavailable });
    });
  });
}

// Point d'étape dans un run : tous les CHECKPOINT_TURNS tours, ou dès FAIL_STREAK échecs d'outil
// d'affilée (quinze façons différentes de rater la même chose ne sont pas une boucle « identique »),
// le run se demande ce qu'il a obtenu. Le plafond de jetons reste la limite dure.
export function checkpoints(pi: ExtensionAPI) {
  let turns = 0;
  let sinceCheck = 0;
  let failures = 0;
  pi.on("tool_result", (event: any) => {
    failures = event.isError ? failures + 1 : 0;
  });
  pi.on("turn_end", () => {
    turns += 1;
    sinceCheck += 1;
    const failing = failures >= FAIL_STREAK;
    if (sinceCheck < CHECKPOINT_TURNS && !failing) return;
    log("run.checkpoint", { turns, reason: failing ? "échecs" : "tours", failures });
    sinceCheck = 0;
    failures = 0;
    const content = [
      `[dot:point d'étape] ${failing ? `Tes ${FAIL_STREAK} dernières actions ont échoué.` : `Tu en es à ${turns} tours dans ce run.`}`,
      "Fais le point, en une phrase : qu'as-tu obtenu de concret depuis le dernier point ?",
      "- Tu avances : continue.",
      "- Tu essaies encore une variante de la même approche, ou tu n'as rien obtenu : arrête-toi. Garde ce que tu as, note dans les notes du projet ce qui ne marche pas et pourquoi, mets le todo en attente avec ta question (`todo` wait) ou termine avec ce que tu as, puis fais ton compte-rendu.",
    ].join("\n");
    try {
      pi.sendMessage({ customType: "dot-checkpoint", content, display: true }, { deliverAs: "steer" });
    } catch (error: any) {
      log("run.checkpoint", { error: String(error?.message ?? error) });
    }
  });
}
