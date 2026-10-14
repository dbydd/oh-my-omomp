# oh-my-omomp 裁剪裁定单

> Base: `dbydd/oh-my-omomp`（fork of `mouriya-s-lab/oh-my-omp` @ `9658fe6`）。
> 用法：每项 `- [x]` = 已定，`- [ ]` = 待你定。改哪项，取消/勾选方框并在下面写一行意见，我按勾逐条执行。
> 本轮起 A / B / C / D / E 全部展开成可勾选项，不再有"建议"式的空白。

## 0 · 前提：本机可达性（已核实的事实，不是推测）

| 上游依赖 | 本机实际 | 后果 |
|---|---|---|
| 上游假设的 provider（`anthropic/` `openai-codex/` `bansos/` `commandcode/` `opencode-go/` `futureppo-pool/`） | `models.yml` 只有两个 provider：`magpie`（81 个模型，全是 `group/*` + `xxprovider/model`）和 `direct`（6 个）。magpie 网关 = `http://127.0.0.1:3425/v1`，`api: openai-completions`，`auth: none`，** kein key 也能跑**（已实测 `chat/completions` 返回 ok） | 所有硬编码模型绑定都要换成 magpie 可达 id。上游的 role 映射（每 tier 一个模型链）不保留——fusion 系列在网关内部自己做路由和推理深度决策 |
| judgment（Jev / typesafe） | 网关**有** `/v1/systemone` 端点（实测返回 422 `body -> state: Field required`，是 protocol 校验，说明端点活着）；但 `models.yml` 里**没有**任何 `api: typesafe` 的模型条目，本地 `judge` role 指向的 `group/decider` 在 81 个模型列表里**不存在** | Jev 通道要打开，须在 `models.yml` 加一条 `api: typesafe` 的 provider/model。不配 = 所有 judge 后端不可用 |
| `omp-todo-more` / `omp-unified-exec` | 未装（`omp plugin list` 只有 `omp-thinking-translator`(enabled:false) / `pi-intercom` / `@luxusai/pi-hindsight`） | 富 todo 链条、`exec_command` 相关规则空转 |
| 上游 agent 体系 `task:high/mid/low/free` + `discuss:*` + `mentor:default` | 本机是 `labor/engineer/theorist/philosopher/fusion-worker/fusion-deepthink/fusion-hierarchical/fusion-flattened` 8 个 magpie lane | 上游派发规则、`agents/*.md` 7 个定义、`user-prompt-inject` 的 target 全部失的 |
| 本机已有旧版平铺扩展 | `~/.omp/agent/extensions/{ctx-tool,ctx-tasklog,repo-rules,tool-policy-nag,ctx-post-compact-hint}.ts`，内容与上游现行目录版都不同 | 你已裁定：**直接覆盖** |

## 已定（你上一轮的裁定，直接执行，不再问）

- [x] 只走 magpie，provider 全部重锚；上游 role 配置（`task.*` 模型链）不保留，fusion 系列自动路由
- [x] 装 `omp-todo-more`，并追踪其更新
- [x] 装 `omp-unified-exec`
- [x] 本机遗留的 5 个平铺扩展直接覆盖，不比对
- [x] "违反规则后反复提醒的插件"不装（指上游的 lang-nag / turn-judge 这类反复 nag 的，实测效果不好——见 C4）
- [x] 删自更新链路：`omp-config-autoupdate` 扩展 + 更新器 + `.omp/commands/` 三个命令 + 轻量模式三件套 + `pi/` 状态 + `.github/workflows/` + `ci/`（本轮工作区已删）

> 关于magpie的systemone端点：这我倒确实没预料到这一茬，还以为magpie会自动插入呢，配一下。我很确定decider路由组存在，我手动配的
>
> pretty-codeblocks不用，我们用tern配omp，吃原生md渲染
>
> pi-hindsight当前用的是我们自己维护的fork，仓库里加submodule指向他：<https://github.com/dbydd/pi-hindsight/tree/main>

## A · 扩展逐项

- [x] **tool-policy-nag** — 保留。form + risk 两条本地可跑；intent 通道的 `judge: commandcode/typesafe/jev` 按你"本机决策模型走 magpie/decider"改写。注意两个插件装上后：`calls.ts` 的 `exec_command` 分支自动生效；`risk.ts:261` 提醒文案把工具名写死成 `exec_command`，本机 `bash` 触发时会说错工具名，顺手修。
- [x] **watchdog-agent** — 保留。聊天 reviewer 后端可用；Jev 后端先留空。
- [x] **turn-judge** — 重写 or 删（二选一）。两个选项：
  - **重写**：judge 指向 `magpie`，但 `openNativeJudge` 要求 `provider == "magpie"` 且 model `api` 是 judgment api——magpie 的 81 个模型全是 `openai-completions`，** `isJudgmentApi` 直接 false**。除非给 `models.yml` 加一条 `api: typesafe` 指向网关 `/v1/systemone` 的 provider，否则改不了。
  - **删**：跟 watchdog-agent 的 Jev 后端一起等 typesafe 条目落地后再加回来。
  - **我的判断：先删**。它和 lang-nag 同属"每轮结束追加判定"，你已经标了反复 nag 的不要。
