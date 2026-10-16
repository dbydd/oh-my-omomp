本机 subagent 配置注意事项
=========================

本目录（`~/.omp/agent/agents/`）里的每个 `.md` 都会被 omp 当作 agent 定义文件解析。
本文件用 `.txt` 结尾，因为非 markdown 文件不参与扫描，可以留在这里当说明。

omp 版本：18.3.2（`omp --version` 输出 `omp/18.3.2`；源码在
`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent`）。
下面标注「本机核对」的条目来自 omp 源码，标注「作者实测」的条目来自
github.com/oh-my-omp/omp-config 作者在自己机器上的观察。
harness 文档指针：`omp://task-agent-discovery.md`、`omp://tools/task.md`、`omp://tools/wait.md`。

分层设计：一个 router 一条 lane。lane 名是标签，`model:` 里的 id 才是实际调用名，两者分开维护；
模型选择由 magpie 的路由组负责，推理强度写在定义文件里。

本机 lane = magpie 的 8 个 fusion router，每个 lane 指向 `magpie/group/<id>`（description 英文）：
- 基础四档：`labor`（苦活/批量/确定性编程，thinking low）、`engineer`（强实践/平衡点，high）、
  `theorist`（理论略大于实践/审美/方案细化，high）、`philosopher`（最强思考与理论/从零设计/科研/数学推导，max）
- 聚合两档：`fusion-worker`（labor→engineer，偏实践）、`fusion-deepthink`（theorist→philosopher，偏理论）
- 最上两档：`fusion-hierarchical`（先分实践/理论再分档）、`fusion-flattened`（平铺直接落四档之一）

已作废：`supercheap`、`generic-researcher-weak`、`generic-researcher-powerful`、`astra`、`opus-5`、
`gemini-3-8-flash`、`sonnet-5-5`（具名直连模型的 lane 与旧系列 lane 全部删除）。

omp 内置 role（`config.yml` 的 `modelRoles`）映射：
`default`→fusion-hierarchical、`task`→fusion-worker、`slow`→philosopher、`plan`→theorist、
`advisor`→fusion-deepthink、`smol`/`tiny`/`memory`/`commit`→labor、`vision`→flash-vibe（多模态）。
`task.agentModelOverrides`：`task`→fusion-worker、`sonic`→labor。

magpie 的 routing group id 只允许小写字母、数字和连字符（`magpie group set <id> id=…`
会拒绝点号），所以组名里的点会被改成连字符：`gpt-6.1-sol` → `group/gpt-6-1-sol`。
请求参数带的就会是那个连字符 id，按真实模型名过滤的 harness 规则因此失配。

`models.yml` 里的 `providers.magpie` 块由 magpie 自己重写（每次它改 provider 或组都会
重写，手改必丢；连里面的 `discovery:` 也会被抹掉）。手工加的 provider 要放成另一个顶层块
——magpie 只重写它自己那个块，别的块实测能活下来。

原来放真模型名的 `providers.direct` 块已删除：用它的具名直连 lane（`gpt-6.1-sol`、
`gemini-3.8-flash`、`GLM-5.3`、`GLM-5.3-Flash`、`grok-4.7`、
`onprs-commandcode/meta/muse-spark-1.3-contributor`）已全部作废。现在文件里唯一的手工块是
`magpie-decisions`：`api: typesafe`、`auth: none`、`baseUrl: http://127.0.0.1:3425`
（**不带 `/v1`**：typesafe wire 自己拼 `/v1/systemone`）、model `group/decider` + `kind: judge`。
它给 omp 的 judge role 提供**原生 System One** 判定后端（本机是 omlx 上的 clef 决策模型，
失败时 magpie 侧退到白嫖的 jev）。`config.yml` 的 `modelRoles.judge` 指向
`magpie-decisions/group/decider`；provider 不叫 `typesafe` 是为了不覆盖内置 TypeSafe
provider 的 baseUrl（否则将来配真 `TYPESAFE_API_KEY` 会被静默指向本地网关）。

没有这个 native 后端时 judge 也能跑：omp 的 judge role 是有凭据模型的链，会退到 chat 模型
做提示词判定（本机落到 `@tiny`）。区别在判定质量和 `find.enabled: auto` / `ttsr.judge: auto`
这类开关——它们只在 judge role 解析出 native 后端时才打开。

omp 侧的 `discovery: openai-models-list` 对这个网关是多余的：magpie 自己就会按网关目录重写
`magpie` 块，那本身就是发现机制；而且它写在 `magpie` 块里会被抹掉。

