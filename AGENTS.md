# Repository Guidelines

## What this repository is

`dbydd/oh-my-omomp` is a trimmed fork of `oh-my-omp/omp-config`: the reviewable,
portable slice of this machine's Oh My Pi (`omp`) configuration. It is not a
backup of `~/.omp`. Databases, sessions, caches, credentials and `models.yml`
stay on the machine.

What the fork decided, and what therefore differs from upstream:

- Every model is reached through the local magpie gateway; there is no other
  provider binding. `agent/agents/` holds one lane per magpie router, and each
  lane's `model:` is `magpie/group/<id>`.
- There is no updater, no sync command, no CI workflow and no light mode. The
  repository reaches a machine by the copy set in `README.md` and
  `./install-plugins.sh`.
- Extension settings are sections of one `agent/omomp.yml`; there are no
  per-extension JSON files.
- `ctx-tool` and `ctx-tasklog` stay here even though upstream deleted them: this
  machine's `omp-todo-more` fork does not ship the `src/ctx/` that replaced them.

## How changes reach the machine

The copy set in `README.md` ("Machine installation") is the whole delivery
mechanism: `agent/*.md`, `agent/config.yml`, `agent/omomp.yml`,
`agent/thinking-translator.json`, and the `agents/`, `rules/`, `skills/`,
`extensions/`, `extensions-last/` directories go to `~/.omp/agent/`; `pi/`
goes to `~/.pi/agent/`. `./install-plugins.sh` installs the plugins.

Copying overwrites whole files, so a machine-local `config.yml` field or
`omomp.yml` section is lost unless it is merged back. `config.yml` hot-reloads;
`AGENTS.md`, `RULES.md`, `PERSONALITY.md`, extension code and plugins take
effect on the next `omp` start; `omomp.yml` sections are re-read per use;
`agents/*.md` applies on the next dispatch.

## Working with upstream

`upstream` is `https://github.com/oh-my-omp/omp-config.git` (default branch
`main`); this fork stays on `master`.

```
git fetch upstream
git log --oneline HEAD..upstream/main
git merge upstream/main
```

Resolve conflicts by the fork's decisions, not upstream's:

- Files this fork deleted stay deleted: `ci/`, `.github/`, `.omp/commands/`,
  `agent/APPEND_SYSTEM.md`, `config-light.yml`, `omp-light.ts`, `task-*.md`
  agents, `lang-nag`, `turn-judge`, `omp-config-autoupdate`,
  `SYSTEM_TEMPLATE.md`, `antigravity-wire-profiles`.
- Files this fork keeps because the machine still runs them stay: `bro`,
  `ctx-tool`, `ctx-tasklog`, `_shared/task-log.ts`, `README*.md`,
  `PERSONALITY.md`, `thinking-translator.json`, `install-plugins.sh`.
- Take upstream's code, then re-anchor its values: magpie model ids in
  `agent/omomp.yml`, the fork's lane names instead of `task:*`, the
  `dbydd.omp.*` session-entry keys.
- Run `bun run check` after resolving.

## Key directories

|Path|Purpose|
|---|---|
|`agent/AGENTS.md`|Style, operating stance, delegation and tool-call rules; installed to `~/.omp/agent/AGENTS.md`|
|`agent/RULES.md`|Standing short rules, injected every turn|
|`agent/PERSONALITY.md`|Persona and tone, rendered into the main session only|
|`agent/config.yml`|omp config: model roles, feature switches, isolation, compaction|
|`agent/omomp.yml`|Every extension's settings, one section per extension directory|
|`agent/thinking-translator.json`|Config of `omp-thinking-translator`|
|`agent/agents/`|Eight magpie lanes plus `README.txt`/`README.zh-CN.txt` with verified pitfalls|
|`agent/rules/`|Native rules-carrier files (for example `tern-session-required.md`)|
|`agent/skills/`|Portable skills, one directory each with `SKILL.md`|
|`agent/extensions/`|Local extensions, one directory each; `_shared/` is not an extension|
|`agent/extensions-last/`|Extensions that must load last; `system-prompt-replace/` is the only `config.yml` `extensions` entry|
|`pi/`|pi-side configuration; `pi-hindsight/` is a submodule of the plugin's fork|
|`install-plugins.sh`, `plugin-audit.sh`|Plugin list, and the read-only drift report against it|

## Development commands

```bash
./install-plugins.sh          # omp install each declared plugin (network required)
./plugin-audit.sh             # read-only: script history since 9658fe6f vs `omp plugin list`
bun install                   # dev dependencies (Biome, TypeScript, omp host packages for types)
bun run check                 # biome check . && tsc --noEmit
bun run format                # biome check --write .
omp config list --json        # confirm applied config values
omp plugin list --json        # confirm plugin names/versions/enabled
git status --short            # confirm no runtime or credential files leaked in
```

