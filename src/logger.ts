import { pino } from "pino";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// Use the system temp directory to ensure cross-platform compatibility
const logDir = path.join(os.tmpdir(), "google-search-logs");
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create the log file path
const logFilePath = path.join(logDir, "google-search.log");

// Create the pino logger instance
const logger = pino({
  level: process.env.LOG_LEVEL || "info", // Log level can be set via environment variable
  transport: {
    targets: [
      // Prettified console output. IMPORTANT: send it to STDERR (destination: 2),
      // not stdout. When this process runs as an MCP server over stdio, stdout is
      // the JSON-RPC channel — any log line there corrupts the protocol. Logs on
      // stderr are shown by the CLI and ignored by MCP clients.
      {
        target: "pino-pretty",
        level: "info",
        options: {
          destination: 2,
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
      // Output to a file - use the trace level to ensure all logs are captured
      {
        target: "pino/file",
        level: "trace", // Use the lowest level to capture all logs
        options: { destination: logFilePath },
      },
    ],
  },
});

// Add handlers for process exit
process.on("exit", () => {
  logger.info("Process exiting, closing logs");
});

process.on("SIGINT", () => {
  logger.info("Received SIGINT signal, closing logs");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("Received SIGTERM signal, closing logs");
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  logger.error({ err: error }, "Uncaught exception");
  process.exit(1);
});

export default logger;
