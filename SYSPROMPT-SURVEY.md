# 三家 system prompt 汇总（设计输入）

> 用途：给 context 合并稿提供对照材料，不进最终的三份/四份 context 文件。
> 每一条都标了出处；标 `[待]` 的是对应 digest 尚未落地。

## 一句话对照

| | 提示放在哪 | 拼装方式 | 换掉内置的代价 |
|---|---|---|---|
| **omp**（本机） | 内置块 0 + 外壳文件；`SYSTEM.md` 可整块替换 | Handlebars 模板，多数小节在 `{{#if}}` 门后 | 整块消失，含子会话分支与工具政策 |
| **DSH** | 有序 section 拼装；人格是一行 `dsh-persona` | 插件贡献 section，按 order 排序 | 换人格只换一行；`complete: true` 时人格即全部 |
| **Claude Code** | 934 个提示串平铺在一层目录里，README 清单就是索引 | 按文件打 `ccVersion`，历史另存语料级 changelog | 谈不上"换掉内置"——它本来就是拼出来的 |

## omp（本机，读的是装在 `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/` 的源码）

内置块 0 是 `src/prompts/system/system-prompt.md`，264 行，Handlebars 模板——除开头两行和 `# 5 Verify` / `Delivery` / `Critical` 的正文，其余小节几乎都在门后，所以两个会话看到的"默认提示"并不逐字节相同。自定义 `SYSTEM.md` 是**整块替换**（`src/system-prompt.ts:1004-1006`），文本被塞进只有 43 行的 `src/prompts/system/custom-system-prompt.md` 里跑；那个包装仍然渲染 skills 列表、`alwaysApplyRules`（即 `RULES.md`）、domain rules 和密钥脱敏说明（`:5-43`）。选择规则是"显式压模板、项目压用户"（`:248-273`），`~/.omp` 永远不当项目目录（`src/discovery/builtin.ts:96-104`）。

工具说明走另一条路：74 个 `src/prompts/tools/*.md` 共 960 行，各自作为工具的 `description` 随 provider schema 到达，这就是 264 行的提示能撑起 74 个工具的原因（`src/tools/read.ts:59`）。人格有专门的缝：`~/.omp/agent/PERSONALITY.md` 覆盖内置 preset，子会话永远不注入（`src/system-prompt.ts:94-120, 807-847`）。末尾 `<project-context>` 是给 prompt cache 定形状的（`:1026-1036`）。提示文本本身由 `scripts/format-prompts.ts` 机械格式化：RFC 2119 关键词加粗、ASCII 符号替换，不靠手写维护。

可吸收：**工具专属说明不进系统提示**；**条件门控**让一份模板服务多种会话；**缓存形状显式保留**。

## DSH（DeepSeek Harness）

四模式是打包进去的 agent preset，不是命令行开关，默认 `standard`（`packages/bundle/web-app/presets/<id>.patch.yml`）。

| 模式 | UI 名 | 人格文本 | 结构差异 |
|---|---|---|---|
| `standard` | Standard | `You are a coding agent powered by the {{model}} model.` | 全工具面：agent-instructions、time-context、bash/pwsh、fs、jobs、schedule、skills、goal、planning、compaction、delegation、ask-user、todo、web、present |
| `ptc` | PTC | 与 `standard` 同 | 只给 `run_code` + 一份生成的 SDK；多出 `tools:ptc-only`（order 800）与 `tools:sdk`（order 5000）两节；workflow 关闭 |
| `minimal` | Minimal | `You are a helpful software engineer assistant.` | `complete: true`——**这一行就是整份系统提示**，官方快照 47 字节；运行时上下文关掉，只剩常驻 shell、读图、压缩 |
| `cordis` | Creator | 与 `standard` 同 | 差别在能力不在文案：加 `tool-cordis`、开插件管理与市场、带四个 authoring 技能的 `description` 触发 |

提示由 `@deepseek-ai/dsh-system-prompt` 从**有序 section** 拼装；人格是一行 `dsh-persona`，注册两个 section 去 shadow 部署级的 `personaPrefix` / `personaSuffix`（order 0 与 10200）。固定开场 `You are an AI agent powered by DeepSeek Harness.` 挂 order −1000。空 section 会被丢掉，**未解析的 `{{var}}` 直接让拼装失败**——响亮报错，不是渲染成畸形文本。

