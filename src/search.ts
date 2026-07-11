import { devices, BrowserContextOptions, Browser } from "playwright";
import { chromium } from "./browser.js"; // stealth-patched Chromium (playwright-extra + stealth)

// Automated mode (voice agent / MCP server / any headless backend): on a CAPTCHA there
// is no human to solve it, so relaunching a HEADED browser just hangs for a minute and
// pops a window. When GOOGLE_SEARCH_NO_HEADED=1, skip that recovery and fail fast so the
// caller gets a quick "blocked" error and can move on instead of stalling the loop.
const NO_HEADED_FALLBACK = process.env.GOOGLE_SEARCH_NO_HEADED === "1";
class CaptchaBlockedError extends Error {
  constructor() {
    super("Search blocked by a Google CAPTCHA (automated mode; headed fallback disabled).");
    this.name = "CaptchaBlockedError";
  }
}
import { SearchResponse, SearchResult, AnswerBox, SportsMatch, Weather, ImageResult, ImageSearchResponse, CommandOptions, HtmlResponse } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";

// Default anti-bot state file, shared by the CLI, MCP server, and HTTP API so a warm
// session saved by ANY entry point benefits the others. Absolute (home-dir) so it does
// not depend on the current working directory. Servers cannot solve CAPTCHAs (no human),
// so they rely on this file being kept warm — most easily by running the CLI once, which
// falls back to headed mode to let you solve the first CAPTCHA and seed the session.
export const DEFAULT_STATE_FILE = path.join(
  os.homedir(),
  ".google-search-browser-state.json"
);

// Fingerprint configuration interface
export interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// Saved state file interface
export interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

/**
 * Get the actual configuration of the host machine
 * @param userLocale User-specified locale (if any)
 * @returns Fingerprint configuration based on the host machine
 */
