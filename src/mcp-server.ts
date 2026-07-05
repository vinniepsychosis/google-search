#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { googleSearch, getGoogleSearchPageHtml } from "./search.js";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import logger from "./logger.js";
import { chromium, Browser } from "playwright";

// Global browser instance
let globalBrowser: Browser | undefined = undefined;

// Create the MCP server instance
const server = new McpServer({
  name: "google-search-server",
  version: "1.0.0",
});

// Structured output schema for the search tool (mirrors SearchResponse)
const searchOutputSchema = {
  query: z.string(),
  results: z
    .array(
      z.object({
        position: z.number().describe("1-based rank of the result"),
        title: z.string(),
        link: z.string(),
        domain: z.string().describe("Hostname of the result link"),
        snippet: z.string(),
      })
    )
    .describe("Organic search results in rank order"),
  peopleAlsoAsk: z
    .array(z.string())
    .optional()
    .describe("'People also ask' questions (useful for query expansion)"),
  relatedSearches: z
    .array(z.string())
    .optional()
    .describe("'Related searches' suggestions"),
  pagination: z
    .object({
      page: z.number(),
      requestedLimit: z.number(),
      returned: z.number(),
      pagesFetched: z.number(),
      hasMore: z.boolean(),
    })
    .optional()
    .describe("Pagination metadata describing what was fetched"),
};

// Register the Google search tool
server.registerTool(
  "google-search",
  {
    title: "Google Search",
    description:
      "Use the Google search engine to query real-time web information, returning search results with titles, links, and snippets. Suitable for scenarios that require the latest information, finding material on a specific topic, researching current events, or verifying facts. Returns structured results including position, domain, snippets, and (when available) 'People also ask' and 'Related searches'.",
    inputSchema: {
      query: z
        .string()
        .describe(
          "The search query string. For best results: 1) Prefer English keywords, since English content is usually richer and more up to date, especially in technical and academic fields; 2) Use specific keywords rather than vague phrases; 3) Use quotes \"exact phrase\" to force an exact match; 4) Use site:domain to restrict to a specific website; 5) Use -exclude to filter out results; 6) Use OR to connect alternative terms; 7) Prefer technical terminology; 8) Keep it to 2-5 keywords for balanced results; 9) Choose an appropriate language for the target content (use Chinese only when you need to find specific Chinese resources). For example: 'climate change report 2024 site:gov -opinion' or '\"machine learning algorithms\" tutorial (Python OR Julia)'"
        ),
      limit: z
        .number()
        .optional()
        .describe("Number of search results to return, fetched across pages as needed (default: 10, recommended range: 1-30)"),
      page: z
        .number()
        .optional()
        .describe("Starting results page, 1-based (default: 1). Use to page deeper into results."),
      timeout: z
        .number()
        .optional()
        .describe("Timeout for the search operation in milliseconds (default: 30000, adjust based on network conditions)"),
    },
    outputSchema: searchOutputSchema,
  },
  async (params) => {
    try {
      const { query, limit, page, timeout } = params;
      logger.info({ query, limit, page }, "Performing Google search");

      // Get the state file path in the user's home directory
      const stateFilePath = path.join(
        os.homedir(),
        ".google-search-browser-state.json"
      );
      logger.info({ stateFilePath }, "Using state file path");

      // Check whether the state file exists
      const stateFileExists = fs.existsSync(stateFilePath);

      // Initialize the warning message
      let warningMessage = "";

      if (!stateFileExists) {
        warningMessage =
          "⚠️ Note: The browser state file does not exist. On first use, if a CAPTCHA is encountered, the system will automatically switch to headed mode so you can complete the verification. Once done, the state file will be saved, and subsequent searches will run more smoothly.";
        logger.warn(warningMessage);
      }

      // Perform the search using the global browser instance
      const results = await googleSearch(
        query,
        {
          limit: limit,
          page: page,
          timeout: timeout,
          stateFile: stateFilePath,
        },
        globalBrowser
      );

      // Build the human-readable text block, including the warning message
      let responseText = JSON.stringify(results, null, 2);
      if (warningMessage) {
        responseText = warningMessage + "\n\n" + responseText;
      }

      return {
        content: [
          {
            type: "text",
            text: responseText,
          },
        ],
        // Machine-readable payload validated against outputSchema
        structuredContent: results as unknown as Record<string, unknown>,
      };
    } catch (error) {
      logger.error({ error }, "Search tool execution error");

      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Search failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  }
);

// Start the server
async function main() {
  try {
    logger.info("Starting the Google search MCP server...");

    // Initialize the global browser instance
    logger.info("Initializing the global browser instance...");
    globalBrowser = await chromium.launch({
      headless: true,
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
    logger.info("Global browser instance initialized successfully");

    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info("Google search MCP server started, waiting for connections...");

    // Set up the cleanup function for process exit
    process.on("exit", async () => {
      await cleanupBrowser();
    });

    // Handle Ctrl+C (Windows and Unix/Linux)
    process.on("SIGINT", async () => {
      logger.info("Received SIGINT signal, shutting down the server...");
      await cleanupBrowser();
      process.exit(0);
    });

    // Handle process termination (Unix/Linux)
    process.on("SIGTERM", async () => {
      logger.info("Received SIGTERM signal, shutting down the server...");
      await cleanupBrowser();
      process.exit(0);
    });

    // Windows-specific handling
    if (process.platform === "win32") {
      // Handle Windows CTRL_CLOSE_EVENT, CTRL_LOGOFF_EVENT, and CTRL_SHUTDOWN_EVENT
      const readline = await import("readline");
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      rl.on("SIGINT", async () => {
        logger.info("Windows: Received SIGINT signal, shutting down the server...");
        await cleanupBrowser();
        process.exit(0);
      });
    }
  } catch (error) {
    logger.error({ error }, "Server startup failed");
    await cleanupBrowser();
    process.exit(1);
  }
}

// Clean up browser resources
async function cleanupBrowser() {
  if (globalBrowser) {
    logger.info("Closing the global browser instance...");
    try {
      await globalBrowser.close();
      globalBrowser = undefined;
      logger.info("Global browser instance closed");
    } catch (error) {
      logger.error({ error }, "Error occurred while closing the browser instance");
    }
  }
}

main();
