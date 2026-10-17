# PI ENV (harness facts)

pi = `@earendil-works/pi-coding-agent`, version 1.3.0, bin `pi` at `~/.bun/bin/pi`, package at `~/.bun/install/global/node_modules/@earendil-works/pi-coding-agent`. Run `pi --version` instead of trusting a number written here. Update: `pi update` (Pi alone), `pi update --extensions` (packages), `pi update --models` (model catalogs), `pi update --all`. Source truth is the installed package's `docs/` (`cli.md`, `configuration.md`, `settings.md`, `skills.md`, `extensions.md`, `packages.md`, `models.md`, `custom-provider.md`, `sessions.md`, `compaction.md`, `environment-variables.md`, `rpc.md`, `rpc-commands.md`, `sdk.md`), then upstream `earendil-works/pi-coding-agent`. Live values: `~/.pi/agent/settings.json`, `pi --help`, `pi list`, `pi config`.

Tool names, schemas, settings keys, and internal surfaces arrive with the runtime; this file keeps what the runtime will not tell you.

## CLI and sessions

A terminal gets the interactive TUI; a redirected stdin or stdout selects print mode. `--mode json` streams JSONL events and accepts no further commands; `--mode rpc` keeps a JSONL command channel for the process lifetime. One-shot `pi -p "<prompt>"` prints the final assistant text and exits nonzero on an `error` or `aborted` stop reason.

Per-run scope: `--tools` / `--exclude-tools` / `--no-tools`, `--skill`, `--extension`, `--no-context-files`, `--prompt-template`, `--append-system-prompt` (repeatable), `--session-dir`, `--name`, `--approve` / `--no-approve`, `--offline`. Session addressing: `-c` continues, `-r` / `--session` / `--session-id` / `--fork` picks one, `--no-session` keeps the run ephemeral.

Process markers are `AI_AGENT=pi` and `PI_CODING_AGENT=true`. Commands run by `bash` receive `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL`, resolved when each command starts — read them rather than inferring the running model from the prompt. Process config: `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`.

This machine sets `defaultProjectTrust: "always"`, `quietStartup: true`, `steeringMode: all`, `followUpMode: all`. Inventory: `pi list` for packages, `pi auth check` for provider readiness (`ready` / `not_ready` / `invalid`), `pi config` for the package-resource TUI.

## Config layers

