import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { diagnose, formatDiagnosis } from "./ciDoctor.js";
import type { Config } from "./config.js";
import { isOk, render } from "./exec.js";
import type { SessionManager } from "./sessions.js";
import { discoverTasks, type Task } from "./tasks.js";

export const SERVER_NAME = "devenv-mcp";
export const SERVER_VERSION = "0.1.0";

function text(body: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(structured ? { structuredContent: structured } : {}) };
}

/**
 * Tool failures are returned in-band with isError so the model can read the
 * message and recover, instead of the whole request failing.
 */
async function guarded(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
  }
}

function summary(t: Task) {
  return { id: t.id, title: t.title, category: t.category, difficulty: t.difficulty };
}

export function buildServer(config: Config, sessions: SessionManager): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Work on sandboxed software-engineering tasks. Typical flow: list_tasks, get_task, " +
        "start_session, then run_in_sandbox as often as needed, and end_session when finished. " +
        "Commands run inside an isolated workspace, not on the user's machine.",
    },
  );

  async function findTask(id: string): Promise<Task> {
    const task = (await discoverTasks(config.tasksDir)).find((t) => t.id === id);
    if (!task) throw new Error(`unknown task '${id}'. Call list_tasks to see available ids.`);
    return task;
  }

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List every available task with its id, title, category and difficulty.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      guarded(async () => {
        const tasks = (await discoverTasks(config.tasksDir)).map(summary);
        const body = tasks.map((t) => `${t.id}  [${t.difficulty}, ${t.category}]  ${t.title}`).join("\n");
        return text(body || "No tasks found.", { tasks });
      }),
  );

  server.registerTool(
    "get_task",
    {
      title: "Get task",
      description: "Get the full prompt and metadata for one task.",
      inputSchema: { task_id: z.string().describe("Task id from list_tasks") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ task_id }) =>
      guarded(async () => {
        const task = await findTask(task_id);
        return text(`# ${task.title}\n\n${task.prompt}`, { ...summary(task), prompt: task.prompt });
      }),
  );

  server.registerTool(
    "start_session",
    {
      title: "Start session",
      description:
        "Create a fresh sandbox containing the task's starting repository. Returns a session_id " +
        "for run_in_sandbox. Each session is independent; end it with end_session.",
      inputSchema: { task_id: z.string().describe("Task id from list_tasks") },
      annotations: { openWorldHint: false },
    },
    ({ task_id }) =>
      guarded(async () => {
        const session = await sessions.start(await findTask(task_id));
        return text(
          `Started session ${session.id} for ${task_id} (${session.sandbox.kind} sandbox). ` +
            "The repository is the current directory for every command.",
          { session_id: session.id, task_id, sandbox: session.sandbox.kind },
        );
      }),
  );

  server.registerTool(
    "run_in_sandbox",
    {
      title: "Run command in sandbox",
      description:
        "Run a shell command from the repository root inside a session's sandbox. Returns the exit " +
        "code and combined stdout/stderr, truncated in the middle if very long. No network access.",
      inputSchema: {
        session_id: z.string(),
        command: z.string().min(1).describe("Shell command, run with sh -c"),
        timeout_s: z.number().int().min(1).max(600).default(60).describe("Kill the command after this many seconds"),
      },
      annotations: { destructiveHint: false, openWorldHint: false },
    },
    ({ session_id, command, timeout_s }) =>
      guarded(async () => {
        const session = sessions.get(session_id);
        const result = await session.sandbox.exec(command, timeout_s * 1000);
        session.commands += 1;
        return {
          ...text(render(result), { exit_code: result.exitCode, timed_out: result.timedOut, output: result.output }),
          isError: !isOk(result),
        };
      }),
  );

  if (config.allowGrading) {
    server.registerTool(
      "run_grader",
      {
        title: "Run hidden grader",
        description:
          "Copy the hidden grader into the session and run it. Only enabled for task authors " +
          "(DEVENV_ALLOW_GRADING=1); an agent under evaluation should not see grader results.",
        inputSchema: { session_id: z.string() },
        annotations: { openWorldHint: false },
      },
      ({ session_id }) =>
        guarded(async () => {
          const session = sessions.get(session_id);
          const result = await session.sandbox.grade();
          session.graded = true;
          const passed = isOk(result);
          return text(`${passed ? "PASSED" : "FAILED"}\n\n${result.output}`, { passed, output: result.output });
        }),
    );
  }

  server.registerTool(
    "end_session",
    {
      title: "End session",
      description: "Destroy a session's sandbox and free its resources.",
      inputSchema: { session_id: z.string() },
      annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ session_id }) =>
      guarded(async () => {
        const { commands } = sessions.get(session_id);
        await sessions.end(session_id);
        return text(`Ended session ${session_id} after ${commands} command(s).`, { session_id, commands });
      }),
  );

  server.registerTool(
    "diagnose_ci",
    {
      title: "Diagnose CI failure",
      description:
        "Classify the failures in a CI log or JUnit XML report (flaky test, dependency conflict, " +
        "timeout, compile error, assertion, ...) and suggest a next step. Uses the ci-doctor CLI.",
      inputSchema: {
        log: z.string().min(1).describe("Raw CI log text or JUnit XML"),
        input_format: z.enum(["auto", "junit", "text"]).default("auto"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ log, input_format }) =>
      guarded(async () => {
        const diagnosis = await diagnose(config.ciDoctorBin, log, input_format);
        return text(formatDiagnosis(diagnosis), diagnosis as unknown as Record<string, unknown>);
      }),
  );

  return server;
}
