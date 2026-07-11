#!/usr/bin/env node
//
// Streamable HTTP entrypoint for the Google-search MCP server — for networked MCP
// clients (n8n's "MCP Client Tool" node, etc.) that connect to a URL rather than
// spawning a stdio subprocess. Point the client at:  http://<host>:<port>/mcp
//
// Stateless mode: every POST /mcp gets its own McpServer + transport (no session
// state to track), which suits a stateless search tool and keeps concurrency simple.

import express, { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import logger from "./logger.js";

const app = express();
app.use(express.json());

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", transport: "streamable-http", uptimeSeconds: Math.round(process.uptime()) });
});

// The MCP endpoint. n8n posts JSON-RPC (initialize / tools/list / tools/call) here.
app.post("/mcp", async (req: Request, res: Response) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  // Tear down per-request resources when the response closes.
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "MCP HTTP request failed"
    );
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no server-initiated SSE stream or session to delete.
const methodNotAllowed = (_req: Request, res: Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server: use POST /mcp)." },
    id: null,
  });
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

const port = Number(process.env.MCP_HTTP_PORT || process.env.PORT || 3001);
const host = process.env.HOST || "0.0.0.0";
app.listen(port, host, () => {
  logger.info({ host, port }, "Google Search MCP (Streamable HTTP) server listening");
  console.log(`MCP endpoint: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/mcp`);
});
