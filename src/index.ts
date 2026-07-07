#!/usr/bin/env node

import { Command } from "commander";
import * as os from "os";
import * as path from "path";
import { getGoogleSearchPageHtml } from "./search.js";
import { search } from "./engines.js";
import { CommandOptions } from "./types.js";

// Get package information
import packageJson from "../package.json" with { type: "json" };

// Create the command line program
const program = new Command();

// Configure command line options
program
  .name("google-search")
  .description("Playwright-based Google search CLI tool")
  .version(packageJson.version)
  .argument("<query>", "Search keywords")
  // Note: use an explicit radix-10 parser. A bare `parseInt` would receive the
  // option's default value as its second argument (the radix), corrupting the result.
  .option("-e, --engine <engine>", "Search engine: google | bing | duckduckgo | brave | all (parallel + merged)", "google")
  .option("-l, --limit <number>", "Result count limit (fetched across pages as needed)", (v) => parseInt(v, 10), 10)
  .option("-p, --page <number>", "Starting results page (1-based)", (v) => parseInt(v, 10), 1)
  .option("-t, --timeout <number>", "Timeout in milliseconds", (v) => parseInt(v, 10), 30000)
  .option("--no-headless", "Deprecated: headless mode is now always tried first, automatically switching to headed mode if a CAPTCHA is encountered")
  .option("--state-file <path>", "Browser state file path", "./browser-state.json")
  .option("--no-save-state", "Do not save browser state")
  .option("--solve", "Open a headed browser to solve a one-time anti-bot challenge (e.g. Brave), then persist the clearance so future headless runs reuse it")
  .option("--headed-solve", "If headless retries hit a challenge, fall back to a headed window for a manual solve")
  .option("--get-html", "Get the raw HTML of the search result page instead of parsing results")
  .option("--save-html", "Save the HTML to a file")
  .option("--html-output <path>", "HTML output file path")
  .action(async (query: string, options: CommandOptions & { getHtml?: boolean, saveHtml?: boolean, htmlOutput?: string, solve?: boolean, saveState?: boolean }) => {
    try {
      // Commander maps `--no-save-state` to `saveState:false`, but the search
      // code reads `noSaveState`. Bridge the two so the flag actually takes effect.
      if (options.saveState === false) options.noSaveState = true;
      // Map the `--solve` flag onto the programmatic option name.
      if (options.solve) options.solveChallenge = true;

      // A one-time solve is most useful when its cleared session is shared with
      // the API/MCP servers, which read ~/.google-search-browser-state.json. So
      // when solving with the default state-file, redirect to that shared path
      // (an explicit --state-file is still respected).
      if (options.solveChallenge && options.stateFile === "./browser-state.json") {
        options.stateFile = path.join(os.homedir(), ".google-search-browser-state.json");
        console.error(`[solve] Using shared state file: ${options.stateFile}`);
      }

      if (options.getHtml) {
        // Get HTML
        const htmlResult = await getGoogleSearchPageHtml(
          query,
          options,
          options.saveHtml || false,
          options.htmlOutput
        );

        // If the HTML was saved to a file, include the file path in the output
        if (options.saveHtml && htmlResult.savedPath) {
          console.log(`HTML saved to file: ${htmlResult.savedPath}`);
        }

        // Output the result (without the full HTML, to avoid excessive console output)
        const outputResult = {
          query: htmlResult.query,
          url: htmlResult.url,
          originalHtmlLength: htmlResult.originalHtmlLength, // Original HTML length (including CSS and JavaScript)
          cleanedHtmlLength: htmlResult.html.length, // Cleaned HTML length (without CSS and JavaScript)
          savedPath: htmlResult.savedPath,
          screenshotPath: htmlResult.screenshotPath, // Page screenshot save path
          // Only output the first 500 characters of the HTML as a preview
          htmlPreview: htmlResult.html.substring(0, 500) + (htmlResult.html.length > 500 ? '...' : '')
        };

        console.log(JSON.stringify(outputResult, null, 2));
      } else {
        // Perform a regular search (engine selected via --engine)
        const results = await search(query, options);

        // Output the results
        console.log(JSON.stringify(results, null, 2));
      }
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse(process.argv);
