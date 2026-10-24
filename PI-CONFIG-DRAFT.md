# pi 基础配置更新草稿

> 草稿，未落地。`pi/` 目录里的四份文件是这次要审的稿子：`AGENTS.md`、`APPEND_SYSTEM.md`、`agents/` 七件、`hindsight.jsonc`。这份文档只解释它们为什么长成现在这样、跟机器上的现状差在哪、以及哪些地方需要你拍板。

## 这次要动什么

四件事。把 omp 的 context 文件融合进 pi 的两份注入文件，把 lane 定义收进仓库，配上 pi-hindsight，再把判定模型接到网关的 System One 决策组上。

判定链路是这四件里唯一有技术不确定性的部分，下面单独说。其余三件都是已知文本的搬运和改写，稿子已经写成可以直接读的样子，不用再对着编号跳来跳去。

## 一个前提变化：pi-tern 不在了

`pi-tern` 已从 `settings.json` 的 packages 里删掉，机器上也没有这个包。这个决定的理由站得住：pi 平时就是 agent 运行时，不是去驱动 Tern 面板的进程，给它配一套 terminal-driving 工具本身就不对路。

所以 omp 那节"浏览器与交互式程序必须走 Tern"的硬规则在 pi 上没有对应物，稿子把交互式程序的处境如实写成"本机没有这个工具"，并给了落地的替代路径：单独一条能跑完的命令照常跑（`ssh host 'cmd'`、`psql -c '…'`、不带 `-it` 的 `docker exec`），真需要终端时说明需要什么、请用户去跑，绝不用管道、heredoc、`expect`、`script -q` 假装一个 PTY。这样规则不会指向一个不存在的工具，也不会因为工具没了就变成"随便怎么办都行"。

## 另外两处按你的意见改了

**后台任务。** 稿子原来只说 `bg_run` 家族，漏了手动挂后台这件事。现在写清两处入口：`bg_run` 工具带 `isAgent` 标记（子 LLM 进程为 `true`，脚本、测试、服务器为 `false`），以及 prompt 里直接 `/bg --name "…" <command>`；`/tasks`、`/logs`、`/kill` 是配套的查看与收尾命令。轮询、`sleep`、`while` 明确禁止，等通知就是等待方式。

**`mentalModels.maxChars`。** 按你的意见维持 65536，不跟 omp 压到 12000。理由是不缺这点上下文窗口，而这个值越大注入的模型细节越全。稿子里的 `hindsight.jsonc` 就是 65536。

## 仓库里会多出一个 pi/ 目录

```
pi/
  AGENTS.md        风格、立场、常驻规则（omp 的 RULES.md 融在这里）
  APPEND_SYSTEM.md pi 专属的 harness 事实
  hindsight.jsonc  pi-hindsight 的配置
  agents/          七个 lane 定义
  README.md        内容表、依赖说明、同步方式（只属于仓库，不下发到机器）
```

机器侧那堆生成物——`sessions/`、`npm/`、`models-store.json`、`auth.json`、`STATE.md`、`.pi/hindsight/` 里的运行态——照旧不进仓库，README 里列了完整清单。`STATE.md` 继续留在机器侧，仓库只 carry 规则和配置。

## 三份 context 文件的合并结果

pi 没有 `RULES.md` 这个载体，也没有人格块，所以延续 2026-09-27 定下的两文件格局，写进了 `pi/AGENTS.md` 和 `pi/APPEND_SYSTEM.md`。稿子顶部有一段说明文件分工，讲清 pi 只注入两份、常驻规则住在本文件，因为读者看到的是一整块连续文本，不说清会以为是三份之一被漏了。

`AGENTS.md` 的行文顺序：文件分工 → 用户只看到最终回复 → 写作规则 → 工作姿态（含循环）→ 记录就是记忆 → 设计文档 → 派发（含 lane 表与隔离规则）→ 工具调用 → 常驻规则各节 → 纠正与自报。

