import { z } from "zod";
import { runProcess } from "./exec.js";

/** JSON emitted by `ci-doctor diagnose --format json` (github.com/TyllerDaniel/ci-doctor). */
export const DiagnosisSchema = z.object({
  input_format: z.string(),
  total_failures: z.number().int(),
  summary: z.record(z.string(), z.number().int()),
  findings: z.array(
    z.object({
      category: z.string(),
      test: z.string().nullable(),
      message: z.string(),
      evidence: z.string(),
      line: z.number().int().nullable(),
      suggestion: z.string(),
    }),
  ),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export async function diagnose(bin: string, log: string, inputFormat: string): Promise<Diagnosis> {
  let result;
  try {
    result = await runProcess(bin, ["diagnose", "--format", "json", "--input-format", inputFormat, "-"], {
      timeoutMs: 30_000,
      input: log,
      outputLimit: 2_000_000,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `ci-doctor not found (looked for '${bin}'). Install it with ` +
          "`cargo install --git https://github.com/TyllerDaniel/ci-doctor` or set CI_DOCTOR_BIN.",
      );
    }
    throw err;
  }
  // ci-doctor exits 1 when it found failures; anything else is a crash.
  if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== 1)) {
    throw new Error(`ci-doctor failed (exit ${result.exitCode}):\n${result.output}`);
  }
  return DiagnosisSchema.parse(JSON.parse(result.output));
}

export function formatDiagnosis(d: Diagnosis): string {
  if (d.findings.length === 0) return `No failures found (${d.input_format} input).`;
  const lines = [`${d.total_failures} failure(s) in ${d.input_format} input:`];
  for (const f of d.findings) {
    const where = f.test ? ` ${f.test}` : f.line !== null ? ` (line ${f.line})` : "";
    lines.push(`\n- [${f.category}]${where}: ${f.message}`);
    lines.push(`  evidence: ${f.evidence}`);
    lines.push(`  next step: ${f.suggestion}`);
  }
  return lines.join("\n");
}
