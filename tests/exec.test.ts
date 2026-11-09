import { describe, expect, it } from "vitest";
import { OutputCollector, runProcess } from "../src/exec.js";

describe("OutputCollector", () => {
  it("keeps short output intact", () => {
    const c = new OutputCollector(100);
    c.push("hello ");
    c.push("world");
    expect(c.toString()).toBe("hello world");
  });

  it("keeps head and tail of long output in bounded memory", () => {
    const c = new OutputCollector(20);
    c.push("HEAD");
    for (let i = 0; i < 1000; i++) c.push("x".repeat(100));
    c.push("TAIL");
    const out = c.toString();
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out).toContain("characters truncated");
    expect(out.length).toBeLessThan(80);
  });
});

describe("runProcess", () => {
  it("returns exit code and combined output", async () => {
    const r = await runProcess("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5000 });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.timedOut).toBe(false);
  });

  it("passes stdin through", async () => {
    const r = await runProcess("cat", [], { timeoutMs: 5000, input: "piped" });
    expect(r.output).toBe("piped");
  });

  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    // The backgrounded sleep would keep the pipes open if only `sh` were killed.
    const r = await runProcess("sh", ["-c", "sleep 30 & sleep 30"], { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(124);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("rejects when the binary does not exist", async () => {
    await expect(runProcess("definitely-not-a-real-binary", [], { timeoutMs: 1000 })).rejects.toThrow();
  });
});
