import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

/** Same on-disk format as rl-env-benchmark: task.toml + repo/ + grader/grade.sh. */
const TaskFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes"),
  title: z.string().min(1),
  category: z.string().min(1),
  difficulty: z.enum(["easy", "medium", "hard"]),
  image: z.string().min(1),
  prompt: z.string().min(1),
  timeout_s: z.number().int().positive().default(120),
});

export interface Task {
  id: string;
  title: string;
  category: string;
  difficulty: "easy" | "medium" | "hard";
  image: string;
  prompt: string;
  timeoutS: number;
  root: string;
  repoDir: string;
  graderDir: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function loadTask(root: string): Promise<Task> {
  const raw = parse(await readFile(join(root, "task.toml"), "utf8"));
  const parsed = TaskFileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`${root}/task.toml is invalid: ${problems}`);
  }
  const t = parsed.data;
  const task: Task = {
    id: t.id,
    title: t.title,
    category: t.category,
    difficulty: t.difficulty,
    image: t.image,
    prompt: t.prompt.trim(),
    timeoutS: t.timeout_s,
    root,
    repoDir: join(root, "repo"),
    graderDir: join(root, "grader"),
  };
  for (const required of [task.repoDir, join(task.graderDir, "grade.sh")]) {
    if (!(await exists(required))) throw new Error(`task ${task.id} is missing ${required}`);
  }
  return task;
}

export async function discoverTasks(tasksDir: string): Promise<Task[]> {
  const entries = await readdir(tasksDir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => join(tasksDir, e.name))
    .sort();
  const tasks: Task[] = [];
  for (const dir of dirs) {
    if (await exists(join(dir, "task.toml"))) tasks.push(await loadTask(dir));
  }
  return tasks;
}