Global `~/.pi/agent/` → project `.pi/` → CLI flags. Project settings override agent-directory values, and resource lists combine. A project `SYSTEM.md` / `APPEND_SYSTEM.md` replaces the global file of that name outright. Global files in play: `settings.json`, `AGENTS.md`, `APPEND_SYSTEM.md`, `STATE.md`, `models.json`, `autoprovider.json`, `pi-fff.json`, `hindsight.json`, `keybindings.json`, `auth.json`, `mcp.json`. Project `.pi/`: `settings.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `agents/`, `skills/`, `prompts/`, `themes/`, `extensions/`, `workflows/`, `helpers/`, `tasks/`.

Generated state to leave alone: `sessions/`, `compact-backups/`, `models-store.json`, `mcp-cache.json`, `web-search-cache/`, `tmp/`, `pi-crash.log`, `.pi/tasks/`, `.pi/delegate/`, `.pi/fusion/`, `.pi/subagents/`, `.pi-glla/`, `intercom/`, `npm/node_modules/`, `.pi/hindsight/`.

Manual edits to settings, keybindings, instructions, or resources need `/reload` in a live session.

## Context injection

`AGENTS.md` / `CLAUDE.md` load from `~/.pi/agent/`, parent directories, and the working directory, concatenated; `AGENTS.override.md` replaces a directory's copy in that directory alone and does not suppress the agent-directory file. Context-file discovery needs no project trust. `SYSTEM.md` / `APPEND_SYSTEM.md` land at the end of the system prompt, single-source, project over global.

pi documents no `RULES.md`. The rule file is `~/.pi/agent/AGENTS.md`, this file is the harness-fact half, and dated records live in `~/.pi/agent/STATE.md`, which is never injected.

Prompt templates load from `~/.pi/agent/prompts/` and `.pi/prompts/`, direct `.md` children only.

## Skills

Name, description, and path reach the system prompt; the body loads on demand by reading `SKILL.md` or through `/skill:<name>`. Roots: `~/.pi/agent/skills/`, project `.pi/skills/`, and the Agent Skills roots `~/.agents/skills/` and `.agents/skills/`; discovery recurses into subdirectories, so the per-manager containers under `~/.agents/skills/` (`orca/`, `herdr/`, `paseo-skills/`) load with no wiring. A malformed `SKILL.md` or a missing description drops that skill; a name clash keeps the first discovery and warns. A pi package can ship skills by declaring them in its `package.json` under `pi.skills`, which is how pi-hindsight delivers `hindsight-memory-doctor`.

## Tools on this machine

Built-in tools default to `read`, `bash`, `edit`, `write`; `grep`, `find`, `ls`, `powershell` ship built-in and off. `@ff-labs/pi-fff` runs in `override` mode (`pi-fff.json`), so the search pair is FFF-backed under the built-in names: `grep` (frecency-ordered, git-aware, smart-case, paginated by cursor), `find` (fuzzy, whole-path, multi-word AND), and `multi_grep` (one OR-logic Aho-Corasick pass over several literal patterns). All three are in-process and pre-indexed; no `fd`/`rg` subprocess per call.

`bash-grep-guard` (a local extension) blocks every `grep` invocation inside `bash` and returns the exact rewrite: the `grep` tool, or `rg` inside a pipeline. It matches shell argument positions, so `cat grep.md`, `rg -e grep`, and `git grep` pass through.

`pi-background-tasks` provides `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, `bg_result`, `bg_delegate`, `bg_run_pi_attested`, and the `fusion_reason` / `fusion_investigate` / `fusion_research` / `fusion_validate` family, plus the `/bg`, `/tasks`, `/kill`, `/logs` commands. `bg_run` starts a named shell job and returns an id plus an output path immediately; terminal state arrives as a durable notification that can start a follow-up turn. `isAgent: true` marks a child LLM process, `false` covers scripts, tests, and servers. Runtime files live in `.pi/tasks/`, `.pi/delegate/`, `.pi/fusion/`.

`pi-web-access` provides `web_search`, `fetch_content`, `source_check`, and `get_search_content`; stored fetches are recovered by response id instead of re-fetching.

`@juicesharp/rpiv-todo` registers the `todo` tool and `/todos`. It is the single task authority; there is no second list to keep.

`pi-codex-goal` provides `get_goal`, `create_goal`, and `update_goal`. A goal is long-running work that survives turns; ordinary work does not need one.

`../local/pi-smart-compact` provides `smart_compact`, `smart_recall`, and `smart_save_memory`. `smart_compact` is for genuinely high context usage; the tool itself skips when usage is not high. `pi-schedule-prompt` provides `schedule_prompt` with cron, interval, and one-shot jobs stored in `<cwd>/.pi/schedule-prompts.json`, fired only while a session is open in that directory.

`pi-intercom` carries 1:1 messages between pi sessions on this machine through a broker that spawns on first use and exits after 5 seconds idle; state lives in `~/.pi/agent/intercom/`.

`pi-tern` is not installed, and that is deliberate: pi normally runs as the agent runtime rather than as a driver of a Tern pane, so no terminal-driving tool is expected here. Interactive programs are a user-requested detour, not a default capability.

Any image- or video-generation need goes through the `magpie-image` MCP server (`~/.pi/agent/mcp.json`, backed by `/Applications/magpie.app/Contents/MacOS/magpie mcp image`), reached through `codemode` as `mcp__magpie_image__generate_image`, `generate_video`, and `generation_result`. Describe subject, style, composition, colours, and any text to render exactly; video also needs motion and camera. Each call saves a file in the project (`generated-images/` or `generated-videos/` unless `path` says otherwise) and returns the path; an id instead means call `generation_result` for it rather than generating again. The composio MCP server is reachable at `http://127.0.0.1:3425/mcp/composio`.

## Models and providers

`settings.json` sets `defaultProvider: magpie`, `defaultModel: group/fusion-flattened`, `defaultThinkingLevel: medium`, `retry` at 4 attempts with a 2 s base, and the `not-enough-retry` mixin on top at 16 attempts with a 30 s cap.

