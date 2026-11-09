import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has safe defaults", () => {
    const c = loadConfig({});
    expect(c.sandbox).toBe("docker");
    expect(c.allowGrading).toBe(false);
    expect(c.maxSessions).toBe(4);
    expect(c.ciDoctorBin).toBe("ci-doctor");
    expect(c.imagesDir.endsWith("images")).toBe(true);
  });

  it("reads overrides", () => {
    const c = loadConfig({
      DEVENV_TASKS_DIR: "/srv/bench/tasks",
      DEVENV_SANDBOX: "local",
      DEVENV_ALLOW_GRADING: "1",
      DEVENV_MAX_SESSIONS: "8",
    });
    expect(c.tasksDir).toBe("/srv/bench/tasks");
    expect(c.imagesDir).toBe("/srv/bench/images");
    expect(c.sandbox).toBe("local");
    expect(c.allowGrading).toBe(true);
    expect(c.maxSessions).toBe(8);
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig({ DEVENV_SANDBOX: "vm" })).toThrow(/DEVENV_SANDBOX/);
    expect(() => loadConfig({ DEVENV_MAX_SESSIONS: "0" })).toThrow(/DEVENV_MAX_SESSIONS/);
  });
});
