import * as fs from "fs";
import * as path from "path";
import type { IncomingMessage, ServerResponse, Server } from "http";
import type { Logger } from "./RemoteLogger";

/**
 * EE2 repo root `tablet_tier_overrides.json` (sibling of `main/`), not cwd-dependent.
 * Runtime `__dirname` is `main/dist` after build.
 */
export const DEFAULT_TIER_OVERRIDES_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "tablet_tier_overrides.json",
);

const TIER_OVERRIDES_REVISION = 1;

function emptyDoc() {
  return {
    revision: TIER_OVERRIDES_REVISION,
    updatedAt: 0,
    modTiersByBase: {} as Record<string, unknown>,
    comboByBase: {} as Record<string, unknown>,
  };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 8_000_000) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.once("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (!raw) {
          resolve(null);
          return;
        }
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
    req.once("error", () => resolve(null));
  });
}

function writeJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body, null, 2));
}

function tryWriteTierOverridesFile(
  outPath: string,
  doc: unknown,
  logger: Logger,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const abs = path.resolve(outPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    fs.renameSync(tmp, abs);
    logger.write(`info [TabletTierOverridesApi] wrote ${abs}`);
    return { ok: true, path: abs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.write(`error [TabletTierOverridesApi] write failed: ${msg}`);
    return { ok: false, error: msg };
  }
}

function loadTierOverridesFile(filePath: string): {
  doc: unknown;
  exists: boolean;
} {
  try {
    if (!fs.existsSync(filePath)) {
      return { doc: emptyDoc(), exists: false };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    return { doc: raw ?? emptyDoc(), exists: true };
  } catch {
    return { doc: emptyDoc(), exists: false };
  }
}

function resolveOutPath(url: URL, body: Record<string, unknown> | null): string {
  const fromBody =
    body && typeof body.out === "string" && body.out.trim()
      ? body.out.trim()
      : null;
  const fromQuery = url.searchParams.get("out");
  return path.resolve(fromBody || fromQuery || DEFAULT_TIER_OVERRIDES_PATH);
}

function extractDoc(body: unknown): unknown | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  if (rec.doc != null) return rec.doc;
  if (rec.tierOverrides != null) return rec.tierOverrides;
  if (
    rec.revision != null &&
    (rec.modTiersByBase != null || rec.comboByBase != null)
  ) {
    return body;
  }
  return null;
}

/**
 * Localhost REST for repo-persisted tablet tier overrides.
 *
 *   GET  /api/tablet-tier-overrides?out=tablet_tier_overrides.json
 *   POST /api/tablet-tier-overrides   body: TabletTierOverridesDocument | { doc }
 */
export function addTabletTierOverridesRoutes(
  httpServer: Server,
  logger: Logger,
) {
  httpServer.addListener("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/api/tablet-tier-overrides") return;

    if (req.method === "GET") {
      const outPath = resolveOutPath(url, null);
      const { doc, exists } = loadTierOverridesFile(outPath);
      writeJson(res, 200, {
        ok: true,
        path: outPath,
        exists,
        doc,
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const outPath = resolveOutPath(
        url,
        body && typeof body === "object"
          ? (body as Record<string, unknown>)
          : null,
      );
      const doc = extractDoc(body);
      if (doc == null) {
        writeJson(res, 400, {
          ok: false,
          error: "Missing tier-overrides document",
        });
        return;
      }
      const write = tryWriteTierOverridesFile(outPath, doc, logger);
      if (!write.ok) {
        writeJson(res, 500, { ok: false, error: write.error, path: outPath });
        return;
      }
      writeJson(res, 200, { ok: true, path: write.path });
      return;
    }

    writeJson(res, 405, { error: "Method not allowed" });
  });
}
