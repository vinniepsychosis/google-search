#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { imageSearch, DEFAULT_STATE_FILE } from "./search.js";
import { search } from "./engines.js";
import * as fs from "fs";
import { fileURLToPath } from "url";
import logger from "./logger.js";

// NOTE: each search gets its OWN fresh browser (launched + closed inside
// googleSearch/getGoogleSearchPageHtml). A single long-lived shared browser was
// previously reused across calls, but Google reliably serves a CAPTCHA to such a
// persistent headless instance — even on its first request — whereas a fresh
// browser per call (loading the same saved anti-bot state) is not flagged.

// Build a fresh MCP server with the google-search tool registered. A factory (not a
// shared singleton) so the stateless Streamable HTTP transport can spin up one per
// request, while the stdio entrypoint below uses a single instance. Both entrypoints
// (mcp-server.ts / mcp-http-server.ts) share this exact tool definition.
export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "google-search-server",
    version: "1.0.0",
  });

// Structured output schema for the search tool (mirrors SearchResponse)
const searchOutputSchema = {
  query: z.string(),
  engine: z.string().optional().describe("Engine that produced these results"),
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
  answerBox: z
    .object({
      type: z.string().describe('"featured_snippet" | "answer" | "weather" | "sports" | "knowledge_panel"'),
      title: z.string(),
      answer: z.string().describe("The concise, direct answer text"),
      source: z.string(),
    })
    .optional()
    .describe(
      "Google's answer box / featured snippet / weather or sports widget / knowledge panel, when present. This is the MOST authoritative, direct answer for real-time facts (scores, weather, prices, 'current X'); prefer it over organic snippets."
    ),
  sportsMatches: z
    .array(
      z.object({
        teams: z.array(z.string()).describe("The two sides, in display order"),
        scores: z.array(z.number()).optional().describe("Per-team scores aligned with `teams` (live/finished matches)"),
        stage: z.string().optional().describe('Round/stage, e.g. "Quarter-finals"'),
        status: z.string().optional().describe('Kickoff/status label, e.g. "Tomorrow 2:30 am" or "Full-time"'),
        startTime: z.string().optional().describe("ISO 8601 kickoff time (UTC)"),
      })
    )
    .optional()
    .describe("Structured fixtures parsed from Google's sports match widget, when present. Authoritative for real-time schedules/scores; prefer over organic snippets."),
  weather: z
    .object({
      location: z.string(),
      temperature: z.number().describe("Current temperature in `unit`"),
      unit: z.enum(["C", "F"]),
      condition: z.string().describe('Sky condition, e.g. "Clear"'),
      precipitation: z.string().optional(),
      humidity: z.string().optional(),
      wind: z.string().optional(),
      observedAt: z.string().optional().describe("Local observation time label"),
      forecast: z
        .array(
          z.object({
            day: z.string(),
            condition: z.string().optional(),
            high: z.number().optional(),
            low: z.number().optional(),
          })
        )
        .optional(),
    })
    .optional()
    .describe("Structured current conditions + forecast from Google's weather widget, when present. Authoritative for real-time weather; prefer over organic snippets."),
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
      "Use the Google search engine to query real-time web information, returning search results with titles, links, and snippets. Suitable for scenarios that require the latest information, finding material on a specific topic, researching current events, or verifying facts. Returns structured results including position, domain, snippets, and (when available) an 'answerBox' — Google's featured snippet / direct answer / weather or sports widget / knowledge panel, which is the most authoritative source for real-time facts like scores, weather, and prices — plus 'People also ask' and 'Related searches'.",
    inputSchema: {
      engine: z
        .enum(["google", "bing", "duckduckgo", "brave", "all"])
        .optional()
        .describe("Search engine to use (default: google). Use others as fallback if Google is blocked. 'all' queries every engine in parallel and merges the results into one deduped list (each result carries a `sources` array)."),
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
      const { query, engine, limit, page, timeout } = params;
      logger.info({ query, engine, limit, page }, "Performing search");

      // Shared anti-bot state file (same one the CLI warms). This server can't solve
      // CAPTCHAs, so it relies on this session being warm — run the CLI once to seed it.
      const stateFilePath = DEFAULT_STATE_FILE;
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

      // Multi-engine dispatch (engine selected via the `engine` arg). No shared browser
      // arg: each call launches and closes its own fresh browser — a long-lived shared
      // instance reliably gets CAPTCHA'd by Google.
      const results = await search(query, {
        engine: engine,
        limit: limit,
        page: page,
        timeout: timeout,
        stateFile: stateFilePath,
      });

      // Build the human-readable text block. Lead with the answer box (featured
      // snippet / widget) when present — it's the authoritative direct answer and we
      // want the model to see it first — then the full structured JSON.
      let responseText = JSON.stringify(results, null, 2);
      if (results.answerBox && results.answerBox.answer) {
        const ab = results.answerBox;
        const src = ab.source ? ` [${ab.source}]` : "";
        responseText = `DIRECT ANSWER (${ab.type}): ${ab.answer}${src}\n\n${responseText}`;
      }
      if (results.sportsMatches && results.sportsMatches.length > 0) {
        const lines = results.sportsMatches.map((m) => {
          const score =
            m.scores && m.scores.length === 2 ? ` ${m.scores[0]}-${m.scores[1]}` : "";
          const when = m.status || m.startTime || "";
          const stage = m.stage ? `${m.stage}: ` : "";
          return `  • ${stage}${m.teams.join(" vs ")}${score}${when ? ` — ${when}` : ""}`;
        });
        responseText = `MATCH WIDGET:\n${lines.join("\n")}\n\n${responseText}`;
      }
      if (results.weather) {
        const w = results.weather;
        const bits = [`${w.temperature}°${w.unit}`, w.condition].filter(Boolean);
        if (w.humidity) bits.push(`humidity ${w.humidity}`);
        if (w.wind) bits.push(`wind ${w.wind}`);
        responseText = `WEATHER (${w.location}): ${bits.join(", ")}\n\n${responseText}`;
      }
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

  // Image search tool (Google Images / udm=2), paginated via scroll.
  server.registerTool(
    "google-image-search",
    {
      title: "Google Image Search",
      description:
        "Search Google Images and return structured image results: full-resolution image URL, dimensions, a thumbnail, the source page URL, and the source site name. Use for finding images, visual references, product photos, diagrams, etc. Paginates by scrolling (Images is infinite-scroll): 'limit' is the number of images to return, 'page' (1-based) offsets into the accumulated results.",
      inputSchema: {
        query: z.string().describe("The image search query."),
        limit: z
          .number()
          .optional()
          .describe("Number of images to return (default 20; larger values scroll more)."),
        page: z.number().optional().describe("1-based page for offsetting results (default 1)."),
        timeout: z.number().optional().describe("Timeout in milliseconds (default 60000)."),
      },
      outputSchema: {
        query: z.string(),
        images: z.array(
          z.object({
            position: z.number(),
            title: z.string(),
            imageUrl: z.string().optional().describe("Full-resolution original image URL"),
            thumbnail: z.string().describe("Thumbnail URL (gstatic)"),
            sourcePage: z.string().describe("Page hosting the image"),
            source: z.string().describe("Source site name"),
            width: z.number().optional(),
            height: z.number().optional(),
          })
        ),
        pagination: z
          .object({
            page: z.number(),
            requestedLimit: z.number(),
            returned: z.number(),
            scrolls: z.number(),
            hasMore: z.boolean(),
          })
          .optional(),
      },
    },
    async (params) => {
      try {
        const { query, limit, page, timeout } = params;
        logger.info({ query, limit, page }, "Performing Google image search");
        const results = await imageSearch(query, {
          limit,
          page,
          timeout,
          stateFile: DEFAULT_STATE_FILE,
        });
        const lines = results.images.map(
          (im) =>
            `  ${im.position}. ${im.title || "(untitled)"} — ${im.imageUrl || im.thumbnail} [${im.source}]`
        );
        const text = `IMAGES for "${results.query}" (${results.images.length}):\n${lines.join("\n")}\n\n${JSON.stringify(results, null, 2)}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: results as unknown as Record<string, unknown>,
        };
      } catch (error) {
        logger.error({ error }, "Image search tool execution error");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Image search failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

// stdio entrypoint — for local MCP clients that spawn this file as a subprocess
// (Claude Desktop, etc.). Networked clients like n8n use mcp-http-server.ts instead.
async function main() {
  const server = createMcpServer();
  try {
    logger.info("Starting the Google search MCP server (stdio)...");

    const transport = new StdioServerTransport();
    await server.connect(transport);

    logger.info("Google search MCP server started, waiting for connections...");

    // Handle Ctrl+C (Windows and Unix/Linux)
    process.on("SIGINT", () => {
      logger.info("Received SIGINT signal, shutting down the server...");
      process.exit(0);
    });

    // Handle process termination (Unix/Linux)
    process.on("SIGTERM", () => {
      logger.info("Received SIGTERM signal, shutting down the server...");
      process.exit(0);
    });
  } catch (error) {
    logger.error({ error }, "Server startup failed");
    process.exit(1);
  }
}

// Only auto-start the stdio server when this file is run directly, so importing
// createMcpServer() from mcp-http-server.ts doesn't spin up a stdio server too.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