// Map an IANA timezone to the matching Google ccTLD, so the domain agrees with the
// exit region. (Modern Google serves results by IP regardless of ccTLD, but a saved
// foreign domain — e.g. google.co.uk on an Indian session — is still an odd signal.)
function googleDomainForTimezone(tz: string): string {
  if (/^Asia\/(Kolkata|Calcutta)/.test(tz)) return "https://www.google.co.in";
  if (/^America\//.test(tz)) return "https://www.google.com";
  if (tz === "Europe/London") return "https://www.google.co.uk";
  if (tz === "Europe/Dublin") return "https://www.google.ie";
  if (/^Australia\//.test(tz)) return "https://www.google.com.au";
  if (/^Asia\/Singapore/.test(tz)) return "https://www.google.com.sg";
  return "https://www.google.com";
}

// Map an IANA timezone to a matching English SERP locale, so the interface language
// agrees with the region rather than fighting it.
function englishLocaleForTimezone(tz: string): string {
  if (/^Asia\/(Kolkata|Calcutta)/.test(tz)) return "en-IN";
  if (/^America\//.test(tz)) return "en-US";
  if (tz === "Europe/Dublin") return "en-IE";
  if (/^Europe\//.test(tz)) return "en-GB";
  if (/^Australia\//.test(tz)) return "en-AU";
  if (/^Pacific\/Auckland/.test(tz)) return "en-NZ";
  if (/^Asia\/Singapore/.test(tz)) return "en-SG";
  return "en-US";
}

// Resolve a COHERENT geo fingerprint: the SERP language, the IANA timezone, and the
// Accept-Language header, all derived so they agree with each OTHER and with the exit IP.
// Anti-bot systems triangulate Accept-Language ↔ Intl timezone ↔ IP geolocation; an
// internal contradiction (e.g. en-US language on an Asia/Shanghai clock from an Indian
// IP) is a strong bot signal. The timezone comes from the real runtime (or an override),
// never a lossy offset guess. Env overrides let you match a proxy's exit region:
//   GOOGLE_SEARCH_TIMEZONE=America/New_York  GOOGLE_SEARCH_LOCALE=en-US
export function resolveGeoProfile(userLocale?: string): {
  locale: string;
  timezoneId: string;
  acceptLanguage: string;
  googleDomain: string;
} {
  const timezoneId =
    process.env.GOOGLE_SEARCH_TIMEZONE ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  // Default to an English SERP (this tool backs an English agent) in the English variant
  // that matches the timezone's region. An explicit locale (env or caller) is honored;
  // "zh-CN" is treated as unset — it's the legacy hard-coded default, not a real choice.
  const explicit = process.env.GOOGLE_SEARCH_LOCALE || userLocale;
  const locale =
    explicit && explicit !== "zh-CN" ? explicit : englishLocaleForTimezone(timezoneId);
  const acceptLanguage = /^en/i.test(locale)
    ? `${locale},en;q=0.9`
    : `${locale},en;q=0.5`;
  const googleDomain =
    process.env.GOOGLE_SEARCH_DOMAIN || googleDomainForTimezone(timezoneId);
  return { locale, timezoneId, acceptLanguage, googleDomain };
}

// Exported for src/stealth.ts (multi-engine path) to reuse the same fingerprint.
export function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // Coherent (language, timezone) from the real runtime — see resolveGeoProfile. The old
  // getTimezoneOffset() heuristic had no branch for UTC+5:30 (India) and several others,
  // so it silently mislabeled them all as Asia/Shanghai.
  const geo = resolveGeoProfile(userLocale);
  const systemLocale = geo.locale;
  const timezoneId = geo.timezoneId;

  // Detect the system color scheme
  // Node.js cannot directly obtain the system color scheme, so use a reasonable default
  // It can be inferred from the time of day: dark mode at night, light mode during the day
  const hour = new Date().getHours();
  const colorScheme =
    hour >= 19 || hour < 7 ? ("dark" as const) : ("light" as const);

  // Use reasonable defaults for other settings
  const reducedMotion = "no-preference" as const; // Most users do not enable reduced motion
  const forcedColors = "none" as const; // Most users do not enable forced colors

  // Choose a suitable device name
  // Choose an appropriate browser based on the operating system
  const platform = os.platform();
  let deviceName = "Desktop Chrome"; // Default to Chrome

  if (platform === "darwin") {
    // macOS
    deviceName = "Desktop Safari";
  } else if (platform === "win32") {
    // Windows
    deviceName = "Desktop Edge";
  } else if (platform === "linux") {
    // Linux
    deviceName = "Desktop Firefox";
  }

  // We use Chrome
  deviceName = "Desktop Chrome";

  return {
    deviceName,
    locale: systemLocale,
    timezoneId,
    colorScheme,
    reducedMotion,
    forcedColors,
  };
}

/**
 * Perform a Google search and return the results
 * @param query Search keywords
 * @param options Search options
 * @returns Search results
 */
export async function googleSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<SearchResponse> {
  // Set default options
  const {
    limit = 10,
    page: pageNum = 1, // Starting results page (1-based)
    timeout = 60000,
    stateFile = DEFAULT_STATE_FILE,
    noSaveState = false,
    locale = "zh-CN", // Default to Chinese
  } = options;

  // Ignore the passed-in headless argument; always launch in headless mode
  let useHeadless = true;

  logger.info({ options }, "Initializing browser...");

  // Check whether a state file exists
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // Fingerprint configuration file path
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found browser state file; will use the saved browser state to avoid anti-bot detection"
    );
    storageState = stateFile;

    // Try to load the saved fingerprint configuration
    if (fs.existsSync(fingerprintFile)) {
      try {
        const fingerprintData = fs.readFileSync(fingerprintFile, "utf8");
        savedState = JSON.parse(fingerprintData);
        logger.info("Loaded the saved browser fingerprint configuration");
      } catch (e) {
        logger.warn({ error: e }, "Unable to load the fingerprint configuration file; a new fingerprint will be created");
      }
    }
  } else {
    logger.info(
      { stateFile },
      "Browser state file not found; will create a new browser session and fingerprint"
    );
  }

  // Use the desktop device list only
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // Timezone list
  const timezoneList = [
    "America/New_York",
    "Europe/London",
    "Asia/Shanghai",
    "Europe/Berlin",
    "Asia/Tokyo",
  ];

  // Get a random device configuration or use the saved configuration
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // Use the saved device configuration
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // Randomly select a device
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // Get a random delay time
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // Define a function to perform the search, reusable for both headless and headed modes
  async function performSearch(headless: boolean): Promise<SearchResponse> {
    let browser: Browser;
    let browserWasProvided = false;

    if (existingBrowser) {
      browser = existingBrowser;
      browserWasProvided = true;
      logger.info("Using the existing browser instance");
    } else {
      logger.info(
        { headless },
        `Preparing to launch the browser in ${headless ? "headless" : "headed"} mode...`
      );

      // Initialize the browser, adding more arguments to avoid detection
      browser = await chromium.launch({
        headless,
        timeout: timeout * 2, // Increase the browser launch timeout
        args: [
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
        ],
        ignoreDefaultArgs: ["--enable-automation"],
      });

      logger.info("Browser launched successfully!");
    }

    // Get the device configuration - use the saved one or generate a random one
    const [deviceName, deviceConfig] = getDeviceConfig();

    // Create browser context options
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // If there is a saved fingerprint configuration, use it; otherwise use the host machine's actual settings
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("Using the saved browser fingerprint configuration");
    } else {
      // Get the host machine's actual settings
      const hostConfig = getHostMachineConfig(locale);

      // If a different device type is needed, re-fetch the device configuration
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on the host machine settings"
        );
        // Use the new device configuration
        contextOptions = { ...devices[hostConfig.deviceName] };
      }

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // Save the newly generated fingerprint configuration
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "Generated a new browser fingerprint configuration based on the host machine"
      );
    }

    // Add common options - ensure the desktop configuration is used
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // Force desktop mode
      hasTouch: false, // Disable touch support
      javaScriptEnabled: true,
    };

    // Apply a COHERENT geo fingerprint: SERP language, IANA timezone, and Accept-Language
    // that all agree with each other AND with the exit IP. Incoherence here — e.g. en-US
    // language on an Asia/Shanghai clock from an Indian IP — was a strong bot signal that
    // triggered CAPTCHAs. Resolved fresh (env override → real machine) and applied OVER any
    // saved fingerprint, so a stale/poisoned timezone can never linger. Also updates the
    // persisted fingerprint so the fix self-heals on the next save.
    const geo = resolveGeoProfile(locale);
    contextOptions.locale = geo.locale;
    contextOptions.timezoneId = geo.timezoneId;
    contextOptions.extraHTTPHeaders = {
      ...(contextOptions.extraHTTPHeaders || {}),
      "Accept-Language": geo.acceptLanguage,
    };
    if (savedState.fingerprint) {
      savedState.fingerprint.locale = geo.locale;
      savedState.fingerprint.timezoneId = geo.timezoneId;
    }
    // navigator.languages must match the locale — Chrome exposes [regional, base].
    const navLanguages =
      /^en/i.test(geo.locale) && geo.locale.toLowerCase() !== "en"
        ? [geo.locale, "en"]
        : [geo.locale];
    logger.info(
      { locale: geo.locale, timezone: geo.timezoneId },
      "Applied coherent geo fingerprint"
    );

    if (storageState) {
      logger.info("Loading the saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // Set additional browser properties to avoid detection
    await context.addInitScript((langs: string[]) => {
      // Override navigator properties
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      // navigator.languages kept coherent with the context locale / Accept-Language.
      Object.defineProperty(navigator, "languages", {
        get: () => langs,
      });

      // Override window properties
      // @ts-ignore - Ignore the error that the chrome property does not exist
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // Add WebGL fingerprint randomization
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // Randomize UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    }, navLanguages);

    const page = await context.newPage();

    // Set additional page properties
    await page.addInitScript(() => {
      // Simulate a realistic screen size and color depth
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // Google domain coherent with the resolved geo (matches the exit IP's region).
      // Applied OVER any saved domain so a stale/foreign ccTLD — e.g. a randomly-picked
      // google.co.uk on an Indian session — can't linger and contradict the fingerprint.
      const selectedDomain = geo.googleDomain;
      savedState.googleDomain = selectedDomain;
      logger.info({ domain: selectedDomain }, "Using the geo-coherent Google domain");

      logger.info("Visiting the Google search page...");

      // Visit the Google search page
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // Check whether we were redirected to a CAPTCHA page
      const currentUrl = page.url();
      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().toString().includes(pattern))
      );

      if (NO_HEADED_FALLBACK && isBlockedPage) {
        logger.warn("CAPTCHA detected on landing (automated mode); failing fast.");
        try { await context.close(); } catch (_) {}
        throw new CaptchaBlockedError();
      }

      if (isBlockedPage) {
        if (headless) {
          logger.warn("CAPTCHA page detected; will restart the browser in headed mode...");

          // Close the current page and context
          await page.close();
          await context.close();

          // If the browser was provided externally, do not close it; instead create a new browser instance
          if (browserWasProvided) {
            logger.info(
              "Encountered a CAPTCHA while using an external browser instance; creating a new browser instance..."
            );
            // Create a new browser instance and no longer use the externally provided one
            const newBrowser = await chromium.launch({
              headless: false, // Use headed mode
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // Other arguments are the same as before
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
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // Use the new browser instance to perform the search
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // Code to handle the CAPTCHA can be added here
              // ...

              // Close the temporary browser when done
              await newBrowser.close();

              // Re-run the search
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // If the browser was not externally provided, close it directly and re-run the search
            await browser.close();
            return performSearch(false); // Re-run the search in headed mode
          }
        } else {
          logger.warn("CAPTCHA page detected; please complete the verification in the browser...");
          // Wait for the user to complete verification and be redirected back to the search page
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("CAPTCHA verification completed; continuing the search...");
        }
      }

      logger.info({ query }, "Entering the search keywords");

      // Wait for the search box to appear - try multiple possible selectors
      const searchInputSelectors = [
        "textarea[name='q']",
        "input[name='q']",
        "textarea[title='Search']",
        "input[title='Search']",
        "textarea[aria-label='Search']",
        "input[aria-label='Search']",
        "textarea",
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          logger.info({ selector }, "Found the search box");
          break;
        }
      }

      if (!searchInput) {
        logger.error("Unable to find the search box");
        throw new Error("Unable to find the search box");
      }

      // Click the search box directly to reduce delay
      await searchInput.click();

      // Type the entire query string directly instead of character by character
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // Reduce the delay before pressing Enter
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for the page to finish loading...");

      // Wait for the page to finish loading
      await page.waitForLoadState("networkidle", { timeout });

      // Check whether the post-search URL was redirected to a CAPTCHA page
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (NO_HEADED_FALLBACK && isBlockedAfterSearch) {
        logger.warn("CAPTCHA detected after searching (automated mode); failing fast.");
        try { await context.close(); } catch (_) {}
        throw new CaptchaBlockedError();
      }

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn(
            "CAPTCHA page detected after searching; will restart the browser in headed mode..."
          );

          // Close the current page and context
          await page.close();
          await context.close();

          // If the browser was provided externally, do not close it; instead create a new browser instance
          if (browserWasProvided) {
            logger.info(
              "Encountered a CAPTCHA after searching while using an external browser instance; creating a new browser instance..."
            );
            // Create a new browser instance and no longer use the externally provided one
            const newBrowser = await chromium.launch({
              headless: false, // Use headed mode
              timeout: timeout * 2,
              args: [
                "--disable-blink-features=AutomationControlled",
                // Other arguments are the same as before
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
              ],
              ignoreDefaultArgs: ["--enable-automation"],
            });

            // Use the new browser instance to perform the search
            try {
              const tempContext = await newBrowser.newContext(contextOptions);
              const tempPage = await tempContext.newPage();

              // Code to handle the CAPTCHA can be added here
              // ...

              // Close the temporary browser when done
              await newBrowser.close();

              // Re-run the search
              return performSearch(false);
            } catch (error) {
              await newBrowser.close();
              throw error;
            }
          } else {
            // If the browser was not externally provided, close it directly and re-run the search
            await browser.close();
            return performSearch(false); // Re-run the search in headed mode
          }
        } else {
          logger.warn("CAPTCHA page detected after searching; please complete the verification in the browser...");
          // Wait for the user to complete verification and be redirected back to the search page
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("CAPTCHA verification completed; continuing the search...");

          // Wait for the page to reload
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      logger.info({ url: page.url() }, "Waiting for the search results to load...");

      // Try multiple possible search result selectors
      const searchResultSelectors = [
        "#search",
        "#rso",
        ".g",
        "[data-sokoban-container]",
        "div[role='main']",
      ];

      let resultsFound = false;
      // Wait for ANY result selector in a SINGLE call (comma-joined) rather than looping
      // 5 selectors × timeout/2 sequentially (which could stall for minutes when blocked).
      // This returns instantly when results render and bounds the block case to one wait.
      // In automated mode, cap the wait short (results normally render in ~1-2s) so a
      // block is surfaced quickly instead of leaving a voice turn silent for many seconds.
      const resultsWaitMs = NO_HEADED_FALLBACK ? Math.min(timeout / 2, 8000) : timeout / 2;
      try {
        await page.waitForSelector(searchResultSelectors.join(", "), { timeout: resultsWaitMs });
        logger.info("Found the search results");
        resultsFound = true;
      } catch (e) {
        // fall through to CAPTCHA / block handling
      }

      if (!resultsFound) {
        // If the search results cannot be found, check whether we were redirected to a CAPTCHA page
        const currentUrl = page.url();
        const isBlockedDuringResults = sorryPatterns.some((pattern) =>
          currentUrl.includes(pattern)
        );

        // Automated backend: no human to solve a CAPTCHA, so bail fast instead of the
        // headed-browser recovery below (which would hang and pop a window).
        if (NO_HEADED_FALLBACK && isBlockedDuringResults) {
          logger.warn("CAPTCHA detected (automated mode); failing fast without headed recovery.");
          try { await context.close(); } catch (_) {}
          throw new CaptchaBlockedError();
        }

        if (isBlockedDuringResults) {
          if (headless) {
            logger.warn(
              "CAPTCHA page detected while waiting for search results; will restart the browser in headed mode..."
            );

            // Close the current page and context
            await page.close();
            await context.close();

            // If the browser was provided externally, do not close it; instead create a new browser instance
            if (browserWasProvided) {
              logger.info(
                "Encountered a CAPTCHA while waiting for search results using an external browser instance; creating a new browser instance..."
              );
              // Create a new browser instance and no longer use the externally provided one
              const newBrowser = await chromium.launch({
                headless: false, // Use headed mode
                timeout: timeout * 2,
                args: [
                  "--disable-blink-features=AutomationControlled",
                  // Other arguments are the same as before
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
                ],
                ignoreDefaultArgs: ["--enable-automation"],
              });

              // Use the new browser instance to perform the search
              try {
                const tempContext = await newBrowser.newContext(contextOptions);
                const tempPage = await tempContext.newPage();

                // Code to handle the CAPTCHA can be added here
                // ...

                // Close the temporary browser when done
                await newBrowser.close();

                // Re-run the search
                return performSearch(false);
              } catch (error) {
                await newBrowser.close();
                throw error;
              }
            } else {
              // If the browser was not externally provided, close it directly and re-run the search
              await browser.close();
              return performSearch(false); // Re-run the search in headed mode
            }
          } else {
            logger.warn(
              "CAPTCHA page detected while waiting for search results; please complete the verification in the browser..."
            );
            // Wait for the user to complete verification and be redirected back to the search page
            await page.waitForNavigation({
              timeout: timeout * 2,
              url: (url) => {
                const urlStr = url.toString();
                return sorryPatterns.every(
                  (pattern) => !urlStr.includes(pattern)
                );
              },
            });
            logger.info("CAPTCHA verification completed; continuing the search...");

            // Try waiting for the search results again
            for (const selector of searchResultSelectors) {
              try {
                await page.waitForSelector(selector, { timeout: timeout / 2 });
                logger.info({ selector }, "Found the search results after verification");
                resultsFound = true;
                break;
              } catch (e) {
                // Continue trying the next selector
              }
            }

            if (!resultsFound) {
              logger.error("Unable to find the search result elements");
              throw new Error("Unable to find the search result elements");
            }
          }
        } else {
          // If it is not a CAPTCHA issue, throw an error
          logger.error("Unable to find the search result elements");
          throw new Error("Unable to find the search result elements");
        }
      }

      // Reduce the wait time
      await page.waitForTimeout(getRandomDelay(200, 500));

      logger.info("Extracting the search results...");

      // Base URL of the results page; used to navigate between result pages via &start=
      const baseSearchUrl = page.url();

      // Per-page result extractor - runs in the browser context.
      // Ported from google-search-extractor.cjs and extended to skip links
      // already collected on previous pages (cross-page deduplication).
      const extractPageResults = (args: { maxResults: number; exclude: string[] }): { title: string; link: string; snippet: string }[] => {
        const { maxResults, exclude } = args;
        const results: { title: string; link: string; snippet: string }[] = [];
        const seenUrls = new Set<string>(exclude); // Used for deduplication (across pages)

        // Define multiple selector sets, ordered by priority (see google-search-extractor.cjs)
        const selectorSets = [
          { container: '#search div[data-hveid]', title: 'h3', snippet: '.VwiC3b' },
          { container: '#rso div[data-hveid]', title: 'h3', snippet: '[data-sncf="1"]' },
          { container: '.g', title: 'h3', snippet: 'div[style*="webkit-line-clamp"]' },
          { container: 'div[jscontroller][data-hveid]', title: 'h3', snippet: 'div[role="text"]' }
        ];

        // Fallback snippet selectors
        const alternativeSnippetSelectors = [
          '.VwiC3b',
          '[data-sncf="1"]',
          'div[style*="webkit-line-clamp"]',
          'div[role="text"]'
        ];

        // Try each selector set
        for (const selectors of selectorSets) {
          if (results.length >= maxResults) break; // Stop if the count limit has been reached

          const containers = document.querySelectorAll(selectors.container);

          for (const container of containers) {
            if (results.length >= maxResults) break;

            const titleElement = container.querySelector(selectors.title);
            if (!titleElement) continue;

            const title = (titleElement.textContent || "").trim();

            // Find the link
            let link = '';
            const linkInTitle = titleElement.querySelector('a');
            if (linkInTitle) {
              link = (linkInTitle as HTMLAnchorElement).href;
            } else {
              let current: Element | null = titleElement;
              while (current && current.tagName !== 'A') {
                current = current.parentElement;
              }
              if (current && current instanceof HTMLAnchorElement) {
                link = current.href;
              } else {
                const containerLink = container.querySelector('a');
                if (containerLink) {
                  link = (containerLink as HTMLAnchorElement).href;
                }
              }
            }

            // Filter out invalid or duplicate links
            if (!link || !link.startsWith('http') || seenUrls.has(link)) continue;

            // Find the snippet
            let snippet = '';
            const snippetElement = container.querySelector(selectors.snippet);
            if (snippetElement) {
              snippet = (snippetElement.textContent || "").trim();
            } else {
              // Try other snippet selectors
              for (const altSelector of alternativeSnippetSelectors) {
                const element = container.querySelector(altSelector);
                if (element) {
                  snippet = (element.textContent || "").trim();
                  break;
                }
              }

              // If no snippet is still found, try a generic approach
              if (!snippet) {
                const textNodes = Array.from(container.querySelectorAll('div')).filter(el =>
                  !el.querySelector('h3') &&
                  (el.textContent || "").trim().length > 20
                );
                if (textNodes.length > 0) {
                  snippet = (textNodes[0].textContent || "").trim();
                }
              }
            }

            // Only add results that have both a title and a link
            if (title && link) {
              results.push({ title, link, snippet });
              seenUrls.add(link); // Record the processed URL
            }
          }
        }

        // If the primary selectors did not find enough results, try a more generic approach (as a supplement)
        if (results.length < maxResults) {
            const anchorElements = Array.from(document.querySelectorAll("a[href^='http']"));
            for (const el of anchorElements) {
                if (results.length >= maxResults) break;

                // Check whether el is an HTMLAnchorElement
                if (!(el instanceof HTMLAnchorElement)) {
                    continue;
                }
                const link = el.href;
                // Filter out navigation links, image links, existing links, etc.
                if (!link || seenUrls.has(link) || link.includes("google.com/") || link.includes("accounts.google") || link.includes("support.google")) {
                    continue;
                }

                const title = (el.textContent || "").trim();
                if (!title) continue; // Skip links with no text content

                // Try to get the surrounding text as the snippet
                let snippet = "";
                let parent = el.parentElement;
                for (let i = 0; i < 3 && parent; i++) {
                  const text = (parent.textContent || "").trim();
                  // Ensure the snippet text differs from the title and has a certain length
                  if (text.length > 20 && text !== title) {
                    snippet = text;
                    break; // Stop searching upward once a suitable snippet is found
                  }
                  parent = parent.parentElement;
                }

                results.push({ title, link, snippet });
                seenUrls.add(link);
            }
        }

        return results.slice(0, maxResults); // Ensure the limit is not exceeded
      };

      // Best-effort extraction of "People also ask" and "Related searches" blocks.
      // These are supplementary signals (useful for query expansion by agents) and
      // may legitimately be empty depending on the query and Google's layout.
      // NOTE: shipped to page.evaluate() as a STRING, not a function, for the same
      // reason as answerBoxScript below: tsx/esbuild's keepNames wraps named nested
      // arrows (e.g. `uniq`) in `__name(...)` calls, which throw `__name is not
      // defined` once serialized into the browser. A string literal is sent verbatim.
      const auxBlocksScript = `(() => {
        const uniq = (arr) =>
          Array.from(new Set(arr.map((s) => (s || "").replace(/\\s+/g, " ").trim()).filter(Boolean)));
        // Strip Google widget chrome that gets concatenated into a node's textContent
        // (loading/error states, feedback links) so entries dedup cleanly.
        const scrubQ = (s) => (s || "")
          .replace(/\\s+/g, " ")
          .replace(/An error has occurred\\. Please try again later\\.?/gi, "")
          .replace(/^People also ask/i, "")
          .replace(/Feedback$/i, "")
          .trim();
        // A real PAA entry is a single question. Reject container blobs that
        // concatenate several questions (more than one '?') into one node.
        const isSingleQuestion = (s) => (s.match(/\\?/g) || []).length <= 1;

        // People also ask
        const paa = [];
        const paaSelectors = [
          'div[jsname="Cpkphb"]',
          '.related-question-pair',
          'div[data-initq]',
          'div[data-q]',
          'div[jsname="yEVEwb"]',
        ];
        for (const sel of paaSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = scrubQ(el.getAttribute('data-q') || el.textContent || '');
            if (t.endsWith('?') && t.length > 8 && t.length < 200 && isSingleQuestion(t)) paa.push(t);
          });
        }
        // Fallback: heading-like / expandable elements ending with a question mark
        if (paa.length === 0) {
          document.querySelectorAll('#search [role="heading"], #search [aria-expanded]').forEach((el) => {
            const t = scrubQ(el.textContent || '');
            if (t.endsWith('?') && t.length > 10 && t.length < 200) paa.push(t);
          });
        }

        // Related searches
        const related = [];
        const relatedSelectors = [
          '#bres a',
          '#botstuff a[data-ved]',
          'a.k8XOCe',
          '.s75CSd',
          '.wM6W7d',
          'div[data-abe] a',
        ];
        for (const sel of relatedSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
            if (t && t.length > 2 && t.length < 100) related.push(t);
          });
        }

        return {
          peopleAlsoAsk: uniq(paa).slice(0, 10),
          relatedSearches: uniq(related).slice(0, 10),
        };
      })()`;

      // Best-effort extraction of Google's "answer box": the featured snippet, direct
      // answer, weather/sports widget, or knowledge panel rendered ABOVE the organic
      // results. This is where authoritative real-time facts (scores, weather, prices,
      // "current X", quick facts) live — organic snippets frequently don't carry them.
      // Every branch is heuristic (Google's DOM shifts constantly) and defensive; the
      // whole thing is non-fatal and yields null when nothing matches.
      //
      // NOTE: this is passed to page.evaluate() as a STRING, not a function, on purpose.
      // tsx/esbuild's keepNames wraps named nested arrows in `__name(...)` calls; when a
      // *function* is serialized into the browser those calls throw `__name is not
      // defined`. A string literal is shipped verbatim, so no such helper is injected.
      const answerBoxScript = `(() => {
        const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
        // Strip Google widget chrome that otherwise pollutes the answer text.
        const scrub = (s) => clean((s || "")
          .replace(/Sports results/gi, " ")
          .replace(/MATCHES\\s+TABLE\\s+PLAYERS/gi, " ")
          .replace(/Match recap[^]{0,12}?\\d+:\\d+/gi, " ")
          .replace(/See more/gi, " ")
          .replace(/Feedback/gi, " ")
          .replace(/\\s+/g, " "));
        // Reject bare UI labels / too-short fragments so junk like "Delete" never wins.
        const NOISE = /^(delete|feedback|see more|more|search|images|maps|news|videos|shopping|sign in|settings|about|share|save)$/i;
        const ok = (t, min) => !!t && t.length >= (min || 12) && !NOISE.test(t);
        const text = (el, max) => scrub(el && (el.innerText || el.textContent)).slice(0, max || 600);
        const firstText = (selectors, min, max) => {
          for (const sel of selectors) {
            const t = text(document.querySelector(sel), max);
            if (ok(t, min)) return t;
          }
          return "";
        };
        try {
          // 1) Weather widget (#wob_wc) — location, temperature and conditions.
          const wob = document.querySelector("#wob_wc");
          if (wob) {
            const loc = clean((document.querySelector("#wob_loc") || {}).textContent);
            const temp = clean((document.querySelector("#wob_tm") || {}).textContent);
            const cond = clean((document.querySelector("#wob_dc") || {}).textContent);
            const bits = [];
            if (temp) bits.push(temp + "\\u00B0");
            if (cond) bits.push(cond);
            const answer = (loc ? loc + ": " : "") + bits.join(", ");
            if (answer.trim().length > 1) return { type: "weather", title: loc, answer: answer.slice(0, 600), source: "google weather" };
          }
          // 2) Sports score widget — the whole match card's visible text (scrubbed).
          const sports = document.querySelector('[data-attrid*="port"], [data-attrid*="Sports"], .imso_mh, .liveresults-sports-immersive__update-box, .liveresults-sports-immersive__updates-container, g-card .imspo_mt');
          const sportsText = text(sports, 500);
          if (ok(sportsText, 8)) return { type: "sports", title: "", answer: sportsText, source: "google sports" };
          // 3) Featured snippet / direct answer.
          const answer = firstText([".Z0LcW", ".IZ6rdc", ".hgKELc", ".LGOjhe", '[data-attrid="wa:/description"]', ".vk_ans", ".vk_bk", ".ayqGOc", ".wDYxhc"], 15, 600);
          if (answer) {
            const c = document.querySelector(".xpdopen cite, .g cite, .kno-rdesc + div cite");
            return { type: "featured_snippet", title: "", answer: answer, source: clean(c && c.textContent) };
          }
          // 4) Knowledge panel description (needs real prose, not a stray label).
          const kp = firstText([".kno-rdesc span", ".kno-rdesc", ".PZPZlf"], 25, 600);
          if (kp) {
            const h = document.querySelector('.qrShPb, .kp-header [role="heading"], .SPZz6b h2');
            return { type: "knowledge_panel", title: clean(h && h.textContent), answer: kp, source: "" };
          }
        } catch (e) { return null; }
        return null;
      })()`;

      // Structured extraction of Google's sports "match widget" — the immersive scores
      // card rendered above the organic results (fixtures, scores, stage, kickoff time).
      // The answerBox above only captures this as one flattened text blob; here we pull
      // each match tile into a structured fixture so agents get teams/times/scores as data.
      //
      // Shipped as a STRING for the same __name serialization reason documented above.
      const sportsWidgetScript = `(() => {
        const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
        try {
          const tiles = document.querySelectorAll('.liveresults-sports-immersive__match-tile');
          if (!tiles || tiles.length === 0) return [];
          const out = [];
          tiles.forEach((tile) => {
            // Team names: one .xNfnlf per side (the visible label; the aria-hidden
            // duplicate is a <span>, so it isn't matched here).
            const teams = Array.from(tile.querySelectorAll('.xNfnlf'))
              .map((e) => clean(e.textContent))
              .filter(Boolean)
              .slice(0, 2);
            if (teams.length < 2) return;

            const stageEl = tile.querySelector('.imspo_mt__lg-st-co');
            const timeEl = tile.querySelector('[data-start-time]');

            // Status/time: the match-status wrapper holds the date + local time for
            // upcoming games ("Tomorrow", "2:30 am") and the state for played ones
            // ("FT", "FT (P)", a live minute). Collect its leaf nodes and join with
            // spaces — reading textContent directly smushes them ("FTToday").
            const collectLeaves = (root) => {
              if (!root) return [];
              const parts = [];
              root.querySelectorAll('*').forEach((n) => {
                if (n.children.length === 0) {
                  const t = clean(n.textContent);
                  if (t) parts.push(t);
                }
              });
              return parts;
            };
            let infos = collectLeaves(tile.querySelector('.imspo_mt__ms-w'));
            if (infos.length === 0) {
              infos = Array.from(tile.querySelectorAll('.imspo_mt__pm-inf'))
                .map((e) => clean(e.textContent))
                .filter(Boolean);
            }
            const status = Array.from(new Set(infos)).join(' ');

            // Scores (live/finished only): numeric score cells aligned to the two sides.
            const scores = Array.from(tile.querySelectorAll('.imspo_mt__sc, .imspo_mt__t-sc'))
              .map((e) => clean(e.textContent))
              .filter((t) => /^\\d{1,3}$/.test(t))
              .map(Number);

            const m = { teams: teams };
            const stage = clean(stageEl && stageEl.textContent);
            if (stage) m.stage = stage;
            if (status) m.status = status;
            const st = timeEl && timeEl.getAttribute('data-start-time');
            if (st) m.startTime = st;
            if (scores.length === 2) m.scores = scores;
            out.push(m);
          });
          return out;
        } catch (e) { return []; }
      })()`;

      // Structured extraction of Google's weather widget (#wob_wc) — current conditions
      // plus the daily forecast strip. The answerBox only captures a flattened
      // "Location: 25°, Clear" string; here we pull temperature/unit/humidity/wind and
      // per-day highs/lows as data. Shipped as a STRING (same __name reason as above).
      const weatherWidgetScript = `(() => {
        const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
        // Parse a signed integer, normalising Google's unicode minus (U+2212).
        const num = (s) => {
          const m = clean(s).replace(/\\u2212/g, "-").match(/-?\\d+/);
          return m ? parseInt(m[0], 10) : undefined;
        };
        const isVisible = (el) => !!el && getComputedStyle(el).display !== "none";
        try {
          const wc = document.querySelector("#wob_wc");
          if (!wc) return null;

          const tmC = document.querySelector("#wob_tm");   // Celsius value
          const tmF = document.querySelector("#wob_ttm");  // Fahrenheit value (hidden)
          let temperature, unit;
          if (isVisible(tmF)) { temperature = num(tmF.textContent); unit = "F"; }
          else if (tmC) { temperature = num(tmC.textContent); unit = "C"; }
          if (temperature === undefined) return null;

          const txt = (sel) => {
            const el = document.querySelector(sel);
            return el ? clean(el.textContent) : "";
          };
          // Wind: prefer whichever unit (km/h vs mph) is visible.
          const wsEl = document.querySelector("#wob_ws");
          const twsEl = document.querySelector("#wob_tws");
          const wind = isVisible(twsEl) ? clean(twsEl.textContent) : (wsEl ? clean(wsEl.textContent) : "");

          // Daily forecast: the visible .wob_t in each high/low cell matches the unit.
          const visTemp = (container) => {
            if (!container) return undefined;
            const spans = container.querySelectorAll(".wob_t");
            for (const s of spans) if (isVisible(s)) return num(s.textContent);
            return spans.length ? num(spans[0].textContent) : undefined;
          };
          const forecast = [];
          document.querySelectorAll("#wob_dp .wob_df").forEach((d) => {
            const dayEl = d.querySelector(".Z1VzSb");
            const day = dayEl ? clean(dayEl.getAttribute("aria-label") || dayEl.textContent) : "";
            if (!day) return;
            const img = d.querySelector("img[alt]");
            const entry = { day: day };
            const cond = img ? clean(img.getAttribute("alt")) : "";
            if (cond) entry.condition = cond;
            const high = visTemp(d.querySelector(".gNCp2e"));
            const low = visTemp(d.querySelector(".QrNVmd"));
            if (high !== undefined) entry.high = high;
            if (low !== undefined) entry.low = low;
            forecast.push(entry);
          });

          // Location heading. #wob_loc is just the "Weather" label; the resolved place
          // name ("Tokyo, Japan") sits in a sibling heading (.BBwThe). Fall back to the
          // widget's aria-label or any nearby heading that isn't the bare "Weather" label.
          let location = txt(".BBwThe");
          if (!location || /^weather$/i.test(location)) {
            const cand = document.querySelector('[data-attrid="title"], .wob_hdr, .card-section [role="heading"]');
            const c = cand ? clean(cand.textContent) : "";
            if (c && !/^weather$/i.test(c)) location = c;
          }

          const w = {
            location: location,
            temperature: temperature,
            unit: unit,
            condition: txt("#wob_dc"),
          };
          const precip = txt("#wob_pp");
          const humidity = txt("#wob_hm");
          const observedAt = txt("#wob_dts");
          if (precip) w.precipitation = precip;
          if (humidity) w.humidity = humidity;
          if (wind) w.wind = wind;
          if (observedAt) w.observedAt = observedAt;
          if (forecast.length > 0) w.forecast = forecast;
          return w;
        } catch (e) { return null; }
      })()`;

      // Fetch pages until we reach the requested limit (or run out of results).
      const perPage = 10;
      const startPageIdx = Math.max(1, pageNum) - 1; // 0-based index of the first page to fetch
      const maxPagesToFetch = Math.max(1, Math.ceil(limit / perPage));

      const collected: { title: string; link: string; snippet: string }[] = [];
      const seenLinks = new Set<string>();
      let peopleAlsoAsk: string[] = [];
      let relatedSearches: string[] = [];
      let answerBox: AnswerBox | undefined = undefined;
      let sportsMatches: SportsMatch[] = [];
      let weather: Weather | undefined = undefined;
      let pagesFetched = 0;
      let lastPageYield = 0;

      for (let p = 0; p < maxPagesToFetch; p++) {
        const pageIdx = startPageIdx + p;
        const startOffset = pageIdx * perPage;
        // The initial search already landed us on page 1 (start=0); only navigate otherwise.
        const alreadyOnPage = p === 0 && startPageIdx === 0;

        if (!alreadyOnPage) {
          const nextUrl = new URL(baseSearchUrl);
          nextUrl.searchParams.set("start", String(startOffset));
          logger.info({ page: pageIdx + 1, start: startOffset }, "Navigating to results page...");
          await page.goto(nextUrl.toString(), { timeout, waitUntil: "networkidle" });

          // Stop paginating if we hit a CAPTCHA on a later page
          const curUrl = page.url();
          if (sorryPatterns.some((pattern) => curUrl.includes(pattern))) {
            logger.warn("CAPTCHA encountered during pagination; stopping early with the results gathered so far");
            break;
          }

          // Wait for results to render on this page
          let ok = false;
          for (const selector of searchResultSelectors) {
            try {
              await page.waitForSelector(selector, { timeout: timeout / 2 });
              ok = true;
              break;
            } catch (e) {
              // try the next selector
            }
          }
          if (!ok) {
            logger.info({ page: pageIdx + 1 }, "No further results page available; stopping pagination");
            break;
          }
          await page.waitForTimeout(getRandomDelay(200, 500));
        }

        const remaining = limit - collected.length;
        const pageResults = await page.evaluate(extractPageResults, {
          maxResults: remaining,
          exclude: Array.from(seenLinks),
        });
        pagesFetched++;
        lastPageYield = pageResults.length;

        for (const r of pageResults) {
          if (collected.length >= limit) break;
          if (seenLinks.has(r.link)) continue;
          seenLinks.add(r.link);
          collected.push(r);
        }

        // Capture aux blocks (PAA / related) and the answer box from the first page only
        if (p === 0) {
          try {
            const aux = (await page.evaluate(auxBlocksScript)) as {
              peopleAlsoAsk: string[];
              relatedSearches: string[];
            };
            peopleAlsoAsk = aux.peopleAlsoAsk;
            relatedSearches = aux.relatedSearches;
          } catch (auxError) {
            logger.warn(
              { error: auxError instanceof Error ? auxError.message : String(auxError) },
              "Failed to extract People-also-ask / Related-searches (non-fatal)"
            );
          }
          try {
            // Answer boxes / weather / sports widgets are injected dynamically and often
            // aren't in the DOM yet when the organic results are. Wait briefly (bounded)
            // for any answer-box-ish container to appear before extracting; timing out is
            // fine (many queries have no answer box at all).
            await page
              .waitForSelector('#wob_wc, .wDYxhc, .Z0LcW, .IZ6rdc, .kno-rdesc, .imso_mh', { timeout: 1500 })
              .catch(() => {});
            const ab = (await page.evaluate(answerBoxScript)) as AnswerBox | null;
            if (ab && ab.answer) {
              answerBox = ab;
              logger.info({ type: ab.type }, "Extracted answer box / featured snippet");
            }
          } catch (abError) {
            logger.warn({ error: abError }, "Failed to extract the answer box (non-fatal)");
          }
          try {
            const matches = (await page.evaluate(sportsWidgetScript)) as SportsMatch[];
            if (Array.isArray(matches) && matches.length > 0) {
              sportsMatches = matches;
              logger.info({ count: matches.length }, "Extracted sports match widget");
              // The structured fixtures supersede the flattened "sports" answer-box blob.
              if (answerBox && answerBox.type === "sports") {
                answerBox = undefined;
              }
            }
          } catch (sportsError) {
            logger.warn(
              { error: sportsError instanceof Error ? sportsError.message : String(sportsError) },
              "Failed to extract the sports match widget (non-fatal)"
            );
          }
          try {
            const w = (await page.evaluate(weatherWidgetScript)) as Weather | null;
            if (w && w.location !== undefined && typeof w.temperature === "number") {
              weather = w;
              logger.info({ location: w.location }, "Extracted weather widget");
              // The structured weather supersedes the flattened "weather" answer-box blob.
              if (answerBox && answerBox.type === "weather") {
                answerBox = undefined;
              }
            }
          } catch (weatherError) {
            logger.warn(
              { error: weatherError instanceof Error ? weatherError.message : String(weatherError) },
              "Failed to extract the weather widget (non-fatal)"
            );
          }
        }

        if (collected.length >= limit) break;
        if (lastPageYield === 0) break; // No more results available
      }

      // Assign an absolute rank and derive the domain for each result
      const getDomain = (link: string): string => {
        try {
          return new URL(link).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      };
      const results: SearchResult[] = collected.slice(0, limit).map((r, i) => ({
        position: startPageIdx * perPage + i + 1,
        title: r.title,
        link: r.link,
        domain: getDomain(r.link),
        snippet: r.snippet,
      }));

      logger.info({ count: results.length, pagesFetched }, "Successfully retrieved the search results");

      try {
        // Save the browser state (unless the user specified not to)
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving the browser state...");

          // Ensure the directory exists
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // Save the state
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully!");

          // Save the fingerprint configuration
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error occurred while saving the fingerprint configuration");
          }
        } else {
          logger.info("Not saving the browser state per the user's setting");
        }
      } catch (error) {
        logger.error({ error }, "Error occurred while saving the browser state");
      }

      // Only close the browser if it was not externally provided.
      // When using a shared/external browser, close just this request's context
      // so contexts don't leak across repeated calls (e.g. API/MCP server usage).
      if (!browserWasProvided) {
        logger.info("Closing the browser...");
        await browser.close();
      } else {
        logger.info("Keeping the shared browser open; closing this request's context");
        try {
          await context.close();
        } catch (closeError) {
          logger.warn({ error: closeError }, "Failed to close the request context (non-fatal)");
        }
      }

      // Return the search results
      return {
        query,
        results, // results is now accessible in this scope
        answerBox,
        sportsMatches: sportsMatches.length > 0 ? sportsMatches : undefined,
        weather,
        peopleAlsoAsk,
        relatedSearches,
        pagination: {
          page: Math.max(1, pageNum),
          requestedLimit: limit,
          returned: results.length,
          pagesFetched,
          // More results are likely available if the last page still yielded
          // items and we stopped only because we reached the requested limit.
          hasMore: lastPageYield > 0 && results.length >= limit,
        },
      };
    } catch (error) {
      logger.error({ error }, "Error occurred during the search");

      try {
        // Try to save the browser state even if an error occurred
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving the browser state...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // Save the fingerprint configuration
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error occurred while saving the fingerprint configuration");
          }
        }
      } catch (stateError) {
        logger.error({ error: stateError }, "Error occurred while saving the browser state");
      }

      // Only close the browser if it was not externally provided.
      // When using a shared/external browser, close just this request's context
      // so contexts don't leak across repeated calls (e.g. API/MCP server usage).
      if (!browserWasProvided) {
        logger.info("Closing the browser...");
        await browser.close();
      } else {
        logger.info("Keeping the shared browser open; closing this request's context");
        try {
          await context.close();
        } catch (closeError) {
          logger.warn({ error: closeError }, "Failed to close the request context (non-fatal)");
        }
      }

      // Propagate a real error so callers (CLI, MCP, API) can distinguish a
      // genuine failure (blocked, timeout, layout change) from an empty result set.
      // logger.error above has already recorded the details.
      throw error instanceof Error
        ? error
        : new Error(`Google search failed: ${String(error)}`);
    }
    // Removed the finally block since resource cleanup is already handled in the try and catch blocks
  }

  // First try to perform the search in headless mode
  return performSearch(useHeadless);
}

