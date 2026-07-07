import { Browser } from "playwright";
import * as os from "os";
import * as path from "path";
import { SearchResponse, SearchResult, CommandOptions, SearchEngine } from "./types.js";
import { googleSearch } from "./search.js";
import { createStealthSession, launchStealthBrowser } from "./stealth.js";
import logger from "./logger.js";

/** A real, single search engine (everything except the "all" meta-engine). */
type RealEngine = Exclude<SearchEngine, "all">;
/** A real non-Google engine — the ones the multi-engine driver handles. */
type OtherEngine = Exclude<SearchEngine, "google" | "all">;

interface EngineDef {
  id: OtherEngine;
  label: string;
  perPage: number;
  /** Homepage visited first to establish cookies (warm-up), like a real user. */
  warmupUrl?: string;
  /** Build the results-page URL for a query, 0-based result offset, and 0-based page index. */
  url: (query: string, start: number, pageIdx: number) => string;
  /** Primary selector to wait for before extracting (best-effort). */
  waitSelector: string;
  /**
   * Pin a launch channel (real installed Chrome/Edge) instead of bundled
   * Chromium. Usually unnecessary — the stealth plugin makes bundled Chromium
   * pass — so leave undefined unless an engine specifically needs the real
   * binary. Falls back to bundled Chromium if the channel isn't installed.
   */
  channel?: "chrome" | "msedge";
  /**
   * Search like a human instead of hitting a results URL directly — the exact
   * strategy the Google path uses: open the homepage, type the query into the
   * search box, press Enter, and page via the "Next" link. A direct
   * `/search?q=` navigation with no form submission is a classic scraper tell;
   * this flow carries a real referer + interaction, so anti-bot trusts it. This
   * is what makes Bing reliable headless across multiple pages.
   */
  humanFlow?: {
    homeUrl: string;
    /** Candidate selectors for the homepage search box. */
    searchBox: string[];
    /** Selector(s) for the "next page" link on the results page. */
    nextPage: string;
  };
}

const ENGINE_DEFS: Record<OtherEngine, EngineDef> = {
  bing: {
    id: "bing",
    label: "Bing",
    perPage: 10,
    // Fallback direct URL (used only if the human flow can't find the box).
    url: (q, start) =>
      `https://www.bing.com/search?q=${encodeURIComponent(q)}` +
      (start ? `&first=${start + 1}` : ""),
    waitSelector: "#b_results",
    humanFlow: {
      homeUrl: "https://www.bing.com/",
      searchBox: ["#sb_form_q", "textarea[name='q']", "input[name='q']"],
      nextPage: "a.sb_pagN, a[title='Next page'], a[aria-label='Next page']",
    },
  },
  duckduckgo: {
    id: "duckduckgo",
    label: "DuckDuckGo",
    perPage: 20,
    warmupUrl: "https://duckduckgo.com/",
    // The no-JS HTML endpoint is stable and easy to parse.
    url: (q, start) =>
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` +
      (start ? `&s=${start}&dc=${start + 1}` : ""),
    waitSelector: "#links",
  },
  brave: {
    id: "brave",
    label: "Brave",
    perPage: 20,
    warmupUrl: "https://search.brave.com/",
    url: (q, _start, pageIdx) =>
      `https://search.brave.com/search?q=${encodeURIComponent(q)}&offset=${pageIdx}&spellcheck=0&source=web`,
    waitSelector: "#results",
    // Brave runs an active Turnstile-style "verify you're not a bot" challenge
    // that detects Playwright-driven *bundled* Chromium. The real installed
    // Chrome binary has a far better chance of clearing it during a headed solve
    // (falls back to bundled Chromium if Chrome isn't installed).
    channel: "chrome",
  },
};

/** Per-engine state file so each engine keeps its own cookie jar / fingerprint. */
function engineStateFile(base: string | undefined, engine: string): string {
  const b = base || path.join(os.homedir(), ".google-search-browser-state.json");
  return b.replace(/\.json$/, `-${engine}.json`);
}