pi runs as an agent runtime, so the session default is `group/fusion-flattened`: one classifier call lands the turn directly in one of the four registers, where `fusion-hierarchical` would spend a second Jev call routing practice-vs-theory first. Thinking levels run `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, with unsupported levels clamping down.

Provider catalog: `models.json` carries provider `magpie` (`http://127.0.0.1:3425/v1`, 91 `group/*` ids) and its `apiKey: "magpie"` is a placeholder that only makes the provider available — the gateway does not check it. `pi-autoprovider` is installed separately from `models.json` and can discover models from a gateway's `GET /models`; its config file `autoprovider.json` is absent here, so it contributes nothing right now. `models-store.json` is generated. Live list: `pi --list-models`. `PI_OFFLINE` / `--offline` stop catalog refreshes.

Classifier models do not appear in `/model` and cannot be declared in `models.json`: that schema has no `type` field and the loader only produces chat models. They come from built-in providers that ship their own implementation tables, or from a provider extension calling `pi.registerProvider` with `models: [{ type: "classifier", … }]` plus a `classifiers` map. pi exposes them through `getModelOfType("classifier", …)`, `codemode`'s `models.getAvailableOfType("classifier")` and `models.classify(...)`, or `ctx.modelRegistry.classify()` from an extension.

## Subagents

`@tintinweb/pi-subagents` provides `Agent` and `SubagentWorkflow` (`agent()` / `parallel()` / `pipeline()`), with `/agents` for the fleet view and workflows. Children run isolated pi sessions; a background call returns an id immediately and notifies on completion, `get_subagent_result` reads the full result, `steer_subagent` redirects a running child. `isolation: "worktree"` copies the repository into a temporary git worktree and fails when isolation is impossible. Agent `@name` mentions reach a running, finished, or never-started agent from the prompt.

Agent types resolve from `.pi/agents/`, then `.agents/agents/`, then `<agent-dir>/agents/`, project over global, with the frontmatter `name` as dispatch identity; the built-ins are `general-purpose`, `Explore`, and `Plan`, and a type that resolves to nothing falls back to `general-purpose`. Frontmatter keys are snake_case (`model`, `thinking`, `tools`, `prompt_mode`, `inherit_context`, `isolation`, `max_turns`, `allowed_subagents`) and outrank invocation parameters for the fields they set.

Definitions on this machine, each pointing at one magpie router and carrying no `thinking` key so the router's own classifier picks depth per turn:

| Type | Router | Shape |
|---|---|---|
| `Explore` | `magpie/group/labor` | read-only search, no writes |
| `Designer` | `magpie/group/theorist` | read-only design checkpoint |
| `researcher` | `magpie/group/theorist` | sourced findings, web tools |
| `reviewer` | `magpie/group/fusion-deepthink` | fresh-context review, never edits |
| `worker` | `magpie/group/fusion-worker` | one implementation slice |
| `vision-handoff` | `magpie/group/flash-vibe` | reads images for a text-only parent |
| `glla-orchestrator` | `magpie/group/fusion-hierarchical` | staged fan-out via one workflow script |

Package settings live in `~/.pi/agent/subagents.json` and `<cwd>/.pi/subagents.json`; both are absent, so the defaults stand (`maxConcurrent` 10, `maxSubagentDepth` 2, `worktreeIsolation` true, `backgroundByDefault` true). Agent state lives in `~/.pi/agent/.pi/subagents/`, with transcripts under `~/.pi/agent/sessions/<cwd>/<owner-session>/<runId>/run-0/session.jsonl`. Subagent schedules store at `<cwd>/.pi/subagent-schedules/<sessionId>.json`, reset on `/new`, and run with `maxPending: 30`, `maxLatenessMs: 300000` from `extensions/subagent/config.json`.

A delegated child reaches its parent only through the tools its own definition allows; `contact_supervisor` does not exist in the installed subagent package, so do not tell a child to call it. Cross-session reach is `intercom`.

## Sessions and compaction

Sessions are JSONL trees under `~/.pi/agent/sessions/`, grouped by working directory; `--session-dir` beats `PI_CODING_AGENT_SESSION_DIR` beats the `sessionDir` setting. Model context rebuilds from the active branch plus system prompt, context files, tools, and loaded skill descriptions. Tree work: `/tree`, `/fork`, `/clone`, `/export`.