- [ ] **user-prompt-inject** — 待你定 target（跟 B3 的 agent 体系绑定：投给哪几个 magpie lane）。机制保留。
- [x] **task-completion-judge** — 待你定：三个依赖现在都到位（omp-todo-more 要装、模型可换 magpie、worker 分档按 magpie lane 重写）。留 = 保留 worker 交付前自审；删 = 少一层拦截。默认建议留（它拦的是"未完成就交付"，本机 fusion lane 派发同样存在这个风险）。
- [ ] **task-split-check** — 待你定：模型可换 magpie，`split` 检查的是"多主题塞给一个 agent"，对 magpie lane 派发同样适用；`report-limit`（不许限制 worker 汇报长度）通用。默认建议留。
- [x] **isolation-nudge** — 保留。
- [x] **fork-task** — 保留（`task.eager: preferred` 已满足其 `async.enabled` 前提）。
- [x] **ctx-tool + ctx-tasklog** — 保留，直接覆盖本机旧版。上游已把 `ctx-post-compact-hint` 并入 ctx-tool，本机那个独立文件作废。
- [ ] **commandcode-model-spec** — 待你定：`pi-commandcode-provider` 不在你要装的清单里，此扩展纯空转。默认删。
- [x] **wt-tool** — 保留。
- [x] **doc-polish** — 保留；`doc-polish.json` 模型换 magpie（详细见 B6）。
- [x] **bro** — 保留；默认模型链换 magpie（详细见 B6）。
- [x] **input-polish** — 保留；`input-polish.json` model 换 magpie（详细见 B6）。
- [x] **lang-nag** — **删**（你已判：反复提醒的效果不好，不装这类）。实现是"回复语言不对就在下一条输入前加 instruction"，属反复 nag；而且你的正会话语言规则由 `AGENTS.md`/`RULES.md` 静态约束。
- [x] **repo-rules** — 保留，覆盖本机旧版。
- [x] **append-system-model** — 保留（`APPEND_SYSTEM_MODEL.md` 属本机，仓库不带）。
- [x] **extensions-last/system-prompt-replace** — 保留。第 5 条（`exec_command` 摘要插入）在装了 `omp-unified-exec` 后是活的；`xd://` 设备那条在本机 prompt 里命中；`task` 默认 agent 句等照 omp 版本逐条 verify。**不删任何一条**。
- [x] **_shared 裁剪** — 待保留项定型后自动推：`helper-session.ts` / `judge.ts` 只服务模型调用类扩展；turn-judge、task-completion-judge、task-split-check、commandcode-model-spec 若删，`judge.ts` 可能无人引用（但 watchdog 的 Jev 后端将来要用，建议保留文件）。

## B · 配置与体系

- [x] **B1 `agent/config.yml`** — 整体重锚。需要改的死项（逐条）：
  - `task.agentModelOverrides` 8 个条目（`discuss:divergent/steady`、`mentor:default`、`task:high/mid/low/free`、`sonic`、`task`）→ 全部删，改走 magpie lane 自身绑定 + `modelRoles`；只保留本机有效的 `task` / `sonic` 覆盖（若 B3 留这两个内置 agent）。
  - `todo.enabled: false` → `omp-todo-more` 装上后仍可关原生（它接管 todo）；**待你确认**是否沿用上游这个组合。
    - 确认沿用
  - `edit.mode: hashline` → 本机是 `apply_patch`，取本机值。
  - `browser.enabled: false` / `lsp.enabled: false` → 与本机 config.yml 对齐（本机 `lsp.enabled:false`、`computer.enabled:true`、`bashInterceptor.enabled:true`、`python.kernelMode: session`）。
  - `extensions` 末项保持 `~/.omp/agent/extensions-last/system-prompt-replace/index.ts`。
- [x] **B2 `agent/thinking-translator.json`** — 改写。`futureppo-pool/`、`commandcode/` 四个模型全不可达；换 magpie 可达 id（这个插件 v0.9.1 本机装着但 `enabled:false`，改完顺手 `omp plugin enable omp-thinking-translator`）。
  > 这个我们装过了

* [x] **B3 `agent/agents/`** — 待你定 agent 体系：
  - **方案 a（推荐）**：删上游 7 个定义（`task-high/mid/low/free`、`discuss-divergent/steady`、`mentor-default`），复制本机 `~/.omp/agent/agents/` 8 个 magpie lane 进仓库。`README.txt` 13 条陷阱保留（它是 harness 实测，与 lane 无关）。后果：`user-prompt-inject` 的 target 改成 `*`（所有 subagent）或指定几个 lane；`task-split-check`/`task-completion-judge` 的对象从 `task:low/mid/free` 改成对应 lane。

* [x] **B4 `agent/APPEND_SYSTEM.md`（25KB）** — 重写，这是最大的一块人工活。按你已定的：magpie lane 派发、原生/omp-todo-more、apply_patch、本机工具集、删上游 role 叙述。我在 A/B 定案后动笔，不动期间你可以继续改其它项。

