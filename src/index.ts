#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { sandboxFactory } from "./sandbox.js";
import { buildServer } from "./server.js";
import { SessionManager } from "./sessions.js";

// stdout carries the MCP protocol, so every log line goes to stderr.
const log = (msg: string) => process.stderr.write(`[devenv-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const config = loadConfig();
  const sessions = new SessionManager(sandboxFactory(config.sandbox, config.imagesDir), config.maxSessions);
  const server = buildServer(config, sessions);

  let shuttingDown = false;
  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason}), closing ${sessions.size} session(s)`);
    await sessions.closeAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));

  await server.connect(new StdioServerTransport());
  log(`ready: tasks=${config.tasksDir} sandbox=${config.sandbox} grading=${config.allowGrading ? "on" : "off"}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