/** Small randomized delay to look less scripted. */
function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Body-text signatures that mean an engine served an anti-bot challenge/block. */
const BLOCK_SIGNATURES = [
  "one last step",
  "solve the challenge",
  "verifying you're not a bot",
  "unusual traffic",
  "are you a robot",
  "verify you are a human",
  "anonymized error code",
  "if this persists",
  "captcha",
];

/** Thrown when a headless attempt hits a challenge, to trigger the headed retry. */
class ChallengeError extends Error {
  constructor(public engineLabel: string) {
    super(`${engineLabel} anti-bot challenge`);
    this.name = "ChallengeError";
  }
}

/** Read the (lowercased, truncated) body text and test it for block signatures. */
async function pageLooksBlocked(page: import("playwright").Page): Promise<boolean> {
  const bodyText = (
    await page.evaluate(() => document.body?.innerText || "").catch(() => "")
  )
    .toLowerCase()
    .slice(0, 800);
  const hit = BLOCK_SIGNATURES.find((s) => bodyText.includes(s));
  if (process.env.DEBUG_BLOCK) {
    logger.info(
      { hit: hit || "none", url: page.url(), sample: bodyText.slice(0, 200).replace(/\s+/g, " ") },
      "pageLooksBlocked check"
    );
  }
  return !!hit;
}

/**
 * Per-engine result extractor. Runs in the browser context, so it must be
 * self-contained (no closures over Node values other than `args`).
 */
