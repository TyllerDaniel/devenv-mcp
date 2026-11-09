import { randomUUID } from "node:crypto";
import type { Sandbox, SandboxFactory } from "./sandbox.js";
import type { Task } from "./tasks.js";

export interface Session {
  id: string;
  task: Task;
  sandbox: Sandbox;
  startedAt: Date;
  commands: number;
  graded: boolean;
}

/** Tracks live sandboxes so they are capped, addressable by id, and always cleaned up. */
export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly factory: SandboxFactory,
    private readonly maxSessions: number,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  async start(task: Task): Promise<Session> {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`session limit reached (${this.maxSessions}); end a session first`);
    }
    const sandbox = this.factory(task);
    try {
      await sandbox.start();
    } catch (err) {
      await sandbox.close().catch(() => undefined);
      throw err;
    }
    const session: Session = {
      id: randomUUID().slice(0, 8),
      task,
      sandbox,
      startedAt: new Date(),
      commands: 0,
      graded: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown session '${id}'`);
    return session;
  }

  async end(id: string): Promise<void> {
    const session = this.get(id);
    this.sessions.delete(id);
    await session.sandbox.close();
  }

  async closeAll(): Promise<void> {
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(all.map((s) => s.sandbox.close()));
  }
}
