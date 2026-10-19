import { createServer as nodeCreateServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { MailSlurpClient } from "./mailslurp.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "..", "public");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 150_000;
const RUN_TTL = 12 * 60 * 60 * 1000;
export const TARGETS = [
  { id: "gmail_chromium_web", title: "Gmail Web", platform: "Desktop" },
  { id: "outlook_classic_windows", title: "Outlook Classic", platform: "Windows" },
  { id: "outlook_chromium_web", title: "Outlook Web", platform: "Desktop" },
  { id: "ios_mail_physical_device", title: "Apple Mail", platform: "iPhone" },
  { id: "gmail_android_emulator", title: "Gmail", platform: "Android" },
  { id: "outlook_new_windows", title: "New Outlook", platform: "Windows" },
];
const TARGET_IDS = new Set(TARGETS.map((t) => t.id));
const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function writeJson(res, status, value) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_BODY) throw new HttpError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Expected a JSON request body.");
  }
}

function validatePreview(body) {
  const subject = body?.subject;
  const html = body?.html;
  const targets = body?.targets;
  if (typeof subject !== "string" || !subject.trim() || subject.length > 200) {
    throw new HttpError(400, "Subject must be 1–200 characters.");
  }
  if (typeof html !== "string" || !html.trim() || html.length > 120_000) {
    throw new HttpError(400, "HTML must be 1–120,000 characters.");
  }
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 6 ||
      new Set(targets).size !== targets.length || targets.some((t) => !TARGET_IDS.has(t))) {
    throw new HttpError(400, "Choose 1–6 supported email clients.");
  }
  return { subject: subject.trim(), html, targets };
}

export function normalizeResults(runId, payload) {
  const run = payload?.run || payload?.devicePreviewRun || {};
  const targets = Array.isArray(payload?.targets) ? payload.targets : [];
  const targetLookup = new Map(targets.map((target) => [target.id || target.targetId, target]));
  const screenshots = Array.isArray(payload?.screenshots) ? payload.screenshots : [];
  return {
    runId,
    status: run.status || payload?.status || "PENDING",
    targets: targets.map((target) => ({
      id: target.id || target.targetId || target.targetKey,
      name: target.displayName || target.name || target.targetKey || target.provider || "Email client",
      status: target.status || "PENDING",
      error: target.errorMessage || null,
    })),
    screenshots: screenshots.filter((shot) => UUID.test(shot.screenshotId || shot.id || "")).map((shot) => {
      const id = shot.screenshotId || shot.id;
      const target = targetLookup.get(shot.targetId) || {};
      return {
        id,
        title: shot.displayName || shot.targetName || target.displayName || target.name ||
          shot.targetKey || target.targetKey || "Email preview",
        status: shot.status || "COMPLETED",
        imageUrl: `/api/runs/${runId}/screenshots/${id}`,
      };
    }),
  };
}

export function createApp({ client, configured = true } = {}) {
  const mail = client || (configured ? new MailSlurpClient({ apiKey: process.env.MAILSLURP_API_KEY }) : null);
  const runs = new Map();
  let activeCreates = 0;
  const purgeRuns = () => {
    for (const [key, entry] of runs) if (Date.now() - entry.createdAt > RUN_TTL) runs.delete(key);
  };

  return nodeCreateServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url || "/", "http://localhost").pathname;
      if (req.method === "GET" && STATIC_FILES[path]) {
        const [filename, type] = STATIC_FILES[path];
        const bytes = await readFile(join(PUBLIC, filename));
        res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
        res.end(bytes);
        return;
      }
      if (path === "/api/health" && req.method === "GET") {
        return writeJson(res, 200, { configured: Boolean(mail) });
      }
      if (path === "/api/targets" && req.method === "GET") {
        return writeJson(res, 200, { targets: TARGETS });
      }
      if (path.startsWith("/api/") && !mail) throw new HttpError(503, "Set MAILSLURP_API_KEY on the server.");
      purgeRuns();

      if (path === "/api/preview" && req.method === "POST") {
        // Local-only by default, and prevent ordinary browser cross-site form abuse.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${req.headers.host}` &&
            origin !== `https://${req.headers.host}`) {
          throw new HttpError(403, "Cross-origin requests are not allowed.");
        }
        if (activeCreates >= 2) throw new HttpError(429, "Two previews are already starting.");
        const input = validatePreview(await readJson(req));
        activeCreates++;
        try {
          const run = await mail.sendAndStartPreview(input);
          if (!UUID.test(run.runId)) throw new Error("MailSlurp returned an invalid run ID.");
          runs.set(run.runId, { createdAt: Date.now(), screenshots: new Set() });
          return writeJson(res, 201, run);
        } finally {
          activeCreates--;
        }
      }

      const match = path.match(/^\/api\/runs\/([0-9a-f-]+)(?:\/screenshots\/([0-9a-f-]+))?$/i);
      if (match && req.method === "GET" && UUID.test(match[1]) &&
          (!match[2] || UUID.test(match[2]))) {
        const [, runId, screenshotId] = match;
        const entry = runs.get(runId);
        if (!entry) throw new HttpError(404, "Preview not found (possibly after server restart).");
        if (screenshotId) {
          if (!entry.screenshots.has(screenshotId)) throw new HttpError(404, "Screenshot not found.");
          const { bytes, contentType } = await mail.getScreenshot(runId, screenshotId);
          res.writeHead(200, {
            "Content-Type": contentType,
            "Content-Length": bytes.length,
            "Cache-Control": "private, max-age=60",
          });
          res.end(bytes);
          return;
        }
        const details = normalizeResults(runId, await mail.getResults(runId));
        entry.screenshots = new Set(details.screenshots.map((s) => s.id));
        return writeJson(res, 200, details);
      }

      throw new HttpError(404, "Not found.");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error?.status === 429 ? 429 : 502);
      writeJson(res, status, {
        error: error instanceof HttpError ? error.message :
          (error?.status ? `MailSlurp API returned HTTP ${error.status}.` :
           error?.message || "MailSlurp request failed."),
      });
    }
  });
}