function extractEngineResults(args: {
  engine: string;
  maxResults: number;
  exclude: string[];
}): { title: string; link: string; snippet: string }[] {
  const { engine, maxResults, exclude } = args;
  const results: { title: string; link: string; snippet: string }[] = [];
  const seen = new Set<string>(exclude);

  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();

  // DuckDuckGo HTML endpoint wraps links in a redirect: /l/?uddg=<encoded>
  const resolveDdg = (href: string): string => {
    try {
      const u = new URL(href, location.href);
      const uddg = u.searchParams.get("uddg");
      return uddg ? decodeURIComponent(uddg) : href;
    } catch {
      return href;
    }
  };

  // Bing wraps every result link in its click tracker: /ck/a?...&u=a1<base64url>.
  // Decode the `u` param back to the real destination (else the bing.com filter
  // below throws away every organic result).
  const resolveBing = (href: string): string => {
    try {
      const u = new URL(href, location.href);
      if (!/^www\.bing\.com$/.test(u.hostname) || !u.pathname.startsWith("/ck/a")) return href;
      const uu = u.searchParams.get("u");
      if (!uu || !uu.startsWith("a1")) return href;
      const b64 = uu.slice(2).replace(/-/g, "+").replace(/_/g, "/");
      const decoded = atob(b64);
      return /^https?:\/\//.test(decoded) ? decoded : href;
    } catch {
      return href;
    }
  };

  const push = (title: string, link: string, snippet: string) => {
    title = clean(title);
    snippet = clean(snippet);
    if (!title || !link || !link.startsWith("http") || seen.has(link)) return;
    // Skip engine-internal / navigational links
    if (/(^|\.)(bing|duckduckgo|brave|microsoft|msn|google)\.com\//.test(link) && engine !== "google") {
      // allow result links that merely mention these only if nothing else — keep simple: skip
      if (!/duckduckgo\.com\/l\//.test(link)) return;
    }
    seen.add(link);
    results.push({ title, link, snippet });
  };

  if (engine === "bing") {
    document.querySelectorAll("#b_results > li.b_algo").forEach((li) => {
      if (results.length >= maxResults) return;
      const a = li.querySelector("h2 a") as HTMLAnchorElement | null;
      if (!a) return;
      const snippet =
        clean(li.querySelector(".b_caption p")?.textContent) ||
        clean(li.querySelector(".b_algoSlug")?.textContent) ||
        clean(li.querySelector("p")?.textContent);
      push(a.textContent || "", resolveBing(a.href), snippet);
    });
  } else if (engine === "duckduckgo") {
    document.querySelectorAll(".result, .web-result").forEach((res) => {
      if (results.length >= maxResults) return;
      const a = res.querySelector("a.result__a") as HTMLAnchorElement | null;
      if (!a) return;
      const link = resolveDdg(a.href);
      const snippet = clean(res.querySelector(".result__snippet")?.textContent);
      push(a.textContent || "", link, snippet);
    });
  } else if (engine === "brave") {
    // Organic web results are exactly `[data-type="web"]` (20/page). We must NOT
    // also match bare `.snippet`, which pulls in the AI answer (#llm-snippet) and
    // the "standalone" discussion/"More on reddit" clusters — non-organic noise.
    document.querySelectorAll('#results [data-type="web"]').forEach((res) => {
      if (results.length >= maxResults) return;
      const a = res.querySelector("a[href^='http']") as HTMLAnchorElement | null;
      if (!a) return;
      const title =
        clean(res.querySelector(".title")?.textContent) || clean(a.textContent);
      // Description class has churned (svelte hashes); try current + legacy.
      const snippet = clean(
        res.querySelector(".generic-snippet, .snippet-description, .snippet-content, .desc")
          ?.textContent
      );
      push(title, a.href, snippet);
    });
  }

  // Generic fallback: only when the engine-specific extractor found NOTHING on
  // this page (its selectors broke). It must not "top up" a page that already
  // yielded results — harvesting loose anchors pulls in nav/related junk AND
  // fills the limit from page 1, starving pagination of the pages it should
  // fetch for more organic results.
  if (results.length === 0) {
    const scope =
      document.querySelector("#b_results, #links, #results, #main, body") || document.body;
    const anchors = Array.from(scope.querySelectorAll("a[href^='http']")) as HTMLAnchorElement[];
    for (const a of anchors) {
      if (results.length >= maxResults) break;
      let link = a.href;
      if (engine === "duckduckgo") link = resolveDdg(link);
      else if (engine === "bing") link = resolveBing(link);
      const title = clean(a.textContent);
      if (!title || title.length < 3) continue;
      // walk up for a snippet
      let snippet = "";
      let parent: Element | null = a.parentElement;
      for (let i = 0; i < 3 && parent; i++) {
        const t = clean(parent.textContent);
        if (t.length > 20 && t !== title) {
          snippet = t;
          break;
        }
        parent = parent.parentElement;
      }
      push(title, link, snippet);
    }
  }

  return results.slice(0, maxResults);
}

function domainOf(link: string): string {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Search a non-Google engine (Bing / DuckDuckGo / Brave) with pagination and
 * the same rich result schema as the Google path.
 */
async function searchOtherEngine(
  query: string,
  engine: OtherEngine,
  options: CommandOptions,
  // Engines always launch their own stealth browser (the plugin's evasions must
  // be present on every page), so a shared vanilla browser can't be reused here.
  _existingBrowser?: Browser
): Promise<SearchResponse> {
  const def = ENGINE_DEFS[engine];
  const { limit = 10, page: pageNum = 1, timeout = 30000, locale = "en-US", noSaveState } = options;
  const stateFile = engineStateFile(options.stateFile, engine);

  const blockError = () =>
    new Error(
      `${def.label} appears to be blocking automated requests (anti-bot challenge). ` +
        `Try engine=google or engine=bing.`
    );

  /**
   * Run one full search attempt. In headless mode a challenge throws
   * ChallengeError so the caller can retry headed; in headed mode we pause and
   * let the user solve the challenge, then continue (mirroring the Google path).
   */
  async function attempt(headless: boolean): Promise<SearchResponse> {
    // Always own the browser: the stealth plugin's evasions live on the launched
    // browser's pages, and a headed retry can never reuse a headless browser.
    const browser = await launchStealthBrowser(headless, def.channel);
    const { context, page, save } = await createStealthSession(browser, {
      stateFile,
      locale,
      noSaveState,
    });

    try {
      // Warm up: visit the engine homepage first to pick up cookies, like a real
      // user. Skipped for human-flow engines — their homepage visit is step 1 of
      // the search itself.
      if (def.warmupUrl && !def.humanFlow) {
        try {
          await page.goto(def.warmupUrl, { waitUntil: "domcontentloaded", timeout });
          await page.waitForTimeout(jitter(400, 900));
        } catch (e) {
          logger.warn({ engine, error: (e as Error).message }, "Warm-up navigation failed (continuing)");
        }
      }

      const perPage = def.perPage;
      const startPageIdx = Math.max(1, pageNum) - 1;
      const maxPages = Math.max(1, Math.ceil(limit / perPage));

      const collected: { title: string; link: string; snippet: string }[] = [];
      const seen = new Set<string>();
      let pagesFetched = 0;
      let lastYield = 0;
      // Set only if a page *after* the first is genuinely challenged. With the
      // stealth plugin Bing paginates cleanly, so this normally stays false; it's
      // kept as a graceful fallback so a late challenge returns the results we
      // already have instead of discarding a good first page.
      let paginationBlocked = false;

      // Resolve an anti-bot block on the current page: bail to a headed retry
      // when headless; when headed, wait (polling, so we survive the challenge's
      // own page reloads) for the user to solve it.
      const handleBlock = async (): Promise<void> => {
        if (headless) throw new ChallengeError(def.label);
        logger.warn(
          { engine },
          "Anti-bot challenge shown — please solve it in the opened browser window; waiting..."
        );
        // Manual solving needs real wall-clock time; give at least 3 minutes
        // regardless of the (network-oriented) per-nav timeout.
        const deadline = Date.now() + Math.max(timeout * 3, 180000);
        while (Date.now() < deadline) {
          await page.waitForTimeout(1500);
          const stillBlocked = await pageLooksBlocked(page).catch(() => true);
          if (stillBlocked) continue;
          const hasContainer = await page
            .$(def.waitSelector)
            .then((el) => !!el)
            .catch(() => false);
          if (hasContainer) {
            logger.info({ engine }, "Challenge cleared; continuing the search");
            return;
          }
        }
        throw blockError();
      };

      // Extract results, tolerating a late anti-bot redirect that can destroy
      // the execution context mid-evaluate (a challenge redirect does this).
      const extract = async (remaining: number) => {
        const run = () =>
          page.evaluate(extractEngineResults, {
            engine,
            maxResults: remaining,
            exclude: Array.from(seen),
          });
        try {
          return await run();
        } catch (e) {
          if (!/execution context was destroyed|navigation/i.test((e as Error).message)) throw e;
          await page.waitForTimeout(1200); // let the redirect settle
          if (await pageLooksBlocked(page)) await handleBlock();
          return run();
        }
      };

      // --- Google-style human search flow (for engines with humanFlow) ---------
      // Open the homepage, type the query into the search box, press Enter. This
      // is what makes Google reliable headless; a direct /search?q= navigation is
      // the scraper tell we were tripping on.
      const humanSearch = async (): Promise<boolean> => {
        const hf = def.humanFlow!;
        await page.goto(hf.homeUrl, { waitUntil: "domcontentloaded", timeout });
        await page.waitForTimeout(jitter(500, 1100));
        let box = null;
        for (const sel of hf.searchBox) {
          box = await page.$(sel);
          if (box) break;
        }
        if (!box) {
          try {
            await page.waitForSelector(hf.searchBox[0], { timeout: timeout / 3 });
            box = await page.$(hf.searchBox[0]);
          } catch {
            /* fall through */
          }
        }
        if (!box) return false;
        await box.click();
        await page.keyboard.type(query, { delay: jitter(20, 60) });
        await page.waitForTimeout(jitter(120, 320));
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => {}),
          page.keyboard.press("Enter"),
        ]);
        await page.waitForTimeout(500);
        return true;
      };

      // Click the results-page "Next" link like a human. false = no next page.
      const clickNext = async (): Promise<boolean> => {
        const hf = def.humanFlow!;
        const link = await page.$(hf.nextPage);
        if (!link) return false;
        await page.waitForTimeout(jitter(1400, 2800)); // human beat before paging
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout }).catch(() => {}),
          link.click().catch(() => {}),
        ]);
        await page.waitForTimeout(400);
        return true;
      };

      // Land on 0-based results page `pageIdx`. Human flow: submit from the
      // homepage, then click Next to reach deeper pages. Direct engines: navigate
      // the results URL. Returns false when there's no further page.
      const gotoResultsPage = async (pageIdx: number, isFirst: boolean): Promise<boolean> => {
        if (def.humanFlow) {
          if (isFirst) {
            const ok = await humanSearch();
            if (!ok) {
              logger.warn({ engine }, "Search box not found; falling back to direct URL");
              await page.goto(def.url(query, pageIdx * perPage, pageIdx), {
                waitUntil: "domcontentloaded",
                timeout,
              });
            }
            for (let k = 0; k < pageIdx; k++) {
              if (!(await clickNext())) return false;
            }
            return true;
          }
          return clickNext();
        }
        // Direct engines (DuckDuckGo / Brave): navigate the results URL.
        if (!isFirst) await page.waitForTimeout(jitter(1400, 2800));
        await page.goto(def.url(query, pageIdx * perPage, pageIdx), {
          waitUntil: "domcontentloaded",
          timeout,
        });
        return true;
      };

      for (let p = 0; p < maxPages; p++) {
        const pageIdx = startPageIdx + p;
        logger.info({ engine, page: pageIdx + 1 }, "Fetching results page");
        const advanced = await gotoResultsPage(pageIdx, p === 0);
        if (!advanced) break;

        // Let any anti-bot redirect settle before we touch the DOM, so we detect
        // the block instead of crashing on it.
        await page.waitForTimeout(1000);
        if (await pageLooksBlocked(page)) {
          // First-page block = real failure: throw so the caller retries (fresh
          // context) or, if opted in, opens a headed window to solve it. A block
          // on a *later* page: keep the results we already have rather than
          // discarding a good first page.
          if (p === 0 || collected.length === 0) {
            await handleBlock();
          } else {
            paginationBlocked = true;
            logger.info(
              { engine, page: pageIdx + 1, gathered: collected.length },
              "Deeper page challenged; returning results gathered so far"
            );
            break;
          }
        }

        try {
          await page.waitForSelector(def.waitSelector, { timeout: timeout / 2 });
        } catch {
          // Some engines render fine without the exact container; continue to extract.
        }
        await page.waitForTimeout(300);

        const remaining = limit - collected.length;
        let pageResults = await extract(remaining);
        pagesFetched++;
        lastYield = pageResults.length;

        // Empty page 0 may be a block that didn't match a signature up front.
        if (p === 0 && pageResults.length === 0 && (await pageLooksBlocked(page))) {
          await handleBlock();
          pageResults = await extract(remaining);
          lastYield = pageResults.length;
          if (pageResults.length === 0) throw blockError();
        }

        for (const r of pageResults) {
          if (collected.length >= limit) break;
          if (seen.has(r.link)) continue;
          seen.add(r.link);
          collected.push(r);
        }

        if (collected.length >= limit) break;
        if (lastYield === 0) break;
      }

      const results: SearchResult[] = collected.slice(0, limit).map((r, i) => ({
        position: startPageIdx * perPage + i + 1,
        title: r.title,
        link: r.link,
        domain: domainOf(r.link),
        snippet: r.snippet,
      }));

      logger.info({ engine, count: results.length, pagesFetched }, "Engine search complete");

      // Persist cookies + fingerprint so subsequent runs look like a returning user.
      await save();

      return {
        query,
        engine,
        results,
        pagination: {
          page: Math.max(1, pageNum),
          requestedLimit: limit,
          returned: results.length,
          pagesFetched,
          // More results exist if we filled the limit with a non-empty last page,
          // or if a deeper page was challenged (results are there, just walled).
          hasMore: paginationBlocked || (lastYield > 0 && results.length >= limit),
        },
      };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  // Deliberate one-time solve (--solve): skip the doomed headless retries and go
  // straight to a headed window so the user can clear an *active* challenge
  // (Brave). attempt(false) persists the clearance via save(); afterwards normal
  // headless runs reuse the cookie from the engine's state file.
  if (options.solveChallenge) {
    if (noSaveState) {
      throw new Error(
        `${def.label}: --solve needs to save the cleared session, but state saving is disabled ` +
          `(remove --no-save-state).`
      );
    }
    logger.info(
      { engine, stateFile },
      "Solve mode: opening a headed window. Solve the challenge in it; the clearance will be saved for future headless runs."
    );
    return await attempt(false);
  }

  // With the stealth plugin the deterministic headless block is gone, but an
  // engine may still throw a *stochastic* challenge on a fraction of requests.
  // Retry headless with backoff — each attempt is a brand-new context/browser,
  // so the retry is automatically a clean identity — before giving up.
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const MAX_HEADLESS_ATTEMPTS = 3;
  for (let i = 0; i < MAX_HEADLESS_ATTEMPTS; i++) {
    try {
      return await attempt(true);
    } catch (e) {
      if (!(e instanceof ChallengeError)) throw e;
      if (i < MAX_HEADLESS_ATTEMPTS - 1) {
        const backoff = jitter(1500, 3000) * (i + 1);
        logger.warn(
          { engine, attempt: i + 1, backoffMs: backoff },
          "Anti-bot challenge; retrying headless after backoff"
        );
        await delay(backoff);
        continue;
      }
      // Exhausted headless retries. Only pop a visible window if explicitly
      // opted in (headedSolve); otherwise surface the block as an error.
      if (options.headedSolve && !noSaveState) {
        logger.warn(
          { engine },
          "Headless retries exhausted; opening a headed window for a one-time manual solve (headedSolve=true)"
        );
        return await attempt(false);
      }
      throw blockError();
    }
  }
  // Unreachable (loop either returns or throws), but satisfies the type checker.
  throw blockError();
}

