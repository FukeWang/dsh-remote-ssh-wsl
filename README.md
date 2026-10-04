# DSH 远程 SSH / WSL 接入指南

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加上**远程 SSH 开发**和 **WSL 工作区**能力的选型、安装、验证与排坑记录。

> 结论先说：这两类能力**都已经有现成插件**，不需要自己写。本文记录的是「选哪个、怎么装、怎么在重启前就确认不会把 DSH 搞挂、以及踩到的坑」。

[English summary ↓](#english-summary)

---

## 目录

- [0. 先搞懂 DSH 的插件机制](#0-先搞懂-dsh-的插件机制)
- [1. WSL：dsh-wsl-workspace](#1-wsldsh-wsl-workspace)
- [2. 远程 SSH：三个候选怎么选](#2-远程-ssh三个候选怎么选)
- [3. 安装](#3-安装)
- [4. 验证：重启前确认不会启动失败](#4-验证重启前确认不会启动失败)
- [5. 已知坑](#5-已知坑)
- [6. 回滚](#6-回滚)
- [附：工具用法](#附工具用法)

---

## 0. 先搞懂 DSH 的插件机制

理解这四点，后面所有判断都顺了。

**① 插件 = npm 包 + 一个 Cordis 补丁文件。**

一个 DSH 插件就是一个普通 npm 包，`package.json` 里声明：

```jsonc
{
  "main": "lib/index.js",          // 导出 Cordis 插件：export function apply(ctx, config)
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // 补丁层
    "client": { "platform": "web", "inject": [...] } // 浏览器半边（可选）
  }
}
```

`cordis.patch.yml` 是一个顶层 YAML 数组，两种写法：

```yaml
# 纯新增（安全）
- insert:
    - id: my-plugin
      name: my-package-name

# 覆盖 / 禁用已有行（危险，注意 blast radius）
- id: directory-picker
  name: '@deepseek-ai/dsh-host-directory-picker-auto'
  disabled: true
```

按 `id` + `name` 递归匹配，匹配不到只告警不报错。

**② Profile 由「有序的 bundle 层」组合而成。**

每个 profile 在 `$DSH_HOME/profiles/<name>/` 下有自己的 `package.json`：

```jsonc
{
  "dependencies": { "my-package-name": "^1.0.0" },
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "my-package-name"          // ← 追加在最后
  ]}}
}
```

组合顺序：`dsh.profile.bundles` 里各 bundle 的补丁 → profile 自己的 `cordis.patch.yml` → `--patch` 覆盖层。**后写的赢**。所以新装的 bundle 追加在末尾，优先级最低，不会意外盖掉已有配置。

**③ 安装推荐的官方入口是 `dsh plugin`，它会自动维护 bundles。**

```bash
dsh plugin --profile <name> add <package>
```

它内部就是「在该 profile 目录跑 pnpm」+ 一步 `reconcile`：把新装的、且 `package.json` 里声明了 `dsh.bundle` 的依赖自动 `push` 进 `dsh.profile.bundles`；没声明 bundle 的只当普通依赖装（打一条 warning）。整个过程会快照 `package.json` / `pnpm-lock.yaml`，失败时回滚。

> 也可以走 GUI：侧边栏 **Plugins** 页可以做同样的事，并且会做版本兼容校验。

**④ ⚠️ 最关键的一点：DSH 对插件行是 fail-loud。**

任何一行插件加载失败，**整个 profile 都起不来** —— GUI 直接白屏/不启动，而不是「少个功能」。源码在 `dsh-app-boot`：

- `loadProfileDirectory()`：listed bundle 找不到、或 `package.json` 里没声明 `dsh.bundle` → 立刻抛错。
- `assertEntriesLoaded()` / `assertEntriesActivated()`：有行 FAILED/PENDING → 抛错，进程 exit 1；浏览器半边同理（`web boot: N entries did not activate`）。

**所以装插件前先离线验证组合，是本文最重要的一条实践** —— 见 [第 4 节](#4-验证重启前确认不会启动失败)。

---

## 1. WSL：`dsh-wsl-workspace`

**发行版**：`dsh-wsl-workspace`（[GitHub](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace)）· 本项目验证于 `0.7.5`

VS Code Remote-WSL 的体验：从 GUI 里直接添加一个 WSL 工作区，整个会话（bash + 文件工具）都跑在 WSL 发行版里，**WSL 内部不需要安装任何东西**（它通过 `\\wsl.localhost\<distro>\...` 的 9P UNC 共享读写文件，通过 `wsl.exe -d <distro> --cd <path> -e bash -lc` 执行命令）。

**为什么选它**：唯一成熟的 WSL 工作区插件，`dsh.compatibility.dshReleases` 里明确列了对应版本 = `compatible`；零 npm 依赖（peer 全是 `*`）；补丁**纯新增**一行：

```yaml
- insert:
    - id: wsl-workspace
      name: 'dsh-wsl-workspace'
```

**前置条件**：Windows + WSL2 + 至少一个发行版；Node 24+；WSL 内无需安装任何东西。

**用法**：Settings 旁出现 **W 按钮** → 选发行版、选/填 Linux 路径 → Create & open。之后该会话直接用 WSL 的 bash 与读写编辑，路径是 Linux 路径，Windows 文件在 `/mnt/<盘符>`。模式选择器里会多出 `WSL · <mode>` 变体。

---

## 2. 远程 SSH：三个候选怎么选

生态里有 **3 个** SSH 插件，能力差别很大，选错代价很高。

| 插件 | 版本 | 实现 | 补丁 | 结论 |
|---|---|---|---|---|
| **`dsh-ssh-remote`** | 0.1.3 | 系统 `ssh` + ControlMaster | 纯新增 | ✅ **推荐** |
| `dsh-plugin-ssh` | 0.1.0 | 进程内 `ssh2` | 纯新增 | ⚠️ 备选（需装 `ssh2`） |
| `dsh-ssh` | 0.3.0-pre | 进程内 `ssh2` | **禁用 + 覆盖** | ❌ **不要装** |

### ✅ `dsh-ssh-remote`

零 npm 依赖，全部走系统 `ssh` / `scp` / `tar` + ControlMaster 连接复用。补丁只新增一行，注入的是 `tools` / `webServer` / `systemPrompt` 这些必定存在的服务；客户端只占用 `settings.section` 与 `conversation.session.header.utilities` 两个插槽，目录选择器用 `priority: -1` 注册，**把位置让给内置实现，不抢**。

提供工具：`ssh_hosts` / `ssh_run` / `ssh_read` / `ssh_write` / `ssh_edit` / `ssh_glob` / `ssh_grep` / `ssh_push` / `ssh_pull` / `ssh_status` / `ssh_target`，并在系统提示里注入一段 SSH 使用指引。

### ❌ `dsh-ssh` 为什么不能装

它能力最全（ProxyJump 链、SFTP 文件系统、PTY 终端、接管「添加工作区」流程），但装上去会**把 DSH 弄挂**：

1. **重复注册服务直接抛错**。它的 `apply()` 会挂载 `SshFileSystem` / `SshSubprocessRuntime`，这两个类的基类分别注册 `ctx.fs` 和 `ctx.subprocess` —— 而这两个服务**已经**被 `dsh-base` 注册了，它的补丁却**没有**禁用原来那两行。Cordis 的 `provide` 遇到重复注册会抛 `service "<n>" has been registered`，该行加载失败 → 整个 profile 起不来。
2. **禁用了正在工作的目录选择器**。补丁把 `@deepseek-ai/dsh-host-directory-picker-auto` 设成 `disabled: true`，而它自己的替代客户端声明了 `@deepseek-ai/dsh-client-runtime` —— 这个包在安装里**根本不存在**。结果是「添加工作区」的能力可能直接消失。
3. 接口漂移：它的 `ctx.fs` 实现缺 `readByteRange`，而 `dsh-api-workspace-files` 会调用它。

### ⚠️ `dsh-plugin-ssh`

补丁纯新增，注入的 5 个服务都核实存在，API 签名也对得上。代价是需要额外装 `ssh2`，且 peer 范围写的是比新版本线更旧的版本。**它的价值在于**：走进程内 `ssh2` 库，**密码认证不依赖 `SSH_ASKPASS`，因此在 Windows 上可用** —— 见 [已知坑 ①](#-已知坑)。

---

## 3. 安装

```bash
# WSL
dsh plugin --profile <profile> add dsh-wsl-workspace

# 远程 SSH（推荐方案）
dsh plugin --profile <profile> add dsh-ssh-remote
```

装完检查 `dsh.profile.bundles` 是否已自动追加：

```bash
cat "$DSH_HOME/profiles/<profile>/package.json"
```

> **Desktop 版注意**：桌面版的 `desktop` profile 由 Electron 独占管理，`dsh --profile desktop --dump-config` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），但 `dsh plugin --profile desktop add ...` 这类包操作是放行的 —— 桌面版的 CLI 启动时就带了 `manageDesktopProfile: true`。

---

## 4. 验证：重启前确认不会启动失败

因为 [fail-loud](#0-先搞懂-dsh-的插件机制) 的存在，**装完先离线复刻一遍组合**，比直接重启安全得多。

[`tools/compose-profile.mjs`](tools/compose-profile.mjs) 用**与宿主完全相同**的模块（`app.asar` 里的 `dsh-app-boot`）、完全相同的安装锚点，重放 `loadProfileDirectory` + `composeEntries`，但不启动任何服务器：

```powershell
# Windows
$env:ELECTRON_RUN_AS_NODE="1"
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
    tools/compose-profile.mjs --profile desktop --grep "wsl|ssh"
```

```bash
# macOS
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
    tools/compose-profile.mjs --profile desktop --grep "wsl|ssh"
```

预期输出：

```
bundles        : 7 (application order)
  - @deepseek-ai/dsh-base
  - @deepseek-ai/dsh-web-app
  ...
  - dsh-wsl-workspace
  - dsh-ssh-remote
composed rows  : 192
  enabled   wsl-workspace  =  dsh-wsl-workspace
  enabled   ssh-remote  =  dsh-ssh-remote

OK: bundle list and every patch layer composed cleanly — boot will not fail on composition.
```

**必须看到 `OK:` 那行。** 任何 `LOAD FAILED` / `COMPOSE FAILED` 都意味着重启后 GUI 起不来。

### 运行时探针

装完后两个插件会**热挂载**（新建 bundle 在 live profile 上会重新组合，不需要重启）。用插件自己的接口确认它真的活了：

```bash
# WSL：列发行版 + 列真实目录（能列出内容 = 9P 共享通了）
curl -s -X POST http://127.0.0.1:<port>/wsl-workspace/api \
  -H 'content-type: application/json' \
  -d '{"method":"listDistros"}'
# → {"ok":true,"value":["Ubuntu"]}

curl -s -X POST http://127.0.0.1:<port>/wsl-workspace/api \
  -H 'content-type: application/json' \
  -d '{"method":"listDir","params":{"distro":"Ubuntu","path":"/home"}}'
# → {"ok":true,"value":{"path":"/home","parent":"/","entries":[...]}}
```

SSH 则直接看工具返回：`ssh_hosts` 应列出你配置的主机，`ssh_status` 看连接池。

---

## 5. 已知坑

### ① `dsh-ssh-remote` 在 Windows 上**不支持密码登录**（实测复现）

想用密码登录时，`ssh_run` 会报：

```
CreateProcessW failed error:193
ssh_askpass: posix_spawnp: Unknown error
<user>@<host>: Permission denied (publickey,password).
```

根因在 `lib/index.js:49` —— 它**无条件**生成一个 `#!/bin/sh` 的 `SSH_ASKPASS` 包装脚本：

```js
const body = '#!/bin/sh\nexec ' + q(process.execPath) + ' ' + q(path.join(here, 'askpass.js')) + ...
```

两个 Windows 上致命的问题：

1. **`SSH_ASKPASS` 指向 `.sh` 文件**。Windows OpenSSH 用 `CreateProcessW` 启动它，而 `.sh` 不是可执行格式 → `error:193`（`ERROR_BAD_EXE_FORMAT`）。askpass 根本没跑起来。
2. **它 `exec` 的是 `process.execPath`**。在 DSH Desktop 上这就是 `DeepSeek Harness.exe`，而且**没有带 `ELECTRON_RUN_AS_NODE=1`** —— 就算脚本能启动，也只会再开一个 GUI 窗口，不会把 `askpass.js` 当 Node 脚本跑。

**规避**：Windows 上用 `auth: "agent"` 或 `auth: "key"`（两者都不需要 askpass）。真要密码登录就换 [`dsh-plugin-ssh`](#-dsh-plugin-ssh)（进程内 `ssh2`，不走 askpass）。

### ② `$DSH_HOME/.agent-presets` 没生成，是**正常**的

`dsh-wsl-workspace` 会为每个健康预设生成一个 `wsl-<mode>` 变体。老机制是往 `$DSH_HOME/.agent-presets/<id>/` 写目录；新机制（运行时提供 `agentPresets.register()` 时）改为**在 Host 内存里注册声明行**，不落盘。

判断依据：宿主里的 `@deepseek-ai/dsh-agent-preset-registry` 是否有 `register()` 方法。有 → 目录为空是预期，不是失败。

> 顺带一提，这个插件会**删除**它没重新生成的、位于 `.agent-presets/` 下形如 `wsl*` 的遗留目录。升级前建议先备份该目录。

### ③ 密码/密钥永不进 `hosts.json`

`dsh-ssh-remote` 的凭据用 AES-256-GCM 逐条加密存在 `credentials.enc`，密钥是自管的 32 字节 `credentials.key`（丢失后已存密码不可解，重设即可）。`hosts.json` 里只有主机元数据。**`credentials.key` 请自行备份。**

### ④ `auth: "agent"` 会设 `BatchMode=yes`

意味着**即使你在设置页存了密码，agent 模式也不会用它**（`BatchMode` 会连同 `SSH_ASKPASS` 一起禁掉）。认证方式由 `auth` 字段单独决定：`agent` → 交给 `~/.ssh/config` + ssh-agent + `~/.ssh/id_*`；`key` → `-i <identityFile>`；`password` → 强制密码（Windows 上不可用，见 ①）。

---

## 6. 回滚

```bash
dsh plugin --profile <profile> remove dsh-wsl-workspace
dsh plugin --profile <profile> remove dsh-ssh-remote
```

移除会先从 `dsh.profile.bundles` 摘掉、卸载运行时贡献，再跑 `pnpm remove`。

手工兜底：把 `dsh.profile.bundles` 里对应项删掉、`dependencies` 里删掉，然后 `dsh plugin --profile <profile> install`。**手工改完记得再跑一次 [第 4 节](#4-验证重启前确认不会启动失败) 的组合校验。**

管理操作的诊断日志在 `$DSH_HOME/profiles/<profile>/.plugin-manager/logs/`。

---

## 附：工具用法

两个脚本都需要用 **Electron-as-Node** 运行，因为打包版 DSH 的运行时在 `app.asar` 里，只有 Electron 的 fs 读得懂。

> 读 asar 时 Electron 会往 stderr 打一条 `DeprecationWarning: fs.Stats constructor is deprecated`。想清掉它（也顺手让退出码干净），加一个环境变量：
>
> ```powershell
> $env:NODE_OPTIONS="--no-deprecation"
> ```

### `tools/compose-profile.mjs`

离线复刻 profile 组合，重启前的安全检查。

```bash
<electron-as-node> tools/compose-profile.mjs [--profile <name>] [--resources <dir>] [--grep <substr>] [--json]
```

- `--profile` 默认取 `$DSH_PROFILE`，否则 `desktop`
- `--resources` 手动指定安装目录；默认按平台自动探测，也可用 `$DSH_RESOURCES`
- `--grep` 只打印 id 或模块名匹配的行
- `--json` 输出完整行列表

退出码：`0` 干净 · `2` bundle/profile 加载失败 · `3` 组合失败。

### `tools/asar-ls.mjs`

列出/读取 `app.asar` 里的文件（读 README、源码、找实现细节时很好用）。

```bash
<electron-as-node> tools/asar-ls.mjs dsh/node_modules/@deepseek-ai
<electron-as-node> tools/asar-ls.mjs dsh/node_modules/@deepseek-ai/dsh-plugin-manager/README.md > pm.md
```

---

## 许可

MIT —— 见 [LICENSE](LICENSE)。
文中提到的第三方插件版权归各自作者所有。

---

<a id="english-summary"></a>
## English summary

**Adding remote SSH + WSL to DeepSeek Harness — selection, install, verification, and pitfalls.**

Both capabilities already have working third-party plugins; nothing needs to be written from scratch.

- **WSL** → [`dsh-wsl-workspace`](https://github.com/dsh-wsl-workspace-maintainers/dsh-wsl-workspace): VS Code Remote-WSL-style workspaces, purely additive patch, zero npm deps, nothing to install inside WSL.
- **Remote SSH** → `dsh-ssh-remote` (0.1.3): purely additive patch, zero npm deps, drives the system `ssh` binary with ControlMaster. **Do not install `dsh-ssh`** — it re-registers the already-registered `ctx.fs`/`ctx.subprocess` services (Cordis throws on duplicate `provide`), disables the working directory picker, and its client half references a package absent from the install.
- **`dsh plugin --profile <p> add <pkg>`** installs the package and auto-appends it to `dsh.profile.bundles`.
- **DSH is fail-loud**: one failing plugin row stops the whole profile from booting. Verify the composition *before* restarting with [`tools/compose-profile.mjs`](tools/compose-profile.mjs), which replays the exact host composition offline.
- **Pitfall**: `dsh-ssh-remote` cannot do password auth on Windows — it writes a `#!/bin/sh` `SSH_ASKPASS` wrapper (Windows OpenSSH fails with `error:193`), and it execs the Electron binary without `ELECTRON_RUN_AS_NODE=1`. Use `auth: "agent"` or `"key"` on Windows, or `dsh-plugin-ssh` (in-process `ssh2`) if you need passwords.
