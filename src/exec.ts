import { spawn } from "node:child_process";

export interface ExecResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

export const MAX_OUTPUT_CHARS = 12_000;

export function isOk(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

export function render(result: ExecResult): string {
  const status = result.timedOut ? "timed out" : `exit code ${result.exitCode}`;
  return `[${status}]\n${result.output}`;
}

/**
 * Collects process output in bounded memory: keeps the first and last
 * `limit / 2` characters and counts what was dropped in between. Errors are
 * usually at the end of a log, so the tail matters as much as the head.
 */
export class OutputCollector {
  private head = "";
  private tail = "";
  private dropped = 0;
  private readonly half: number;

  constructor(limit = MAX_OUTPUT_CHARS) {
    this.half = Math.floor(limit / 2);
  }

  push(chunk: string): void {
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    this.tail += chunk;
    if (this.tail.length > this.half) {
      this.dropped += this.tail.length - this.half;
      this.tail = this.tail.slice(-this.half);
    }
  }

  toString(): string {
    if (this.dropped === 0) return this.head + this.tail;
    return `${this.head}\n... [${this.dropped} characters truncated] ...\n${this.tail}`;
  }
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  input?: string;
  outputLimit?: number;
}

/**
 * Runs a command and kills its whole process group on timeout. Killing only
 * the direct child leaves grandchildren (sh -> pytest) holding the pipes open.
 */
export function runProcess(command: string, args: string[], opts: RunOptions): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true, // new process group, so we can kill the whole tree
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = new OutputCollector(opts.outputLimit);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : (code ?? (signal ? 128 + signalNumber(signal) : 1));
      resolvePromise({ exitCode, output: output.toString(), timedOut });
    });

    child.stdin.on("error", () => {
      /* the command may exit without reading stdin */
    });
    child.stdin.end(opts.input ?? "");
  });
}

function signalNumber(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = { SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11, SIGABRT: 6 };
  return numbers[signal] ?? 0;
}
