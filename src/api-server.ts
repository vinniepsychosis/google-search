#!/usr/bin/env node

import express, { Request, Response, NextFunction } from "express";
import * as os from "os";
import * as path from "path";
import { chromium, Browser } from "playwright";
import { getGoogleSearchPageHtml } from "./search.js";
import { search, SUPPORTED_ENGINES } from "./engines.js";
import { CommandOptions, SearchEngine } from "./types.js";
import logger from "./logger.js";

// A single shared browser instance reused across requests. Each request gets its
// own browser context inside googleSearch(), so requests stay isolated.
let globalBrowser: Browser | undefined = undefined;

// State file shared by all requests (persists anti-bot fingerprint/session)
const stateFilePath = path.join(
  os.homedir(),
  ".google-search-browser-state.json"
);

// Chromium launch arguments tuned to avoid automation detection
const launchArgs = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-site-isolation-trials",
  "--disable-web-security",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-accelerated-2d-canvas",
  "--no-first-run",
  "--no-zygote",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-breakpad",
  "--disable-component-extensions-with-background-pages",
  "--disable-extensions",
  "--disable-features=TranslateUI",
  "--disable-ipc-flooding-protection",
  "--disable-renderer-backgrounding",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
];

/**
 * Parse a positive integer query/body parameter, falling back to a default.
 */
function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Build search options from a request's merged query + body parameters.
 */
function toEngine(value: unknown): SearchEngine {
  const e = typeof value === "string" ? value.toLowerCase() : "";
  return (SUPPORTED_ENGINES as string[]).includes(e) ? (e as SearchEngine) : "google";
}

function optionsFromParams(source: Record<string, unknown>): CommandOptions {
  const options: CommandOptions = {
    engine: toEngine(source.engine),
    limit: toPositiveInt(source.limit, 10),
    page: toPositiveInt(source.page, 1),
    timeout: toPositiveInt(source.timeout, 30000),
    stateFile: stateFilePath,
  };
  return options;
}

const app = express();
app.use(express.json());

// Simple request logging
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.info({ method: req.method, path: req.path }, "Incoming request");
  next();
});

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    browserReady: Boolean(globalBrowser),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

/**
 * Shared search handler for GET and POST.
 */
async function handleSearch(req: Request, res: Response): Promise<void> {
  const merged = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
  const query = (merged.q ?? merged.query) as string | undefined;

  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400).json({
      error: "Missing required parameter 'q' (or 'query')",
    });
    return;
  }

  const options = optionsFromParams(merged);

  try {
    // Google reuses the shared anti-bot browser; other engines manage their own context.
    const results = await search(query.trim(), options, globalBrowser);
    res.json(results);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "Search request failed");
    res.status(502).json({
      error: "Search failed",
      message,
    });
  }
}

// GET /search?q=...&limit=...&page=...&timeout=...
app.get("/search", (req, res) => {
  void handleSearch(req, res);
});

// POST /search  { "query": "...", "limit": 10, "page": 1, "timeout": 30000 }
app.post("/search", (req, res) => {
  void handleSearch(req, res);
});

/**
 * GET /html?q=...&save=true  - return the cleaned raw HTML of the results page.
 */
async function handleHtml(req: Request, res: Response): Promise<void> {
  const merged = { ...(req.query as Record<string, unknown>), ...(req.body ?? {}) };
  const query = (merged.q ?? merged.query) as string | undefined;

  if (!query || typeof query !== "string" || !query.trim()) {
    res.status(400).json({ error: "Missing required parameter 'q' (or 'query')" });
    return;
  }

  const options = optionsFromParams(merged);
  const save = merged.save === "true" || merged.save === true;

  try {
    // getGoogleSearchPageHtml launches and manages its own browser instance.
    const htmlResult = await getGoogleSearchPageHtml(query.trim(), options, save);
    res.json(htmlResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message }, "HTML request failed");
    res.status(502).json({ error: "Failed to fetch page HTML", message });
  }
}

app.get("/html", (req, res) => {
  void handleHtml(req, res);
});

// 404 fallback
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

async function main() {
  const port = toPositiveInt(process.env.PORT, 3000);
  const host = process.env.HOST || "0.0.0.0";

  try {
    logger.info("Initializing the shared browser instance...");
    globalBrowser = await chromium.launch({
      headless: true,
      args: launchArgs,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    logger.info("Shared browser instance initialized successfully");
  } catch (error) {
    logger.error({ error }, "Failed to initialize the browser; exiting");
    process.exit(1);
  }

  const server = app.listen(port, host, () => {
    logger.info({ host, port }, "Google Search API server listening");
    // Also print to stdout for convenience when run directly
    console.log(`Google Search API listening on http://${host}:${port}`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down API server...");
    server.close();
    await cleanupBrowser();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function cleanupBrowser() {
  if (globalBrowser) {
    logger.info("Closing the shared browser instance...");
    try {
      await globalBrowser.close();
      globalBrowser = undefined;
      logger.info("Shared browser instance closed");
    } catch (error) {
      logger.error({ error }, "Error while closing the browser instance");
    }
  }
}

main();