/**
 * Get the raw HTML of a Google search results page
 * @param query Search keywords
 * @param options Search options
 * @param saveToFile Whether to save the HTML to a file (optional)
 * @param outputPath HTML output file path (optional, defaults to './google-search-html/[query]-[timestamp].html')
 * @returns Response object containing the HTML content
 */
export async function getGoogleSearchPageHtml(
  query: string,
  options: CommandOptions = {},
  saveToFile: boolean = false,
  outputPath?: string
): Promise<HtmlResponse> {
  // Set default options, consistent with googleSearch
  const {
    timeout = 60000,
    stateFile = DEFAULT_STATE_FILE,
    noSaveState = false,
    locale = "zh-CN", // Default to Chinese
  } = options;

  // Ignore the passed-in headless argument; always launch in headless mode
  let useHeadless = true;

  logger.info({ options }, "Initializing the browser to fetch the search page HTML...");

  // Reuse the browser initialization code from googleSearch
  // Check whether a state file exists
  let storageState: string | undefined = undefined;
  let savedState: SavedState = {};

  // Fingerprint configuration file path
  const fingerprintFile = stateFile.replace(".json", "-fingerprint.json");

  if (fs.existsSync(stateFile)) {
    logger.info(
      { stateFile },
      "Found browser state file; will use the saved browser state to avoid anti-bot detection"
    );
    storageState = stateFile;

    // Try to load the saved fingerprint configuration
    if (fs.existsSync(fingerprintFile)) {
      try {
        const fingerprintData = fs.readFileSync(fingerprintFile, "utf8");
        savedState = JSON.parse(fingerprintData);
        logger.info("Loaded the saved browser fingerprint configuration");
      } catch (e) {
        logger.warn({ error: e }, "Unable to load the fingerprint configuration file; a new fingerprint will be created");
      }
    }
  } else {
    logger.info(
      { stateFile },
      "Browser state file not found; will create a new browser session and fingerprint"
    );
  }

  // Use the desktop device list only
  const deviceList = [
    "Desktop Chrome",
    "Desktop Edge",
    "Desktop Firefox",
    "Desktop Safari",
  ];

  // Get a random device configuration or use the saved configuration
  const getDeviceConfig = (): [string, any] => {
    if (
      savedState.fingerprint?.deviceName &&
      devices[savedState.fingerprint.deviceName]
    ) {
      // Use the saved device configuration
      return [
        savedState.fingerprint.deviceName,
        devices[savedState.fingerprint.deviceName],
      ];
    } else {
      // Randomly select a device
      const randomDevice =
        deviceList[Math.floor(Math.random() * deviceList.length)];
      return [randomDevice, devices[randomDevice]];
    }
  };

  // Get a random delay time
  const getRandomDelay = (min: number, max: number) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  // Define a dedicated function to fetch the HTML
  async function performSearchAndGetHtml(headless: boolean): Promise<HtmlResponse> {
    let browser: Browser;

    // Initialize the browser, adding more arguments to avoid detection
    browser = await chromium.launch({
      headless,
      timeout: timeout * 2, // Increase the browser launch timeout
      args: [
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
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    logger.info("Browser launched successfully!");

    // Get the device configuration - use the saved one or generate a random one
    const [deviceName, deviceConfig] = getDeviceConfig();

    // Create browser context options
    let contextOptions: BrowserContextOptions = {
      ...deviceConfig,
    };

    // If there is a saved fingerprint configuration, use it; otherwise use the host machine's actual settings
    if (savedState.fingerprint) {
      contextOptions = {
        ...contextOptions,
        locale: savedState.fingerprint.locale,
        timezoneId: savedState.fingerprint.timezoneId,
        colorScheme: savedState.fingerprint.colorScheme,
        reducedMotion: savedState.fingerprint.reducedMotion,
        forcedColors: savedState.fingerprint.forcedColors,
      };
      logger.info("Using the saved browser fingerprint configuration");
    } else {
      // Get the host machine's actual settings
      const hostConfig = getHostMachineConfig(locale);

      // If a different device type is needed, re-fetch the device configuration
      if (hostConfig.deviceName !== deviceName) {
        logger.info(
          { deviceType: hostConfig.deviceName },
          "Using device type based on the host machine settings"
        );
        // Use the new device configuration
        contextOptions = { ...devices[hostConfig.deviceName] };
      }

      contextOptions = {
        ...contextOptions,
        locale: hostConfig.locale,
        timezoneId: hostConfig.timezoneId,
        colorScheme: hostConfig.colorScheme,
        reducedMotion: hostConfig.reducedMotion,
        forcedColors: hostConfig.forcedColors,
      };

      // Save the newly generated fingerprint configuration
      savedState.fingerprint = hostConfig;
      logger.info(
        {
          locale: hostConfig.locale,
          timezone: hostConfig.timezoneId,
          colorScheme: hostConfig.colorScheme,
          deviceType: hostConfig.deviceName,
        },
        "Generated a new browser fingerprint configuration based on the host machine"
      );
    }

    // Add common options - ensure the desktop configuration is used
    contextOptions = {
      ...contextOptions,
      permissions: ["geolocation", "notifications"],
      acceptDownloads: true,
      isMobile: false, // Force desktop mode
      hasTouch: false, // Disable touch support
      javaScriptEnabled: true,
    };

    // Apply a COHERENT geo fingerprint: SERP language, IANA timezone, and Accept-Language
    // that all agree with each other AND with the exit IP. Incoherence here — e.g. en-US
    // language on an Asia/Shanghai clock from an Indian IP — was a strong bot signal that
    // triggered CAPTCHAs. Resolved fresh (env override → real machine) and applied OVER any
    // saved fingerprint, so a stale/poisoned timezone can never linger. Also updates the
    // persisted fingerprint so the fix self-heals on the next save.
    const geo = resolveGeoProfile(locale);
    contextOptions.locale = geo.locale;
    contextOptions.timezoneId = geo.timezoneId;
    contextOptions.extraHTTPHeaders = {
      ...(contextOptions.extraHTTPHeaders || {}),
      "Accept-Language": geo.acceptLanguage,
    };
    if (savedState.fingerprint) {
      savedState.fingerprint.locale = geo.locale;
      savedState.fingerprint.timezoneId = geo.timezoneId;
    }
    // navigator.languages must match the locale — Chrome exposes [regional, base].
    const navLanguages =
      /^en/i.test(geo.locale) && geo.locale.toLowerCase() !== "en"
        ? [geo.locale, "en"]
        : [geo.locale];
    logger.info(
      { locale: geo.locale, timezone: geo.timezoneId },
      "Applied coherent geo fingerprint"
    );

    if (storageState) {
      logger.info("Loading the saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // Set additional browser properties to avoid detection
    await context.addInitScript((langs: string[]) => {
      // Override navigator properties
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      // navigator.languages kept coherent with the context locale / Accept-Language.
      Object.defineProperty(navigator, "languages", {
        get: () => langs,
      });

      // Override window properties
      // @ts-ignore - Ignore the error that the chrome property does not exist
      window.chrome = {
        runtime: {},
        loadTimes: function () {},
        csi: function () {},
        app: {},
      };

      // Add WebGL fingerprint randomization
      if (typeof WebGLRenderingContext !== "undefined") {
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (
          parameter: number
        ) {
          // Randomize UNMASKED_VENDOR_WEBGL and UNMASKED_RENDERER_WEBGL
          if (parameter === 37445) {
            return "Intel Inc.";
          }
          if (parameter === 37446) {
            return "Intel Iris OpenGL Engine";
          }
          return getParameter.call(this, parameter);
        };
      }
    }, navLanguages);

    const page = await context.newPage();

    // Set additional page properties
    await page.addInitScript(() => {
      // Simulate a realistic screen size and color depth
      Object.defineProperty(window.screen, "width", { get: () => 1920 });
      Object.defineProperty(window.screen, "height", { get: () => 1080 });
      Object.defineProperty(window.screen, "colorDepth", { get: () => 24 });
      Object.defineProperty(window.screen, "pixelDepth", { get: () => 24 });
    });

    try {
      // Google domain coherent with the resolved geo (matches the exit IP's region).
      // Applied OVER any saved domain so a stale/foreign ccTLD — e.g. a randomly-picked
      // google.co.uk on an Indian session — can't linger and contradict the fingerprint.
      const selectedDomain = geo.googleDomain;
      savedState.googleDomain = selectedDomain;
      logger.info({ domain: selectedDomain }, "Using the geo-coherent Google domain");

      logger.info("Visiting the Google search page...");

      // Visit the Google search page
      const response = await page.goto(selectedDomain, {
        timeout,
        waitUntil: "networkidle",
      });

      // Check whether we were redirected to a CAPTCHA page
      const currentUrl = page.url();
      const sorryPatterns = [
        "google.com/sorry/index",
        "google.com/sorry",
        "recaptcha",
        "captcha",
        "unusual traffic",
      ];

      const isBlockedPage = sorryPatterns.some(
        (pattern) =>
          currentUrl.includes(pattern) ||
          (response && response.url().toString().includes(pattern))
      );

      if (NO_HEADED_FALLBACK && isBlockedPage) {
        logger.warn("CAPTCHA detected on landing (automated mode); failing fast.");
        try { await context.close(); } catch (_) {}
        throw new CaptchaBlockedError();
      }

      if (isBlockedPage) {
        if (headless) {
          logger.warn("CAPTCHA page detected; will restart the browser in headed mode...");

          // Close the current page and context
          await page.close();
          await context.close();
          await browser.close();

          // Re-run in headed mode
          return performSearchAndGetHtml(false);
        } else {
          logger.warn("CAPTCHA page detected; please complete the verification in the browser...");
          // Wait for the user to complete verification and be redirected back to the search page
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("CAPTCHA verification completed; continuing the search...");
        }
      }

      logger.info({ query }, "Entering the search keywords");

      // Wait for the search box to appear - try multiple possible selectors
      const searchInputSelectors = [
        "textarea[name='q']",
        "input[name='q']",
        "textarea[title='Search']",
        "input[title='Search']",
        "textarea[aria-label='Search']",
        "input[aria-label='Search']",
        "textarea",
      ];

      let searchInput = null;
      for (const selector of searchInputSelectors) {
        searchInput = await page.$(selector);
        if (searchInput) {
          logger.info({ selector }, "Found the search box");
          break;
        }
      }

      if (!searchInput) {
        logger.error("Unable to find the search box");
        throw new Error("Unable to find the search box");
      }

      // Click the search box directly to reduce delay
      await searchInput.click();

      // Type the entire query string directly instead of character by character
      await page.keyboard.type(query, { delay: getRandomDelay(10, 30) });

      // Reduce the delay before pressing Enter
      await page.waitForTimeout(getRandomDelay(100, 300));
      await page.keyboard.press("Enter");

      logger.info("Waiting for the search results page to finish loading...");

      // Wait for the page to finish loading
      await page.waitForLoadState("networkidle", { timeout });

      // Check whether the post-search URL was redirected to a CAPTCHA page
      const searchUrl = page.url();
      const isBlockedAfterSearch = sorryPatterns.some((pattern) =>
        searchUrl.includes(pattern)
      );

      if (isBlockedAfterSearch) {
        if (headless) {
          logger.warn("CAPTCHA page detected after searching; will restart the browser in headed mode...");

          // Close the current page and context
          await page.close();
          await context.close();
          await browser.close();

          // Re-run in headed mode
          return performSearchAndGetHtml(false);
        } else {
          logger.warn("CAPTCHA page detected after searching; please complete the verification in the browser...");
          // Wait for the user to complete verification and be redirected back to the search page
          await page.waitForNavigation({
            timeout: timeout * 2,
            url: (url) => {
              const urlStr = url.toString();
              return sorryPatterns.every(
                (pattern) => !urlStr.includes(pattern)
              );
            },
          });
          logger.info("CAPTCHA verification completed; continuing the search...");

          // Wait for the page to reload
          await page.waitForLoadState("networkidle", { timeout });
        }
      }

      // Get the current page URL
      const finalUrl = page.url();
      logger.info({ url: finalUrl }, "Search results page loaded; preparing to extract the HTML...");

      // Add extra wait time to ensure the page is fully loaded and stable
      logger.info("Waiting for the page to stabilize...");
      await page.waitForTimeout(1000); // Wait 1 second to let the page fully stabilize

      // Wait for network idle again to ensure all asynchronous operations are complete
      await page.waitForLoadState("networkidle", { timeout });

      // Get the page HTML content
      const fullHtml = await page.content();

      // Remove CSS and JavaScript content, keeping only plain HTML
      // Remove all <style> tags and their content
      let html = fullHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
      // Remove all <link rel="stylesheet"> tags
      html = html.replace(/<link\s+[^>]*rel=["']stylesheet["'][^>]*>/gi, '');
      // Remove all <script> tags and their content
      html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

      logger.info({
        originalLength: fullHtml.length,
        cleanedLength: html.length
      }, "Successfully fetched and cleaned the page HTML content");

      // If needed, save the HTML to a file and take a screenshot
      let savedFilePath: string | undefined = undefined;
      let screenshotPath: string | undefined = undefined;

      if (saveToFile) {
        // Generate a default file name (if not provided)
        if (!outputPath) {
          // Ensure the directory exists
          const outputDir = "./google-search-html";
          if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
          }

          // Generate the file name: query-timestamp.html
          const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\./g, "-");
          const sanitizedQuery = query.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
          outputPath = `${outputDir}/${sanitizedQuery}-${timestamp}.html`;
        }

        // Ensure the file directory exists
        const fileDir = path.dirname(outputPath);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }

        // Write the HTML file
        fs.writeFileSync(outputPath, html, "utf8");
        savedFilePath = outputPath;
        logger.info({ path: outputPath }, "Cleaned HTML content has been saved to file");

        // Save a screenshot of the web page
        // Generate the screenshot file name (based on the HTML file name, but with a .png extension)
        const screenshotFilePath = outputPath.replace(/\.html$/, '.png');

        // Take a screenshot of the entire page
        logger.info("Taking a screenshot of the web page...");
        await page.screenshot({
          path: screenshotFilePath,
          fullPage: true
        });

        screenshotPath = screenshotFilePath;
        logger.info({ path: screenshotFilePath }, "Web page screenshot has been saved");
      }

      try {
        // Save the browser state (unless the user specified not to)
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving the browser state...");

          // Ensure the directory exists
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }

          // Save the state
          await context.storageState({ path: stateFile });
          logger.info("Browser state saved successfully!");

          // Save the fingerprint configuration
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error occurred while saving the fingerprint configuration");
          }
        } else {
          logger.info("Not saving the browser state per the user's setting");
        }
      } catch (error) {
        logger.error({ error }, "Error occurred while saving the browser state");
      }

      // Close the browser
      logger.info("Closing the browser...");
      await browser.close();

      // Return the HTML response
      return {
        query,
        html,
        url: finalUrl,
        savedPath: savedFilePath,
        screenshotPath: screenshotPath,
        originalHtmlLength: fullHtml.length
      };
    } catch (error) {
      logger.error({ error }, "Error occurred while fetching the page HTML");

      try {
        // Try to save the browser state even if an error occurred
        if (!noSaveState) {
          logger.info({ stateFile }, "Saving the browser state...");
          const stateDir = path.dirname(stateFile);
          if (!fs.existsSync(stateDir)) {
            fs.mkdirSync(stateDir, { recursive: true });
          }
          await context.storageState({ path: stateFile });

          // Save the fingerprint configuration
          try {
            fs.writeFileSync(
              fingerprintFile,
              JSON.stringify(savedState, null, 2),
              "utf8"
            );
            logger.info({ fingerprintFile }, "Fingerprint configuration saved");
          } catch (fingerprintError) {
            logger.error({ error: fingerprintError }, "Error occurred while saving the fingerprint configuration");
          }
        }
      } catch (stateError) {
        logger.error({ error: stateError }, "Error occurred while saving the browser state");
      }

      // Close the browser
      logger.info("Closing the browser...");
      await browser.close();

      // Return error information
      throw new Error(`Failed to get the Google search page HTML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // First try to run in headless mode
  return performSearchAndGetHtml(useHeadless);
}

/**
 * Search Google Images (udm=2) and return structured image results, with pagination.
 *
 * Images is an infinite-scroll surface (no `&start=` paging), so pagination is realized
 * by scrolling to accumulate results: we gather `page * limit` unique images, then return
 * the slice for the requested 1-based `page`. Reuses the same warm anti-bot state and
 * coherent geo fingerprint as googleSearch. On a CAPTCHA it fails fast (no headed
 * fallback in v1) — keep the session warm via the CLI web search or `npm run warm:profile`.
 *
 * Each result carries the full-res `imageUrl` + real `width`/`height` (parsed from the
 * page's inline JSON, keyed by the cell's docid) plus a gstatic `thumbnail`, the
 * `sourcePage`, and the `source` site name.
 */
export async function imageSearch(
  query: string,
  options: CommandOptions = {},
  existingBrowser?: Browser
): Promise<ImageSearchResponse> {
  const {
    limit = 20,
    page: pageNum = 1,
    timeout = 60000,
    stateFile = DEFAULT_STATE_FILE,
    noSaveState = false,
    locale = "zh-CN",
  } = options;

  const startPage = Math.max(1, pageNum);
  const startOffset = (startPage - 1) * limit;
  const need = startOffset + limit;
  const geo = resolveGeoProfile(locale);
  const getDelay = () => 700 + Math.floor(Math.random() * 600);

  // Load the saved anti-bot cookie state if present (shared with the web search).
  const storageState: string | undefined = fs.existsSync(stateFile) ? stateFile : undefined;
  if (storageState) logger.info({ stateFile }, "Loading saved browser state for image search");

  let browser: Browser;
  const browserWasProvided = !!existingBrowser;
  if (existingBrowser) {
    browser = existingBrowser;
    logger.info("Using the existing browser instance");
  } else {
    browser = await chromium.launch({
      headless: true,
      timeout: timeout * 2,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--mute-audio",
        "--enable-features=NetworkService,NetworkServiceInProcess",
        "--force-color-profile=srgb",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    });
  }

  const contextOptions: BrowserContextOptions = {
    ...devices["Desktop Chrome"],
    locale: geo.locale,
    timezoneId: geo.timezoneId,
    permissions: ["geolocation", "notifications"],
    acceptDownloads: true,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    extraHTTPHeaders: { "Accept-Language": geo.acceptLanguage },
  };

  const navLanguages =
    /^en/i.test(geo.locale) && geo.locale.toLowerCase() !== "en"
      ? [geo.locale, "en"]
      : [geo.locale];

  const context = await browser.newContext(
    storageState ? { ...contextOptions, storageState } : contextOptions
  );
  await context.addInitScript((langs: string[]) => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => langs });
    // @ts-ignore - the chrome property is not typed on window
    window.chrome = { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} };
  }, navLanguages);

  const page = await context.newPage();

  // STRING (not a function) for the same tsx/esbuild __name serialization reason as the
  // other page.evaluate extractors in this file.
  const extractImagesScript = `(() => {
    const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
    // Decode \\uXXXX escapes in an inline-JSON URL via JSON.parse (URLs never contain a
    // raw double-quote, so wrapping in quotes is safe).
    const unesc = (s) => { try { return JSON.parse('"' + s + '"'); } catch (e) { return s; } };
    // docid -> {thumb, original, width, height} from the page's inline JSON. Each image
    // entry looks like [0,"docid",[thumbUrl,h,w],[originalUrl,h,w],...].
    const map = {};
    const src = document.documentElement.innerHTML;
    const re = /"([\\w-]{6,})",\\["(https?:[^"]+?)",(\\d+),(\\d+)\\],\\["(https?:[^"]+?)",(\\d+),(\\d+)\\]/g;
    let m;
    while ((m = re.exec(src))) {
      if (!map[m[1]]) {
        map[m[1]] = { thumb: unesc(m[2]), original: unesc(m[5]), height: parseInt(m[6], 10), width: parseInt(m[7], 10) };
      }
    }
    const out = [];
    document.querySelectorAll('div[data-attrid="images universal"]').forEach((cell) => {
      const docid = cell.getAttribute('data-docid') || '';
      const lpage = cell.getAttribute('data-lpage') || '';
      const imgEl = cell.querySelector('.ImUqSb img') || cell.querySelector('img[alt]:not([alt=""])');
      const title = clean((imgEl && imgEl.getAttribute('alt')) || (cell.querySelector('.Q6A6Dc') || {}).textContent);
      const source = clean((cell.querySelector('.VYhLad span, .VYhLad') || {}).textContent);
      const meta = map[docid] || {};
      const thumbnail = meta.thumb || (imgEl && imgEl.getAttribute('src')) || '';
      if (!lpage && !meta.original) return;
      const r = { docid: docid, title: title, sourcePage: lpage, source: source, thumbnail: thumbnail };
      if (meta.original) r.imageUrl = meta.original;
      if (meta.width) r.width = meta.width;
      if (meta.height) r.height = meta.height;
      out.push(r);
    });
    return out;
  })()`;

  try {
    const url = new URL(geo.googleDomain + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("udm", "2"); // Images vertical (replaces the legacy tbm=isch)
    logger.info({ query, url: url.toString() }, "Visiting Google Images...");
    await page.goto(url.toString(), { timeout, waitUntil: "domcontentloaded" });

    if (page.url().includes("/sorry/") || page.url().includes("/sorry?")) {
      logger.warn("CAPTCHA on image search; failing fast.");
      try { await context.close(); } catch (e) {}
      if (!browserWasProvided) await browser.close();
      throw new CaptchaBlockedError();
    }

    await page.waitForTimeout(1500);

    // Scroll-pagination: accumulate unique images until we have `need`, growth stalls, or
    // we hit the scroll cap.
    const collected: any[] = [];
    const seen = new Set<string>();
    let scrolls = 0;
    let stagnant = 0;
    const maxScrolls = 40;
    const merge = (arr: any[]) => {
      for (const r of arr) {
        const key = r.docid || r.imageUrl || r.sourcePage;
        if (key && !seen.has(key)) {
          seen.add(key);
          collected.push(r);
        }
      }
    };
    while (collected.length < need && scrolls < maxScrolls && stagnant < 3) {
      const batch = (await page.evaluate(extractImagesScript)) as any[];
      const before = collected.length;
      merge(batch);
      if (collected.length === before) stagnant++;
      else stagnant = 0;
      if (collected.length >= need) break;
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.waitForTimeout(getDelay());
      scrolls++;
    }

    const images: ImageResult[] = collected
      .slice(startOffset, startOffset + limit)
      .map((r, i) => ({
        position: startOffset + i + 1,
        title: r.title,
        imageUrl: r.imageUrl,
        thumbnail: r.thumbnail,
        sourcePage: r.sourcePage,
        source: r.source,
        width: r.width,
        height: r.height,
      }));

    logger.info(
      { count: images.length, scrolls, gathered: collected.length },
      "Successfully retrieved image results"
    );

    if (!noSaveState) {
      try {
        const dir = path.dirname(stateFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        await context.storageState({ path: stateFile });
      } catch (e) {
        logger.warn(
          { error: e instanceof Error ? e.message : String(e) },
          "Failed to save browser state (non-fatal)"
        );
      }
    }

    if (!browserWasProvided) await browser.close();
    else { try { await context.close(); } catch (e) {} }

    return {
      query,
      images,
      pagination: {
        page: startPage,
        requestedLimit: limit,
        returned: images.length,
        scrolls,
        hasMore: collected.length > startOffset + limit,
      },
    };
  } catch (error) {
    try { await context.close(); } catch (e) {}
    if (!browserWasProvided) { try { await browser.close(); } catch (e) {} }
    if (error instanceof CaptchaBlockedError) throw error;
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "Image search failed"
    );
    throw new Error(
      `Image search failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
