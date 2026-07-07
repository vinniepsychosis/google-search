# Project: google-search (Vinnie's fork)

Playwright-based Google search tool, exposed three ways: a **CLI**, an **MCP server**, and an **HTTP REST API**.

## Repo / Git

- **origin** → `https://github.com/vinniepsychosis/google-search` (Vinnie's fork — push here)
- **upstream** → `https://github.com/web-agent-master/google-search` (original — pull updates from here)
- Use `GH_CONFIG_DIR=~/.config/gh-personal gh` for all GitHub operations.
- Active feature branch: `feat/tier1-rich-results-and-api`.

### Commit workflow
- Never commit directly on `main`; branch first (`feat/*`, `fix/*`).
- Commit at logical checkpoints once a unit of work builds + is verified.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Push to `origin` (the fork). Open PRs against `main` of the fork.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Compile TS → `dist/` |
| `npm run dev -- "<query>"` | Run CLI via ts-node |
| `npm start -- "<query>"` | Run built CLI |
| `npm run mcp` / `mcp:build` | Run MCP server (stdio) |
| `npm run api` / `api:build` | Run HTTP API server |

CLI flags: `--limit <n>`, `--page <n>` (1-based), `--timeout <ms>`, `--get-html`, `--save-html`.

## HTTP API (src/api-server.ts)

- `GET /health`
- `GET /search?q=...&engine=google&limit=10&page=1&timeout=30000` (`engine`: google|bing|duckduckgo|brave|all)
- `POST /search` `{ "query", "engine", "limit", "page", "timeout" }`
- `GET /html?q=...&save=true`
- Env: `PORT` (default 3000), `HOST` (default 0.0.0.0).
- Uses one shared browser; each request gets its own context (closed after use).

## Architecture notes

- `src/engines.ts` — engine-agnostic `search()` entry point. Routes `google` to `googleSearch()`; routes `bing`/`duckduckgo`/`brave` to `searchOtherEngine()` (shared pagination loop, block detection, per-engine extractors, same rich-result schema); routes `all` to `searchAllEngines()`. CLI/MCP/API all call `search()`.
- **`engine=all` (meta-engine):** queries every engine in parallel (`Promise.allSettled`), merges + dedupes by normalized URL, and ranks by cross-engine consensus (more engines agreeing → higher; best position as tie-break). Each result carries a `sources: SearchEngine[]`; the response adds `enginesUsed[]` / `enginesFailed[]`. Resilient — a blocked engine is skipped, not fatal, unless *all* fail.
- `src/stealth.ts` — anti-bot layer for the non-Google engines, built on **`playwright-extra` + `puppeteer-extra-plugin-stealth`**. `launchStealthBrowser()` registers the plugin once and launches bundled Chromium (portable); `createStealthSession()` sets a plausible desktop context (viewport/locale/timezone) + cookie persistence and injects **no** manual init-scripts. This replaced the old hand-rolled `navigator.webdriver`/`window.chrome`/WebGL overrides, whose *inconsistency* was exactly what tripped Bing's anti-bot on the pagination request.
- **Engine status:** Google ✅, Bing ✅ (headless multi-page, no IP cooldown, via homepage human-flow + click-Next), DuckDuckGo ✅. Brave ✅ **after a one-time solve** — it runs an *active* Turnstile-style "verify you're not a bot" challenge that can't be cleared headless, so run `--engine brave --solve` once (opens a headed window; click Verify), which saves the `search.brave.com` clearance cookie; headless Brave then works (multi-page verified) until the cookie expires. `--engine <google|bing|duckduckgo|brave>`. Solve options: `--solve` (deliberate: skips headless retries, straight to a headed window, and redirects the default state file to the shared `~/.google-search-browser-state.json` so the API/MCP servers reuse the clearance); `--headed-solve` (auto-fallback to headed only after headless retries fail). `DEBUG_BLOCK=1` logs anti-bot signature matches.
- `src/search.ts` — `googleSearch()` (paginates via `&start=`, cross-page dedup, rich results with `position`/`domain`, best-effort `peopleAlsoAsk`/`relatedSearches`) and `getGoogleSearchPageHtml()`. **Throws** on real failure (no fake "Search failed" result).
- Result shape: `{ query, results[], peopleAlsoAsk?, relatedSearches?, pagination }` — see `src/types.ts`.
- Anti-bot: saved browser state + fingerprint at `~/.google-search-browser-state.json`; auto-switches to headed mode on CAPTCHA.
- CLI numeric options use an explicit `(v) => parseInt(v, 10)` coercion — a bare `parseInt` receives commander's default as the radix and corrupts the value.

## Backlog (agreed roadmap)

- Tier 2: `fetch-page` tool (search → read → synthesize) via Readability/jsdom.
- Tier 3: context pool, TTL cache, backoff, multi-engine fallback.
- Tier 4: proxy support/rotation.
- Tier 5: Vitest + fixture-based extractor tests, GitHub Actions CI.