Auto-compaction fires when `contextTokens > contextWindow - reserveTokens`, default `reserveTokens` 16384 and `keepRecentTokens` 20000; this machine sets `reserveTokens: 100000`. The summary carries Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps; branch navigation summarizes the abandoned branch.

## Extensions

TypeScript modules loaded into the pi process from `~/.pi/agent/extensions/` or `.pi/extensions/`, run through `jiti` with no compile step; a subdirectory needs an `index.ts` / `index.js` entry. Loaded here: `bash-grep-guard.ts`, `orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`, and `subagent/` with its `config.json`. `session_start` owns long-lived resources, and the factory starts no processes, sockets, watchers, or timers. `--extension <path>` loads one file for an invocation; `ctx.reload()` replaces the extension runtime. Extensions load in interactive, JSON, RPC, and print modes.

## Memory: pi-hindsight

`../../manual_install_pkgs/pi-hindsight` installs the fork from checkout, so the machine runs whatever that branch holds rather than a published release. Config: `~/.pi/agent/hindsight.json` or `.jsonc` for the global scope, `.pi/hindsight.json(c)` for a project; `.json` wins when both exist at the same scope. Runtime state: `~/.pi/agent/.pi/hindsight/` (retain queue, cursors, receipts).

The memory server itself is a separate service at `hindsight.baseUrl` (default `http://localhost:8888`): recall retrieval, retain extraction, observation consolidation, mental-model generation, and session import all happen there, not in pi.

The decision gates — automatic recall routing and retain bank routing — take one of several rungs per call. On pi the registry resolves chat models only, so a classifier rung never exists for a decision group; the typed path is `decision.systemOne`, which posts noul questions straight to a System One endpoint through `system-one-core`'s `HttpSystemOneProvider`. It is off by default; enabling it means:

```jsonc
"decision": { "systemOne": { "enabled": true, "baseUrl": "http://127.0.0.1:3425", "model": "group/decider" } }
```

Facts that matter when reading a failure: the rung is built only after `decision.model` resolves on this host, so a model id the pi registry does not know leaves the ladder empty and System One is never inserted; the rung sits before the text bridge on pi and after a host-native judgment on omp; the local gateway needs no credentials, and `apiKeyEnvVar` exists only for a gateway that does. `magpie/group/decider` is a decision-only group — chat requests against it are rejected by the gateway.

## Visual

`markdown.mermaid` is `"streaming"`, so mermaid fences render as terminal ASCII through the bundled `grok-mermaid` package (flow, sequence, state, class, ER). Bad geometry yields nothing or the raw source, so a missing diagram means check width and label length. Measure before sending:

`bun -e "import {render} from 'grok-mermaid'; import fs from 'node:fs'; const a = render(fs.readFileSync('/tmp/x.mmd','utf8')); console.log(a ? 'width='+a.width+' warnings='+JSON.stringify(a.warnings) : 'NULL')"`

Images paste with Ctrl+V or load through `read`.

## OmniWM

macOS window manager: Niri-style scrolling workspaces plus multiple displays. Coordinator `/Applications/OmniWM.app/Contents/MacOS/omniwmctl` (protocol bound to the app version, keep in sync); IPC on via `[general] ipcEnabled = true` in `~/.config/omniwm/settings.toml`. Skill and scripts: `~/.agents/skills/omniwm-computer-use/` (`SKILL.md`, `scripts/focus-guard.sh`, `scripts/focus-window.sh`, `scripts/verify-setup.sh`).

OmniWM owns window lifecycle by default — open, activate, focus, move, resize, hide, close, across browsers, Playwright, apps under test, dialogs, menus, zoom, workspaces, displays; no user request needed. Orca-embedded pages, workspaces, and terminals go to `orca-cli`; real windows outside Orca go to OmniWM. pi sessions launched under orca or herdr are identified by the `ORCA_*` / `HERDR_ENV=1` variables, and the pane rules live in the `orca-cli` / `herdr` skills.

Read `SKILL.md` first (focus guard plus window-location flow), then `scripts/verify-setup.sh`: a layout anomaly gets reported before any decision, an environment anomaly gets fixed first. Blind focus grabs and cross-display hard launches are forbidden. Layout stays untouched unless the user asks: foreground stays foreground, background work stays background, window state restored at task end.
