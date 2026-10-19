# ZCode 模式（dsh-zcode-mode）

不改 DeepSeek Harness 源码，用一个**外部 bundle** 把 ZCode 的 agent 模式形状补到 dsh 上。
dsh 出厂的模型可见提示词只有约 3 行身份加每条工具一句描述；ZCode 在会话开场还会注入行为与
输出纪律、当前处境（平台 / 仓库状态 / 日期）与具名子代理。这三层差距各用一个**已存在的
扩展点**闭合：

| ZCode 有、dsh 出厂没有 | 本包用的机制 | 要写 JS 吗 |
|---|---|---|
| 身份块、安全块、`# Harness`、输出与自主性纪律 | preset 行里 `dsh-persona` 的 `config.prefix` | 否 |
| `# Environment`、`gitStatus` 快照、`# currentDate` | `SystemPrompt.context()`，provider 每次装配求值 | 是，`src/situation.js` |
| `Explore` / `general-purpose` 具名子代理 | `@deepseek-ai/dsh-tool-subagent` 行（`toolName` / `toolFilter` / `persona`） | 否 |

模式 id 是 `zcode`，菜单名 **「ZCode 模式」**，`order: 6`。

## 实测数字（win32，dsh r5fc6e6b5fa）

| 量 | standard | zcode |
|---|---|---|
| 装配 persona | 54 字符 | **7126** 字符（+7072） |
| 整段 system prompt | 5376 字符 | **12523** 字符（+7147） |
| boot 期可见工具 | 25 | **27**（+`subagent_explore`、+`subagent_general`、+`bash`、−`pwsh`） |
| 处境 context 段 | 无 | 3 条，空 session 时 159 字符 |

`+7147` 的构成不是巧合，verify-mount 按**逐段集合差**在守：persona 的 `+7072`，加上 dsh **自己**
为每条具名子代理生成的 `tool:subagent_*` 指引段各 121 字符，再加上 shell 指引随门控反转发生的
互换 `tool:pwsh`(259) → `tool:bash`(92)，净 −167。子代理 persona **不**进入父
提示词（见下面「三条已知边界」）。

线上请求口径另算：`subagent`（spawn provider）是**惰性注册**的，boot 期不在注册表里，
装配请求时才 `mount()`，因此线上是 standard 26 / zcode 28。boot 期与线上两个数字口径不同，
不要互相引用。

## 结构

```
package.json              dsh.bundle.patch → cordis.patch.yml；exports "./situation"
text/persona.md           主控 persona 唯一真源（7126 字符）
text/personas/{explore,general}.md   子代理 persona 真源
src/situation.js          处境插件：注册 3 条 context
scripts/make-preset.mjs   cordis.patch.yml 的唯一写入者
scripts/layers.mjs        本包往子列表里加的行（处境行 + 两条具名子代理行）
scripts/doctor.mjs        离线门：漂移 + 静态断言 + roster 门槛
scripts/verify-mount.mjs  装配门：真装真起，读活注册表
scripts/unit-situation.mjs 纯函数门：真实 git 探针 + 用出厂插值器验 braceSafe
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
npm run preset    # 生成 cordis.patch.yml
npm run doctor    # 离线门（11 项）
npm run unit      # 处境层纯函数 + 花括号护栏（18 项）
npm run verify    # 真装真起，读活注册表（18 项）
```

安装、试用、升级、回滚与故障处置的唯一事实来源是 [INSTALL.md](INSTALL.md)，本文件不重复。

## 三条已知边界（不要再往外推）

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

## 本包没有做的

- **权限模式层。** ZCode 的 plan/build/edit/yolo/guarded 差异主要是**权限策略**，不是提示词；
  动审批与沙箱默认值是行为安全面，留给单独决定。
- **输出质量证据。** 以上全部是**装配层**数字。字符数不等于更聪明；要证这一步得在同一批任务上
  做双臂产出对比。