omp 的 `PERSONALITY.md`（蓝色大肥鱼）**不并入 pi**，已定：pi 是 agent 运行时，不带人格预设。稿子里的行文就是按这个写的。

## 过时条目都清掉了

`APPEND_SYSTEM.md` 旧稿里记着一批已经不成立的东西，这次逐条核对并改掉：

- 版本号写的是 0.87.1，实测 `pi --version` 是 **1.3.0**。稿子现在写"跑 `pi --version` 而不是信这里的数字"，把这条旧记录自己的教训记了进去。
- Packages 清单里 `pi-mcp-adapter`、`context-mode` 都已经不在了；`pi-tern` 按你的决定删掉；补上 `@juicesharp/rpiv-todo` 和本地 checkout 安装的 pi-hindsight。
- MODEL 那节原来记着 `Explore`→generic-researcher-weak、`worker`→supercheap、`reviewer`→glm-5.3，实际 `agents/*.md` 早就换成 magpie 路由组了。稿子改成一张以真实 frontmatter 为准的表。
- `anchoredTools` 那段在安装包里查不到任何实现，删掉。
- 原来写 `grep`/`find`/`ls` "ship built-in and off"，实际本机 `pi-fff.json` 是 `override` 模式，搜索工具以 `grep` / `find` / `multi_grep` 三个名字由 FFF 提供，并且有一个 `bash-grep-guard` 扩展在挡 `bash` 里的 `grep`。稿子按真实情况写。
- `ctx_execute` 在安装的包和人家的 agent 定义里都找不到对应实现（它是 omp 的），稿子没有把它当既有能力介绍，只在工具调用一节留了一句"当前会话里有就用"。
- `contact_supervisor` 在 `@tintinweb/pi-subagents` 0.22.0 里查不到，七个 lane 定义里原本有六处引用它。这是会真的让子会话调用一个不存在的东西，已经全部改成"把问题交回调用方"的写法，`glla-orchestrator` 的 `tools:` 列表里也删了这一项。
- `agents/*.md` 的 `tools:` 还写着 `ffgrep`/`fffind`/`fff-multi-grep`，那是 `tools-and-ui` 模式下的名字；`override` 模式下实际名字是 `grep`/`find`/`multi_grep`。七个文件的工具列表和正文措辞都换成了真实名字，`Explore` 里那句用 `ls` 的示例也改掉了，因为本机 `ls` 工具是关的。

## 判定链路：接到网关的 System One 上

这部分是这次唯一真正的技术活。

**pi 这边为什么原来的路走不通。** pi 1.3.0 的 `models.json` schema 里模型条目没有 `type` 字段，分类器模型在那儿配不出来；`docs/custom-provider.md` 说 image/classifier 需要显式 discriminant 加按 api 键的实现表，那两个字段只存在于 extension 的 `ProviderConfig`。而 pi-hindsight fork 的 pi host 看不见任何分类器模型——`findPiModel` 走 `registry.find`，pi 的 `ModelRegistry.find` 只查 chat 模型，分类器得走 `findOfType("classifier", …)`。加上你定的"判定必须用决策模型、不用 chat 文本"（文本又慢又烧钱），两条老路都封死。

**网关这边的事实。** 3425 服务 `POST /v1/systemone`，带 `model: "group/decider"` 实测返回正常 noul 答案；同一模型走 `/v1/chat/completions` 被直接拒绝——decider 组只做决策，不承载对话。后端会轮换（抓到过 `clef-flash` 和 `jev-1.13-free`），组内质量大差不差，clef 兜底仍在。不需要凭证：不带 Authorization 头的裸请求就是 HTTP 200。pi 的 `models.json` 里 magpie 那个 `"apiKey": "magpie"` 是 chat 面的占位哑值，别抄进 hindsight 配置。

