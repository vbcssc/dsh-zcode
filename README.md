# ZCode 模式（dsh-zcode-mode）

不改 DeepSeek Harness 源码，用一个**外部 bundle** 把 ZCode 的 agent 模式形状补到 dsh 上。
dsh 出厂的模型可见提示词只有约 3 行身份加每条工具一句描述；ZCode 在会话开场还会注入行为与
输出纪律、当前处境（平台 / 仓库状态 / 日期）、具名子代理，并在收尾时对「改了东西却没验证」
施加硬约束。这四层各用一个**已存在的扩展点**闭合：

| ZCode 有、dsh 出厂没有 | 本包用的机制 | 要写 JS 吗 |
|---|---|---|
| 身份块、安全块、`# Harness`、输出与自主性纪律 | preset 行里 `dsh-persona` 的 `config.prefix` | 否 |
| `# Environment`、`gitStatus` 快照、`# currentDate` | `SystemPrompt.context()`，provider 每次装配求值 | 是，`src/situation.js` |
| `Explore` / `general-purpose` 具名子代理 | `@deepseek-ai/dsh-tool-subagent` 行（`toolName` / `toolFilter` / `persona`） | 否 |
| 「改了文件必须有成功验证」的**硬校验** | `sessionProjections` 的持久化折叠 + `agent/turn-stopping` 上的 `agent.steer()` | 是，`src/verification-guard.js` |

模式 id 是 `zcode`，菜单名 **「ZCode 模式」**，`order: 6`。

## 为什么第四层不是提示词

「验证后再报告」写在 persona 里只是概率性遵守，而 `status: DONE` 之类的自我申报没有任何外部
核对。`verification-guard` 把它变成由运行时事实驱动的确定性检查：本轮是否成功写过文件
（`write` / `edit` 的 `tool/result` 非错误）与本轮是否有一条退出码为 0 的 shell 调用
（解析 `bash`/`pwsh` 结果里的 `[exit code: N]`；**非零退出不是工具错误**，见
`packages/shell/tool-bash/README.md`）。若前者为真、后者为假，turn 边界不关闭，守卫用
`agent.steer()` 把缺失的事实送回模型，强制多走一步。

关键实现约束：

- 事实从**已提交事件折叠**（`tool/call` 按 `callId` 与 `tool/result` 配对，因为结果事件不带
  工具名），因此 resume 后判定一致；`snapshotEvents` / `eventAt` / `ownEvents` 已对新代码禁用，
  此处不碰。
- 强制续跑有**上限**（`maxContinuations`，默认 1），计数由守卫自己的 steer 消息在折叠里数出，
  resume 不会重置。上游 hooks 桥的同类风险仍是 TODO，本插件自带该闸。
- 子代理不强制（按 `delegationDepth` 与 `options.subagentDepth` 取大者判断），以免卡住委派任务。

## 实测数字（win32，dsh r5fc6e6b5fa）

| 量 | standard | zcode |
|---|---|---|
| 装配 persona | 54 字符 | **9158** 字符（+9104） |
| 整段 system prompt | 5376 字符 | **14555** 字符（+9179） |
| boot 期可见工具 | 25 | **27**（+`subagent_explore`、+`subagent_general`、+`bash`、−`pwsh`） |
| 处境 context 段 | 无 | 3 条，空 session 时 159 字符 |
| 守卫投影 | 无 | `zcodeVerification`（host-only，随 session 落盘） |

`+9179` 的构成不是巧合，verify-mount 按**逐段集合差**在守：persona 的 `+9104`，加上 dsh
**自己**为每条具名子代理生成的 `tool:subagent_*` 指引段各 121 字符，再加上 shell 指引随门控
反转发生的互换 `tool:pwsh`(259) → `tool:bash`(92)，净 −167。子代理 persona **不**进入父
提示词（见下面「已知边界」）。

线上请求口径另算：`subagent`（spawn provider）是**惰性注册**的，boot 期不在注册表里，
装配请求时才 `mount()`，因此线上是 standard 26 / zcode 28。boot 期与线上两个数字口径不同，
不要互相引用。

## 结构

```
package.json              dsh.bundle.patch → cordis.patch.yml；exports "./situation"、"./verification-guard"
text/persona.md           主控 persona 唯一真源（9158 字符）
text/personas/{explore,general}.md   子代理 persona 真源
src/situation.js          处境插件：注册 3 条 context
src/verification-guard.js 硬校验插件：投影折叠 + turn 边界 steer
scripts/make-preset.mjs   cordis.patch.yml 的唯一写入者
scripts/layers.mjs        本包往子列表里加的行（处境行、守卫行、两条具名子代理行）
scripts/doctor.mjs        离线门：漂移 + 静态断言 + roster 门槛
scripts/verify-mount.mjs  装配门：真装真起，读活注册表
scripts/unit-situation.mjs 纯函数门：真实 git 探针 + 用出厂插值器验 braceSafe
scripts/unit-guard.mjs    纯函数门：exit-code 解析、事件折叠、steer 决策、上限
scripts/e2e-guard.mjs     端到端门：真实 Context/AgentLoop + 脚本化模型，验负控
```

