# pi/

The machine-level configuration for pi, written the way `agent/` holds the omp side: the files here are the source of truth for `~/.pi/agent/`, and a change lands here first.

```
pi/
  AGENTS.md         voice, working stance, standing rules
  APPEND_SYSTEM.md  harness and machine facts
  agents/           lane definitions
  hindsight.jsonc   pi-hindsight configuration (System One rung is present in the pinned submodule)
  README.md         this file
```

| File | Machine location | What carries it |
|---|---|---|
| `AGENTS.md` | `~/.pi/agent/AGENTS.md` | injected as a context file |
| `APPEND_SYSTEM.md` | `~/.pi/agent/APPEND_SYSTEM.md` | appended to the system prompt |
| `agents/*.md` | `~/.pi/agent/agents/` | resolved by `@tintinweb/pi-subagents` |
| `hindsight.jsonc` | `~/.pi/agent/hindsight.jsonc` | read by pi-hindsight |

pi documents no `RULES.md`, so the standing rules live inside `AGENTS.md` rather than in a third injected file. Dated records stay on the machine in `~/.pi/agent/STATE.md`, never here.

## Why two files instead of four

omp splits the job four ways: style and stance, persona, standing rules, harness facts. pi has no persona slot and no per-turn rules carrier, so the split collapses to two injected files plus the state record that is never injected. The persona file stays an omp-only artifact.

## Syncing to the machine

Copy the file over the machine copy after reviewing the change. `AGENTS.md` and `APPEND_SYSTEM.md` are single-source, so a copy is the whole update; running pi afterwards picks them up, and a live session needs `/reload` for the resource lists only.

`agents/` is a directory: copy the seven definitions in, and an agent file that renames or removes a type leaves a stale definition behind on the machine unless it is deleted there too.

`hindsight.jsonc` is not a straight copy yet. The machine has `~/.pi/agent/hindsight.json`, and pi-hindsight prefers `.json` over `.jsonc` at the same scope, so writing a `.jsonc` beside it changes nothing. Merge the settings into the file that is actually loaded, or move the old one aside first.

## Dependencies this configuration assumes

pi itself, with `~/.pi/agent/settings.json` carrying the `magpie` provider and the `group/fusion-flattened` default. The package set listed there provides everything the two context files describe: `@ff-labs/pi-fff` for the `grep` / `find` / `multi_grep` tools, `pi-background-tasks` for `bg_run` and the Fusion family, `@tintinweb/pi-subagents` for `Agent` and `SubagentWorkflow`, `@juicesharp/rpiv-todo` for `todo`, `pi-codex-goal` for the goal tools, `pi-smart-compact` for `smart_compact` / `smart_recall`, `pi-schedule-prompt` for `schedule_prompt`, `pi-intercom` for cross-session messages, `pi-web-access` for the web tools, and the local fork `pi-hindsight` for memory.

pi-hindsight's System One decision rung depends on `system-one-core` and a gateway serving `POST /v1/systemone` — in this machine's case the local magpie gateway on port 3425, whose `group/decider` is a decision-only group. The `pi-system-one` package from the pi registry is unrelated to that path: it is an optional agent-facing tool for calling System One by hand, not a piece of the memory backend, and nothing here requires it.

`pi-tern` is deliberately absent. pi runs as the agent runtime rather than as a driver of somebody else's pane, so the terminal-driving surface is out of scope; interactive programs are a user-requested detour instead of a default capability.

## Generated state that never enters this repository

`sessions/`, `npm/`, `models-store.json`, `auth.json`, `compact-backups/`, `.pi/tasks/`, `.pi/delegate/`, `.pi/fusion/`, `.pi/subagents/`, `.pi-glla/`, `intercom/`, `.pi/hindsight/`, `tmp/`, `pi-crash.log`. The last of the state directories holds the retain queue and receipts, which belong beside the data they describe rather than in a review.
