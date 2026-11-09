import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk, runProcess, type ExecResult } from "./exec.js";
import type { Task } from "./tasks.js";

export interface Sandbox {
  readonly kind: "docker" | "local";
  start(): Promise<void>;
  exec(command: string, timeoutMs: number): Promise<ExecResult>;
  grade(): Promise<ExecResult>;
  close(): Promise<void>;
}

/**
 * A temp-dir copy of the repo on the host. Fast and needs no Docker, but it is
 * NOT isolated: commands run with your user's permissions. Use for trusted
 * task development only.
 */
export class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  private base: string | undefined;

  constructor(private readonly task: Task) {}

  get workspace(): string {
    if (!this.base) throw new Error("sandbox not started");
    return join(this.base, "workspace");
  }

  async start(): Promise<void> {
    this.base = await mkdtemp(join(tmpdir(), `devenv-${this.task.id}-`));
    await cp(this.task.repoDir, this.workspace, { recursive: true });
  }

  exec(command: string, timeoutMs: number): Promise<ExecResult> {
    return runProcess("sh", ["-c", command], { cwd: this.workspace, timeoutMs });
  }

  async grade(): Promise<ExecResult> {
    // The grader lives beside the workspace, never inside it.
    const graderDir = join(this.base!, "grader");
    await cp(this.task.graderDir, graderDir, { recursive: true });
    return runProcess("sh", [join(graderDir, "grade.sh")], {
      cwd: this.workspace,
      env: { ...process.env, GRADER_DIR: graderDir },
      timeoutMs: this.task.timeoutS * 1000,
    });
  }

  async close(): Promise<void> {
    if (this.base) await rm(this.base, { recursive: true, force: true });
    this.base = undefined;
  }
}

function docker(args: string[], timeoutMs = 600_000): Promise<ExecResult> {
  return runProcess("docker", args, { timeoutMs });
}

async function ensureImage(kind: string, imagesDir: string): Promise<string> {
  const tag = `rlbench-${kind}:latest`;
  if (isOk(await docker(["image", "inspect", tag], 30_000))) return tag;
  const built = await docker(["build", "-t", tag, join(imagesDir, kind)], 1_200_000);
  if (!isOk(built)) throw new Error(`docker build failed for ${tag}:\n${built.output}`);
  return tag;
}

/** One container per session: no network, CPU/memory/PID limits, grader copied in last. */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly name: string;
  private running = false;

  constructor(
    private readonly task: Task,
    private readonly imagesDir: string,
  ) {
    this.name = `devenv-${task.id}-${randomUUID().slice(0, 8)}`;
  }

  private async check(result: Promise<ExecResult>, what: string): Promise<void> {
    const r = await result;
    if (!isOk(r)) throw new Error(`${what} failed:\n${r.output}`);
  }

  async start(): Promise<void> {
    const image = await ensureImage(this.task.image, this.imagesDir);
    await this.check(
      docker([
        "run", "-d", "--name", this.name,
        "--network", "none", "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
        image, "sleep", "infinity",
      ]),
      "docker run",
    );
    this.running = true;
    await this.check(docker(["cp", `${this.task.repoDir}/.`, `${this.name}:/workspace`]), "copying repo");
  }

  private async run(argv: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<ExecResult> {
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    // The in-container `timeout` kills the command; the outer one guards against a hung docker exec.
    const result = await docker(
      ["exec", "-w", "/workspace", ...envArgs, this.name, "timeout", "-s", "KILL", String(seconds), ...argv],
      timeoutMs + 15_000,
    );
    if (result.exitCode === 137) result.timedOut = true;
    return result;
  }

  exec(command: string, timeoutMs: number): Promise<ExecResult> {
    return this.run(["sh", "-c", command], timeoutMs);
  }

  async grade(): Promise<ExecResult> {
    await this.check(docker(["cp", `${this.task.graderDir}/.`, `${this.name}:/grader`]), "copying grader");
    return this.run(["sh", "/grader/grade.sh"], this.task.timeoutS * 1000, { GRADER_DIR: "/grader" });
  }

  async close(): Promise<void> {
    if (this.running) await docker(["rm", "-f", this.name], 60_000);
    this.running = false;
  }
}

export type SandboxFactory = (task: Task) => Sandbox;

export function sandboxFactory(kind: "docker" | "local", imagesDir: string): SandboxFactory {
  return kind === "docker" ? (task) => new DockerSandbox(task, imagesDir) : (task) => new LocalSandbox(task);
}