There is no build step and no test suite.

## Code conventions

Enforced by `bun run check` (Biome plus `tsc --noEmit`). A change is done when
that passes and the touched extension has been exercised in a real omp session.

- **Layout.** One directory per extension, kebab-case, named after the extension
  id. `index.ts` begins with a header comment (what it does, what it registers,
  which files it reads and writes, main or sub scope, failure policy) and
  default-exports a camelCase factory named after the directory. Other `*.ts`
  files in the directory are its private modules, one level only. Nothing
  directly under `extensions/` or `extensions-last/` is a `.ts` file.
- **No cross-extension imports.** Code used by two or more extensions lives in
  `extensions/_shared/` and is imported by relative path with the `.ts`
  extension. `_shared` provides mechanics, not policy: retries, timeouts,
  user-visible wording and failure-to-null rules stay in the caller.
  - Extension config: `defineOmompSection(import.meta.dir, schema)` once, then
    `loadOmompSection(section, cwd)` (`cwd` `null` = agent dir only). The first
    `omomp.*` copy that holds the section wins, project `.omp/` before the agent
    dir; invalid copies are reported in `skipped`. Writes go through
    `writeOmompSection`.
  - Model specs `provider/id[:level]`, comma chains: `resolveModelChain`,
    `findModel`, `splitLevel`.
  - One-shot model calls: `runHelperPrompt` (never throws; `taskDepth: 1`,
    in-memory, no tools, MCP, LSP or extensions unless asked). Any other
    `createAgentSession` an extension builds must also pass `taskDepth: 1`:
    without it the SDK treats the helper as a main session, and `dispose()`
    tears down the global `AgentLifecycleManager`, turning every idle subagent
    into `Unknown agent`.
  - Native judges: `openNativeJudge` follows the session's OMP JUDGE role; a
    chat-only JUDGE leaves native consumers inactive.
  - Spec files (`*-<label>.md`): `discoverSpecFiles`, `parseFrontmatter`,
    `unquote`. Message text: `textOf`, `lastAssistantText`. Errors: `errorText`.
  - Task log path, format and goal model: `_shared/task-log.ts`, shared by
    `ctx-tool` and `ctx-tasklog`.
- **Code copied from omp** is wrapped in
  `// @upstream <verbatim|adapted> <package>@<version> <src path>#<symbol>` …
  `// @upstream-end`. After an omp upgrade, compare the block and bump the version.
- **Files an extension owns sit beside it**, read via `import.meta.dir`, never
  via `getAgentDir()` or the agent root. Only paths fixed by someone else stay
  elsewhere (`thinking-translator.json`, `commandcode-models.json`).
- **Format:** Biome only (tabs, double quotes, semicolons, trailing commas,
  width 140). Run `bun run format`; never hand-format.
- **Types:** strict `tsc` with `noUncheckedIndexedAccess`; no `any`. An `as`
  cast only where no runtime check is possible, with a one-line reason; never
  on external input. External input — JSON/YAML files, tool parameters, session
  entries, `unknown` event payloads, child-process output — is parsed once at
  the boundary with `z` from `@oh-my-pi/pi-coding-agent` or a type guard.
- **State:** variants are a discriminated union on `kind` handled by an
  exhaustive `switch` with a `never` default arm. Independent facts stay
  independent fields; booleans never encode mutually exclusive states.
- **Errors:** expected failures are result unions; exceptions are programmer
  errors. A hook or tool never throws into omp: catch at the handler boundary
  and `pi.logger.warn(message, { error: errorText(error) })`. An empty
  `catch {}` carries a comment naming the expected failure.
- **Main vs sub session:** `ctx.agent.kind` (`"main" | "sub"`), never the
  session-file name.
- **Injected user-role messages carry `attribution: "agent"`.** The default is
  `user`, and `user-prompt-inject` treats `user`-attributed messages as the
  human's own prompts.
- **Imports:** omp host package roots (`pi-agent-core`, `pi-ai`, `pi-catalog`,
  `pi-coding-agent`, `pi-natives`, `pi-tui`, `pi-utils`), Node/Bun built-ins and
  relative paths. Use a host subpath only when an extension already loads it in
  a real omp session; dev type-checking resolves packages from `node_modules/`,
  which proves nothing about runtime loading.
- **Size:** a function over ~150 lines is split into named module-level
  functions.
- **Lifecycle:** `session_start`, `before_agent_start`, `input`, `context`,
  `tool_call`, `tool_result`, `message_end`, `agent_start`, `agent_end`,
  `session_compact`, `auto_compaction_end`, `before_subagent_spawn`,
  `session_shutdown`, `session_switch/branch/tree`. Only `context` fires on
  every model call, including IRC wakes of idle or parked subagents.

