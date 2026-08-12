import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { IncomingMessage, ServerResponse, Server } from "http";
import type { ServerEvents } from "./server";
import type { Logger } from "./RemoteLogger";

type SurveyJobStatus =
  | "starting"
  | "running"
  | "complete"
  | "error"
  | "cancelled"
  | "paused";

type SurveyJob = {
  requestId: string;
  outPath: string | null;
  forceNew: boolean;
  status: SurveyJobStatus;
  detail: string;
  survey: unknown | null;
  startedAt: number;
  updatedAt: number;
  lastWriteAt: number;
  waiters: Array<{
    res: ServerResponse;
    mode: "wait" | "accepted";
  }>;
};

let activeJob: SurveyJob | null = null;

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 64_000) {
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve({});
          return;
        }
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.once("error", () => resolve({}));
  });
}

function parseBool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (s === "1" || s === "true" || s === "yes") return true;
    if (s === "0" || s === "false" || s === "no") return false;
  }
  return fallback;
}

function jobPublic(job: SurveyJob) {
  return {
    requestId: job.requestId,
    status: job.status,
    detail: job.detail,
    outPath: job.outPath,
    forceNew: job.forceNew,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    hasSurvey: job.survey != null,
  };
}

function writeJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function tryWriteSurveyFile(
  outPath: string,
  survey: unknown,
  logger: Logger,
  quiet = false,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Atomic-ish write
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ survey }, null, 2), "utf8");
    fs.renameSync(tmp, abs);
    if (!quiet) logger.write(`info [TabletSurveyApi] wrote ${abs}`);
    return { ok: true, path: abs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.write(`error [TabletSurveyApi] write failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

function loadSurveySeed(outPath: string): unknown | null {
  try {
    if (!fs.existsSync(outPath)) return null;
    const raw = JSON.parse(fs.readFileSync(outPath, "utf8")) as {
      survey?: unknown;
    };
    const s = raw.survey ?? raw;
    if (!s || typeof s !== "object") return null;
    const doc = s as {
      status?: string;
      observations?: Record<string, unknown>;
      revision?: number;
    };
    if (doc.status === "complete") return null;
    if (!doc.observations || Object.keys(doc.observations).length === 0) {
      if (doc.status === "error" || doc.status === "cancelled") return null;
    }
    return s;
  } catch {
    return null;
  }
}

function checkpoint(job: SurveyJob, logger: Logger, force = false) {
  if (!job.outPath || job.survey == null) return;
  const now = Date.now();
  if (!force && now - job.lastWriteAt < 750) return;
  job.lastWriteAt = now;
  tryWriteSurveyFile(job.outPath, job.survey, logger, true);
}

function finishWaiters(job: SurveyJob, logger: Logger) {
  let writeResult:
    | { ok: true; path: string }
    | { ok: false; error: string }
    | null = null;
  if (job.outPath && job.survey != null) {
    writeResult = tryWriteSurveyFile(job.outPath, job.survey, logger);
    job.lastWriteAt = Date.now();
  }
  const payload = {
    ...jobPublic(job),
    write: writeResult,
    survey: job.survey,
  };
  const code =
    job.status === "error" ? 500 : job.status === "paused" ? 202 : 200;
  for (const w of job.waiters) {
    if (w.res.writableEnded) continue;
    writeJson(w.res, code, payload);
  }
  job.waiters = [];
}

/**
 * Localhost REST for Breach tablet tier survey (renderer runs trade queries).
 *
 *   POST /api/tablet-tier-survey?force=1&out=...&wait=1
 *   GET  /api/tablet-tier-survey
 *   POST /api/tablet-tier-survey/cancel
 */
export function addTabletTierSurveyRoutes(
  httpServer: Server,
  events: ServerEvents,
  logger: Logger,
) {
  events.onEventAnyClient("CLIENT->MAIN::tablet-tier-survey", (payload) => {
    if (!activeJob || activeJob.requestId !== payload.requestId) return;
    activeJob.status = payload.status === "running" ? "running" : payload.status;
    activeJob.detail = payload.detail ?? activeJob.detail;
    activeJob.updatedAt = Date.now();
    if (payload.survey !== undefined) activeJob.survey = payload.survey;
    // D: checkpoint every progress update
    if (payload.status === "running") {
      checkpoint(activeJob, logger);
    }
    if (payload.status !== "running") {
      finishWaiters(activeJob, logger);
    }
  });

  httpServer.addListener("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/api/tablet-tier-survey")) return;

    if (
      req.method === "POST" &&
      url.pathname === "/api/tablet-tier-survey/cancel"
    ) {
      if (activeJob) {
        events.sendEventTo("broadcast", {
          name: "MAIN->CLIENT::tablet-tier-survey",
          payload: {
            requestId: activeJob.requestId,
            action: "cancel",
          },
        });
        activeJob.status = "cancelled";
        activeJob.detail = "Cancel requested";
        activeJob.updatedAt = Date.now();
        finishWaiters(activeJob, logger);
      }
      writeJson(res, 200, {
        ok: true,
        job: activeJob ? jobPublic(activeJob) : null,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tablet-tier-survey") {
      if (!activeJob) {
        writeJson(res, 404, { error: "No survey job" });
        return;
      }
      writeJson(res, 200, {
        ...jobPublic(activeJob),
        survey: activeJob.survey,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tablet-tier-survey") {
      const body = await readJsonBody(req);
      const forceNew = parseBool(
        body.force ?? url.searchParams.get("force"),
        true,
      );
      const wait = parseBool(body.wait ?? url.searchParams.get("wait"), true);
      const outRaw =
        (typeof body.out === "string" && body.out) ||
        url.searchParams.get("out") ||
        null;
      const outPath = outRaw ? path.resolve(outRaw) : null;

      if (
        activeJob &&
        (activeJob.status === "starting" || activeJob.status === "running")
      ) {
        writeJson(res, 409, {
          error: "Survey already running",
          job: jobPublic(activeJob),
        });
        return;
      }

      const seed =
        !forceNew && outPath ? loadSurveySeed(outPath) : null;

      const requestId = randomUUID();
      const job: SurveyJob = {
        requestId,
        outPath,
        forceNew,
        status: "starting",
        detail: seed
          ? "Resuming from checkpoint…"
          : "Dispatching to overlay…",
        survey: seed,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        lastWriteAt: 0,
        waiters: [],
      };
      activeJob = job;

      events.sendEventTo("broadcast", {
        name: "MAIN->CLIENT::tablet-tier-survey",
        payload: {
          requestId,
          action: "start",
          forceNew,
          outPath: outPath ?? undefined,
          seed: seed ?? undefined,
        },
      });

      logger.write(
        `info [TabletSurveyApi] start requestId=${requestId} force=${forceNew} resume=${!!seed} out=${outPath ?? "(none)"}`,
      );

      if (wait) {
        job.waiters.push({ res, mode: "wait" });
        req.on("close", () => {
          job.waiters = job.waiters.filter((w) => w.res !== res);
        });
        return;
      }

      writeJson(res, 202, jobPublic(job));
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" });
  });
}

/** After overlay connects, optionally auto-start from `--run-tablet-survey=path`. */
export function maybeAutostartTabletSurveyFromArgv(
  events: ServerEvents,
  logger: Logger,
) {
  const flag = process.argv.find((a) => a.startsWith("--run-tablet-survey"));
  if (!flag) return;
  const outPath = flag.includes("=")
    ? path.resolve(flag.split("=").slice(1).join("="))
    : path.resolve("breach_survey.json");

  let started = false;
  const kick = () => {
    if (started) return;
    started = true;
    const seed = loadSurveySeed(outPath);
    const requestId = randomUUID();
    activeJob = {
      requestId,
      outPath,
      forceNew: !seed,
      status: "starting",
      detail: seed
        ? "Autostart resume from checkpoint"
        : "Autostart from --run-tablet-survey",
      survey: seed,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      lastWriteAt: 0,
      waiters: [],
    };
    events.sendEventTo("broadcast", {
      name: "MAIN->CLIENT::tablet-tier-survey",
      payload: {
        requestId,
        action: "start",
        forceNew: !seed,
        outPath,
        seed: seed ?? undefined,
      },
    });
    logger.write(`info [TabletSurveyApi] autostart → ${outPath}`);
  };

  events.onEventAnyClient("CLIENT->MAIN::used-recently", () => {
    setTimeout(kick, 1500);
  });
  setTimeout(kick, 8000);
}