**现在的方案是 System One transport rung。** pi-hindsight 自己依赖 `system-one-core`（实到 0.2.1），用它的 `HttpSystemOneProvider` 直接 POST 到网关的 `/v1/systemone`，问题全部用协议的原生 `noul` 形式，判定阈值复用现有的 `decision.threshold`。代码已在 fork 的 `custom/systemone-rung` 分支上，commit `79f2500`，本机跑它的三个测试文件 26 个用例全过。

配置就写在 hindsight 那份配置里，`pi/hindsight.jsonc` 里已经写好：

```jsonc
"decision": {
  "systemOne": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:3425",
    "model": "group/decider"
  }
}
```

rung 插在 ladder 的什么位置：pi 上在文本桥之前；omp 上在宿主原生类型判定之后、文本桥之前——宿主自己的原生判定仍然优先。网关挂了就是普通的一次 failed rung，ladder 继续，最后落 `decision.fallback`，不会丢 memory。

**作用范围要说清，别误会成"整个 pi-hindsight 都换了 provider"。** 只有 automatic recall 和 retain 的判定闸门走这条路。其余——向量+关键字+reranker 检索、retain 的提取与写入、observation consolidation、mental models 生成、session import——一如既往走 Hindsight 自己的服务（`hindsight.baseUrl: http://localhost:8888`），不过 3425，不经过 `system-one-core`，也不耗判定 token。

**还有个触发前提容易踩。** rung 挂在判定模型解析之后：`decision.model` 先在 pi 的 chat registry 里解析，解析不出模型时 `backends` 首行就 `return []`，ladder 是空的，System One 根本不会被插进来。所以 `decision.model` 不能写成 pi registry 里不存在的分类器 id（比如 `magpie-decisions/group/decider`）。稿子的 `hindsight.jsonc` 里没有写 `decision.model`，走默认值 `role:judge`：pi 上没有 role 表，会回落到会话模型（`magpie/group/fusion-flattened`），这条能解析，ladder 成立，System One 才跟着进来抢在文本桥之前判定。这条可以用判定链路的 telemetry（`status` / `ladder` / `reason`）验证。

**关于 `pi-system-one` 这个插件。** 它起初被当作备选基础，实际不参与这条链路，也不提供 hindsight 需要的接口，只是 pi 侧一个面向 agent 的工具包。仓库的 pi 配置里它至多作为可选调试前端，既不读取也不承载 hindsight 的任何配置。

**机器现状。** `~/.pi/agent/hindsight.json` 里没有 `decision.systemOne` 字段，还是 `decision.model: "magpie-decisions/group/decider"`——这个 spec 在 pi 上会掉进文本桥然后被网关拒绝。所以本机判定链路现在并没有接上 System One。

## 落地顺序

先把 fork 的 `custom/systemone-rung` 合并到 `custom/main`，推进 `dbydd-omp-config/pi-hindsight` 的子模块 pin——这一步做完前，机器上改配置没有意义。

然后机器侧同步，每步先备份：`AGENTS.md` 和 `APPEND_SYSTEM.md` 覆盖，agents 七件覆盖（`worker` 的 router 保持 `fusion-worker`），`hindsight.json` 原位写进 `decision.systemOne`（先确认加载的是 `.json`，别投放一个 `.jsonc` 然后假设生效）。

最后是实测。pi 侧打开 `enabled: true` 跑一轮判定型任务，用 telemetry 确认命中的是 System One rung 而不是文本桥；再验 recall/retain 主链路（bank 归一化、写权限、tag 校验）；最后看没命中时是否干净地落回 fallback。三步都过了才写机器的 `STATE.md`。

## 没有等你拍板的了

记忆库名已定：全局仿照 omp 把稳定的 bank 列全但禁用（Alexandria 两库占位、`coding` 沉洞），带注释说明各自的启用条件与沉洞机制；`pi-agent-mem` 作为 project 别名落在草稿里。人格已定不并，`mentalModels.maxChars` 已定维持 65536。剩下全是落地动作，见上一节。

`mentalModels.maxChars` 按你的意见维持 65536，这一条不用再问。
