# 安装 · 升级 · 回滚 · 排障

本文件是 ZCode 模式（`dsh-zcode-mode`）**装法与处置**的唯一事实来源；模式是什么、闭合了哪三层、
装配数字与已知边界见 [README.md](README.md)，本文件不重复其结论。

## 一、装进 profile（持久）

```sh
dsh plugin --profile web add file:D:/docker_and_big_models/开源仓库-分析区/dsh-zcode
```

进 Web 界面后在预设菜单选 **「ZCode 模式」**。

- **win32 前置条件：profile 里已有直替 bash 执行器的 bundle**（本机为 `dsh-git-bash`，提供
  `dsh-bash-local`，与 `standard-gitbash` 预设共用同一条依赖）。模式把 shell 门固定反转成
  `bash` 恒挂载、`pwsh` 不挂载；没有该执行器时 `bash` 工具会挂载但调用失败（README 边界 3）。
- **必须走 `dsh plugin add`**，不要用裸 `pnpm add`：那只把包写进 `dependencies`，不会选中
  bundle，`dsh.bundle.patch` 指向的 `cordis.patch.yml` 因此永不加载。
- `file:` 安装是**硬链接**而不是复制：profile 的 `node_modules` 里那份文件与本仓库同 inode。
  因此任何「写 profile 副本」的调试动作都会写穿到本仓库。仓库内脚本一律先 `detachProfile`
  得到新 inode 再改。
- 自定义 profile 必须建在**真实 home 下**才解析得到凭据；一次性洁净 `DSH_HOME` 会在预检就停
  在 `MISSING_CREDENTIAL`，与模式本身无关。

## 二、只在一次会话上试用（不写配置）

```sh
dsh --profile web --patch ./cordis.patch.yml web
```

`--patch` 必须写在应用参数**之前**，写在后面会得到 `unknown option '--patch'`。
patch 层顺序：bundle 层 → profile 自身 `cordis.patch.yml` → home 层 → `--patch`；
`--patch` 压过 profile 层，所以试新文本**不需要重装 bundle**。

## 三、升级

```sh
npm run doctor
```

两种漂移分开报，处置不同：

| 报告 | 含义 | 处置 |
|---|---|---|
| LOCAL drift | `cordis.patch.yml` ≠ 生成器输出（手编过 patch，或改了 `text/` 没重跑） | `npm run preset` |
| UPSTREAM drift | header 记录的 `standard.patch.yml` sha 与当前 shipped 文件不符 | 对着新 checkout 跑 `npm run preset`，**再跑 `npm run verify` 并把新数字写进 README** |

UPSTREAM drift 之所以危险：预设的 `config.plugins` 是**整字段覆写**，patch 里那份全量子列表
过期时，模式可能挂载出厂标准已经不再挂的工具。

## 四、验收（改完必须过）

```sh
npm run doctor    # 离线：漂移 + 静态断言 + roster 门槛（11 项）
npm run unit      # 处境层：真实 git 探针 + 用出厂插值器验 braceSafe（18 项）
npm run verify    # 真装真起，读活注册表（18 项）
```

`npm run verify` 需要：一个 dsh 安装（脚本从 `dsh.CMD` shim 反推安装锚点，可用
`$DSH_INSTALL_ANCHOR` 覆盖）与兄弟仓库 `starfield-dsh` 的 `tests/lib/real-channel.mjs`
（复用其已复原的启动三要素，不重复推导）。这是**开发期耦合**，交付时不需要。

`npm run unit` 要能解析 `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-system-prompt`
（它用出厂插值器做真实反证）。本仓库的 `node_modules` 是指向全局 dsh store 的 **junction**，
（开发期便利，不在 `files` 里、不随包分发；换机器时重建一个 junction，或在包目录正常安装这几个
peer 即可）。运行期不需要它们被装进本包：真启动时 `src/situation.js` 的 import 由 profile 与
dsh 安装一起解析，`npm run verify` 正是在验这条路径。

重新录制工具白名单基线（升级 dsh 后要做）：

```sh
ZCODE_RECORD_ROSTER=1 npm run verify
```

写出的 `scripts/roster.standard.json` 带 `platform` 字段；跨平台不复用，
verify 在平台不符时明说跳过比较而不是误报。

## 五、回滚 / 卸载

```sh
dsh plugin --profile web remove dsh-zcode-mode
```

然后检查 profile 自己的 `cordis.patch.yml` 是否残留 `preset-zcode` / `tool-subagent-zcode-*`
的 override 行：因为 `config.plugins` 是整字段覆写、profile 层压过 bundle 层，残留行会在
重装时重新生效。**禁止手工向 `$DSH_HOME/profiles/<name>` 写文件**来「清理」——先用
`detachProfile` 那套，或走 CLI。

## 六、症状 → 根因 → 处置

| 症状 | 根因 | 处置 |
|---|---|---|
| 菜单里没有 ZCode 模式，也没有报错 | peer 版本不满足 → `evaluatePluginCompatibility` 判不过 → 整包进 `skippedBundles`（`packages/boot/app-boot/src/profile.ts`），只有一行 stderr | `npm run verify` 的最后两项专测此；把 `peerDependencies` 对齐安装实带版本（本机：cordis 4.0.4、dsh-* 0.2.0-rc.2、schemastery 3.18.4） |
| 预设存在，一选就失败 | bundle patch 层某行坏了；注意坏 child **不会**留下可读的 `broken` 行，而是 `acquireScope` 抛 `agent-preset/invalid` | `npm run verify`，它按字段独立捕获并打印 reason |
| 委派给子代理时报「unknown global tool」 | `toolFilter.allow` 写了本模式没挂的名字。本模式恒挂 `bash`、**不**挂 `pwsh`（`SHELL_GATE` 反转） | 别手编 patch；白名单名要过生成期 roster 门槛与 doctor 的两条 shell 断言。想恢复出厂 PowerShell 门，改 `SHELL_GATE` 后 `npm run preset`，不要只改 `layers.mjs` 的 `- bash` 一行 |
| win32 上 `bash` 工具一调就失败 | profile 没有直替受限 token 的 bash 执行器（出厂 `dsh-bash-sandbox` 在 win32 被禁用；模式恒挂 `tool-bash`） | 装 `dsh-git-bash` 或等效执行器 bundle；不装就别用本模式跑 shell 任务 |
| 一轮请求装配抛 `unknown prompt variable` | 有原始仓库文本未经 `braceSafe()` 进了 context | 每条 provider 出口必须过 `braceSafe()`；`npm run unit` 第 12 项就是断言不过护栏的原始 `git status` 会让请求炸 |

## 七、红线

- 不修改 dsh 源码：`deepseek-harness` 必须始终 `git status --untracked-files=no` 为空。
- 脚本不读 `.credentials.yaml`，不打印、不落盘、不把 key 作为参数传递。
- `cordis.patch.yml` 只有 `npm run preset` 能写。
- 捕获的真实请求体含使用者当轮输入，只作草稿，不入库、不外传。
