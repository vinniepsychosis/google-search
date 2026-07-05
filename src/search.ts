import { chromium, devices, BrowserContextOptions, Browser } from "playwright";
import { SearchResponse, SearchResult, CommandOptions, HtmlResponse } from "./types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import logger from "./logger.js";

// Fingerprint configuration interface
interface FingerprintConfig {
  deviceName: string;
  locale: string;
  timezoneId: string;
  colorScheme: "dark" | "light";
  reducedMotion: "reduce" | "no-preference";
  forcedColors: "active" | "none";
}

// Saved state file interface
interface SavedState {
  fingerprint?: FingerprintConfig;
  googleDomain?: string;
}

/**
 * Get the actual configuration of the host machine
 * @param userLocale User-specified locale (if any)
 * @returns Fingerprint configuration based on the host machine
 */
function getHostMachineConfig(userLocale?: string): FingerprintConfig {
  // Get the system locale
  const systemLocale = userLocale || process.env.LANG || "zh-CN";

  // Get the system timezone
  // Node.js does not directly provide timezone information, but it can be inferred from the timezone offset
  const timezoneOffset = new Date().getTimezoneOffset();
  let timezoneId = "Asia/Shanghai"; // Default to the Shanghai timezone

  // Roughly infer the timezone from the timezone offset
  // The timezone offset is in minutes, representing the difference from UTC; a negative value indicates an eastern timezone
  if (timezoneOffset <= -480 && timezoneOffset > -600) {
    // UTC+8 (China, Singapore, Hong Kong, etc.)
    timezoneId = "Asia/Shanghai";
  } else if (timezoneOffset <= -540) {
    // UTC+9 (Japan, Korea, etc.)
    timezoneId = "Asia/Tokyo";
  } else if (timezoneOffset <= -420 && timezoneOffset > -480) {
    // UTC+7 (Thailand, Vietnam, etc.)
    timezoneId = "Asia/Bangkok";
  } else if (timezoneOffset <= 0 && timezoneOffset > -60) {
    // UTC+0 (United Kingdom, etc.)
    timezoneId = "Europe/London";
  } else if (timezoneOffset <= 60 && timezoneOffset > 0) {
    // UTC-1 (parts of Europe)
    timezoneId = "Europe/Berlin";
  } else if (timezoneOffset <= 300 && timezoneOffset > 240) {
    // UTC-5 (eastern United States)
    timezoneId = "America/New_York";
  }

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
    stateFile = "./browser-state.json",
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

  // Google domain list
  const googleDomains = [
    "https://www.google.com",
    "https://www.google.co.uk",
    "https://www.google.ca",
    "https://www.google.com.au",
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

    if (storageState) {
      logger.info("Loading the saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // Set additional browser properties to avoid detection
    await context.addInitScript(() => {
      // Override navigator properties
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en", "zh-CN"],
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
    });

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
      // Use the saved Google domain or randomly select one
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using the saved Google domain");
      } else {
        selectedDomain =
          googleDomains[Math.floor(Math.random() * googleDomains.length)];
        // Save the selected domain
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Randomly selected a Google domain");
      }

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
      for (const selector of searchResultSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: timeout / 2 });
          logger.info({ selector }, "Found the search results");
          resultsFound = true;
          break;
        } catch (e) {
          // Continue trying the next selector
        }
      }

      if (!resultsFound) {
        // If the search results cannot be found, check whether we were redirected to a CAPTCHA page
        const currentUrl = page.url();
        const isBlockedDuringResults = sorryPatterns.some((pattern) =>
          currentUrl.includes(pattern)
        );

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
      const extractAuxBlocks = (): { peopleAlsoAsk: string[]; relatedSearches: string[] } => {
        const uniq = (arr: string[]) =>
          Array.from(new Set(arr.map((s) => s.trim()).filter(Boolean)));

        // People also ask
        const paa: string[] = [];
        const paaSelectors = [
          'div[jsname="Cpkphb"]',
          '.related-question-pair',
          'div[data-initq]',
          'div[data-q]',
        ];
        for (const sel of paaSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.getAttribute('data-q') || el.textContent || '').trim();
            if (t && t.length > 8 && t.length < 200) paa.push(t);
          });
        }
        // Fallback: heading-like elements ending with a question mark
        if (paa.length === 0) {
          document.querySelectorAll('#search [role="heading"]').forEach((el) => {
            const t = (el.textContent || '').trim();
            if (t.endsWith('?') && t.length > 10 && t.length < 200) paa.push(t);
          });
        }

        // Related searches
        const related: string[] = [];
        const relatedSelectors = ['#bres a', 'a.k8XOCe', '.s75CSd', '.wM6W7d'];
        for (const sel of relatedSelectors) {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.textContent || '').trim();
            if (t && t.length > 2 && t.length < 100) related.push(t);
          });
        }

        return {
          peopleAlsoAsk: uniq(paa).slice(0, 10),
          relatedSearches: uniq(related).slice(0, 10),
        };
      };

      // Fetch pages until we reach the requested limit (or run out of results).
      const perPage = 10;
      const startPageIdx = Math.max(1, pageNum) - 1; // 0-based index of the first page to fetch
      const maxPagesToFetch = Math.max(1, Math.ceil(limit / perPage));

      const collected: { title: string; link: string; snippet: string }[] = [];
      const seenLinks = new Set<string>();
      let peopleAlsoAsk: string[] = [];
      let relatedSearches: string[] = [];
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

        // Capture aux blocks (PAA / related) from the first fetched page only
        if (p === 0) {
          try {
            const aux = await page.evaluate(extractAuxBlocks);
            peopleAlsoAsk = aux.peopleAlsoAsk;
            relatedSearches = aux.relatedSearches;
          } catch (auxError) {
            logger.warn({ error: auxError }, "Failed to extract People-also-ask / Related-searches (non-fatal)");
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
    stateFile = "./browser-state.json",
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

  // Google domain list
  const googleDomains = [
    "https://www.google.com",
    "https://www.google.co.uk",
    "https://www.google.ca",
    "https://www.google.com.au",
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

    if (storageState) {
      logger.info("Loading the saved browser state...");
    }

    const context = await browser.newContext(
      storageState ? { ...contextOptions, storageState } : contextOptions
    );

    // Set additional browser properties to avoid detection
    await context.addInitScript(() => {
      // Override navigator properties
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-US", "en", "zh-CN"],
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
    });

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
      // Use the saved Google domain or randomly select one
      let selectedDomain: string;
      if (savedState.googleDomain) {
        selectedDomain = savedState.googleDomain;
        logger.info({ domain: selectedDomain }, "Using the saved Google domain");
      } else {
        selectedDomain =
          googleDomains[Math.floor(Math.random() * googleDomains.length)];
        // Save the selected domain
        savedState.googleDomain = selectedDomain;
        logger.info({ domain: selectedDomain }, "Randomly selected a Google domain");
      }

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
