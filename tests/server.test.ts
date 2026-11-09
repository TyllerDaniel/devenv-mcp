import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { sandboxFactory } from "../src/sandbox.js";
import { buildServer } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";

const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const fakeCiDoctor = `${fixtures}/fake-ci-doctor.sh`;
chmodSync(fakeCiDoctor, 0o755);

function config(overrides: Partial<Config> = {}): Config {
  return {
    tasksDir: `${fixtures}/tasks`,
    imagesDir: `${fixtures}/images`,
    sandbox: "local",
    allowGrading: false,
    maxSessions: 2,
    ciDoctorBin: fakeCiDoctor,
    ...overrides,
  };
}

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.map((fn) => fn()));
  cleanup = [];
});

/** Connects a real MCP client to the server over an in-memory transport. */
async function connect(cfg = config()) {
  const sessions = new SessionManager(sandboxFactory(cfg.sandbox, cfg.imagesDir), cfg.maxSessions);
  const server = buildServer(cfg, sessions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => {
    await client.close();
    await sessions.closeAll();
  });
  return { client, sessions };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content.map((c) => c.text).join("\n");
}

describe("devenv-mcp server", () => {
  it("advertises its tools, hiding the grader by default", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["diagnose_ci", "end_session", "get_task", "list_tasks", "run_in_sandbox", "start_session"]);
  });

  it("exposes run_grader only when grading is enabled", async () => {
    const { client } = await connect(config({ allowGrading: true }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("run_grader");
  });

  it("lists and describes tasks", async () => {
    const { client } = await connect();
    const list = await client.callTool({ name: "list_tasks", arguments: {} });
    expect(list.structuredContent).toEqual({
      tasks: [{ id: "demo-answer", title: "Fix the answer", category: "debugging", difficulty: "easy" }],
    });
    const task = await client.callTool({ name: "get_task", arguments: { task_id: "demo-answer" } });
    expect(textOf(task)).toContain("answer.txt should contain 42.");
  });

  it("returns a readable in-band error for unknown tasks", async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: "get_task", arguments: { task_id: "nope" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unknown task 'nope'/);
  });

  it("runs a full solve-and-grade loop", async () => {
    const { client } = await connect(config({ allowGrading: true }));
    const started = await client.callTool({ name: "start_session", arguments: { task_id: "demo-answer" } });
    const sessionId = (started.structuredContent as { session_id: string }).session_id;

    const before = await client.callTool({ name: "run_grader", arguments: { session_id: sessionId } });
    expect((before.structuredContent as { passed: boolean }).passed).toBe(false);

    const fix = await client.callTool({
      name: "run_in_sandbox",
      arguments: { session_id: sessionId, command: "echo 42 > answer.txt && cat answer.txt" },
    });
    expect(fix.isError).toBe(false);
    expect(textOf(fix)).toContain("[exit code 0]");

    const after = await client.callTool({ name: "run_grader", arguments: { session_id: sessionId } });
    expect((after.structuredContent as { passed: boolean }).passed).toBe(true);

    const ended = await client.callTool({ name: "end_session", arguments: { session_id: sessionId } });
    expect(textOf(ended)).toContain("after 1 command(s)");
  });

  it("keeps the hidden grader out of the workspace", async () => {
    const { client } = await connect();
    const started = await client.callTool({ name: "start_session", arguments: { task_id: "demo-answer" } });
    const sessionId = (started.structuredContent as { session_id: string }).session_id;
    const listing = await client.callTool({
      name: "run_in_sandbox",
      arguments: { session_id: sessionId, command: "ls -aR; ls -a ..; find .. -name 'secret_expected*' 2>/dev/null" },
    });
    expect(textOf(listing)).not.toContain("secret_expected");
  });

  it("flags failing commands and timeouts as errors", async () => {
    const { client } = await connect();
    const started = await client.callTool({ name: "start_session", arguments: { task_id: "demo-answer" } });
    const sessionId = (started.structuredContent as { session_id: string }).session_id;

    const failed = await client.callTool({
      name: "run_in_sandbox",
      arguments: { session_id: sessionId, command: "exit 2" },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ exit_code: 2, timed_out: false });

    const slow = await client.callTool({
      name: "run_in_sandbox",
      arguments: { session_id: sessionId, command: "sleep 10", timeout_s: 1 },
    });
    expect(slow.structuredContent).toMatchObject({ timed_out: true });
  });

  it("enforces the session limit", async () => {
    const { client } = await connect(config({ maxSessions: 1 }));
    await client.callTool({ name: "start_session", arguments: { task_id: "demo-answer" } });
    const second = await client.callTool({ name: "start_session", arguments: { task_id: "demo-answer" } });
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/session limit reached/);
  });

  it("validates tool arguments", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "run_in_sandbox",
      arguments: { session_id: "x", command: "true", timeout_s: 10_000 },
    });
    expect(result.isError).toBe(true);
  });

  it("diagnoses CI logs through ci-doctor", async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: "diagnose_ci",
      arguments: { log: "step 1\nstep 2\nError: The operation was canceled." },
    });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("[timeout] (line 3)");
    expect(result.structuredContent).toMatchObject({ total_failures: 1 });
  });

  it("explains how to install ci-doctor when it is missing", async () => {
    const { client } = await connect(config({ ciDoctorBin: "/nonexistent/ci-doctor" }));
    const result = await client.callTool({ name: "diagnose_ci", arguments: { log: "boom" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/cargo install/);
  });
});
