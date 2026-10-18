# omp-config

English | [简体中文](README.zh-CN.md)

The reviewable, portable part of an Oh My Pi (OMP) machine configuration, tuned for heavy programming work. Databases, sessions, caches, logs, lock files, credentials and `models.yml` stay out of the repository; the machine-only pieces listed in [Repository contents](#repository-contents) stay on the machine.

- [Repository contents](#repository-contents)
- [Quick start](#quick-start)
- [Design](#design)
- [Skills](#skills)
- [Local extensions](#local-extensions)
- [Machine installation](#machine-installation)
- [Maintenance notes](#maintenance-notes)

## Repository contents

|Path|Content|Machine location|
|---|---|---|
|`agent/AGENTS.md`|Style, operating stance, delegation, tool-call rules|`~/.omp/agent/AGENTS.md`|
|`agent/RULES.md`|Standing short rules, injected every turn|`~/.omp/agent/RULES.md`|
|`agent/PERSONALITY.md`|Persona and tone, rendered into the main session only|`~/.omp/agent/PERSONALITY.md`|
|`agent/config.yml`|OMP config: UI behavior, feature switches, model roles|`~/.omp/agent/config.yml`|
|`agent/thinking-translator.json`|Config of the `omp-thinking-translator` plugin|`~/.omp/agent/thinking-translator.json`|
|`agent/agents/`|Subagent lane definitions (`*.md`); `README.txt` records verified pitfalls|`~/.omp/agent/agents/`|
|`agent/rules/`|Rule files for the native rules carrier (for example `tern-session-required.md`)|`~/.omp/agent/rules/`|
|`agent/skills/`|Portable OMP skills, one directory per skill with `SKILL.md` at its root; currently [computer-use-decider](#computer-use-decider)|`~/.omp/agent/skills/`|
|`agent/extensions/`|Local extensions, one directory each; see [Local extensions](#local-extensions)|`~/.omp/agent/extensions/`|
|`agent/extensions-last/system-prompt-replace/`|The extension that must run last, loaded explicitly as the only `extensions` entry of `config.yml`|`~/.omp/agent/extensions-last/`|
|`pi/`|The pi-side configuration; see `pi/README.md`|`~/.pi/agent/`|
|`pi-hindsight/`|Git submodule: the pi-hindsight fork source|Installed as the `pi-hindsight` plugin|
|`install-plugins.sh`|Declares the plugin list and runs `omp install` for each entry|—|
|`plugin-audit.sh`|Read-only drift check: script history since the fork point versus `omp plugin list`|—|
|`package.json`, `biome.json`, `tsconfig.json`|Dev tooling: `bun run check` runs Biome and `tsc --noEmit` over `agent/**/*.ts` and `pi-hindsight` is type-checked in its own repository|—|

Inside an extension directory, the `.ts` modules and the templates and configs the repository ships belong to the repository; other files there (`bro-settings.json`, `doc-polish.json` at its live location, watchdog and prompt-inject templates the machine adds) belong to the machine.

## Quick start

On a new machine:

1. Copy the managed files into `~/.omp/agent/` and `~/.pi/agent/` with the set in [Machine installation](#machine-installation).
2. Run `./install-plugins.sh` (network required; it installs the plugins declared in its list).
3. Restart OMP. Context files, extensions, plugins and skills are all loaded at startup or picked up by skill discovery on the next session.

To carry provider logins from an old machine, copy the `auth_credentials` table of `~/.omp/agent/agent.db` (for example with sqlite3's `.backup` on the remote side).

## Design

### Scope

- The full prompt does not cater to small, simple tasks. Use plain `omp` without the heavy config for small tasks.
- Every nonportable decision stays on the machine. The repository holds only what a person can review line by line.

### Constraints that make the prompt hold

These constraints do not assume that the model follows the system prompt reliably. In practice, models follow its rules selectively; once they start bypassing the tool-call conventions, the other constraints tend to fail with them. The configuration therefore constrains side effects, detects drift and adds reminders at runtime, all at once.

**Bind writes to observed state.** The edit tool runs in apply-patch mode and refuses to change lines that were not read first (`config.yml`: `edit.mode: apply_patch`, `readLineNumbers: true`). A write is thus bound to a snapshot that was actually observed. The rules are in `# Tool calls` of `agent/AGENTS.md`.

**Treat todo and ctx as one combined tool set.** todo maintains the task lifecycle; when the model stops on an ordinary end path while the todo is not finished, todo makes the agent continue. It also reduces asking the user too early after a small setback. Native todo is off (`todo.enabled: false`); the independent plugin `omp-todo-more` (this machine's fork) provides `todo` with a goal and an explanation per item, keeps the native reminders, and restores todo for `task:*` workers.

Every successful todo change is captured by `ctx-tasklog`; `ctx` replays those events into the final task state, giving a short work record that does not depend on the model summarizing itself. After the main session compacts, `ctx-tool` injects that record, together with the context tree, into the new context.

**Treat an off-contract tool call as a signal of overall drift.** `tool-policy-nag` detects whether the model bypasses the built-in tools; it only reminds and never blocks a command. The intent lane judges through OMP's JUDGE role which tool should have been used; the risk lane is deterministic and flags calls whose outcome cannot be read off the command line. The config repository disables the whole extension on this machine (`disabledExtensions: extension-module:tool-policy-nag`), keeping the code shipped for other machines.

**Use a watchdog for independent runtime review.** `watchdog-agent` reads the context automatically as a third-party observer and injects reminders by rule; options declared in a watchdog file route to OMP's native JUDGE backend.

**Judge every turn and correct directly.** `turn-judge` judges each main-session turn through OMP's native JUDGE; when the matching option's confidence reaches its threshold it types the preset prompt, otherwise it only shows the verdict.

**Let advisors see the user's own words.** The mentor and discussants know only what the spawning agent tells them, so they advise along that retelling and become echo amplifiers. `user-prompt-inject` injects the prompts the user wrote in the root session into every model call they make, so they check the other agent's plan against the user's goals and constraints.

**Treat the final reply as the only deliverable.** The user sees neither the thinking nor the files read, tool results or subagent reports, only the last reply. Its prose uses complete sentences with explicit subjects, names each item at first mention, and states the supporting observation next to every conclusion. The rules are in `# The user sees only the final reply` of `agent/AGENTS.md`.

### Context management

The context is not just file contents; it also holds requirements, trade-offs, confirmed facts and intent aligned with the human. Compaction squeezes all of that, so every compact in a long task is a lossy operation to avoid as far as possible.

- Grepping instead of reading in full hardens partial information into wrong beliefs.
- Chaining many operations into one long bash widens side effects and makes failures harder to diagnose.
- External command output can explode; cutting it with `head` or `tail` loses key evidence just the same.

Prefer the tools' own paging and default ordering, which keep output size under control while preserving a traceable read boundary.

**Put disposable work in subagent contexts.** A subagent's context is a disposable working branch; important conclusions and evidence come back over subagent IRC, and the main agent distills them into its own context. What gets discarded is the execution, not the task intent.

**The owner of the intent writes the documents and the core code.** Documents and core code carry design intent; each level's current owner writes them personally. The full rules are in `# Operating stance` of `agent/AGENTS.md`.

**Fork the context when the full background is needed.** `fork_task` spawns a subagent whose initial transcript is a copy of the caller's conversation ([fork-task](#fork-task)), so the assignment depends on requirements and decisions already settled here. If the main context still compacts, the ctx chain replays the recorded progress into the compacted session.

### Model roles and the decision route

`agent/config.yml` maps OMP's built-in roles to magpie routing groups; each lane definition in `agent/agents/` points at `magpie/group/<id>` with `thinkingLevel: inherit`, so the gateway decides the reasoning depth per turn and no lane pins a level.

|Role|Route|
|---|---|
|`default`|`magpie/group/fusion-hierarchical`|
|`task`|`magpie/group/fusion-worker`|
|`slow`|`magpie/group/philosopher`|
|`plan`|`magpie/group/theorist`|
|`advisor`|`magpie/group/fusion-deepthink`|
|`smol`, `tiny`, `memory`, `commit`|`magpie/group/labor`|
|`vision`|`magpie/group/flash-vibe`|
|`judge`|`magpie-decisions/group/decider`|

The `judge` role resolves to the machine's `magpie-decisions` provider: `api: typesafe`, `baseUrl: http://127.0.0.1:3425` (no `/v1`; the typesafe wire appends `/v1/systemone`), model `group/decider`, `kind: judge`. The provider id avoids the built-in `typesafe` provider so a future real `TYPESAFE_API_KEY` would not be silently pointed at the local gateway. On this machine the group mixes decision-only models served by omlx (clef-flash among them) with free ones; requests answer in the 100–200 ms range with a full probability distribution. Without the native backend, the judge role falls back to a chat model with prompt-based judgment.

### Subagent system

Subagent lanes mirror magpie's routers; a lane name is a label and the `model:` id inside its definition is what actually gets called, so the two are maintained separately. The four base lanes: `labor` (bulk and deterministic work), `engineer` (strong practice, balanced), `theorist` (design and trade-offs), `philosopher` (strongest reasoning). The four aggregation lanes: `fusion-worker` (labor → engineer), `fusion-deepthink` (theorist → philosopher), `fusion-hierarchical` (splits practice from theory first), `fusion-flattened` (picks one base lane directly).

`agent/agents/README.txt` records the verified pitfalls: `spawns` allowlists and the silent default, names in `task.disabledAgents` that cannot be spawned even when allowlisted, the recursion depth cap, a `yield`-only agent losing its answer, and a non-agent `.md` in the directory being parsed as a definition. Keep non-agent notes as `.txt`. Changes apply on the next dispatch without a restart.

## Skills

`agent/skills/` holds portable OMP skills; each directory carries one skill whose root is `SKILL.md`. Copy the directory into `~/.omp/agent/skills/` to install it; skill discovery picks it up on the next session. Skills there run in the main session and subagents alike, and none of them reads or writes a config file.

### computer-use-decider

`computer-use-decider` speeds up browser and desktop UI work that repeats the same control selection. The agent keeps the goal, the text to type, execution, and verification; a decision call through OMP's JUDGE route picks one observed action per step: build candidates from a `browser` `observe()` or a `computer` AX tree, let the judge choose action and target in one call, execute through the existing element handles, and re-observe. Low confidence, an `inspect` choice, or a failed call hands the step back to the agent.

The skill covers when to use it, the confidence threshold, and the guard rules against page changes and stale targets. The bundled helper `scripts/decider.js` builds candidates and runs the one decision call; it sends no input and opens nothing by itself.

|What|Where|
|---|---|
|Skill instructions|`agent/skills/computer-use-decider/SKILL.md`|
|Decision helper|`agent/skills/computer-use-decider/scripts/decider.js`|
|Machine location|`~/.omp/agent/skills/computer-use-decider/`|

## Local extensions

The extensions in `agent/extensions/` and `agent/extensions-last/` patch defects in OMP and plugins, or add behavior constraints, context recovery, dispatch checks and similar features. Each extension is one directory; `<name>/` below means `agent/extensions/<name>/`; the config, templates and state files an extension reads and writes are all in its own directory.

|Extension|What it does|
|---|---|
|[tool-policy-nag](#tool-policy-nag)|Reminds when shell/eval stands in for a built-in tool; intent lane via native JUDGE, risk lane deterministic|
|[watchdog-agent](#watchdog-agent)|Third-party reviewer delivered to chosen targets|
|[user-prompt-inject](#user-prompt-inject)|Injects the user's own words into chosen subagents through templates|
|[turn-judge](#turn-judge)|Judges each main-session turn with native JUDGE; types a preset prompt past the threshold, otherwise shows the verdict|
|[child-memory-warning](#child-memory-warning)|Warns the main UI and agent when a macOS descendant exceeds 4 GiB physical footprint, including previously observed surviving orphans|
|[repo-rules](#repo-rules)|Also reads repo-level rule directories such as `.claude/rules`|
|`tern-tool`|Registers the `tern` tool with the session required on every call|
|[append-system-model](#append-system-model)|Appends system-prompt text by model / provider regex|
|[system-prompt-replace](#system-prompt-replace)|Runs last among path-loaded extensions and replaces system-prompt text by JSON rules, used to rewrite built-in tool descriptions|
|[fork-task](#fork-task)|Registers `fork_task`: spawns a subagent carrying a copy of the current conversation|
|[isolation-nudge](#isolation-nudge)|Blocks once when several writers share a directory|
|[task-split-check](#task-split-check)|Blocks multi-topic dispatches and dispatches that cap report length|
|[task-completion-judge](#task-completion-judge)|Reviews completion once before a worker delivers|
|[ctx-tool](#ctx-tool)|Registers the read-only `ctx` tool; after compaction it forces the `ctx` overview and current task record in|
|[ctx-tasklog](#ctx-tasklog)|Captures successful todo / goal changes as the record `ctx` derives from|
|[response-reading-coverage](#response-reading-coverage)|Reports low/medium/high source-reading follow-up against a historical baseline|
|[doc-polish](#doc-polish)|`polish_doc` / `/polish-doc`: polishes documents without changing their meaning|
|[bro](#bro)|`/bro`: rewrites a reply, document or web page into an easy explanation|
|[input-polish](#input-polish)|`Ctrl+Enter` polishes the input-box draft; Enter sends after the overlay preview, Esc cancels|
|[tool-description-restore](#tool-description-restore)|Restores tool descriptions stripped by the `openai-completions` wire on magpie|
|[wt-tool](#wt-tool)|Registers `wt` / `wt_remove`: the main agent invokes the human `/wt` to enter a new worktree, or after a check and confirmation removes the worktree it is in and returns to the main checkout|
|[commandcode-model-spec](#commandcode-model-spec)|Fixes the auth failure when `--model` names a commandcode model|

`agent/rules/tern-session-required.md` is a native rules-carrier file: it gates bash calls of the `tern` CLI through the judge and teaches the session-required usage for when the `tern` tool is unavailable.

### Layout and development conventions

omp looks only one level down from `~/.omp/agent/extensions/`: a `*.ts` placed directly, `<dir>/index.ts`, or the entry declared in `<dir>/package.json`. This repository always uses `<dir>/index.ts`, and the directory name is the extension id; other `.ts` files in the directory are its own modules, one level only, and `_shared/` holds code shared by several extensions (it has no `index.ts`, so omp never loads it as an extension).

|Location|What goes there|
|---|---|
|`agent/extensions/<name>/index.ts`|The extension entry; default-exports the registering function, named after the directory in camelCase (such as `toolPolicyNag`)|
|`agent/extensions/<name>/*.ts`|The extension's own modules, one level only|
|Other files in `agent/extensions/<name>/`|Config, templates and state the extension reads and writes, located with `import.meta.dir`|
|`agent/extensions/_shared/*.ts`|Code shared by two or more extensions; no `index.ts`|
|`agent/extensions-last/system-prompt-replace/`|The same structure, loaded by path as the only `extensions` entry of `config.yml`, so it runs after every natively discovered extension|

No `.ts` sits directly under `extensions/` or `extensions-last/`. Extensions do not import each other; shared code goes into `_shared/` and is imported by relative path with the `.ts` suffix:

|Module|Provides|
|---|---|
|`errors.ts`|`errorText`: turns an exception into text|
|`messages.ts`|`textOf`, `lastAssistantText`: take the text blocks of a message|
|`config.ts`|`loadJsonConfig(file name, schema, [ctx.cwd, import.meta.dir])`: a copy under cwd wins, invalid copies are skipped and listed in `skipped`|
|`models.ts`|`resolveModelChain`, `findModel`, `splitLevel`: parse `provider/id[:level]` and comma-separated candidate chains; they only look up the model list and send no request|
|`helper-session.ts`|`runHelperPrompt`: one model call in an in-memory helper session; never throws, always passes `taskDepth: 1`|
|`judge.ts`|`openNativeJudge`: chooses the concrete JUDGE model with the current session's config and OMP's role resolver; only the native judgment API is usable, and credentials come from the host|
|`spec-files.ts`|`discoverSpecFiles`, `parseFrontmatter`, `unquote`: find and parse `*-<label>.md`|
|`task-log.ts`|The task log's path and format, plus the `TaskLogGoal` model, parser and formatter, shared by `ctx-tool` and `ctx-tasklog`|

`_shared` provides mechanism only. Retries, timeouts, throttling, user-visible wording and what to return on failure stay in the caller.

Code conventions, enforced by `bun run check` (Biome and `tsc --noEmit`):

- **Format**: Biome only (tabs, double quotes, semicolons, trailing commas, width 140); tidy with `bun run format`, never by hand.
- **Types**: `tsc` strict plus `noUncheckedIndexedAccess`, no `any`. `as` only on host types that cannot be checked at runtime, with a one-line reason, and never on external input.
- **External input**: parsed once at the boundary with the `z` exported by `@oh-my-pi/pi-coding-agent` or a type guard; only typed values travel after that.
- **State**: multiple cases use a union discriminated by `kind`, with an exhaustive `switch` and a `never` arm. Independent facts stay independent fields.
- **Errors**: expected failures return result unions; exceptions mean programmer errors. Hooks and tools never throw into omp: catch at the entry and record with `pi.logger.warn(…, { error: errorText(error) })`. An empty `catch {}` carries a comment naming the expected failure.
- **Main session or subagent**: decide with `ctx.agent.kind`, never the session file name.
- **File locations**: an extension reads its own files with `import.meta.dir`, not `getAgentDir()`.
- **Injected messages**: user messages an extension sends on its own behalf set `attribution: "agent"`.
- **Structure**: `index.ts` starts with a header comment stating what the extension does, what it registers, which files it reads and writes, its scope, and its failure policy. Only the default export, unless another file of the same extension needs a name. A function over about 150 lines is split into named module-level functions.
- **Imports**: only omp host package roots, Node/Bun built-ins and relative paths. A host-package subpath may not load inside omp (`@oh-my-pi/pi-tui/thinking` does not), so use only subpaths already loaded in a real omp session.

`bun run check` type-checks against the host packages in `node_modules`, which cannot prove an extension loads inside omp. After changing an extension, also load it for real from a directory without `node_modules` and trigger the changed tool, command or hook in a real session.

### Behavior constraints

`turn-judge`, the intent lane of `tool-policy-nag` and the option backend of `watchdog-agent` share OMP's **JUDGE model role** instead of each setting its own provider/model. Configure JUDGE once; these features join automatically when the role's first available candidate is a native judgment API model. Role resolution follows OMP's candidate order and defaults, and credentials come from OMP.

When the role resolves to a model without the native backend, the related judgments run through that model with prompt-based parsing; a failed request produces no reminder and no fallback switch. Every trigger re-reads the current session's role config.

#### tool-policy-nag

`tool-policy-nag/` acts on the main session only. At the `tool_call` stage it checks watched calls; it only reminds and never blocks a command. Three lanes each handle a **different** concern, switched separately by `tool-policy-nag.json` in the same directory, and they can all be on at once:

- `form` — string detection: a command parser mechanically counts how many operations in this call should have used a built-in tool.
- `intent` — intent detection: hands the whole call to the native JUDGE and asks which built-in tool should have done the work. It answers a **tool-routing** question.
- `risk` — risk detection: decides deterministically whether **what the call does can be read off this one line**. When a command is long, involves many external programs and has a writing step, its outcome cannot be inferred from the command alone.

- **Watched calls**: `bash` / `bash_bg` commands; `exec_command` commands; commands written through `write` to `xd://bash`, `xd://bash_bg` or `xd://exec_command`; `eval` Python / JS code (the risk lane looks only at shell commands).
- **Config** `tool-policy-nag.json`: `form: {"detector": "heuristic"}` turns the string lane on, `intent: {"threshold": 0.5}` declares the intent lane (the repository's value; the lane runs once the native backend is available), `risk: {"minCommands": 4, "minChars": 600, "minPrograms": 3}` turns the risk lane on (the repository's values), and `null` turns a lane off. The file under cwd wins over the one beside the extension; it is re-read on every watched call.
- **The two tool lanes send at most one reminder per call.** When the intent lane is declared, valid, enabled and native JUDGE is available, it owns the reminder while `form` still counts and logs; otherwise `form` sends the generic reminder. The risk lane runs before that resolution and is not bound by this rule.
- **This machine runs it disabled**: `config.yml` lists `extension-module:tool-policy-nag` in `disabledExtensions`. The code and config stay in the repository for machines that want it.

The form lane's shell violation classes, the eval violation regexes, the cadence (first three violations recorded, then one steer per violating call up to three per context, capped until the next compaction) and the state key `mouriya.omp.tool-policy-nag.state` follow the heuristic in `heuristic.ts`. The intent lane sends one `choice` question per watched call with its 12 options (`list`, `read`, `search`, `edit`, `write`, `move`, `eval`, `ast`, `pty`, `shell`, `mixed`, `none`) defined in `INTENT-policy.md`; each `rubric` carries positive examples and counterexamples drawn from real false-positive classes. The risk lane fires when a call has at least `minCommands` segments or `minChars` characters, involves at least `minPrograms` distinct programs after dropping shell plumbing, and includes a write; a read-only command is the intent lane's business.

#### watchdog-agent

`watchdog-agent/` is a watchdog delivered to chosen targets, driven by `WATCHDOG-<label>.md` files found beside the extension or from cwd upward. Each file is an independent watchdog with its own counting, run and cap. The extension directory's watchdog files belong to the machine.

**Frontmatter fields:**

|Field|Meaning|
|---|---|
|`target` (required)|`main`, an agent name (such as `task:low`), `*`, `subagents`, or a comma-separated list|
|`name`, `enabled`|`name` defaults to the label in the file name; `enabled` defaults to `true`|
|`delivery`|`aside` (default), `steer`, `nextTurn`, `followUp`|
|`maxPerContext`|Reminders allowed between two compactions, unlimited by default|
|`every`|Run once after this many operations (each tool call or nonempty text reply counts 1), default 30|
|`scope`|`full` (the whole branch, default) or `window` (messages after this watchdog's last concluded review)|
|`model`, `tools`|For the chat reviewer backend|
|`instructions`, `option.*`|For the native JUDGE backend; declaring `option.*` selects it|

**Two backends, one or the other:**

- **Chat reviewer** (default): reviews in an in-memory session that may not load extensions. `model` may carry `:effort`; by default the `@advisor`, `advisor` and `@slow` roles are tried in turn, then the session model. `tools` defaults to `read`/`grep`/`glob`. The body is the review focus; an answer starting with `PASS`, `OK`, `LGTM` or `NONE` passes, any other nonempty answer is injected as a problem.
- **Native JUDGE**: declare `option.*`; the model follows OMP's JUDGE role. It picks one of the declared options from the transcript and the body's criteria, calls no tools; the injected text is that option's prewritten prompt. Without native JUDGE it is skipped silently.

Judgment options are declared with flat keys (`option.<label>`, `option.<label>.prompt`, `option.<label>.delivery`, `instructions`). An unknown `option.*` key, a prompt for an undeclared option, or an empty prompt skips the whole file with a warning.

**How it runs**: every finished assistant message advances the count; at `every` the review runs immediately, and a turn ending below the threshold with a nonzero count runs one catch-up review. `scope` selects the transcript; the cursor advances only after a concluded review. A failing review leaves it in place. Reminders are injected as `<watchdog name=… severity=…>` with the `delivery` timing; queued reminders live in memory only. With `maxPerContext` set, the watchdog stops reviewing after that many reminders until the next compaction. Cursor and cap state are written into session custom entries and restored on resume, branch switch and tree navigation.

**Slash commands**: `/watchdog` (list), `/watchdog on|off <name> [session|global]`, `/watchdog add <request>`, `/watchdog edit <name> [change]`, `/watchdog rm <name>`. `add` and `edit` draft through the model in rounds — draft, revise, write only after the user confirms — and every successful write touching a `WATCHDOG-*.md` is re-read at once and reported in the tool result.

#### user-prompt-inject

`user-prompt-inject/` fills the prompts the user wrote in the root session into `PROMPT-INJECT-<label>.md` templates and injects them into every model call of the chosen subagents. OMP has nothing ready-made: `before_subagent_spawn` can only swap the model or block, and `before_agent_start` does not fire when an idle subagent is woken by `write agent://<id>`.

**Frontmatter**: `target` (required; agent names or `*`), `name` (defaults to the label), `enabled`. The body is a template over `user_prompt`, the array of user prompts in time order: `{{user_prompt[0]}}` the first, `{{user_prompt[-1]}}` the latest, `{{user_prompt[3:e]}}` a slice with `e` meaning the end. Any other placeholder form skips the whole file with a warning.

The repository's `PROMPT-INJECT-user-goal.md` targets `mentor:default`, `discuss:steady` and `discuss:divergent`, injects every user prompt with `{{user_prompt[0:e]}}`, and tells them to treat the user's own words as authoritative.

**Prompt source**: from the subagent it follows `ctx.agent.parentId` up the agent registry to the main session and reads its current branch's `role: "user"`, `attribution: "user"`, non-`synthetic` messages in order, text blocks only; an empty message (only an image, for example) takes no position. Input is read after the `input` hook and command expansion. Messages this repository's extensions inject are all marked `agent` for this reason.

**Timing**: templates are read when the subagent session starts; on every `context` event it re-reads the root session and puts one request-only developer message at the very front. The message is not written into the session. A malformed file is skipped with a warning; a missing main session injects nothing. Both fail open.

#### turn-judge

After every main-session turn, `turn-judge/` judges that turn through OMP's native JUDGE according to `TURN-JUDGE-<label>.md`, one question per file. When an option with a prompt reaches its confidence threshold, that prompt is typed as a user message; otherwise an info notification shows the verdict.

**Frontmatter** (keys case-insensitive): `name`, `enabled`, `maxChars` (default 30000), `option.<label>`, `option.<label>.prompt`, `option.<label>.threshold` (required with a prompt, in (0, 1]). Labels may be Chinese but may not contain `.` or whitespace. The body is the question, handed to JUDGE as is. Fewer than two options, a prompt for an undeclared option, or a missing threshold skips the file.

The repository's `TURN-JUDGE-甩锅.md` asks "模型是不是在甩锅？" (is the model passing the buck?), options `是`/`否`; when `是` reaches probability 0.5 it types the preset nudge to finish the work.

**A turn**: an assistant message with text that the model ended itself (`stopReason: "stop"`) in the main session. JUDGE receives `{ 过去的记录: [{角色, 内容}], 本轮回复 }`: the record is user inputs (`attribution: "user"`, not `synthetic`) and assistant text in time order, whole entries dropped from the oldest past `maxChars`; the reply is the last message's text, untruncated. Among triggering options the most probable prompt is sent with `attribution: "agent"`; every other file shows one merged info notification per turn. A turn caused by a prompt is judged too, with no limit. Files are re-read at the end of every turn.

#### lang-nag

`lang-nag/` acts on the main session only. After a main-agent turn, it takes the last paragraph (first 200 characters) of the last reply with body text and asks a model in a helper session whether it is in the target language; if not, it prepends `instruction` to the user's next input. It never changes a reply already sent. Config `lang-nag.json` requires `model`, `language` and `instruction`; the file under cwd wins, and the file belongs to the machine. Automatic continuations, failed judgments and an unavailable model produce no reminder.

#### repo-rules

`repo-rules/` also reads repo-level rules OMP does not scan by default (`.claude/rules`, `.agents/rules`, `.pi/rules`). At session start it scans from cwd up to the git root; rules without frontmatter or with `alwaysApply: true` have their body injected, others are listed by name and path for a later `read`. Same-named rules are judged by file name, the one nearer cwd winning; a body already present in the system prompt is not injected twice.

#### append-system-model

`append-system-model/` lets appended prompts differ by model without rewriting the whole system prompt. **File**: `APPEND_SYSTEM_MODEL.md` in the extension directory, owned by the machine, with several blocks in one file, each a YAML header wrapped in `---` (`model`, `provider` — JavaScript regexes matched against the model id and provider id) followed by the body. Every matching block is appended in file order on every `before_agent_start`, main session and subagents. The file is re-read for every prompt. A missing file injects nothing; a format error injects nothing and logs a warning with the line number.

#### system-prompt-replace

`extensions-last/system-prompt-replace/` replaces text in the system prompt. OMP's built-in prompt templates (tool descriptions included) are bundled into the program; this repository turns on `inlineToolDescriptors`, so built-in tool descriptions are part of the system prompt, and sentences that conflict with `agent/AGENTS.md` can only be fixed by rewriting that text.

**Rules file**: `system-prompt-replace.json` in the same directory; each rule has exactly one of `literal` or `regex`, plus `replace`. `literal` replaces every occurrence; `regex` gets `g` automatically and interprets `$1`. Rules apply in file order to every system-prompt block. A missing file replaces nothing; a format error replaces nothing and warns. When a rule's target appears nowhere in the main session's system prompt, the rule warns once per process.

The repository's rules rewrite built-in and plugin tool descriptions: the `task` tool's agent-selection sentence ("Always set `agent` explicitly; never rely on the default."), the engineering rule about rerunning checks, the missing verb in the compiled-code rule, a paragraph appended to the `eval` tool description refusing file investigation through eval, two paragraphs inserted after the opening sentence of `exec_command` (file investigation refusal; interactive work through `tty: true` with early-polling guidance), and a paragraph appended after the `xd://` device-call instruction. Rules about how to use one tool go into that tool's description rather than the appendix: subagents do not receive `AGENTS.md` but do see tool descriptions.

**Running last**: `before_agent_start` runs serially in extension load order. The load order is native discovery → hooks → plugin extensions → `-e` arguments → `config.yml`'s `extensions` in list order → OMP's built-in inline extensions. The extension therefore sits in `extensions-last/` outside `extensions/` and is written as the last (currently only) entry of `config.yml`'s `extensions`. There is no ordering inside `extensions/`; a definite order is only available through the `extensions` list.

### Source reading coverage

#### response-reading-coverage

`response-reading-coverage/` observes native `grep`, `glob`, `find` and `read` calls in the main session and reports a **low / medium / high** source-reading follow-up level relative to a frozen historical baseline of main replies with similar returned-search width. It does not measure comprehension, citation accuracy or answer quality. This machine disables it (`disabledExtensions: extension-module:response-reading-coverage`); the code stays here for other machines.

- `S` is the union of file identities returned by searches in one reply window; `R` counts successful reads whose invocation follows a search returning that identity, deduplicated across the window. Reads invoked before a search, direct reads of other known paths, directory listings and failed reads give no credit.
- A successful empty search adds no evidence and creates no scoring group; no returned files means **not applicable**, not low. Failed or ambiguous observations mean **incomplete**.
- The baseline is a frozen integer table fitted offline from 1,283 reconstructed reply windows (calibration interval ending 2026-10-15): within each returned-search-width stratum, the weighted empirical one-third and two-thirds quantiles of `R` define the low and high boundaries. Runtime uses the table, never a live refit.
- Reports are written as session custom entries; the main session gets one info notification with the level, and children send a displayable message to the root main. The extension has no config and no model calls.

### Local process resources

#### child-memory-warning

`child-memory-warning/` samples the interactive OMP process's descendants on macOS every 250 ms. It reads `proc_pid_rusage`'s **phys_footprint**, including compressed and swapped-out memory accounting, not RSS. A footprint strictly greater than 4 GiB produces one main-UI warning and one agent-attributed message to the main agent. It only warns; it never sends a signal.

- **Ownership**: PID plus kernel start time identifies a process; the process table is validated twice before ancestry or group membership is used. Previously observed descendants remain owned after PPID becomes 1. A group is registered only after its descendant leader is observed.
- **Lifetime**: the first main session owns the managed timer and native handle for the process; main-session switching refreshes the delivery context without resetting ownership. Monitoring ends when the owning main session ends.
- **Limits**: polling cannot retroactively attribute a process born and orphaned entirely between observations with no known surviving group anchor. Non-Darwin startup logs one `未启用` info entry and imports no Darwin binding. Initialization and sampling failures log warnings and never substitute RSS.

### Dispatch and delivery

#### fork-task

`fork-task/` registers the `fork_task` tool. Its parameters follow `task`'s batch form, but the spawned subagent's initial transcript is a copy of the caller's current conversation, followed by the assignment. It suits multi-step work whose assignment depends on requirements, decisions and material already settled in this conversation.

- `isolated` defaults to `true`; write `isolated: false` explicitly for research only. An isolated subagent cannot be continued after it finishes.
- Each item may set `shake: true`, which runs `session.shake("elide")` on the copy: the most recent ~4,000 tokens are protected, earlier text tool results, fenced code blocks and large lowercase XML elements are replaced with `[shaken ~N tokens — recover: artifact://<id> (region K)]`, and the subagent can `read` the original back.
- `name` gets a `_xxxx` suffix; the subagent id in the result is authoritative. It needs `eval` (async) enabled.

Implementation: the caller's session is forked into `$TMPDIR/omp-fork-task/<uuid>/` (inherited cost zeroed, aborted results added for tool calls that never returned, todo cleared, a `<system-notice cause="fork_task">` appended), the parent session's runtime entries are removed and reattached one level up, and the copy is moved to the child session file path the executor opens. This depends on OMP internals; re-verify inheritance, isolation, shake and continuation in a real TUI after every OMP upgrade.

#### isolation-nudge

`isolation-nudge/` checks `task` calls at the `tool_call` stage (not `fork_task`): when two or more writing agents would share the current directory without isolation, it blocks the call once and asks for `isolated: true` on writers and an explicit `isolated: false` on research-only items. It never sets `isolated` for the model. "Two or more" includes several in one batch plus earlier shared writers still running. The reminder is recorded by the sha256 of each item's `task` text, so an unchanged redispatch passes.

#### task-split-check

`task-split-check/` uses a model at the `tool_call` stage to check each dispatch item of `task` / `fork_task`, and blocks the whole call when any item fails. `split` judges items for `task:low` / `task:free` / `task:mid` on whether they stuff several topics into one agent (topics, not file counts); `report-limit` checks every `task:*` item on whether it caps the worker's report length (caps in words, characters, tokens or a "brief report"; setting the length of a deliverable does not count). One merged model request answers line by line; a 25-second abort signal bounds it; verdicts are cached in memory keyed by check plus prompt hash; an unavailable model, a failed request or a timeout passes the checks (fail-open), an unparseable answer passes only that check.

#### task-completion-judge

`task-completion-judge/` intercepts the delivering `yield` in `task:low`, `task:mid` and `task:free` sessions and first has a model judge whether the slice is really done. Evidence: the assignment (the `task` prompt of the last `session_init`), the shared background, the worker's own todo goal, its last 50 tool calls and results, and the submission. The goal is only the worker's restatement; a narrowed scope or a measure never exercised judges `NOT_DONE`. On `NOT_DONE` it blocks the yield once and asks the worker to finish and verify; on `DONE` it re-reads the todo projection and also blocks once while pending or in_progress items remain. Each kind of bounce happens at most once. A passing delivery gets `completion_judge` attached. Model unavailability, request failures and timeouts let the yield through without annotation (fail-open); when the todo plugin does not answer, it logs a warning and fails open.

### Context recovery

In full mode, `todo-more`, `ctx-tasklog` and `ctx-tool` form one combined chain: todo maintains the authoritative task state, the task log records successful change calls, `ctx` replays the record into a short timeline, and after a compact the main session's `ctx list` and `ctx show` results are injected. The task log's path and format are defined by `_shared/task-log.ts`.

#### ctx-tool

`ctx-tool/` registers the read-only `ctx` tool, which assembles the current session, the subagent registry, transcripts, compaction summaries and the task log into one context tree. It modifies no session or file, and it owns the main session's post-compact injection.

- `ctx list [<id>] [all=true]`: depth-first, one context per line, with status, summary and task counts. By default only the main session and `task` subagents are shown; other contexts (mentor, discuss, trace) are hidden with their visible descendants promoted; `all=true` lists everything. More than 8 descendants fold into one line.
- `ctx show <id>`: the handoff, `## Goal` and a `## Tasks` timeline. The goal is the last valid goal-set record in the task log; the handoff is the branch's latest compaction summary (or the sidecar summary for other contexts); the timeline replays todo operations from the task log, each task name keeping its latest state.
- Counts and timeline are approximations rebuilt from the operation log; phase-wide batch operations record one target, and deleting tasks never operated on individually does not adjust counts correctly.
- **Post-compact injection**: after the main session compacts it injects a `<post-compact-ctx>` steer message with `ctx list` and the main session's `ctx show`, at most once per 5 seconds. Subagent sessions get no injection.

#### ctx-tasklog

After every successful `todo` / `goal` change, `ctx-tasklog/` appends the local time, tool name, operation and details to `task-log/<agent-id>.md` under the local root. `ctx` replays only the `todo` events and todo goal lines; `goal` events are recorded but do not enter counts or the timeline. Read-only calls and failed calls are not recorded; successful calls that changed nothing still are. A write failure only logs a warning.

### User tools

#### doc-polish

`doc-polish/` registers the `polish_doc` tool and the `/polish-doc <path…>` command, which restructure and polish `.md` / `.txt` without changing their meaning. It does not modify the source file; it writes the review to `/tmp/doc-polish/<timestamp>-<file name>/`: `review.md` (groups of "before / after / comment"), a copy of the original and the split index `split.json`.

**Three subagents**: split (reads the original, writes the split index with line ranges and a glossary), polish (no tools, batched by body text of at most 5000 code points, returns polished text and glossary changes), check (no tools, judges group by group whether the meaning is preserved). Model precedence: tool parameters > `doc-polish.json` > the current session model; the repository's config sets split and polish models and concurrency 8. A missing model in the available list errors immediately without writing anything; a failed request retries up to 3 times; unparseable polish output keeps the original and is flagged. When the model calls it, the review path comes back as the tool result; when a person runs `/polish-doc`, the same content is handed to the main agent as new input with hard requirements attached: handle it personally, read every review in full.

#### bro

`bro/` registers the `/bro` command, which rewrites content into an easy explanation streamed into a TUI overlay; the explanation is not written into the main session.

|Subcommand|What it does|
|---|---|
|`/bro` or `/bro simplify`|Explains the latest assistant reply once the session is idle|
|`/bro simplify <text>`|Explains the given text|
|`/bro file <path>`|Explains a file inside cwd: text formats read directly, `.pdf` / `.docx` / `.pptx` / `.xlsx` / `.epub` converted to Markdown first. Up to 10 MiB and 100,000 characters, no OCR|
|`/bro url <url>`|Fetches a public HTML page and explains it: HTTP(S) only, at most 5 redirects, 25-second fetch timeout, 5 MiB cap, page JS not run|
|`/bro open`|Reopens the last explanation|
|`/bro model` / `effort` / `mode`|Sets the model, reasoning effort and mode (`brief`, `balanced`, `faithful`)|
|`/bro doctor`|Checks settings, the custom prompt, model availability and reasoning effort|

In the overlay, up/down keys scroll; once complete, `C` copies to the clipboard and `R` regenerates; `Esc` closes. Settings live in `bro-settings.json` beside the extension (machine-owned, created on load if missing); the custom prompt `bro-prompt.md` must contain `{{response}}` exactly once and fully replaces the built-in mode prompts when valid. Helper sessions load no extensions.

#### input-polish

`input-polish/` acts only on the main session's interactive TUI. Pressing the configured chord (default `Ctrl+Enter`) in the input box instead of Enter polishes the draft with a model. The polished text is not written into the input box; it streams into an overlay, and `Enter` replaces the draft and submits through the usual path, `Esc` aborts. Blank drafts and drafts starting with `/`, `!` or `$` pass through untouched. The rewrite must keep the original language, code, paths, identifiers and `[Paste #N …]` / `[Image #N …]` placeholders; a mismatched rewrite is treated as a failure and not applied. Config `input-polish.json` requires `model` and `instruction`; `key` may be `ctrl+enter` (default, needs a terminal that distinguishes it from Enter) or `alt+enter`. Helper sessions pass `taskDepth: 1`.

#### tool-description-restore

`tool-description-restore/` restores tool descriptions on the `magpie` provider's `openai-completions` wire: when the provider returns function tools without descriptions, it refills them from the session's registered tools at `before_provider_request`. It changes nothing for other providers or APIs.

### Session moves

#### wt-tool

`wt-tool/` registers two tools, `wt` and `wt_remove`, so the main agent of the interactive TUI can move its session into a new worktree and, when done, delete it and return to the main checkout. OMP's `/wt` can only be used by a person in the input box, and the extension API has no entry point for invoking built-in slash commands.

- **Scope**: enabled only in the interactive TUI's main session; subagents, `omp -p`, RPC and ACP never have the tools. They are inactive by default and added at `session_start` / `session_switch`.
- **Timing**: both tools only register a request and tell the model to end the turn; once the turn truly ends (`agent_end` that is not `willContinue`) and the session is idle, the registered human command runs through the input box's own dispatcher, with the TUI's error/status/present methods temporarily wrapped to hand the text back to the model. The command does not enter the person's input history, does not clear the draft, and skips other extensions' `input` hooks.
- **`wt`**: runs OMP's built-in `/wt` (forking the checkout into a linked worktree with uncommitted changes and moving the session there). When already inside a linked worktree, the first call creates nothing and returns the current worktree's details plus a `confirm` value; the second call with that value creates a worktree anyway.
- **`wt_remove`**: deletes the linked worktree the session is in and moves the session to the main checkout, keeping the branch. Two calls required: the first is a read-only check (verdict `SAFE`/`UNSAFE`/`BLOCKED`, what deletion would lose, unreachable commits, blockers, a `confirm` value that is a deterministic hash of the worktree state); the second re-checks and refuses when the value differs or a blocker remains, then runs the human `/move`, verifies the cwd, and force-deletes the worktree through OMP's VCS interface. The hand-back names the exact stage where it stopped.
- **Getting the TUI instance**: the extension API does not expose InteractiveMode; within the one synchronous `ctx.ui.setEditorComponent` call the extension swaps the prototype method for a function that only records `this`, then restores it immediately.

### Compatibility fixes

#### commandcode-model-spec

`commandcode-model-spec/` fixes the wrong transport or provider, and the resulting auth failure, when `--model` names a commandcode model. Two failures: cache shadowing (the host's `model_cache` records commandcode models under host transports, so resolution skips the plugin's `commandcode-custom` and auth fails) and name collision (an id like `google/gemini-3.5-flash-lite` resolves to the same-named built-in provider that has no credentials). The extension checks once at `session_start`; when the current model's `api` is not `commandcode-custom`, it reselects the plugin's same-named model. It registers no provider and changes no default. Judgment relies on `commandcode-models.json` in the agent directory, generated by the plugin, cached empty when unreadable.

## Machine installation

A machine is set up by copying the managed files and installing the plugins; the machine owns everything not copied.

```bash
mkdir -p "$HOME/.omp/agent" "$HOME/.pi/agent"
# omp context and config
cp agent/AGENTS.md agent/RULES.md agent/PERSONALITY.md agent/config.yml \
  agent/thinking-translator.json "$HOME/.omp/agent/"
cp -a agent/agents agent/rules agent/skills agent/extensions agent/extensions-last "$HOME/.omp/agent/"
# pi side (see pi/README.md; hindsight.jsonc needs a merge, see there)
cp pi/AGENTS.md pi/APPEND_SYSTEM.md "$HOME/.pi/agent/"
cp -a pi/agents "$HOME/.pi/agent/"
./install-plugins.sh
```

Notes:

- The copy set overwrites whole files. Machine-local fields of `config.yml` (for example `compaction.thresholdTokens`, `theme`, the machine's own `disabledExtensions` additions) and machine entries of `extensions` are replaced; merge them back after copying on a machine with an existing config.
- `~/.pi/agent/hindsight.json` exists and wins over a `.jsonc` beside it; merge the repository's `hindsight.jsonc` into the loaded file instead of copying it.
- The `pi-hindsight` plugin is installed by the script rather than linked to a checkout, so the machine runs a pushed state; re-run `./install-plugins.sh` after a hindsight merge.
- `models.yml`, `agent.db`, sessions, caches and logs stay machine-only. The machine's `~/.pi/agent/STATE.md` and `~/.omp/agent/STATE.md` carry dated records.

### Plugins

`install-plugins.sh` declares the plugin list and runs `omp install` for each entry. Every GitHub entry points at this user's own fork; an install from upstream would overwrite the customizations.

- GitHub forks: `dbydd/omp-todo-more` (decider-gated stop reminders, subagent todo install), `dbydd/omp-thinking-translator`, `dbydd/pi-hindsight` (the submodule's pushed state).
- npm: `pi-intercom`.

Nothing is pinned: GitHub URLs track the default branch, and rerunning the script may upgrade plugins. The result goes into `~/.omp/plugins/`. The script needs the network and downloads and loads third-party code. Re-run it after a hindsight merge to pick up the submodule's pushed state.

`./plugin-audit.sh` is read-only: it collects every plugin that appeared in `install-plugins.sh` since the fork-point base commit `9658fe6f`, compares the normalized names with `omp plugin list` and reports missing (install), uninstall candidates (removed from the script, still installed), kept (never declared) and in-sync. It reads only committed versions, so commit a changed plugin list before running the audit.

### Thinking translation

`omp-thinking-translator` reads its chain from `agent/thinking-translator.json` (installed to the agent root). The repository's copy is `enabled: false` with `magpie/group/fusion-flattened` as the single translator model; the machine's live copy enables it with `magpie/group/generic-writer`. Both files parse as the same schema: `enabled`, `targetLanguage`, `translatorModels` (ordered candidate chain, first entry first, next only on failure, re-read when the next message starts) and `trace`. The chain belongs to whoever edits last; a machine that enables it keeps its own copy and does not copy the repository's `false` over it.

## Maintenance notes

- **This README exists in English (`README.md`, the default) and Simplified Chinese (`README.zh-CN.md`).** Change both together, section for section, so they never disagree.
- **Adding a machine-owned file inside an extension directory is the default**: only the `.ts` modules and the shipped templates and configs listed in [Repository contents](#repository-contents) belong to the repository; the copy set above is the boundary.
- **Writing extension code**: run `bun install` first and `bun run check` before delivering; conventions in [Layout and development conventions](#layout-and-development-conventions). A newly introduced `@oh-my-pi/*` subpath must be loaded for real once from a directory without `node_modules`.
- **Helper sessions an extension creates must pass `taskDepth: 1`.** One-shot model calls go through `runHelperPrompt` in `_shared/helper-session.ts`, which already passes it; the only extension creating a session itself is `fork-task`'s shake, which passes it too. Without it the SDK treats the session as a main session, and `dispose()` tears down the global `AgentLifecycleManager`, turning every idle subagent into `Unknown agent`. Extensions that only call `completeSimple` (`task-split-check`, `task-completion-judge`) create no session.
- **After an OMP upgrade**, re-verify in a real TUI: [fork-task](#fork-task), [user-prompt-inject](#user-prompt-inject), [turn-judge](#turn-judge), [task-completion-judge](#task-completion-judge), [ctx-tool](#ctx-tool) (including post-compact injection), [ctx-tasklog](#ctx-tasklog), [bro](#bro) and [wt-tool](#wt-tool) — they depend on OMP internals (registry, session entries, hooks, host projections, the TUI and worktree dispatchers). The todo-more plugin's implementation updates happen in its own repository; this repository verifies the read protocol and consumer results.
- **After an OMP upgrade**, if a `system-prompt-replace: … found no target` warning appears when the main session starts a model turn, update `system-prompt-replace.json` to the new template text; when upstream deleted the sentence a rule rewrites, delete the rule. Also confirm the extension load order [system-prompt-replace](#system-prompt-replace) relies on has not changed.
- **Extensions that inject user messages set `attribution: "agent"`.** Otherwise it defaults to `user`, and [user-prompt-inject](#user-prompt-inject) injects them as the user's own words.
- **Before changing agent definitions** read `agent/agents/README.txt`; notes in that directory use `.txt`, never `.md`.
- **pi-side records** live in `pi/README.md` of this repository; dated records stay in the machines' `STATE.md` files.
