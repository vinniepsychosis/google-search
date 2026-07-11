#!/usr/bin/env node

import express, { Request, Response, NextFunction } from "express";
import { getGoogleSearchPageHtml, DEFAULT_STATE_FILE } from "./search.js";
import { search, SUPPORTED_ENGINES } from "./engines.js";
import { CommandOptions, SearchEngine } from "./types.js";
import logger from "./logger.js";

// Each request gets its OWN fresh browser (launched + closed inside search() /
// getGoogleSearchPageHtml). A shared long-lived browser was dropped because Google
// reliably CAPTCHAs a persistent headless instance; the shared-browser optimization is
// deferred to the Tier-3 context-pool work.
//
// IMPORTANT: this server can't solve CAPTCHAs (no human; headed fallback disabled via
// GOOGLE_SEARCH_NO_HEADED), so it depends on a WARM anti-bot session in DEFAULT_STATE_FILE
// (shared with the CLI — run the CLI once, or `npm run warm:profile`).
const stateFilePath = DEFAULT_STATE_FILE;

/**
 * Parse a positive integer query/body parameter, falling back to a default.
 */
function toPositiveInt(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/**
 * Coerce an engine parameter to a supported engine, defaulting to google.
 */
function toEngine(value: unknown): SearchEngine {
  const e = typeof value === "string" ? value.toLowerCase() : "";
  return (SUPPORTED_ENGINES as string[]).includes(e) ? (e as SearchEngine) : "google";
}

/**
 * Build search options from a request's merged query + body parameters.
 */
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
    engines: SUPPORTED_ENGINES,
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
    // No shared browser arg: each engine launches/closes its own fresh browser.
    const results = await search(query.trim(), options);
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

// GET /search?q=...&engine=...&limit=...&page=...&timeout=...
app.get("/search", (req, res) => {
  void handleSearch(req, res);
});

// POST /search  { "query": "...", "engine": "google", "limit": 10, "page": 1, "timeout": 30000 }
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

  const server = app.listen(port, host, () => {
    logger.info({ host, port }, "Google Search API server listening");
    // Also print to stdout for convenience when run directly
    console.log(`Google Search API listening on http://${host}:${port}`);
  });

  // Graceful shutdown
  const shutdown = (signal: string) => {
    logger.info({ signal }, "Shutting down API server...");
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