## 纪律：patch 只有一个写入者

`cordis.patch.yml` 是**生成物**，不要手编。派生源是 shipped
`packages/bundle/web-app/presets/standard.patch.yml`——bundle patch 格式无继承、无深合并，
且 `config.plugins` 是整字段，所以想保留标准工具集就必须全量重述；手抄会随上游改动漂移。
生成器把改动限制在四处并逐处反证：替换 persona 的 `prefix:` 行、按 `SHELL_GATE` 反转两条
shell `disabled:` 门（`bash` 恒挂载、`pwsh` 恒不挂载，win32 因此走 Git Bash，见边界 3）、在
`delegation` group 内插入子代理行、在末尾追加本包自己的插件行。每步都做一次「把插入内容原样删除能否还原输入」
的字节等值检查，另加 `!!js` 计数与行 id 集合检查。

```sh
npm run preset      # 生成 cordis.patch.yml
npm run doctor      # 离线门（11 项）
npm run unit        # 处境层纯函数 + 花括号护栏（18 项）
npm run unit:guard  # 守卫纯函数 + 接线（35 项）
npm run e2e:guard   # 真实 AgentLoop 端到端负控（4 项）
npm run verify      # 真装真起，读活注册表（21 项）
```

安装、试用、升级、回滚与故障处置的唯一事实来源是 [INSTALL.md](INSTALL.md)，本文件不重复。

## 已知边界（不要再往外推）

1. **具名子代理的 persona 到不了父侧。** 实测：`subagent_explore` 与 `subagent_general` 的
   父可见描述是同一段出厂通用文案（各 434 字符、逐字节相同）；row 的 `persona` 在 spawn 时
   替换**子**作用域的 `deployment:persona-prefix`（`packages/subagent/subagent/src/child-agent.ts`）。
   所以主控唯一能知道「这两个子代理各干什么」的地方是 persona 里的 `# Delegation` 段——
   doctor 断言该段点名两条工具且各一次。
2. **坏 `toolFilter` 名在 boot 阶段不可见。** 负控实测：把 `web_search` 换成 `nope_tool` 后，
   `verify-mount` 的每一检查项**仍然全部通过**、27 工具照读——限制名要到子作用域应用时才由
   `tools.restrict()` 校验（`packages/core/tools/src/index.ts`，那里未知名与 `restrict({})`
   都抛错）。因此生成期的 `roster.standard.json` 门槛是**唯一**防线：它拿真实 boot 录到的
   工具名去校验即将写入的每一行，不通过就拒绝写出（改一个假名可复现：抛
   `subagent filters name tools the composition does not mount`，且 patch 哈希不变）。
3. **win32 的 `bash` 工具依赖 profile 提供的本地执行器，门只证明「挂载」不证明「能跑」。**
   反转后的 patch 恒挂 `tool-bash`，而 dsh 出厂的 `dsh-bash-sandbox` 执行器在 win32 被禁用
   （WRITE_RESTRICTED token 下 MSYS 的 `msys-2.0.dll` `CreateFileMapping` 失败）。会话真正
   有 shell 可用，需要 profile 装了直替执行器的 bundle（本机为 `dsh-git-bash`，提供
   `dsh-bash-local`，与 `standard-gitbash` 预设同一条依赖）。没有它时 ZCode 模式仍能选、
   仍能装配，但 `bash` 工具调用会失败。
4. **守卫判定的是「有没有过一次成功的 shell」，不是「那次 shell 是否真的验证了这次改动」。**
   当本轮既有 `write`/`edit`、又有一条与本改动无关且退出 0 的命令（例如 `git status`），守卫
   会判为已验证。它拦的是**完全没有验证**与**验证失败却仍报完成**这两种可观测的谎报；要判
   「验证是否切题」需要理解命令语义，那不是确定性检查能做的，别把边界往外推。
5. **`maxContinuations` 是硬上限，不是保证。** 默认 1：模型被逼问一次后仍可再次不验证就收尾，
   此时 turn 以 `completed` 正常关闭。这是刻意选择——无限续跑的代价高于一次未验证的收尾，
   上游 hooks 桥至今没有 run-level halt，也是同一取舍。
6. **守卫只认 `bash` / `pwsh` 的退出码。** 在 `run_code`（PTC）里调用的命令、后台任务
   （`started background job ...`）、被推广/超时/中断的调用都不计为验证；判定时会明确说
   「没有完成的验证」，而不是把不确定当成成功。

## 本包没有做的

- **权限模式层。** ZCode 的 plan/build/edit/yolo/guarded 差异主要是**权限策略**，不是提示词；
  动审批与沙箱默认值是行为安全面，留给单独决定。
- **输出质量证据。** 装配层数字（字符数、行数、门项）**不等于**更聪明或更少幻觉。守卫的正确性
  有端到端负控（`npm run e2e:guard`），但「整体产出是否变好」仍需在同一批任务上做双臂对比，
  本包目前没有这份数据。