`spawns` 首项是省略 `agent` 时的静默默认。本机各 lane 的 `spawns` 首位即它自己（同级互派）。
推理强度一律写 `thinkingLevel: inherit`：omp 的 `inherit` 解析为 `ThinkingLevel.Inherit`，
`resolveThinkingLevelForModel` 对它返回 `undefined`，于是**不向网关发送任何 effort**，
由 magpie 路由组自己的 `effort=auto` + Jev classifier 逐轮判定。**不要写 `auto`**——
那会让 omp 本地再跑一次 `classifyDifficulty` 并把结果钉在请求上，覆盖 Jev。
所以**默认不传 `effort`**，让 lane 的 `inherit` 生效、由 magpie 逐轮判定。但这不是禁令：
`task.enableEffort: true`（本机保持开启）时，主 agent 派子任务传的 `effort=lo|med|hi`
按 `executor.ts:4295` 的优先级（caller effort > `:level` 后缀 > 定义文件 thinkingLevel）会**覆盖** lane 的
`inherit`，把子任务钉在一个具体档位（实测 `group/labor` 被钉成 `minimal`）。即：lane 的 `inherit`
只在调用方不传 effort 时生效。需要固定强度时才传——必须最便宜的成批活，或必须最强的从零设计。
想让 magpie 判得更准，用 `solutionSpace`（`executor.ts:445`）：它把这件事有多开放带进子会话的
auto classifier，是判定过程的输入而不是覆盖。要让 Jev 全权接管，则把 `task.enableEffort` 关掉——
本机保留开启。
`defaultThinkingLevel` 的合法值只有具体档位与 `auto`，**没有 `inherit`**（`session/settings.ts:200`），
所以主会话无法「不钉 effort」，写 `inherit` 会被静默回退成默认 `high`。
内置 `task` 与 `sonic` 由 `config.yml` 的 `task.agentModelOverrides` 映射：
`task` → `magpie/group/fusion-worker`，`sonic` → `magpie/group/labor`。
`scout`、`reviewer`、`security-reviewer` 仍在 `task.disabledAgents` 里，派发会在预检失败。

1. `spawns` 缺省时，子 agent 的 `task` 工具是死的
--------------------------------------------------
frontmatter 里既无 `tools` 也无 `spawns` 时，子会话拿到的是空的 spawn policy，
而 `task` 仍在它的工具列表里。每次调用都在预检阶段被拒：

    Cannot spawn 'mentor:default'. Allowed: none (spawns disabled for this agent)

这里有两条层次不同的规则，别混在一起：
- 解析层 backcompat：`spawns` 缺失、但 `tools` 列表含 `task` 时，归一化为 `spawns: "*"`
  （本机核对 `src/discovery/helpers.ts:351-354`；`omp://task-agent-discovery.md` 的
  「Agent definition shape」）。
- 执行层补工具：只在 `agent.spawns` 已声明、且深度未到顶时，才把 `task` 自动加进工具列表
  （本机核对 `src/task/executor.ts:3479`，整段在 `if (agent.tools)` 内）；`spawns` 未声明时
  `spawnsEnv` 是空串（同文件 `:3502-3508`），子会话的 spawn policy 因此为空。

两者都不写就得到一个死工具，提示词措辞绕不过去。所以定义文件都该显式写 `spawns`。

2. 显式 allowlist 优于 `spawns: "*"`
-------------------------------------
两种写法对「省略 `agent` 字段」的解析结果不同（本机核对 `src/task/spawn-policy.ts:53`，
`defaultAgent` 取列表首项；兜底常量 `DEFAULT_SPAWN_AGENT = "task"` 在同文件 `:2`）：

    spawns: "*"        -> 省略 agent 解析为内置 task
    spawns: a, b, c    -> 省略 agent 解析为列表首项

`"*"` 配省略字段时，省略的 `agent` 会解析到内置 `task`。显式列表白送掉这个坑，但首项要有意
选择，因为它就是静默默认。

3. `task.disabledAgents` 里的名字即使 allowlist 也无效
------------------------------------------------------
本机该列表当前为空。往里加名字后（`omp config` 或 `/agents` 面板），即使 `spawns` 允许，
预检仍会失败，表现为「这个 agent 莫名消失」（本机核对
`src/task/structured-subagent.ts:301-307`；设置本身注册于 `src/task/settings.ts:359`，
默认值是空列表）：

    Agent "task" is disabled in settings. Enable it via /agents, or use a different agent type.

派发时永远显式写 `agent`：依赖默认值会直接走进第 2 条。