export const SUPPORTED_ENGINES: SearchEngine[] = ["google", "bing", "duckduckgo", "brave", "all"];

/** Real engines the "all" meta-engine queries, in priority order (used as the
 * tie-breaker when two engines rank a shared URL identically). */
const AGGREGATE_ENGINES: RealEngine[] = ["google", "bing", "duckduckgo", "brave"];

/**
 * Normalize a URL for cross-engine dedup: drop the fragment and common tracking
 * params, lowercase the host, strip a leading "www." and any trailing slash.
 * Two links that normalize equal are treated as the same result.
 */
function normalizeLink(link: string): string {
  try {
    const u = new URL(link);
    u.hash = "";
    for (const p of [
      "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
      "ref", "fbclid", "gclid", "mc_cid", "mc_eid",
    ]) {
      u.searchParams.delete(p);
    }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    const path = u.pathname.replace(/\/+$/, "");
    const search = u.search ? u.search : "";
    return `${u.protocol}//${host}${path}${search}`.toLowerCase();
  } catch {
    return link.toLowerCase();
  }
}

/**
 * Meta-engine: query every real engine in parallel and merge their results into
 * one deduped, ranked list. Ranking rewards cross-engine consensus — a URL that
 * several engines returned outranks one only a single engine found — with each
 * URL's best (lowest) position across engines as the tie-breaker. Resilient: an
 * engine that fails (e.g. Brave without a valid clearance cookie) is recorded in
 * `enginesFailed` and simply omitted, as long as at least one engine succeeds.
 */