可吸收：**`complete: true` 这个开关**（人格即整份提示，极简模式的极端做法）；**section 顺序显式化**；**未解析变量即报错**；**模式差异做在能力层、文案只换一行**。第三方 16 个角色 preset 也正是靠"同一份 `standard` 基线，只换 persona"这个缝做的。

## Claude Code

源是 `https://github.com/Piebald-AI/claude-code-system-prompts`（`main`，对应 Claude Code v2.1.300，2026-10-14）——它是**934 个提示串的平铺镜像**，不是一份系统提示：工具说明 235、System Prompt 180、Data 175、System Reminder 154、Agent Prompt 89、Skill 73、Tool Parameter 28，索引 token 合计 504,566。没有 `manifest.json` / `index.json` / `package.json`（都探过，全 404），README 那张清单本身就是索引。上游自己的说法是 Claude Code 并不只有一份系统提示串：很大一部分按环境与配置条件加载，内置工具各自带（有时很长的）说明，内置 agent 有独立提示，压缩、生成 CLAUDE.md 这类工具也各有一份。

形状上有两点值得知道。**碎片是一等公民**：127 个文件正文不到 300 字符，35 个不到 100，最短的一个 14 token，就是一句"Your responses should be short and concise."——存的是零件，不只是整篇。**模板化反而是少数**：495/934 完全字面，替换数中位数为 0，最活的 System Reminders 也只有 24% 是字面。版本是**按文件盖 `ccVersion`**，同一份快照里从 2.1.53 铺到 2.1.300（活到最久的文本是 2.0.14），历史另在语料级 changelog 里，里面 313 个版本标题、806 个 `**NEW:**` / 259 个 `**REMOVED:**`。

技法里我们还没有、值得抄的四条：

| 技法 | 逐字引用 | 落到我们哪一节 |
|---|---|---|
| 最终消息是本轮的 API | `Everything the user needs from this turn, including answers, summaries, findings, conclusions, and deliverables, must be in the final text message of your turn, with no tool calls after it.` | 用户只看到最终回复 |
| 风格层自己声明优先级 | `Where these rules conflict with more general communication or formatting guidance elsewhere in your instructions, these rules win.` | 写作规则 |
| 收尾自检 | `Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls.` | 自主与停止 |
| 失败排在报告最前 | `Never quietly work around a failure in a way that makes it look resolved; a problem the user can see is recoverable, one your summary hides is not.` | 纠正与自报 |

已经吻合、不用抄的：委派成本模型（他们 `system-prompt-subagent-delegation-cost-guidance.md` 里"写不出清楚的简报，说明你还没懂到能交出去"和我们「派发」一节几乎同义）、子会话摘要的 trust-but-verify、动作安全里的同意栏与"拒绝只用于真正有害或明确被禁止的请求"。

他们最强的一件是独立的**安全监视器**提示：换另一个模型当岗，带威胁模型、默认放行、把 HARD BLOCK（不可清除）和 SOFT BLOCK（可被意图清除）分开、显式列出不归它管的范围（"捏造或错报结果……烂代码、错答案、打转、烧 token"），输出还是可解析的框架。里面那句 `Naming the enclosing task is not naming the destructive step.` 是把"动手点上再确认"说得最利落的版本。

## 对我们的三条结论

1. **人格与能力分离**（DSH 那条缝）：人设与语气走 `PERSONALITY.md`，能力与编排留在内置块 0 与 `RULES.md`；换人设不动能力，也不碰系统提示。
2. **工具专属说明单独走**：系统提示只放跨工具的政策与编排，具体工具的长说明留给工具自己的 description。
3. **规则按能单独替换的零件存**（Claude Code 的做法）：一条规则一个文件或一节，改一条不动其他——他们 934 个文件里有 127 个短于 300 字符，最短的就是一句话。

## 源

- omp：安装包源码，逐处 `path:line` 见 `/private/tmp/sysprompt-research/omp.md`（352 行）。
- DSH：`https://github.com/deepseek-ai/deepseek-harness`（pin 到 `86a4022`，v0.2.1-alpha.4）+ npm `@deepseek-ai/dsh`，逐处出处见 `/private/tmp/sysprompt-research/dsh.md`。
- Claude Code：`https://github.com/Piebald-AI/claude-code-system-prompts` @ `main`（v2.1.300），逐处出处与限制见 `/private/tmp/sysprompt-research/claude-code.md`（16.8 KB）。
