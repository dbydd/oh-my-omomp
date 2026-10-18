# omp-config

[English](README.md) | 简体中文

Oh My Pi（OMP）本机配置中可以审查、可迁移的部分，为重型编程场景定制。数据库、会话、缓存、日志、锁文件、凭据和 `models.yml` 留在本机；只属于本机的部分见[仓库内容](#仓库内容)。

- [仓库内容](#仓库内容)
- [快速上手](#快速上手)
- [设计思路](#设计思路)
- [Skills](#skills)
- [本地扩展](#本地扩展)
- [本机安装](#本机安装)
- [维护须知](#维护须知)

## 仓库内容

|路径|内容|本机位置|
|---|---|---|
|`agent/AGENTS.md`|文风、做事立场、委派与工具调用规则|`~/.omp/agent/AGENTS.md`|
|`agent/RULES.md`|每轮注入的固定短规则|`~/.omp/agent/RULES.md`|
|`agent/PERSONALITY.md`|人格与语气，只渲染进主会话|`~/.omp/agent/PERSONALITY.md`|
|`agent/config.yml`|OMP 配置：UI 行为、功能开关、模型角色|`~/.omp/agent/config.yml`|
|`agent/thinking-translator.json`|`omp-thinking-translator` 插件的配置|`~/.omp/agent/thinking-translator.json`|
|`agent/agents/`|subagent lane 定义（`*.md`）；`README.txt` 记录实测陷阱|`~/.omp/agent/agents/`|
|`agent/rules/`|原生 rules 载体的规则文件（如 `tern-session-required.md`）|`~/.omp/agent/rules/`|
|`agent/skills/`|可移植 OMP skill，每个 skill 一个目录、根上是 `SKILL.md`；目前有 [computer-use-decider](#computer-use-decider)|`~/.omp/agent/skills/`|
|`agent/extensions/`|本地扩展，每个扩展一个目录；见[本地扩展](#本地扩展)|`~/.omp/agent/extensions/`|
|`agent/extensions-last/system-prompt-replace/`|必须最后运行的扩展，作为 `config.yml` 里唯一的 `extensions` 条目按路径加载|`~/.omp/agent/extensions-last/`|
|`pi/`|pi 侧配置；见 `pi/README.md`|`~/.pi/agent/`|
|`pi-hindsight/`|git 子模块：pi-hindsight fork 源码|作为 `pi-hindsight` 插件安装|
|`install-plugins.sh`|声明插件列表并逐项 `omp install`|—|
|`plugin-audit.sh`|只读漂移检查：fork 点以来的脚本历史对比 `omp plugin list`|—|
|`package.json`、`biome.json`、`tsconfig.json`|开发工具：`bun run check` 对 `agent/**/*.ts` 跑 Biome 和 `tsc --noEmit`；`pi-hindsight` 在自己的仓库里做类型检查|—|

扩展目录里的 `.ts` 模块和仓库自带的模板、配置归仓库；那里的其他文件（`bro-settings.json`、位于实际位置的 `doc-polish.json`、本机自己加的 watchdog 与 prompt-inject 模板）归本机。

## 快速上手

新机器：

1. 按[本机安装](#本机安装)的文件集，把托管文件拷进 `~/.omp/agent/` 和 `~/.pi/agent/`。
2. 运行 `./install-plugins.sh`（需要联网；安装它声明的插件列表）。
3. 重启 OMP。上下文文件、扩展、插件在启动时加载，skill 由发现机制在下一次会话读取。

要沿用旧机器的供应商登录，拷贝 `~/.omp/agent/agent.db` 的 `auth_credentials` 表（远端侧可用 sqlite3 的 `.backup`）。

## 设计思路

### 定位

- 完整 prompt 不考虑简单小任务；小任务直接用不带这套重配置的 `omp`。
- 一切不可移植的决定留在本机。仓库只放能逐行审查的内容。

### 让 prompt 真正生效的约束

这些约束不假设模型会稳定遵循 system prompt。实际使用中，模型会选择性执行其中的规则；一旦开始绕开工具调用规范，其他约束也往往一起失效。这套配置因此同时约束副作用、检测偏离，并在运行时补充提醒。

**把写入绑定到已观察的状态。** edit 工具运行在 apply-patch 模式，拒绝改动没有读过的行（`config.yml`：`edit.mode: apply_patch`、`readLineNumbers: true`）。写操作因此绑定到实际观察过的快照。规则见 `agent/AGENTS.md` 的 `# Tool calls`。

**把 todo 与 ctx 作为一套联合工具。** todo 维护任务生命周期；模型在普通结束路径上停下而 todo 尚未完成时，todo 会要求 agent 继续，也减少因小挫折而过早询问用户。原生 todo 关闭（`todo.enabled: false`）；独立插件 `omp-todo-more`（本机的 fork）提供带 goal 和逐项 explanation 的 `todo`，保留原生提醒，并为 `task:*` worker 恢复 todo。

每次成功的 todo 修改都会被 `ctx-tasklog` 捕获；`ctx` 按这些事件重放任务的最终状态，形成不依赖模型自行总结的简短行事记录。主会话发生 compact 后，`ctx-tool` 会把这份记录连同 context 树注入新 context。

**把偏离契约的工具调用当作整体偏离的信号。** `tool-policy-nag` 检测模型是否绕开内置工具，只提醒，不拦截命令。intent 通道通过 OMP 的 JUDGE 角色判断该用哪个工具；risk 通道是确定性的，标记结果无法从命令本身看出来的调用。本机在 `disabledExtensions` 里禁用了整个扩展（`extension-module:tool-policy-nag`），代码保留给其他机器。

**用 watchdog 做独立的运行时审阅。** `watchdog-agent` 作为第三方观察者自动读取 context，按规则注入提醒；watchdog 文件里声明的选项路由到 OMP 的原生 JUDGE 后端。

**逐轮判定并直接纠正。** `turn-judge` 每轮通过 OMP 的原生 JUDGE 判断主会话的这一轮；对应选项的置信度达到阈值就直接输入预设 prompt，否则只显示判定结果。

**让顾问看到用户原话。** mentor 和 discussant 只知道派它的 agent 告诉它的东西，只能顺着转述给意见，成了回声放大器。`user-prompt-inject` 把根会话里用户自己写的 prompt 注入它们的每次模型调用，让它们拿用户的目标和约束去核对对方的计划。

**把最终回复当作唯一的交付物。** 用户看不到思考、读过的文件、工具结果和 subagent 的汇报，只看到最后一条回复。回复的正文用有主语的完整句子，第一次出现的对象先说明它是什么，每条结论旁边写出支撑它的观察。规则见 `agent/AGENTS.md` 的 `# The user sees only the final reply`。

### Context 管理

context 不只是文件内容，还包含需求、取舍、已确认的事实，以及与人类对齐过的意图。compact 会压缩这些信息，所以长程任务中的每次 compact 都是高损耗操作，应尽量避免。

- 用 grep 代替完整阅读，会让片面信息固化成错误认识。
- 把许多操作拼成一次长 bash，会扩大副作用并降低失败时的可判断性。
- 外部命令的输出量可能失控；直接用 `head` 或 `tail` 截断同样会丢失关键证据。

应优先使用工具自带的分页和默认排序，在控制输出规模的同时保留可追溯的读取边界。

**把可丢弃的工作放进 subagent context。** subagent 的 context 是可抛弃的工作分支；重要结论和证据通过 subagent IRC 返回，由主 agent 整理并写回自己的 context。丢弃的是执行过程，不是任务意图。

**由意图负责人写文档和核心代码。** 文档和核心代码是设计意图的载体，每一层的当前负责人必须亲自完成。完整规则见 `agent/AGENTS.md` 的 `# Operating stance`。

**需要完整背景时 fork context。** `fork_task` 派出初始 transcript 为调用方对话副本的 subagent（[fork-task](#fork-task)），让派工单依赖本对话已经定下的需求和决定。主 context 最终仍发生 compact 时，ctx 链路会把已记录的进度重放进压缩后的会话。

### 模型角色与判定路由

`agent/config.yml` 把 OMP 内置角色映射到 magpie 路由组；`agent/agents/` 里每个 lane 定义指向 `magpie/group/<id>` 并写 `thinkingLevel: inherit`，推理深度由网关逐轮判定，lane 不钉档位。

|角色|路由|
|---|---|
|`default`|`magpie/group/fusion-hierarchical`|
|`task`|`magpie/group/fusion-worker`|
|`slow`|`magpie/group/philosopher`|
|`plan`|`magpie/group/theorist`|
|`advisor`|`magpie/group/fusion-deepthink`|
|`smol`、`tiny`、`memory`、`commit`|`magpie/group/labor`|
|`vision`|`magpie/group/flash-vibe`|
|`judge`|`magpie-decisions/group/decider`|

`judge` 角色解析到本机的 `magpie-decisions` provider：`api: typesafe`、`baseUrl: http://127.0.0.1:3425`（不带 `/v1`，typesafe wire 自己拼 `/v1/systemone`）、model `group/decider`、`kind: judge`。provider 不叫内置的 `typesafe`，是为了将来配真 `TYPESAFE_API_KEY` 时不会被静默指到本地网关。本机这个组混用 omlx 托管的决策模型（其中有 clef-flash）和免费决策模型，请求在 100–200 毫秒内返回完整概率分布。没有原生后端时，judge 角色回退到聊天模型做提示词判定。

### Subagent 体系

subagent lane 对应 magpie 的 router；lane 名是标签，定义里的 `model:` id 才是实际调用名，两者分开维护。基础四档：`labor`（苦活与确定性工作）、`engineer`（强实践、平衡点）、`theorist`（设计与取舍）、`philosopher`（最强思考）。聚合四档：`fusion-worker`（labor → engineer）、`fusion-deepthink`（theorist → philosopher）、`fusion-hierarchical`（先分实践/理论再分档）、`fusion-flattened`（平铺直接落基础档之一）。

`agent/agents/README.txt` 记录实测陷阱：`spawns` 白名单与静默默认、`task.disabledAgents` 里的名字即使列进白名单也派不出去、递归深度上限、只有 `yield` 的 agent 会丢答案、目录里的非 agent `.md` 会被当成定义解析。非 agent 的笔记一律用 `.txt`。改动在下次派发时生效，不用重启。

## Skills

`agent/skills/` 存放可移植的 OMP skill；每个目录一个 skill，根上是 `SKILL.md`。把目录拷进 `~/.omp/agent/skills/` 即安装，下一次会话被 skill 发现机制读取。这里的 skill 在主会话和 subagent 里都可用，都不读写配置文件。

### computer-use-decider

`computer-use-decider` 为重复做同类控件选择的浏览器和桌面操作提速。agent 保留目标、要输入的文字、执行与核验；通过 OMP 的 JUDGE 路由做一次决策调用，每步只选一个已观察到的动作：从 `browser` 的 `observe()` 或 `computer` 的 AX 树构造候选，让决策模型在一次调用里同时选出动作和目标，用现有元素句柄执行，再重新观察。置信度低、选择 `inspect`、或调用失败时，该步交回 agent。

skill 正文写明适用场景、置信度阈值，以及针对页面变化和目标失效的防护规则。随附的 `scripts/decider.js` 负责构造候选和发起那次决策调用；它自己不发任何输入，也不打开任何东西。

|内容|位置|
|---|---|
|Skill 说明|`agent/skills/computer-use-decider/SKILL.md`|
|决策 helper|`agent/skills/computer-use-decider/scripts/decider.js`|
|本机位置|`~/.omp/agent/skills/computer-use-decider/`|

## 本地扩展

`agent/extensions/` 和 `agent/extensions-last/` 里的扩展修补 OMP 和插件的缺陷，或补充行为约束、上下文恢复、派发检查等能力。每个扩展一个目录，下文的 `<名字>/` 指 `agent/extensions/<名字>/`；扩展读写的配置、模板和状态文件都在它自己的目录里。

|扩展|作用|
|---|---|
|[tool-policy-nag](#tool-policy-nag)|发现用 shell/eval 代替内置工具时提醒；intent 通道走原生 JUDGE，risk 通道确定性判断|
|[watchdog-agent](#watchdog-agent)|按目标投放的第三方审查者|
|[user-prompt-inject](#user-prompt-inject)|按模板把用户原话注入指定的 subagent|
|[turn-judge](#turn-judge)|主会话每轮用原生 JUDGE 判断，达到阈值就输入预设 prompt，否则显示判定|
|[child-memory-warning](#child-memory-warning)|macOS 后代进程物理 footprint 超过 4 GiB 时通知主 UI 和 agent，包括此前已观察到的存活孤儿|
|[repo-rules](#repo-rules)|补读 `.claude/rules` 等 repo 级 rule 目录|
|`tern-tool`|注册 `tern` 工具，每次调用都必须写明 session|
|[append-system-model](#append-system-model)|按模型 / 提供商正则追加系统提示词|
|[system-prompt-replace](#system-prompt-replace)|在按路径加载的扩展里最后执行，按 JSON 规则替换 system prompt 文字，用来改写内置工具说明|
|[fork-task](#fork-task)|注册 `fork_task`：带着当前对话副本派 subagent|
|[isolation-nudge](#isolation-nudge)|多个写入者共用目录时拦一次|
|[task-split-check](#task-split-check)|拦下多主题派发和限制汇报长度的派发|
|[task-completion-judge](#task-completion-judge)|worker 交付前审一次完成度|
|[ctx-tool](#ctx-tool)|注册只读 `ctx` 工具；compact 后强制注入 `ctx` 概览和当前任务记录|
|[ctx-tasklog](#ctx-tasklog)|捕获成功的 todo / goal 修改，形成 `ctx` 的派生记录|
|[response-reading-coverage](#response-reading-coverage)|以历史基准返回来源阅读跟进的低／中／高|
|[doc-polish](#doc-polish)|`polish_doc` / `/polish-doc`：不改原意地润色文档|
|[bro](#bro)|`/bro`：把回复、文档或网页改写成易懂的解释|
|[input-polish](#input-polish)|`Ctrl+Enter` 润色输入框草稿，overlay 预览后回车发送、Esc 取消|
|[tool-description-restore](#tool-description-restore)|恢复 magpie 的 `openai-completions` wire 丢掉的工具说明|
|[wt-tool](#wt-tool)|注册 `wt` / `wt_remove`：主 agent 调用人用的 `/wt` 进入新 worktree，或检查、确认后删掉所在 worktree 回到主 checkout|
|[commandcode-model-spec](#commandcode-model-spec)|修复 `--model` 指定 commandcode 模型时的认证失败|

`agent/rules/tern-session-required.md` 是原生 rules 载体的规则文件：用 judge 拦截 `tern` CLI 的 bash 调用，并教会在 `tern` 工具不可用时的 session 必填用法。

### 目录结构与开发规范

omp 从 `~/.omp/agent/extensions/` 往下只找一层：直接放的 `*.ts`、`<目录>/index.ts`，或 `<目录>/package.json` 里声明的入口。本仓库统一用 `<目录>/index.ts`，目录名就是扩展 id；同目录的其他 `.ts` 是它自己的模块，只有一层，`_shared/` 放多个扩展共用的代码（没有 `index.ts`，omp 不会把它当扩展加载）。

|位置|放什么|
|---|---|
|`agent/extensions/<名字>/index.ts`|扩展入口，默认导出注册函数，函数名取目录名的 camelCase（如 `toolPolicyNag`）|
|`agent/extensions/<名字>/*.ts`|这个扩展自己的模块，只有一层|
|`agent/extensions/<名字>/` 里的其他文件|这个扩展读写的配置、模板和状态，用 `import.meta.dir` 定位|
|`agent/extensions/_shared/*.ts`|两个以上扩展共用的代码；没有 `index.ts`|
|`agent/extensions-last/system-prompt-replace/`|同样的结构，作为 `config.yml` 里唯一的 `extensions` 条目按路径加载，所以在所有原生发现的扩展之后运行|

`extensions/` 和 `extensions-last/` 下不直接放 `.ts`。扩展之间不互相 import，共用的代码放进 `_shared/`，用带 `.ts` 后缀的相对路径导入：

|模块|提供|
|---|---|
|`errors.ts`|`errorText`：异常转成文字|
|`messages.ts`|`textOf`、`lastAssistantText`：取消息里的文字块|
|`config.ts`|`loadJsonConfig(文件名, schema, [ctx.cwd, import.meta.dir])`：cwd 下的副本优先，无效的副本跳过并记进 `skipped`|
|`models.ts`|`resolveModelChain`、`findModel`、`splitLevel`：解析 `provider/id[:level]` 和逗号分隔的候选链，只查模型列表，不发请求|
|`helper-session.ts`|`runHelperPrompt`：在内存辅助会话里做一次模型调用，不抛异常，固定传 `taskDepth: 1`|
|`judge.ts`|`openNativeJudge`：用当前会话的配置和 OMP 角色解析器选择 JUDGE 的具体模型，仅原生 judgment API 可用，凭据由宿主提供|
|`spec-files.ts`|`discoverSpecFiles`、`parseFrontmatter`、`unquote`：查找和解析 `*-<标签>.md`|
|`task-log.ts`|task log 的路径与格式，以及 `TaskLogGoal` 模型、解析器和 formatter，`ctx-tool` 与 `ctx-tasklog` 共用|

`_shared` 只提供机制。重试、超时、节流、用户看到的措辞、失败时返回什么，都留在调用方。

代码规范，由 `bun run check`（Biome 和 `tsc --noEmit`）强制：

- **格式**：只用 Biome（tab、双引号、分号、尾逗号、行宽 140），用 `bun run format` 整理，不手调格式。
- **类型**：`tsc` strict 加 `noUncheckedIndexedAccess`，不用 `any`。`as` 只用在运行时没法检查的宿主类型上，并写一行原因；外部输入一律不用。
- **外部输入**：在边界用 `@oh-my-pi/pi-coding-agent` 导出的 `z` 或类型守卫解析一次，之后只传有类型的值。
- **状态**：有多种情形时用以 `kind` 区分的联合类型，`switch` 写全并带 `never` 分支。互相独立的事实保持独立字段。
- **错误**：预期内的失败用结果联合类型返回，异常只表示程序错误。hook 和工具不把异常抛给 omp：在入口捕获，用 `pi.logger.warn(…, { error: errorText(error) })` 记下。空的 `catch {}` 要写注释说明预期的是哪种失败。
- **主会话还是 subagent**：用 `ctx.agent.kind` 判断，不看会话文件名。
- **文件位置**：扩展自己的文件用 `import.meta.dir` 读，不用 `getAgentDir()`。
- **注入消息**：扩展替自己发的用户消息写 `attribution: "agent"`。
- **结构**：`index.ts` 开头写头注释，说明扩展做什么、注册了什么、读写哪些文件、作用范围和失败策略。只有默认导出，除非同一扩展的其他文件要用。超过约 150 行的函数拆成模块级的具名函数。
- **import**：只用 omp 宿主包根路径、Node/Bun 内置模块和相对路径。宿主包的子路径不一定能在 omp 里加载（`@oh-my-pi/pi-tui/thinking` 就加载不到），只用已经在真实 omp 会话里加载过的。

`bun run check` 用 `node_modules` 里的宿主包做类型检查，证明不了扩展在 omp 里能加载。改了扩展还要在没有 `node_modules` 的目录里真实加载一次，并在真实会话里触发改动的工具、命令或钩子。

### 行为约束

`turn-judge`、`tool-policy-nag` 的 intent 通道、`watchdog-agent` 的选项判定后端共用 OMP 的 **JUDGE 模型角色**，不各自设置 provider/model。只需配置 JUDGE 一次；该角色首选可用候选是原生 judgment API 模型时，这些功能自动参与。角色解析沿用 OMP 的候选顺序与默认值，凭据也从 OMP 取得。

角色解析出的模型没有原生后端时，相关判定用该模型做提示词解析；请求失败不提醒，也不切换后端。每次触发重新取当前会话的角色配置。

#### tool-policy-nag

`tool-policy-nag/` 只作用于主会话。它在 `tool_call` 阶段检查被监视的调用，只提醒，不拦截命令。三条通道各管一件**不同**的事，由同目录的 `tool-policy-nag.json` 分别开关，可以同时开着：

- `form` — 字符串检测：命令解析器机械地数这次调用里有几个操作本该用内置工具。
- `intent` — 意图检测：把这次调用整体交给原生 JUDGE，问它这件事该用哪个内置工具。回答的是**工具路由**问题。
- `risk` — 风险检测：确定性判断这次调用**能不能从这一行看出它会做什么**。命令又长、牵涉的外部程序又多、还有会写入的步骤时，结果没法只从命令本身推出来。

- **检查的调用**：`bash` / `bash_bg` 的命令；`exec_command` 的命令；经 `write` 写到 `xd://bash`、`xd://bash_bg`、`xd://exec_command` 的命令；`eval` 的 Python / JS 代码（risk 通道只看 shell 命令）。
- **配置** `tool-policy-nag.json`：`form: {"detector": "heuristic"}` 打开字符串通道；`intent: {"threshold": 0.5}` 声明意图通道（仓库的值，原生后端可用后自动运行）；`risk: {"minCommands": 4, "minChars": 600, "minPrograms": 3}` 打开风险通道（仓库的值）；`null` 关掉一条通道。cwd 下的文件优先于扩展目录旁的文件；每次检查调用时重读。
- **两条工具通道一次调用只发一条提醒。** `intent` 已声明、有效、启用且原生 JUDGE 可用时由它负责提醒，`form` 照常计数和记日志；不满足这些条件时由 `form` 发通用提醒。risk 通道在这个解析之前运行，不受这条约束。
- **本机禁用该扩展**：`config.yml` 把 `extension-module:tool-policy-nag` 列在 `disabledExtensions`。代码和配置留在仓库给需要的机器。

form 通道的 shell 违规分类、eval 违规正则、节奏（前三次只记录，之后每次违规调用一条 steer，每个 context 最多三条，发满停到下次 compaction）和状态键 `mouriya.omp.tool-policy-nag.state` 见 `heuristic.ts` 的实现。intent 通道每个被检查的调用发一次 `choice` 问题，12 个选项（`list`、`read`、`search`、`edit`、`write`、`move`、`eval`、`ast`、`pty`、`shell`、`mixed`、`none`）的判据在同目录 `INTENT-policy.md`；每条 `rubric` 带正面例子和取自实际误报类的反例。risk 通道在调用至少有 `minCommands` 段或 `minChars` 字符、去掉 shell 管道件后牵涉至少 `minPrograms` 个不同程序、且包含写入时触发；只读的命令归 intent 通道管。

#### watchdog-agent

`watchdog-agent/` 是按目标投放的 watchdog，由扩展目录旁或从 cwd 往上找到的 `WATCHDOG-<标签>.md` 驱动。每个文件是独立的 watchdog，各自计数、各自运行、各自封顶。扩展目录里的 watchdog 文件属于本机。

**frontmatter 字段：**

|字段|说明|
|---|---|
|`target`（必填）|`main`、agent 名（如 `task:low`）、`*`、`subagents`，或逗号分隔的列表|
|`name`、`enabled`|`name` 缺省取文件名里的标签；`enabled` 默认 `true`|
|`delivery`|`aside`（默认）、`steer`、`nextTurn`、`followUp`|
|`maxPerContext`|两次压缩之间最多提醒几次，默认不限|
|`every`|累计多少条操作后运行一次（每个工具调用或非空文字回复算 1 条），默认 30|
|`scope`|`full`（整条分支，默认）或 `window`（本 watchdog 上次得出结论之后的新消息）|
|`model`、`tools`|聊天 reviewer 后端用|
|`instructions`、`option.*`|原生 JUDGE 后端用；声明 `option.*` 即选择该后端|

**两种后端，二选一：**

- **聊天 reviewer**（默认）：用禁止加载扩展的内存会话审阅。`model` 可带 `:effort`；缺省依次尝试 `@advisor`、`advisor`、`@slow` 角色，最后用会话模型。`tools` 默认 `read`/`grep`/`glob`。正文是审阅重点；回答以 `PASS`、`OK`、`LGTM`、`NONE` 开头算通过，其他非空回答当作问题说明注入。
- **原生 JUDGE**：声明 `option.*`，模型跟随 OMP 的 JUDGE 角色。它从 transcript 和正文准则里选一个声明的选项，不调工具；注入的文字是该选项预先写好的 prompt。没有原生 JUDGE 时静默跳过。

判定选项用扁平键声明（`option.<标签>`、`option.<标签>.prompt`、`option.<标签>.delivery`、`instructions`）。未知的 `option.*` 键、给未声明选项写 prompt、空 prompt，都会让整个文件被跳过并记 warning。

**运行方式**：每条 assistant 消息推进计数；达到 `every` 立即运行，一轮结束时计数没到但有累计就补跑一次。`scope` 选 transcript；游标只在得出结论的审阅后推进，失败的审阅不动。提醒以 `<watchdog name=… severity=…>` 注入，时机按 `delivery`；排队的提醒只在内存里。设了 `maxPerContext` 时，发满后到下次压缩前不再审阅。游标和封顶状态写进 session custom entry，恢复会话、切换分支和跳转树时还原。

**斜杠命令**：`/watchdog`（列表）、`/watchdog on|off <name> [session|global]`、`/watchdog add <需求>`、`/watchdog edit <name> [改动]`、`/watchdog rm <name>`。`add` 和 `edit` 经模型分轮起草——起草、修改、用户确认后才写入——任何成功的写入碰到 `WATCHDOG-*.md` 都会立即重读并在工具结果里报告。

#### user-prompt-inject

`user-prompt-inject/` 把根会话里用户自己写的 prompt 填进 `PROMPT-INJECT-<标签>.md` 模板，注入指定 subagent 的每一次模型调用。OMP 没有现成办法：`before_subagent_spawn` 只能换模型或拦截，`before_agent_start` 在 idle 的 subagent 被 `write agent://<id>` 唤醒时不触发。

**frontmatter**：`target`（必填；agent 名或 `*`）、`name`（缺省取标签）、`enabled`。正文是关于 `user_prompt`（按时间顺序的用户 prompt 数组）的模板：`{{user_prompt[0]}}` 第一条、`{{user_prompt[-1]}}` 最新一条、`{{user_prompt[3:e]}}` 切片且 `e` 表示结尾。其他占位符写法让整个文件跳过并记 warning。

仓库的 `PROMPT-INJECT-user-goal.md` 投给 `mentor:default`、`discuss:steady`、`discuss:divergent`，用 `{{user_prompt[0:e]}}` 注入全部用户 prompt，并要求它们以用户原话为准。

**prompt 来源**：从本 subagent 沿 `ctx.agent.parentId` 在 agent registry 里往上找到主会话，按顺序读它当前分支上 `role: "user"`、`attribution: "user"`、非 `synthetic` 的消息，只取文本块；取完为空的消息（比如只有图片）不占位置。输入在 `input` 钩子和命令展开之后读取。本仓库扩展注入的消息因此都标 `agent`。

**时机**：模板在 subagent 会话开始时读取；每次 `context` 事件重新读根会话，在消息最前面加一条只用于本次请求的 developer 消息。这条消息不写进会话。文件格式错误时跳过并记 warning；找不到主会话时不注入。都失败放行。

#### turn-judge

主会话每一轮结束后，`turn-judge/` 按 `TURN-JUDGE-<标签>.md` 通过 OMP 的原生 JUDGE 判断这一轮，每个文件问一个问题。带 prompt 的选项置信度达到阈值时，把 prompt 直接作为一条用户消息输入；否则弹 info 显示判定结果。

**frontmatter**（键不区分大小写）：`name`、`enabled`、`maxChars`（默认 30000）、`option.<标签>`、`option.<标签>.prompt`、`option.<标签>.threshold`（写了 prompt 就必填，取 (0, 1]）。标签可以用中文，不能含 `.` 或空白。正文是问题，原样交给 JUDGE。少于两个选项、给未声明选项写 prompt、threshold 缺失，都会让文件被跳过。

仓库的 `TURN-JUDGE-甩锅.md` 问“模型是不是在甩锅？”，选项 `是`/`否`；`是` 的概率达到 0.5 时输入预设的提醒，让它接着做完该做的事。

**一轮**：主会话里模型自己结束（`stopReason: "stop"`）、有文字的 assistant 消息。JUDGE 收到 `{ 过去的记录: [{角色, 内容}], 本轮回复 }`：记录是按时间顺序的用户输入（`attribution: "user"`、非 `synthetic`）和 assistant 文字，超过 `maxChars` 从最早整条丢掉；回复是最后那条消息的文字，不截断。触发的选项里取概率最高的 prompt，以 `attribution: "agent"` 发出；其余文件每轮合并成一条 info。prompt 引起的那轮照样判，没有上限。文件每轮结束时重读。

#### lang-nag

`lang-nag/` 只作用于主会话。主 agent 一轮结束后，取最后一条有正文的回复的最后一段（前 200 个字符），用辅助会话问模型这段是不是目标语言；判定为否，就在用户下一条输入前面加上 `instruction`。它不改已经发出的回复。配置 `lang-nag.json` 要求 `model`、`language`、`instruction`；cwd 下的文件优先，文件属于本机。自动续写的轮次、判定失败、模型不可用都不提醒。

#### repo-rules

`repo-rules/` 补读 OMP 默认不扫描的 repo 级 rule（`.claude/rules`、`.agents/rules`、`.pi/rules`）。会话开始时从 cwd 往上扫到 git root；没有 frontmatter 或 `alwaysApply: true` 的注入正文，其余的按名字和路径列出供以后 `read`。同名规则按文件名判断，离 cwd 近的优先；正文已经出现在 system prompt 里的不重复注入。

#### append-system-model

`append-system-model/` 让追加提示词能按模型区分，而不用改写整个系统提示词。**文件**：扩展目录下的 `APPEND_SYSTEM_MODEL.md`，属于本机，一个文件写多块，每块先是 `---` 包起来的 YAML 头（`model`、`provider`，都是匹配模型 id 和提供商 id 的 JavaScript 正则），后面是正文。每次 `before_agent_start`，主会话和每个 subagent 按各自的模型把所有生效的块按文件顺序追加。每条 prompt 重新读文件。文件不存在时静默不注入；格式错误时不注入并按行号记 warning。

#### system-prompt-replace

`extensions-last/system-prompt-replace/` 对 system prompt 做文字替换。OMP 内置的提示词模板（包括工具说明）打包在程序里；本仓库打开了 `inlineToolDescriptors`，内置工具的说明拼在 system prompt 里，和 `agent/AGENTS.md` 冲突的句子只能靠改写这段文字修正。

**规则文件**：同目录的 `system-prompt-replace.json`；每条规则 `literal`、`regex` 二选一，再加 `replace`。`literal` 替换所有出现处；`regex` 自动加 `g`，按 `String.prototype.replace` 解释 `$1`。规则按文件顺序依次作用于每个 system prompt 块。文件缺失时不替换；格式错误时不替换并记 warning。某条规则的目标在主会话 system prompt 里一处都找不到时，该规则每个进程警告一次。

仓库的规则改写内置和插件工具说明：`task` 工具选 agent 的那句（“Always set \`agent\` explicitly; never rely on the default.”）、engineering 里关于重跑检查的规则、编译代码规则缺失的谓语、`eval` 工具说明末尾追加的“拒绝用 eval 调查文件”段落、`exec_command` 开头句之后插入的两段（拒绝文件调查；交互操作走 `tty: true` 与轮询指引），以及 `xd://` 设备调用说明之后追加的段落。关于某个工具怎么用的规则优先写进该工具的说明：subagent 收不到 `AGENTS.md`，但能看到工具说明。

**最后执行**：`before_agent_start` 按扩展加载顺序串行执行。加载顺序是原生发现 → hooks → 插件扩展 → `-e` 参数 → `config.yml` 的 `extensions`（按列表顺序）→ OMP 内置 inline 扩展。因此本扩展放在 `extensions/` 之外的 `extensions-last/`，并写成 `config.yml` 的 `extensions` 最后一项（当前也是唯一一项）。`extensions/` 目录内部没有排序；需要确定顺序只能靠 `extensions` 列表。

### 来源阅读充实度

#### response-reading-coverage

`response-reading-coverage/` 观察主会话的原生 `grep`、`glob`、`find`、`read` 调用，相对一个冻结的历史基准（相近已返回搜索规模的主回复）返回来源阅读跟进的**低／中／高**等级。它不衡量理解深度、引用准确性或答案质量。本机禁用它（`disabledExtensions: extension-module:response-reading-coverage`）；代码保留给其他机器。

- `S` 是一个回复窗口内搜索返回文件身份的并集；`R` 只计调用顺序上位于返回该身份的搜索之后、成功 read 的来源，整个窗口去重。先 read 后搜索、直接读取其他已知路径、目录列表和失败 read 都不给 credit。
- 成功的空搜索不增加证据、不创建评分组；没有返回文件时为**不适用**，不算低档。失败或有歧义的观测为**统计不完整**。
- 基准是从 1,283 个重建回复窗口离线拟合的冻结整数表（校准区间止于 2026-10-15）：在每个返回搜索宽度层内，`R` 的加权经验三分位定出低、高边界。运行时只用这张表，不实时重拟合。
- 报告写成 session custom entry；主会话收到一条只显示等级的 info，子 agent 向根主会话发可显示消息。扩展没有配置，也不发模型调用。

### 本地进程资源

#### child-memory-warning

`child-memory-warning/` 在 macOS 上每 250 ms 采样交互式 OMP 进程的后代。内存读 `proc_pid_rusage` 的 **phys_footprint**（包括压缩与换出内存的计账），不读 RSS。footprint 严格大于 4 GiB 时，主 UI 收到一条 warning，主 agent 收到一条归因为 agent 的消息。它只告警，不发信号。

- **归属**：PID 加内核启动时间标识进程；进程表经两遍核对后才参与祖先与进程组归属判断。已观察到的后代在 PPID 变为 1 后仍保留归属。只有观察到属于本 OMP 的后代组长后才登记进程组。
- **生命周期**：首个主会话拥有该进程的 managed timer 和 native handle；主会话切换只刷新投递 context，不清空归属。owner 主会话结束时监控结束。
- **边界**：轮询无法追溯在两次观测之间完成创建、脱离并成为孤儿、又没有已知存活组锚点的进程。非 Darwin 启动只记一条 `未启用` info，不导入 Darwin binding。初始化和采样失败记 warning，不改用 RSS。

### 派发与交付

#### fork-task

`fork-task/` 注册 `fork_task` 工具。参数沿用 `task` 的批量形式，但派出的 subagent 初始 transcript 是调用方当前对话的副本，之后才是派工单。适合派工单依赖本对话已经定下的需求、决定和材料的多步工作。

- `isolated` 默认 `true`；只调查时显式写 `isolated: false`。隔离的 subagent 结束后不能续聊。
- 每项可选 `shake: true`，对副本执行 `session.shake("elide")`：最近约 4,000 token 受保护，更早的文本工具结果、围栏代码块和大型小写 XML 元素替换成 `[shaken ~N tokens — recover: artifact://<id> (region K)]`，子代理可以 `read` 取回原文。
- `name` 会加 `_xxxx` 后缀，子代理 id 以结果为准。需要开启 `eval`（async）。

实现：调用方会话 fork 到 `$TMPDIR/omp-fork-task/<uuid>/`（继承费用清零、给未返回的工具调用补中止结果、清空 todo、追加 `<system-notice cause="fork_task">`），删掉父会话的运行时条目并让子条目挂到上一级，再把副本移到执行器要打开的子会话文件路径。这依赖 OMP 内部实现；每次升级 OMP 后都要在真实 TUI 里重新验证继承、隔离、shake 和续聊。

#### isolation-nudge

`isolation-nudge/` 在 `tool_call` 阶段检查 `task` 调用（不查 `fork_task`）：会有两个以上可写 agent 不带隔离、共用当前目录时拦下一次，提示写入者加 `isolated: true`、只调查的项写明 `isolated: false`。它不会替模型设置 `isolated`。“两个以上”包括同一批里的多个，以及之前派出、仍在运行的共享写入者。提醒按每项 `task` 文本的 sha256 记录，原样重派放行。

#### task-split-check

`task-split-check/` 在 `tool_call` 阶段用模型检查 `task` / `fork_task` 的每个派发项，有一项不合格就拦下整次调用。`split` 对派给 `task:low` / `task:free` / `task:mid` 的项判断是否把多个主题塞给一个 agent（看主题，不看文件数）；`report-limit` 对所有 `task:*` 项检查是否限制 worker 汇报的长度（字数、字符、token 上限或“简短汇报”；给交付物定长度不算）。同一项的检查合并成一次模型请求，逐行回答；25 秒中止信号封顶；判定按检查加 prompt 哈希缓存在内存；模型不可用、请求失败或超时时放行（fail-open），单个回答解析不了只放行那一项。

#### task-completion-judge

`task-completion-judge/` 在 `task:low`、`task:mid`、`task:free` 的会话里拦截交付用的 `yield`，先让模型判断切片是否真的做完。依据：派工单（最后一条 `session_init` 的 `task` prompt）、system prompt 里的共享背景、worker 自己 todo 的 goal、它最近 50 次工具调用及结果、这次提交的内容。goal 只是 worker 的复述；缩小了范围或衡量方法没做过都判 `NOT_DONE`。判 `NOT_DONE` 时拦下这次 `yield` 一次，要求继续做完并验证；判 `DONE` 后重读 todo 投影，仍有 pending / in_progress 项时也拦一次。两种退回各最多一次。放行的交付附上 `completion_judge`。模型不可用、请求失败和超时直接放行不附注（fail-open）；todo 插件不回答时记 warning 并放行。

### Context 恢复

完整模式下，`todo-more`、`ctx-tasklog` 和 `ctx-tool` 组成一条联合链路：todo 维护权威任务状态，task log 记录成功的修改调用，`ctx` 将记录重放成简短时间线，compact 后把主会话的 `ctx list` 和 `ctx show` 结果注入。task log 的路径和格式由两边共用的 `_shared/task-log.ts` 定义。

#### ctx-tool

`ctx-tool/` 注册只读的 `ctx` 工具，把当前会话、subagent registry、transcript、compaction 摘要和 task log 拼成一棵上下文树。不修改会话或文件，并负责主会话 compact 后的注入。

- `ctx list [<id>] [all=true]`：深度优先，每行一个 context，含状态、摘要和任务计数。默认只显示主会话和 `task` 子代理；mentor、discuss、trace 等其他 context 隐藏，其可见后代提升到上一级；`all=true` 全部列出。后代超过 8 个折叠成一行。
- `ctx show <id>`：handoff、`## Goal` 加 `## Tasks` 时间线。goal 是 task log 里最后一条有效的 goal-set 记录；handoff 取当前分支最新的 compaction 摘要（其他 context 取 sidecar 摘要）；时间线按 task log 的 todo 操作重放，每个任务名保留最新状态。
- 计数和时间线是从操作日志重建的近似值；按 phase 的批量操作只记一个目标，删掉从没被单独操作过的任务不会正确改动计数。
- **compact 后注入**：主会话 compact 后以 steer 消息注入 `<post-compact-ctx>` 块，内容为 `ctx list` 加主会话的 `ctx show`，5 秒内最多注入一次。subagent 会话不注入。

#### ctx-tasklog

每次成功的 `todo` / `goal` 修改后，`ctx-tasklog/` 把本地时间、工具名、操作和详情追加到 local root 下的 `task-log/<agent-id>.md`。`ctx` 只重放其中的 `todo` 事件和 todo goal 行；`goal` 事件记下来但不进计数和时间线。只读调用和失败调用不记；成功但没改变状态的调用照样记。写失败只记 warning。

### 用户工具

#### doc-polish

`doc-polish/` 注册 `polish_doc` 工具和 `/polish-doc <path…>` 命令，在不改原意的前提下重排、润色 `.md` / `.txt`。它不改源文件，而是把评审写到 `/tmp/doc-polish/<时间戳>-<文件名>/`：`review.md`（逐组“改之前 / 改之后 / 点评”）、原文副本和切分索引 `split.json`。

**三个子代理**：拆分（自己读原文，写出带起止行号的切分索引和词表）、润色（无工具，按正文不超过 5000 码点分批，返回润色文本和词表变更）、校验（无工具，逐组判断语义是否保持）。模型优先级：工具参数 > `doc-polish.json` > 当前会话模型；仓库配置设了拆分、润色模型和并发 8。所选模型不在可用列表里时立即报错、什么都不写；请求失败最多重试 3 次；润色输出解析不了时该批保留原文并在评审里标出。模型调用时评审路径作为工具结果返回；人调用 `/polish-doc` 时同样内容作为新输入交给主 agent，并附带硬性要求：必须亲自处理、每份评审完整读完。

#### bro

`bro/` 注册 `/bro` 命令，把一段内容改写成易懂的解释，在 TUI overlay 里流式显示；解释不写进主会话。

|子命令|作用|
|---|---|
|`/bro` 或 `/bro simplify`|等当前会话空闲后，解释最近一条 assistant 回复|
|`/bro simplify <text>`|解释给定的文字|
|`/bro file <path>`|解释 cwd 内的文件：文本格式直接读，`.pdf` / `.docx` / `.pptx` / `.xlsx` / `.epub` 先转成 Markdown。上限 10 MiB 和 100,000 字符，不做 OCR|
|`/bro url <url>`|抓取公网 HTML 页面后解释：只接受 HTTP(S)，最多 5 次重定向，抓取 25 秒超时，5 MiB 上限，不运行页面 JS|
|`/bro open`|重新打开上一次的解释|
|`/bro model` / `effort` / `mode`|设置模型、推理强度、模式（`brief`、`balanced`、`faithful`）|
|`/bro doctor`|检查设置、自定义 prompt、模型可用性和推理强度|

overlay 里上下键滚动；解释完整生成后 `C` 复制到剪贴板、`R` 重新生成，`Esc` 关闭。设置在扩展目录旁的 `bro-settings.json`（属于本机，加载时不存在就创建）；自定义 prompt `bro-prompt.md` 必须恰好包含一次 `{{response}}`，有效时完全替代内置模式 prompt。辅助会话不加载扩展。

#### input-polish

`input-polish/` 只作用于主会话的交互式 TUI。在输入框按配置的组合键（默认 `Ctrl+Enter`）代替回车，就用模型润色草稿。润色结果不写进输入框，而是在 overlay 里流式显示；`Enter` 用润色稿替换草稿并走原有提交路径，`Esc` 中止。空白草稿和以 `/`、`!`、`$` 开头的草稿原样通过。改写必须保留原语言、代码、路径、标识符和 `[Paste #N …]`、`[Image #N …]` 占位符；对不上的改写按失败处理、不应用。配置 `input-polish.json` 要求 `model` 和 `instruction`；`key` 可选 `ctrl+enter`（默认，需要终端能区分它和回车）或 `alt+enter`。辅助会话传 `taskDepth: 1`。

#### tool-description-restore

`tool-description-restore/` 恢复 magpie provider 的 `openai-completions` wire 丢掉的工具说明：provider 返回的 function tools 缺 description 时，它在 `before_provider_request` 用会话已注册工具的说明补上。对其他 provider 和 API 不做任何事。

### 会话迁移

#### wt-tool

`wt-tool/` 注册 `wt` 和 `wt_remove` 两个工具，让交互式 TUI 的主 agent 自己把会话移进新 worktree，用完删掉它回到主 checkout。OMP 的 `/wt` 只能由人在输入框里用，扩展 API 也没有调用内置斜杠命令的入口。

- **范围**：只在交互式 TUI 的主会话启用；subagent、`omp -p`、RPC、ACP 里都没有。两个工具默认不启用，`session_start` / `session_switch` 时加入启用列表。
- **时机**：两个工具都只登记请求并要求模型立即结束本轮；一轮真正结束（`agent_end` 且不是 `willContinue`）、会话空闲后，登记的人用命令经输入框自己的分发器执行，期间临时包住 TUI 的错误/状态/present 方法把文字回传给模型。这条命令不进人的输入历史、不清空草稿、不经过其他扩展的 `input` 钩子。
- **`wt`**：执行 OMP 内置的 `/wt`（把 checkout 分叉成带未提交改动的 linked worktree 并移入会话）。已经在 linked worktree 里时，第一次调用什么都不建，返回当前 worktree 详情加一个 `confirm` 值；带上这个值再调一次才会建。
- **`wt_remove`**：删掉会话所在的 linked worktree，把会话移到主 checkout，分支一律保留。必须调用两次：第一次是只读检查（判定 `SAFE`/`UNSAFE`/`BLOCKED`、删除会永久丢掉什么、到不了的提交、阻塞项、一个由 worktree 状态确定性哈希得到的 `confirm` 值）；第二次重新检查，值不一致或有阻塞就拒绝，然后执行人的 `/move`、确认 cwd、经 OMP 的 VCS 接口强制删除 worktree。回传写明停在哪一步。
- **拿到 TUI 实例**：扩展 API 不暴露 InteractiveMode；在 `ctx.ui.setEditorComponent` 那一次同步调用里，把原型方法换成只记录 `this` 的函数，调用完立即恢复。

### 兼容性修复

#### commandcode-model-spec

`commandcode-model-spec/` 修复用 `--model` 指定 commandcode 模型时选错 transport 或 provider、认证失败的问题。两种失败：缓存遮蔽（宿主的 `model_cache` 把 commandcode 模型记在宿主 transport 下，解析时跳过插件的 `commandcode-custom`，认证失败）和名称冲突（`google/gemini-3.5-flash-lite` 这类 id 解析到同名的无凭据内置 provider）。扩展只在 `session_start` 检查一次；当前模型的 `api` 不是 `commandcode-custom` 时，把它重新选回插件的同名模型。不注册 provider，不改默认模型。判断依据是 agent 目录下的 `commandcode-models.json`，由插件生成，读不到时缓存为空。

## 本机安装

一台机器的搭建方式是拷贝托管文件并安装插件；没拷贝的都归本机所有。

```bash
mkdir -p "$HOME/.omp/agent" "$HOME/.pi/agent"
# omp 上下文与配置
cp agent/AGENTS.md agent/RULES.md agent/PERSONALITY.md agent/config.yml \
  agent/thinking-translator.json "$HOME/.omp/agent/"
cp -a agent/agents agent/rules agent/skills agent/extensions agent/extensions-last "$HOME/.omp/agent/"
# pi 侧（见 pi/README.md；hindsight.jsonc 需要合并，见那里）
cp pi/AGENTS.md pi/APPEND_SYSTEM.md "$HOME/.pi/agent/"
cp -a pi/agents "$HOME/.pi/agent/"
./install-plugins.sh
```

说明：

- 这组拷贝整体覆盖文件。已有配置的机器上，`config.yml` 的本机字段（如 `compaction.thresholdTokens`、`theme`、本机自己加的 `disabledExtensions` 条目）和 `extensions` 的本机条目会被覆盖；拷贝后要把它们合并回去。
- `~/.pi/agent/hindsight.json` 已存在时优先于旁边的 `.jsonc`；把仓库的 `hindsight.jsonc` 合并进实际加载的那个文件，不要直接拷。
- `pi-hindsight` 插件由脚本安装而不链接到 checkout，这样本机跑的是已推送的状态；hindsight 合并后重跑 `./install-plugins.sh`。
- `models.yml`、`agent.db`、会话、缓存和日志只属于本机。本机的 `~/.pi/agent/STATE.md` 和 `~/.omp/agent/STATE.md` 放带日期的记录。

### 插件

`install-plugins.sh` 声明插件列表并逐项 `omp install`。GitHub 条目全部指向本用户自己的 fork；从上游安装会覆盖定制。

- GitHub fork：`dbydd/omp-todo-more`（decider 门控的停止提醒、subagent todo 安装）、`dbydd/omp-thinking-translator`、`dbydd/pi-hindsight`（子模块的已推送状态）。
- npm：`pi-intercom`。

所有插件都不钉版本：GitHub URL 跟随默认分支，重跑脚本可能升级插件。结果写进 `~/.omp/plugins/`。脚本需要联网，会下载并加载第三方代码。hindsight 合并后重跑它，让子模块的推送状态生效。

`./plugin-audit.sh` 只读：从 fork 点基准提交 `9658fe6f` 起收集 `install-plugins.sh` 里出现过的插件，归一后与 `omp plugin list` 对比，报告缺失（安装）、卸载候选（脚本已移除、本机还装着）、保留（从未登记）和已同步。它只读已提交的版本，改了插件列表要先提交再跑 audit。

### 思考翻译

`omp-thinking-translator` 从 `agent/thinking-translator.json`（安装到 agent 根目录）读取候选链。仓库副本是 `enabled: false`、单个翻译模型 `magpie/group/fusion-flattened`；本机实际运行的副本开启并使用 `magpie/group/generic-writer`。两个文件同一 schema：`enabled`、`targetLanguage`、`translatorModels`（有序候选链，第一项优先，失败才试下一项，下一条消息开始时重读）和 `trace`。链归最后编辑的一方所有；开了它的机器保留自己的副本，不要拿仓库的 `false` 盖上去。

## 维护须知

- **本 README 有英文（`README.md`，默认）和简体中文（`README.zh-CN.md`）两份。** 两份逐节对应、同时修改，不能互相矛盾。
- **扩展目录里新加的文件默认属于本机**：只有 `.ts` 模块和[仓库内容](#仓库内容)列出的自带模板与配置归仓库；上面的拷贝集就是边界。
- **写扩展代码**：先 `bun install`，交付前 `bun run check`，规范见[目录结构与开发规范](#目录结构与开发规范)。新引入的 `@oh-my-pi/*` 子路径要在没有 `node_modules` 的目录里真实加载一次。
- **扩展建的辅助会话必须传 `taskDepth: 1`。** 一次性的模型调用统一走 `_shared/helper-session.ts` 的 `runHelperPrompt`，它已经传了；自己建会话的只有 `fork-task` 的 shake，也传了。不传的话 SDK 把它当主会话，`dispose()` 时会销毁全局 `AgentLifecycleManager`，所有空闲 subagent 变成 `Unknown agent`。只调用 `completeSimple` 的扩展（`task-split-check`、`task-completion-judge`）不建会话，不涉及这条。
- **升级 OMP 后**，在真实 TUI 里重新验证：[fork-task](#fork-task)、[user-prompt-inject](#user-prompt-inject)、[turn-judge](#turn-judge)、[task-completion-judge](#task-completion-judge)、[ctx-tool](#ctx-tool)（含 compact 后注入）、[ctx-tasklog](#ctx-tasklog)、[bro](#bro) 和 [wt-tool](#wt-tool)——它们依赖 OMP 内部实现（registry、会话条目、钩子、宿主投影、TUI 与 worktree 分发器）。todo-more 插件的实现更新在自己的仓库完成；本仓库验证只读协议与消费者结果。
- **升级 OMP 后**，主会话开始模型回合时如果弹出 `system-prompt-replace: … found no target` 警告，就按新的模板文字改 `system-prompt-replace.json`；上游删掉了规则要改写的那句话时，删掉这条规则。同时确认 [system-prompt-replace](#system-prompt-replace) 依赖的扩展加载顺序没变。
- **注入用户消息的扩展写 `attribution: "agent"`。** 否则默认是 `user`，[user-prompt-inject](#user-prompt-inject) 会把它们当成用户原话。
- **改 agent 定义前**先读 `agent/agents/README.txt`；那个目录里的笔记用 `.txt`，不用 `.md`。
- **pi 侧的记录**在本仓库的 `pi/README.md`；带日期的记录留在各机器的 `STATE.md` 里。
