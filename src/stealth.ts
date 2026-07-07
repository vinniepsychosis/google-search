import type {
  Browser,
  BrowserContext,
  Page,
  BrowserContextOptions,
} from "playwright";
import { chromium as extraChromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as fs from "fs";
import * as path from "path";
import logger from "./logger.js";
import { getHostMachineConfig, SavedState } from "./search.js";

/**
 * Chromium launch args tuned to reduce automation detection. Shared by every
 * non-Google engine. Deliberately smaller than the Google path's list — the
 * stealth plugin (below) handles the fingerprint masking, so we only keep the
 * args that genuinely help and avoid ones (like --disable-web-security) that are
 * themselves detectable tells.
 */
export const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--disable-gpu",
  "--hide-scrollbars",
  "--mute-audio",
  "--disable-background-networking",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--force-color-profile=srgb",
  "--metrics-recording-only",
];

// The stealth plugin patches ~15 automation tells CONSISTENTLY (navigator.
// webdriver, the "HeadlessChrome" UA token, window.chrome, plugins/mimeTypes,
// languages, WebGL vendor/renderer, permissions, iframe.contentWindow, and
// more). The project's old hand-rolled init scripts patched a handful of these
// *inconsistently*, which is itself a detectable signal — that mismatch is what
// tripped Bing's challenge on the second (pagination) request. Registering the
// plugin once, globally, on playwright-extra's chromium wrapper fixes that: it
// must run before the first launch and applies to every page thereafter.
let pluginRegistered = false;
function stealthChromium(): typeof extraChromium {
  if (!pluginRegistered) {
    extraChromium.use(StealthPlugin());
    pluginRegistered = true;
    logger.info("Registered puppeteer-extra stealth plugin on chromium");
  }
  return extraChromium;
}

/**
 * Launch a stealth-hardened Chromium. Defaults to Playwright's bundled Chromium
 * (portable — no dependency on a locally installed browser); pass a `channel`
 * to pin the real installed Chrome/Edge instead, falling back to bundled
 * Chromium if that channel isn't present.
 */
export async function launchStealthBrowser(
  headless: boolean,
  channel?: "chrome" | "msedge"
): Promise<Browser> {
  const chromium = stealthChromium();
  const base = {
    headless,
    args: STEALTH_LAUNCH_ARGS,
    ignoreDefaultArgs: ["--enable-automation"],
  };
  if (channel) {
    try {
      return (await chromium.launch({ ...base, channel })) as unknown as Browser;
    } catch (e) {
      logger.warn(
        { channel, error: (e as Error).message },
        "Channel browser not available; falling back to bundled Chromium"
      );
    }
  }
  return (await chromium.launch(base)) as unknown as Browser;
}

export interface StealthSession {
  context: BrowserContext;
  page: Page;
  /** Persist storage state (cookies) + fingerprint so future runs look like a returning user. */
  save: () => Promise<void>;
}

/**
 * Create a browser context + page for a non-Google engine.
 *
 * Fingerprint masking is delegated entirely to the stealth plugin (applied at
 * launch via {@link launchStealthBrowser}); this function only sets a realistic
 * context (desktop viewport, host locale/timezone/colorScheme) and wires up
 * cookie + fingerprint persistence. Crucially it injects NO manual
 * anti-detection init scripts — doing so alongside the plugin re-creates the
 * exact inconsistency the plugin exists to avoid.
 *
 * Each engine should pass its own `stateFile` so cookie jars don't collide.
 */
export async function createStealthSession(
  browser: Browser,
  opts: { stateFile: string; locale?: string; noSaveState?: boolean }
): Promise<StealthSession> {
  const { stateFile, locale = "en-US", noSaveState = false } = opts;
  const fingerprintFile = stateFile.replace(/\.json$/, "-fingerprint.json");

  // Load a previously saved fingerprint (cookies load separately via storageState).
  let savedState: SavedState = {};
  const hasStorageState = fs.existsSync(stateFile);
  if (fs.existsSync(fingerprintFile)) {
    try {
      savedState = JSON.parse(fs.readFileSync(fingerprintFile, "utf8"));
      logger.info({ fingerprintFile }, "Loaded saved fingerprint");
    } catch (e) {
      logger.warn({ error: e }, "Could not read fingerprint file; regenerating");
    }
  }

  // Reuse the host machine's real locale/timezone/colorScheme (persisted across
  // runs). We deliberately do NOT apply a Playwright device descriptor here: its
  // hard-coded User-Agent would fight the plugin's UA evasion. Let the plugin own
  // the UA and just present a plausible desktop viewport.
  const fp = savedState.fingerprint || getHostMachineConfig(locale);
  savedState.fingerprint = fp;

  let contextOptions: BrowserContextOptions = {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    acceptDownloads: true,
    locale: fp.locale,
    timezoneId: fp.timezoneId,
    colorScheme: fp.colorScheme,
    reducedMotion: fp.reducedMotion,
    forcedColors: fp.forcedColors,
    permissions: ["geolocation", "notifications"],
  };

  const context = await browser.newContext(
    hasStorageState ? { ...contextOptions, storageState: stateFile } : contextOptions
  );

  const page = await context.newPage();

  const save = async () => {
    if (noSaveState) return;
    try {
      const dir = path.dirname(stateFile);
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await context.storageState({ path: stateFile });
      fs.writeFileSync(fingerprintFile, JSON.stringify(savedState, null, 2), "utf8");
      logger.info({ stateFile }, "Persisted stealth session state");
    } catch (e) {
      logger.warn({ error: e }, "Failed to persist stealth state (non-fatal)");
    }
  };

  return { context, page, save };
}
