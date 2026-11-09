import { join, resolve } from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  DEVENV_TASKS_DIR: z.string().default("./tasks"),
  DEVENV_IMAGES_DIR: z.string().optional(),
  DEVENV_SANDBOX: z.enum(["docker", "local"]).default("docker"),
  DEVENV_ALLOW_GRADING: z.enum(["0", "1"]).default("0"),
  DEVENV_MAX_SESSIONS: z.coerce.number().int().min(1).max(32).default(4),
  CI_DOCTOR_BIN: z.string().default("ci-doctor"),
});

export interface Config {
  tasksDir: string;
  imagesDir: string;
  sandbox: "docker" | "local";
  /** Grading reveals hidden-test results, so it is off unless explicitly enabled. */
  allowGrading: boolean;
  maxSessions: number;
  ciDoctorBin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const e = parsed.data;
  const tasksDir = resolve(e.DEVENV_TASKS_DIR);
  return {
    tasksDir,
    imagesDir: resolve(e.DEVENV_IMAGES_DIR ?? join(tasksDir, "..", "images")),
    sandbox: e.DEVENV_SANDBOX,
    allowGrading: e.DEVENV_ALLOW_GRADING === "1",
    maxSessions: e.DEVENV_MAX_SESSIONS,
    ciDoctorBin: e.CI_DOCTOR_BIN,
  };
}