async function searchAllEngines(
  query: string,
  options: CommandOptions,
  existingBrowser?: Browser
): Promise<SearchResponse> {
  const limit = options.limit ?? 10;

  interface Merged {
    title: string;
    link: string;
    domain: string;
    snippet: string;
    sources: SearchEngine[];
    bestPosition: number;
  }

  logger.info({ engines: AGGREGATE_ENGINES, limit }, "Aggregate search across all engines");

  // Fetch `limit` from each engine so the merged pool is rich; slice to `limit`
  // after ranking. Google reuses the shared browser (API path); the rest launch
  // their own stealth browsers. allSettled so one blocked engine can't fail all.
  const settled = await Promise.allSettled(
    AGGREGATE_ENGINES.map((e) =>
      search(
        query,
        { ...options, engine: e },
        e === "google" ? existingBrowser : undefined
      )
    )
  );

  const merged = new Map<string, Merged>();
  const enginesUsed: SearchEngine[] = [];
  const enginesFailed: { engine: SearchEngine; error: string }[] = [];

  settled.forEach((res, i) => {
    const eng = AGGREGATE_ENGINES[i];
    if (res.status === "rejected") {
      const error = res.reason instanceof Error ? res.reason.message : String(res.reason);
      enginesFailed.push({ engine: eng, error });
      logger.warn({ engine: eng, error }, "Engine failed during aggregate search (skipped)");
      return;
    }
    enginesUsed.push(eng);
    for (const r of res.value.results) {
      const key = normalizeLink(r.link);
      const existing = merged.get(key);
      if (existing) {
        if (!existing.sources.includes(eng)) existing.sources.push(eng);
        existing.bestPosition = Math.min(existing.bestPosition, r.position);
        // Keep the richest snippet / a non-empty title across engines.
        if ((r.snippet?.length || 0) > (existing.snippet?.length || 0)) existing.snippet = r.snippet;
        if (!existing.title && r.title) existing.title = r.title;
      } else {
        merged.set(key, {
          title: r.title,
          link: r.link,
          domain: r.domain,
          snippet: r.snippet,
          sources: [eng],
          bestPosition: r.position,
        });
      }
    }
  });

  // Every engine failed → surface a real error so the caller (API) returns 502.
  if (enginesUsed.length === 0) {
    throw new Error(
      `All engines failed for aggregate search: ` +
        enginesFailed.map((f) => `${f.engine} (${f.error})`).join("; ")
    );
  }

  const priority = (e: SearchEngine) => AGGREGATE_ENGINES.indexOf(e as RealEngine);
  const ranked = [...merged.values()].sort(
    (a, b) =>
      b.sources.length - a.sources.length || // more engines agreed → higher
      a.bestPosition - b.bestPosition || // else best rank across engines
      priority(a.sources[0]) - priority(b.sources[0]) // stable tie-break
  );

  const results: SearchResult[] = ranked.slice(0, limit).map((m, i) => ({
    position: i + 1,
    title: m.title,
    link: m.link,
    domain: m.domain,
    snippet: m.snippet,
    sources: m.sources,
  }));

  logger.info(
    { unique: merged.size, returned: results.length, enginesUsed, enginesFailed: enginesFailed.map((f) => f.engine) },
    "Aggregate search complete"
  );

  return {
    query,
    engine: "all",
    results,
    enginesUsed,
    enginesFailed,
    pagination: {
      page: 1,
      requestedLimit: limit,
      returned: results.length,
      pagesFetched: enginesUsed.length,
      hasMore: merged.size > results.length,
    },
  };
}

/**
 * Engine-agnostic entry point. Routes "google" to the existing anti-bot Google
 * implementation, "all" to the parallel aggregator, and everything else to the
 * multi-engine driver.
 */
export async function search(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  const engine = (options.engine || "google") as SearchEngine;
  if (engine === "all") {
    return searchAllEngines(query, options, existingBrowser);
  }
  if (engine === "google") {
    const resp = await googleSearch(query, options, existingBrowser);
    return { engine: "google", ...resp };
  }
  if (!(engine in ENGINE_DEFS)) {
    throw new Error(
      `Unsupported engine "${engine}". Supported: ${SUPPORTED_ENGINES.join(", ")}`
    );
  }
  return searchOtherEngine(query, engine as OtherEngine, options, existingBrowser);
}
