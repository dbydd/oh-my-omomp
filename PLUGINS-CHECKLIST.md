# 上游 install-plugins.sh 的 10 个插件：逐个是什么、本机要不要

> 每条来自各插件自己的 README（2026-10-14 读的 HEAD），不是猜的。
> `本机判定` 列写：本机（magpie 网关 + 当前 `~/.omp/plugins/` 已装 `omp-onlyne` / `@dbydd/pi-hindsight-s1enhanced` / `omp-todo-more` / `omp-thinking-translator`）拿它干什么用。
> 你要装/不装，直接改 `- [ ]`。

## 总览

| # | 插件 | 一句话 | 本机判定 |
|---|---|---|---|
| 1 | `omp-unified-exec` | 给 omp 加**常驻 shell 会话**：命令不是一次跑完就死，而是开一个 session，之后 `write_stdin` 往里写、轮询读、发 Ctrl-C/方向键；PTY 模式走 headless 终端模拟器，输出是"当前屏幕"而不是所有重绘的累加 | **装**（你已定） |
| 2 | `omp-todo-more` | 富信息 Todo：替代原生 `todo`，每条任务带 explanation，列表带 goal（objective/measure/doneWhen），保留阶段、提醒、`task:*` 子会话行为 | **装**（你已定） |
| 3 | `omp-thinking-translator` | 把可见的 assistant thinking 块**只用于显示**地翻译成另一种语言；译文只活在扩展内存里，不进 session 文件、不进下一次请求、不进 compaction | 本机已装 v0.9.1，但 `enabled: false`。上游 `thinking-translator.json` 的四个模型全不可达 → 要么改模型后启用，要么不装 |
| 4 | `pi-intercom` | 跨会话通信：给另一个 pi 会话发消息、派活、共享上下文 | omp 侧已卸载，改由 `omp-onlyne` 承担（`msg` + `onlyne://`）。pi 侧仍用 intercom：onlyne 没有 pi 集成包 |
| 5 | `@luxusai/pi-hindsight` | 记忆后端：recall/reflect/retain，本机 config.yml `memory.backend: hindsight` | 本机已装 0.13.0 且 enabled。**已在用，别动**（它不在上游 install-plugins.sh 里，是本机自己加的） |
| 6 | `pi-commandcode-provider` | 把 Command Code API（commandcode.ai）注册成一个 provider | magpie 已聚合，无第二凭据源。**不装** → 连带 `commandcode-model-spec` 扩展一起删 |
| 7 | `pi-bansos` | 免费模型 provider：一个 `bansos` provider，上游是 OpenCode Zen + KiloCode 网关，全部模型免费 | magpie 的 81 个模型已含 `opencode-zen/*-free` 十几个免费档。**不装**（除非你要用 magpie 列表之外的特定免费模型） |
| 8 | `omp-codex-image-gen` | 用已有 ChatGPT Plus/Pro Codex 登录生成/编辑 PNG，不需要 `OPENAI_API_KEY` | 依赖 Codex 付费订阅。本机 `generate_image.enabled: false`。**不装** |
| 9 | `pi-package-search` | 在 pi 内部从 npm 发现、安装 pi 包 | 元工具，装了只多一个装插件的入口。**不装** |
| 10 | `pi-schedule` | 定时动作：定时 prompt、shell 检查、通知、一次性任务、有界轮询 | 本机没有定时任务场景。**不装** |
| — | `pi-pretty-codeblocks` | TUI 里隐藏 markdown 代码栅栏同时保留语法高亮 | 纯观感。上游列表里有，本机 `composer.shape: claude`、theme dark-tokyo-night——要不要看你 |
| — | `omp-remote-build` | 每个 git worktree 在远端 Docker 主机上克隆一套构建环境（Mutagen 副本 + Komodo 容器），agent 通过 4 个 `container_*` 工具在容器里编译测试 | 上游标"可选、默认不装"：依赖太多。**不装** |

## 逐项细节

### 1. omp-unified-exec —— 常驻 shell 会话 + Tern 终端 HUD

**没有它时**：`bash` 工具一次调用一个进程，调用结束进程可能被杀（或被挂到 bg），没有"跨轮次还活着的终端"。想驱动 `ssh`、REPL、`sudo` 要密码、TUI、`git rebase -i`、dev server，只能靠 `pty: true` + `proc://<id>` 写 stdin 手搓，且 `bash` 的 pty 不支持 `write_stdin` 那套协议。

**有它时**，工具面是 `exec_command` / `write_stdin` / `set_on_exit` / `kill_session` / `list_sessions`：

- `exec_command` 起进程，在 yield 窗口内返回"到目前为止的输出" + `session_id`，**取消调用不会杀进程**；
- `write_stdin` 后续轮次往里写、轮询、发控制字节（`\x03` Ctrl-C、方向键）；
- `tty: true` 走 headless 终端模拟器（Bun 原生 `Bun.Terminal`，Bun 1.4+），所以进度条、全屏程序、重绘回来的是**当前屏幕** + 自上次调用滚出屏幕的行 + 光标位置，而不是每次重绘都追加。终端查询（光标位置、设备属性、颜色）也由模拟器回答，认终端 palettes 的程序行为跟真终端一致；
- 每个结果 tail-cap 50 KiB / 2000 行、剥终端控制符；**完整原始流写 `log_path`**，可回放；
- `on_exit: "wake"`：后台进程在没人看的时候退出，就唤醒 agent 一次；`set_on_exit` 解除；
- 渲染走 omp 自己的 bash card（命令行、输出、exit chip、error tone），ANSI TUI 和 Tern 一致；
- Tern 里有一个终端 HUD：计数器 pill、终端 sheet（每 session 一行：状态点、大小、PID、运行时长，选中看命令/状态/目录/日志路径/最新输出）、终端全屏页（彩色滚动回看、**人可以直接打字进去**、Esc 返回、Kill 结束）。HUD 只读 session，不留副本；
- 顺带装一个 CSS-only Tern 插件，把 HUD 挂到 omp pill 行上方。没有 `tern` 可执行文件时不影响非 Tern 使用。

