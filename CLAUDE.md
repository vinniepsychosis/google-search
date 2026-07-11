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

CLI flags: `--limit <n>`, `--page <n>` (1-based), `--timeout <ms>`, `--get-html`, `--save-html`, `--images`.

`--images` runs a **Google Images** search (`udm=2`) instead of web results, returning `{ query, images[], pagination }`. Also exposed as the `google-image-search` MCP tool (stdio + HTTP).

## HTTP API (src/api-server.ts)

- `GET /health`
- `GET /search?q=...&limit=10&page=1&timeout=30000`
- `POST /search` `{ "query", "limit", "page", "timeout" }`
- `GET /html?q=...&save=true`
- Env: `PORT` (default 3000), `HOST` (default 0.0.0.0), `GOOGLE_SEARCH_NO_HEADED` (set to `1` by the `api`/`mcp` npm scripts — see below).
- Each request launches its **own fresh browser** (via `googleSearch`), then closes it. A single long-lived shared browser was tried but is deferred to Tier 3 (context pool) — see the anti-bot note below for why fresh-per-request is safer.

## Architecture notes

- `src/search.ts` — `googleSearch()` (paginates via `&start=`, cross-page dedup, rich results with `position`/`domain`, best-effort `answerBox`, `sportsMatches`, `weather`, `peopleAlsoAsk`/`relatedSearches`) and `getGoogleSearchPageHtml()`. **Throws** on real failure (no fake "Search failed" result).
- Result shape: `{ query, results[], answerBox?, sportsMatches?, weather?, peopleAlsoAsk?, relatedSearches?, pagination }` — see `src/types.ts`.
- Structured widgets (`sportsMatches`, `weather`) are parsed from Google's immersive cards and **supersede** the flattened `answerBox` blob of the same kind (the redundant `sports`/`weather` answerBox is dropped when the structured form is present).
- `imageSearch()` — Google Images (`udm=2`). Returns `ImageResult[]` with full-res `imageUrl` + `width`/`height` parsed from the page's **inline JSON** (each image entry is `[0,"docid",[thumbUrl,h,w],[originalUrl,h,w],…]`, joined to the DOM grid cell `div[data-attrid="images universal"]` by its `data-docid`), plus a gstatic `thumbnail`, `sourcePage` (`data-lpage`), and `source` name. Images is infinite-scroll, so **pagination is by scrolling**: it accumulates `page*limit` unique results (dedup by docid) then slices the requested page; `pagination.scrolls`/`hasMore` report the effort. On CAPTCHA it fails fast (no headed fallback in v1 — warm via the web CLI or `warm:profile`).
- CLI numeric options use an explicit `(v) => parseInt(v, 10)` coercion — a bare `parseInt` receives commander's default as the radix and corrupts the value.
- **`page.evaluate` scripts must be shipped as STRINGS, not functions.** tsx/esbuild's `keepNames` wraps named nested arrows (e.g. `const uniq = …`) in `__name(...)` calls; serialized into the browser they throw `__name is not defined`. `answerBoxScript`, `auxBlocksScript`, `sportsWidgetScript`, and `weatherWidgetScript` are string literals for this reason. `extractPageResults` gets away with being a function only because it has no nested named arrows.

### Anti-bot state (why servers can 500 with a CAPTCHA)

- Shared state file for **all three entry points**: `DEFAULT_STATE_FILE` = `~/.google-search-browser-state.json` (exported from `src/search.ts`; CLI `--state-file` and both servers default to it). A warm session saved by any one benefits the others. `<file>-fingerprint.json` sits alongside it.
- **The CLI can self-heal; the servers cannot.** On a CAPTCHA the CLI falls back to **headed** mode so you solve it once and the session is saved warm. The MCP/API servers run headless with **no human**, so `npm run api`/`npm run mcp` set `GOOGLE_SEARCH_NO_HEADED=1` → on a CAPTCHA they **fail fast** with a clean error (`CaptchaBlockedError`, HTTP 502) instead of hanging ~50s trying to pop a headed window.
- Consequence: the servers depend on a **warm** state file. A cold/stale file → CAPTCHA on every request → it re-saves the still-cold state → death spiral.
  - **Best warm-up — authenticated session (`npm run warm:profile`):** exports a logged-in Google account's cookies from the local Chrome profile into `~/.google-search-browser-state.json`. An authenticated session is trusted far more than an anonymous one and stays valid for weeks, so this is the most durable fix. `scripts/warm-from-chrome-profile.mjs` reads the macOS Keychain "Chrome Safe Storage" key (one-time "Allow" prompt), derives the AES key, and decrypts the cookie DB **directly** — it does NOT launch Chrome, because Playwright-launched Chrome uses `password-store=basic` and can't decrypt real cookies. Re-run when the session ages. Env `CHROME_PROFILE_DIR` (default `Default`) picks the profile; `Default` = `vinamrgrover@gmail.com`. Note: this signs the scraper in as that account (account-flag risk lives here).
  - **Fallback warm-up — anonymous:** run the CLI once and solve any CAPTCHA — `npm run dev -- "anything"`. Seeds an anonymous session; goes stale faster than the authenticated one.
- History: this is exactly why "search worked in the CLI but failed in the API/MCP" — they used to point at *different* state files (`./browser-state.json` vs `~/…`), so the servers never saw the CLI's warm session. Unifying the path fixed it.

## Backlog (agreed roadmap)

- Tier 2: `fetch-page` tool (search → read → synthesize) via Readability/jsdom.
- Tier 3: context pool, TTL cache, backoff, multi-engine fallback.
- Tier 4: proxy support/rotation.
- Tier 5: Vitest + fixture-based extractor tests, GitHub Actions CI.