> 重写具体讨论，讨论前不要去碰

* [x] **B5 `.gitignore`** — 加 `.omp/hindsight/`（本机 hindsight 队列，未跟踪）。另：`agent/models.yml` 已在忽略列表，本机那份含 API key 的 models.yml 不会被提交——但要确认仓库里的 `models.yml` 不存在（当前仓库没有，OK）。
* [x] **B6 五个扩展的 json** — 全部换 magpie 可达 id。候选（实测网关存在、且带 reasoning）：

> 全部用fusion-flattened，当前的decider实际上是跑在本机omlx上的clef-flash决策模型，跑分略超jev，无限用量。

* `doc-polish.json`：拆分用 `group/labor`、润色用 `group/fusion-flattened`、校验用 `group/theorist`（可带 `:high` effort）
* `bro/index.ts` 默认链：`group/flash-vibe, group/supercheap`（都是廉价快档）
* `input-polish.json`：`opencode-zen/muse-spark-1.3-contributor-free`（对应上游原型号的平价替代）
* `lang-nag` — 删了，json 一起删
* `tool-policy-nag.json`：intent 的 judge 改 `magpie/<typesafe-decision-model>`——**依赖 B7**
* `thinking-translator.json`：`group/flash-vibe` 或 `opencode-zen/ling-3.1-flash-free`（都是快模型，适合翻译 thinking 块）

## C · 运维与杂项

- [x] **C1 `install-plugins.sh`** — 重写为你实际要装的清单。上游 10 个 → 现在该是：`omp-todo-more`、`omp-unified-exec`、`omp-thinking-translator`、`pi-intercom`，加 `@luxusai/pi-hindsight`（本机已装、记忆后端开着）。要不要保留那段"可选默认不装"的注释块？

> 不保留，我们不专门搞轻量模式的安装

* [x] **C2 `plugin-audit.sh`** — 跟着 C1 走（它比对的就是这个脚本 + `omp plugin list --json`）。脚本改则它改。
* [x] **C3 `AGENTS.md`（49KB）** — 重写。写的全是上游仓库维护方式（更新器、双向同步、`LOCAL_CONFIG_FIELDS`/`MACHINE_LIST_FIELDS`、CI 分工、轻量模式），大部分随删除失效。保留：工具规范类章节 + `agents/README.txt` 引用的经验。你之前说会有自己的管理脚本——**脚本落定后我再写这节**，否则又写一遍错的。

> 额外的提一嘴：确信你写的是这个仓库而不是全局\~/.omp下的AGENTS.md

* [x] **C4 `README.md`（137KB）** — 重写。策略同 C3：留骨架，逐扩展的说明按 A/B 裁定结果重写。**放在最后**，等 A/B/C1-C3 全部定案。
* [x] **C5 `package.json` 等** — 保留；`name` 改 `oh-my-omomp`。`bun run check` 仍是本地检查命令。（无需你批，改名无风险）
* [x] **C6 名字/路径残留** — 全仓扫一遍 `mouriya` / `omp-config` 字样：`tool-policy-nag` 和 `watchdog-agent` 的 session entry key 是 `mouriya.omp.*`，改它会丢旧会话状态（新会话无影响）。默认改，你要留旧状态就说。

## D · 已执行（工作区内，未提交）

- [x] fork → `dbydd/oh-my-omomp`，本地 `master @ 9658fe6`
- [x] 删 `agent/extensions/omp-config-autoupdate/`
- [x] 删 `.omp/commands/`
- [x] 删轻量模式三件套
- [x] 删 `pi/agent/pi-bansos-relay-state.json`
- [x] 删 `.github/workflows/config-check.yml` + `ci/`
- [x] `.omp/hindsight/` 未跟踪
- [x] 校验：剩余 `.ts` 对已删模块 0 处引用；剩余 json/yml 全部解析通过

## E · 遗留确认（需要你拍的两个事实）

- [x] **E1 `models.yml` 要不要加 typesafe provider**：决定所有 Jev 判定通道（turn-judge、watchdog 的 judge 后端、tool-policy-nag 的 intent）能否打开。加的话形如：
  ```yaml
  typesafe:
    api: typesafe
    auth: none
    baseUrl: http://127.0.0.1:3425/v1
    models:
      - id: <网关 /v1/systemone 认的 model 名>
        kind: judge
  ```
  > 按你现在的发现来

但 `models.yml` 含 API key、按你规矩不进仓库——**这条加了也只在本机，仓库里不放**。不加就按删 turn-judge、intent 留空的方案走。

- [x] **E2 web_search / fetch 要不要**：上游备了 25 个 web provider 回退链。本机 `config.yml` 没有 web 相关配置，magpie 网关 81 个模型里也没有 web 专用条目。删回退链 = 模型不能联网搜索，只影响 `web_search` 工具可用性。

> web provider我一直用的omp自带的默认设置，所以没显式配置，不过25个webprovider？看看我们有哪些缺的可以补，目前本机有的是JINA,TAVILY,EXA,TINYFISH,FIRECRAWL,SEARCH_INFINITY和OPENALEX，不过其中有一些也通过composio提供
