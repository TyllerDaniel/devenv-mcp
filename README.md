# devenv-mcp

[![CI](https://github.com/TyllerDaniel/devenv-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/TyllerDaniel/devenv-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an
AI agent a safe place to do software-engineering work. The agent can browse
tasks, open a sandboxed copy of a broken repository, run commands in it, and
diagnose CI failures, all through typed MCP tools.

It is the agent-facing half of
[rl-env-benchmark](https://github.com/TyllerDaniel/rl-env-benchmark) and reads
the same task format, and it calls
[ci-doctor](https://github.com/TyllerDaniel/ci-doctor) for CI log diagnosis.

## Tools

| Tool | What it does |
| --- | --- |
| `list_tasks` | List tasks with id, title, category and difficulty |
| `get_task` | Full prompt for one task |
| `start_session` | Create a fresh sandbox holding the task's starting repo; returns `session_id` |
| `run_in_sandbox` | Run a shell command in the session's repo root; returns exit code and output |
| `end_session` | Destroy the sandbox |
| `diagnose_ci` | Classify failures in a CI log or JUnit XML and suggest a next step |
| `run_grader` | Run the hidden grader. **Off by default**, see below |

Every tool declares a zod input schema, returns `structuredContent` alongside
readable text, and reports failures in-band with `isError`, so the model can
read what went wrong and recover instead of the call failing outright.

## Design decisions

* **Isolation by default.** Sessions run in Docker with `--network none`, 1 CPU,
  1 GB of memory and a PID limit. A `local` mode exists for task authoring, but
  it runs commands on the host and is clearly labelled as not isolated.
* **Grading is opt-in.** If an agent under evaluation can call the grader, it
  can iterate against hidden tests until they pass, which measures persistence
  rather than skill. `run_grader` is only registered when
  `DEVENV_ALLOW_GRADING=1`, for task authors and human reviewers.
* **The grader never enters the workspace early.** It is copied in only when
  grading runs, and a test asserts the agent cannot find it beforehand.
* **Bounded output.** Command output is collected in a head-plus-tail buffer
  (the end of a log is usually where the error is), so a runaway process cannot
  exhaust memory or flood the model's context.
* **Real timeouts.** Commands start in their own process group and the whole
  group is killed on timeout. Killing only `sh` would leave grandchildren such
  as `pytest` holding the pipes open, and the call would hang.
* **Capped, cleaned-up sessions.** A session limit prevents runaway container
  creation, and all sandboxes are destroyed on SIGINT, SIGTERM or client
  disconnect.
* **stdout is the protocol.** All logging goes to stderr.

## Install

```bash
git clone https://github.com/TyllerDaniel/devenv-mcp
cd devenv-mcp && npm install && npm run build
```

## Use with Claude Desktop or Claude Code

```json
{
  "mcpServers": {
    "devenv": {
      "command": "node",
      "args": ["/path/to/devenv-mcp/dist/index.js"],
      "env": {
        "DEVENV_TASKS_DIR": "/path/to/rl-env-benchmark/tasks",
        "DEVENV_SANDBOX": "docker"
      }
    }
  }
}
```

With Claude Code: `claude mcp add devenv -e DEVENV_TASKS_DIR=/path/to/tasks -- node /path/to/devenv-mcp/dist/index.js`

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DEVENV_TASKS_DIR` | `./tasks` | Directory of tasks (`task.toml` + `repo/` + `grader/`) |
| `DEVENV_IMAGES_DIR` | `<tasks>/../images` | Base images, `images/<name>/Dockerfile` |
| `DEVENV_SANDBOX` | `docker` | `docker` or `local` (not isolated) |
| `DEVENV_ALLOW_GRADING` | `0` | `1` registers `run_grader` |
| `DEVENV_MAX_SESSIONS` | `4` | Concurrent sandbox limit |
| `CI_DOCTOR_BIN` | `ci-doctor` | Path to the ci-doctor binary |

Invalid values fail fast at startup with a message naming the variable.

## Example session

From `npm run build` and a client connected over stdio, against the
rl-env-benchmark tasks with grading enabled:

```
> start_session {"task_id": "004-quadratic-dedupe"}
Started session 72721590 for 004-quadratic-dedupe (local sandbox).

> run_in_sandbox {"session_id": "72721590", "command": "python3 -m pytest -q tests | tail -1"}
[exit code 0]
1 passed in 0.01s

> run_grader {"session_id": "72721590"}
FAILED                    <- visible tests pass, but the hidden 300k-event test times out

> run_in_sandbox {..., "command": "sed -i 's/seen = \\[\\]/seen = set()/; s/seen.append/seen.add/' ingest/dedupe.py"}
> run_grader {"session_id": "72721590"}
PASSED
```

## Development

```bash
npm test          # vitest: unit tests plus a real MCP client over an in-memory transport
npm run typecheck
npm run build
```

The server tests connect an actual MCP `Client` to the server, so they cover
schemas, error handling and the full start, run, grade and end loop rather than
calling handlers directly.

## License

MIT
