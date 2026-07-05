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
- `GET /search?q=...&limit=10&page=1&timeout=30000`
- `POST /search` `{ "query", "limit", "page", "timeout" }`
- `GET /html?q=...&save=true`
- Env: `PORT` (default 3000), `HOST` (default 0.0.0.0).
- Uses one shared browser; each request gets its own context (closed after use).

## Architecture notes

- `src/search.ts` — `googleSearch()` (paginates via `&start=`, cross-page dedup, rich results with `position`/`domain`, best-effort `peopleAlsoAsk`/`relatedSearches`) and `getGoogleSearchPageHtml()`. **Throws** on real failure (no fake "Search failed" result).
- Result shape: `{ query, results[], peopleAlsoAsk?, relatedSearches?, pagination }` — see `src/types.ts`.
- Anti-bot: saved browser state + fingerprint at `~/.google-search-browser-state.json`; auto-switches to headed mode on CAPTCHA.
- CLI numeric options use an explicit `(v) => parseInt(v, 10)` coercion — a bare `parseInt` receives commander's default as the radix and corrupts the value.

## Backlog (agreed roadmap)

- Tier 2: `fetch-page` tool (search → read → synthesize) via Readability/jsdom.
- Tier 3: context pool, TTL cache, backoff, multi-engine fallback.
- Tier 4: proxy support/rotation.
- Tier 5: Vitest + fixture-based extractor tests, GitHub Actions CI.