4. 递归深度上限 2，孙代是叶子
------------------------------
`task.maxRecursionDepth` 默认 2（本机核对 `src/task/settings.ts:259`，负值关闭上限）。
主 agent 派出的 worker 在 depth 1，worker 派出的子在 depth 2 到顶：封顶判定在
`src/task/executor.ts:3472`（`childDepth >= maxRecursionDepth`），到顶那一层 `task` 工具被
剥离（`:3484`）、spawn policy 被置空（`:3502-3508`）；`omp://task-agent-discovery.md` 的
「Recursion-depth gating」同述。

推论：worker 可以开一层并发，交出去的每片都必须可直接执行，不能写「再拆一层」。需要三层
并存的计划，要从浅一层起步。作者实测：depth 2 的子 agent 工具列表是
read、bash、edit、eval、glob、grep、hub、web_search、write、yield，没有 `task`。

5. 只有 `yield` 一个工具的 agent 会静默丢答案
----------------------------------------------
一个定义写成 `tools: []` 时，`yield` 就是它唯一的工具。作者实测的失败链：

    把完整答案写成纯文本、没有工具调用
      -> harness 注入 "Last turn had no tool call -> session idle"
      -> 被强制补的 `yield` 什么也没带
      -> job 以 `failed (exit 1)` 结束 + "Subagent called yield with null data."

这是真的数据丢失：`agent://<id>` 里完全没有答案，父级只能偶然从 transcript 里捡回正文。
防线写在提示词里：开局答案必须装进 `yield` 载荷，任何一轮都以工具调用结束。任何被裁到只剩
`yield` 的 agent 都有这个风险。

6. `agent://` 与 `history://` 是两回事
---------------------------------------
    agent://<id>            消费通道，`yield` 载荷落在这里
    history://<id>          完整原始 transcript，显示它实际经历了什么
    agent://<id>?q=.field   从结构化结果里取一个字段

job 失败可以留下一个内容完好的 transcript 配一个空工件（第 5 条）。调试子 agent 时先读
`history://`，job 状态本身会误导。

7. job id 会过期，agent id 不会
--------------------------------
job 行是进程本地的，结算后大约五分钟就没了。之后只有 agent id 还能用：`hub` 消息、
`agent://<id>`、`history://<id>`。

8. 子 agent yield 之后仍然可达
-------------------------------
yield 让它先 idle，再 parked，`hub` 消息会带着完整上下文把它唤醒；它以新的 `yield` 作答，
这份载荷作为一条新的 task 结果回到发送方（本机核对 `src/task/executor.ts:2763`：唤醒轮的
输出由 harness 以 `replyTo: source.messageId` 转达，所以没有消息工具的 agent 也能答复）。
多轮对话就靠这个。为同一个话题重新 spawn 一个，等于把它读过的一切重买一遍。

9. plan 模式会静默改写子 agent
-------------------------------
父级处于 plan 模式时，子级被包成只读：工具裁到 read/grep/glob/web_search，spawn
policy 清空，prewalk 清空。排查派发问题时先确认自己不在 plan 模式，否则你量到的是
包装层，不是定义文件。

10. 改定义文件不需要重启
------------------------
每次派发前会重载设置并重新发现 agent，所以这里的编辑在下一次 spawn 生效。已经在跑的
子级保留启动时的提示词，活的 agent 没有热重载。

11. 名字区分大小写，先到先得
-----------------------------
project 的 `.omp/agents` 覆盖用户级 `~/.omp/agent/agents`，自定义覆盖内置，同一目录内
按文件名字典序读取，重名后来的被丢弃。`Task` 和 `task` 是两个 agent。

12. 一个坏定义不会带崩其他定义
-------------------------------
自定义 agent 文件的 frontmatter 解析失败会记一条 warning 并跳过该文件，只有内置解析
失败是致命的。后果是被你写坏的文件表现为「这个 agent 神秘消失了」，看不到报错。
去 `~/.omp/logs` 找 warning，不要在调用点等失败。

13. 别在本目录留非 agent 的 `.md`
----------------------------------
本目录每个 `.md` 都会被当作 agent 定义候选。一份普通笔记会在每次发现阶段产生：

    warn "Failed to read agent file"
    AgentParsingError: Failed to parse agent: Invalid agent field: .../<file>.md

本机核对：抛出点在 `src/task/agents.ts:115`，无 frontmatter（没有 `---` 与 `name:`）的
文件即命中。按第 12 条它只是噪音，代价是每次派发两条永久日志。笔记用 `.txt`。