**兼容性**：PTY 模式需要 Bun 1.4+ 或可选的 `@homebridge/node-pty-prebuilt-multiarch`；两者都没有时 `tty: false` 仍可用，`tty: true` 报缺能力。

**与上游配置的耦合**：`system-prompt-replace.json` 第 5 条、`tool-policy-nag` 的 `calls.ts` / `INTENT-policy.md` / `risk.ts` 全都在描述它的协议。你已定要装 → **这些全部保留，一条不删**，只需把 `risk.ts:261` 写死的工具名改成动态。

- [x] 装 `omp-unified-exec`（你已定）
- [ ] 装 `omp-remote-build`？默认不装（上游标可选）

### 2. omp-todo-more —— 富信息 Todo，替代原生

原生 `todo` 只有 title + status + phase；它加了两样：**每条任务的 explanation**、**列表级 goal**（`{objective, measure, doneWhen}`）。操作集不变：`init/start/done/rm/drop/block/unblock/append/view/explain`。

关键机制：当前会话分支是唯一权威。每次成功的状态 mutation 追加完整 `mouriya.omp.todo-more` snapshot 到分支，并同步宿主 TodoTracker 投影——也就是宿主原生 todo 卡片只是投影，真正的状态在插件里。reader 负责把宿主的 `user_todo_edit` 和旧原生工具结果按 title 联结回来。

**必须配**：用之前要在 config.yml 关掉原生 todo（`todo.enabled: false`），且不能同时加载旧的本地 `extensions/todo-more/`。这正是上游 `config.yml` 里 `todo.enabled: false` 的由来。

**联动**：上游的 `task-completion-judge`（交付前查 todo 有没有 pending/in_progress）、`ctx-tasklog`（todo 变更写 task log）、`ctx-tool`（重放成任务时间线）、`fork-task`（fork 时清 todo）整条链都建立在它上面。它装上，这条链才活。

- [x] 装 `omp-todo-more`（你已定）
- [x] 要不要跟上游一样 `todo.enabled: false`？默认跟上游（它接管 todo，避免两套状态）

### 3. omp-thinking-translator —— 只用于显示的 thinking 翻译

在每条可见的 assistant thinking 块下面渲染一个译文框。Tern 里是原生可折叠的 `omp.thinking` 段，跟宿主自己的 thinking 同样式；其它终端是 ANSI 框。**译文只活在扩展内存**：不写 session 文件、不进下一次模型请求、不进 compaction input。所以它对上下文零成本，纯粹是给人看的。

本机状态：v0.9.1 已装但 `enabled: false`，`thinking-translator.json` 里四个模型（`futureppo-pool/`、`commandcode/` 三个）全不可达。要启用就换 magpie 模型。

- [ ] 换模型后启用？默认换（`group/flash-vibe` 或 `opencode-zen/ling-3.1-flash-free`，都是快模型）

> 已经有了，但我们这没什么适合快速翻译的模型，先禁用放着

### 6. pi-commandcode-provider —— 第三方 provider

把 Command Code API 注册成 omp 的 provider。本机所有模型已聚合到 magpie，没有第二个凭据源 → 不装。连带扩展 `commandcode-model-spec`（修的就是它的故障）也删。

- [x] 不装
- [x] 连带删 `commandcode-model-spec` 扩展

### 7. pi-bansos —— 免费模型 provider

一个 `bansos` provider，上游是 OpenCode Zen + KiloCode 网关，模型全免费（表格里列了 muse-spark 系列等）。本机 magpie 列表已含 `opencode-zen/*-free` 11 个免费档，覆盖同一批上游 → 不装。

- [x] 不装

### 8. omp-codex-image-gen —— 用 Codex 登录生成图片

一条 PNG 生成/编辑路径（提示词生成、对 1–5 张本地图编辑），复用 OMP 已管理的 ChatGPT Plus/Pro Codex 登录，**不需要 `OPENAI_API_KEY`**。请求政策跟随 Codex CLI。本机 `generate_image.enabled: false`，没有 Codex 订阅的迹象 → 不装。

> 统一走magpie的生图mcp

- [x] 不装

### 9. pi-package-search —— 在 pi 里装 pi 包

元工具。`omp install` 已够用 → 不装。

- [x] 不装

### 10. pi-schedule —— 定时动作

定时 prompt、shell 检查、通知、一次性任务、有界轮询。本机没有定时场景（loop 类需求走 `/loop`）→ 不装。

- [x] 不装

### pi-pretty-codeblocks —— TUI 观感

隐藏 markdown 代码栅栏、保留语法高亮。不影响行为，纯显示。

> 不装，有tern提供原生渲染

- [ ] 装？默认装（上游清单里有，一行成本）