## Subagent definitions (`agent/agents/*.md`)

- YAML frontmatter: `name`, `description`, and optionally `spawns` (comma list)
  or `tools`. **No `model` field** — the binding is `model: magpie/group/<id>`
  in the definition itself; `config.yml` `task.agentModelOverrides` only covers
  the built-in `task` and `sonic`.
- Prefer an explicit `spawns` allowlist over `"*"`; the first listed name is the
  silent default for an omitted `agent`.
- Read `agent/agents/README.txt` before editing: `task.disabledAgents` names
  cannot be spawned even when allowlisted, recursion depth caps at 2, a
  `yield`-only agent can lose its answer, edits apply on the next spawn, and a
  broken definition is skipped with a log warning rather than a call-site error.
- Keep non-agent notes as `.txt`: every `.md` here is parsed as an agent
  candidate, and a plain note becomes permanent per-dispatch log noise.

## Important files

- `agent/config.yml` — `extensions` (only the `extensions-last/` entry, which
  must stay last), `modelRoles` (magpie routes; the `judge` role lives in the
  machine's copy and resolves to `magpie-decisions/group/decider`),
  `task.disabledAgents`, `task.isolation` (`enabled`, `merge: branch`),
  `compaction` (`methodOrder`, `thresholdTokens` machine-local,
  `asyncEnabled: false`), `edit.mode: apply_patch`, `readLineNumbers: true`,
  `inlineToolDescriptors: "on"`, `todo.enabled: false` (the `omp-todo-more`
  plugin provides `todo`), `bashInterceptor.enabled: true`.
- `agent/omomp.yml` — sections `tool-policy-nag`, `task-completion-judge`,
  `task-split-check`, `child-memory-warning`, `system-prompt-replace`. The
  machine-local sections `doc-polish` and `model-compaction` are not in the
  repository. `system-prompt-replace` is read from the agent dir only.
- `agent/extensions/child-memory-warning/` — Darwin-only descendant footprint
  warnings every 2 s; `thresholdGiB` comes from the `child-memory-warning`
  section, project copy first, re-read every scan.
- `agent/extensions/tool-policy-nag/` — `detector: heuristic` runs the local
  command parser and turns `bashInterceptor.enabled` off at runtime;
  `detector: jev` asks the JUDGE role one question per call and leaves the
  interceptor to config. The `risk` lane is deterministic. This machine
  disables the whole extension.
- `agent/extensions/user-prompt-inject/PROMPT-INJECT-user-goal.md` — targets
  `*`, injects every root user prompt into each subagent's model calls.
- `agent/extensions/tool-policy-nag/INTENT-policy.md` — the `jev` lane's
  `choice` question and its per-option rubrics.
- `agent/thinking-translator.json` — the plugin's chain; the repository copy is
  `enabled: false`.
- `pi/` — `AGENTS.md`, `APPEND_SYSTEM.md`, `agents/` (seven definitions),
  `hindsight.jsonc`; `pi-hindsight/` is the submodule the plugin is installed
  from.

## Runtime and tooling

- **Harness:** Bun-based `omp`. Validation one-liners use `bun -e`
  (`Bun.YAML.parse`, `JSON.parse`). `append-system-model` uses
  `Bun.YAML.parse` for its headers.
- **Dev tooling:** `bun install` fetches Biome, TypeScript and the omp host
  packages for types only. `bun.lock` is not committed.
- **Plugins:** installed by `omp install` into `~/.omp/plugins/`; machine state,
  never copied into this repository. Every entry points at this user's fork or
  at npm `pi-intercom`.
- **Never commit:** `.gitignore` covers `agent/*.db*`, `agent/*.lock`,
  `agent/models.yml*`, `agent/commandcode-models.json`,
  `agent/{sessions,terminal-sessions,blobs,cache}/`, `plugins/node_modules/`,
  `node_modules/`, `bun.lock`, `.omp/hindsight/`, `**/*.db`, `**/logs/`, `/.pi`.
- **Do not overwrite app-managed files:** files marked
  `// @orca-managed-pi-extension` or `marker: _otty` belong to their apps.

## Testing and QA

- **Static checks:** `bun run check` (Biome plus `tsc --noEmit`). Type-checking
  resolves host packages from `node_modules/`, so it cannot prove an import
  loads inside omp.
- **Runtime proof:** copy the change to `~/.omp/agent/`, restart `omp`, and
  exercise the changed tool, command or hook; observe the output or side effect.
  A parse check or `cmp` is necessary, not sufficient.
- **`plugin-audit.sh`** validates the plugin list only; it says nothing about
  extension code.
- If runtime verification is not possible, say so explicitly.
