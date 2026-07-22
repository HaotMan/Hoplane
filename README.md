# Hoplane

Hoplane 是一个面向 AI Agent 的本地 SSH 安全网关。它统一管理多台 SSH 主机，通过 MCP 或 CLI 提供受策略约束的命令执行和文件传输能力，并保证凭据不暴露给 AI、所有操作可审计。

## MVP 能力

- 主机、分组、标签、默认目录和 AI 访问开关；
- 主机表单内直接配置密码、私钥/口令或 SSH Agent，每台主机独立保存自己的认证信息；
- macOS 和 Windows 统一使用主密码保护的本地加密保险库；SQLite 只保存凭据引用；
- SSH 主机指纹首次信任与变更阻断；
- 默认拒绝的逐主机命令、工作目录和文件路径策略；
- SFTP 上传和下载，路径规范化、符号链接二次校验、大小与覆盖限制；
- Electron 桌面 App、托盘驻留、登录时启动选项和内置 Core；
- Codex 一键安装 Skill 与稳定 stdio MCP，另保留可开关的 Streamable HTTP 和 `aiterm` CLI；
- React 管理界面、一键复制 Agent 配置、追加式操作审计和逐主机只读实时终端；
- 最多 20 个并发 SSH 连接，输出、请求和超时上限。

## 环境要求

- macOS 或 Windows 10/11 x64；
- Node.js 24；
- pnpm 11；
- 可访问的 SSH 服务器。

本地保险库使用 scrypt 派生密钥和 AES-256-GCM 认证加密，默认保存在 `~/.hoplane/vault.enc`。Hoplane 不读取或写入操作系统钥匙串。

## 安装与运行

Apple Silicon macOS 可直接安装：

```text
release/Hoplane-0.1.0-arm64.dmg
```

这是未签名的开发构建；正式分发前应配置 Apple Developer ID 签名和公证。

Windows 10/11 x64 可使用 NSIS 安装包或免安装 ZIP：

```text
release/Hoplane-0.1.0-windows-x64.exe
release/Hoplane-0.1.0-windows-x64.zip
```

Windows 构建当前未进行代码签名，首次运行可能显示“未知发布者”。

从源码启动桌面 App：

```bash
pnpm install
pnpm build
pnpm app
```

App 会启动内置 Core 并驻留菜单栏；关闭窗口不会停止 MCP，使用菜单栏“退出”才会结束服务。也可以用 `pnpm core` 单独启动浏览器版本。

生成 DMG 和 ZIP：

```bash
pnpm build:app
```

生成 Windows x64 安装包和 ZIP：

```bash
pnpm build:app:win
```

开发模式：

```bash
pnpm dev:core
pnpm dev:desktop
```

生产构建的界面由 Core 同源提供；开发服务器默认运行在 `5173`，需要通过 Core 的本地代理或使用构建后的界面进行完整鉴权测试。

数据默认保存在 `~/.hoplane`：

```text
hoplane.sqlite3  主机、策略和审计数据
core.token       本地 API 随机 Token（权限 0600）
core.pid         Core 进程 ID
vault.enc        本地加密凭据保险库（权限 0600）
policies/        每个策略对应一个可直接编辑的 YAML 文件
```

可以用 `HOPLANE_DATA_DIR` 和 `HOPLANE_CORE_PORT` 覆盖测试环境路径与端口。

## 首次配置

1. 首次启动时创建本地保险库主密码；
2. 使用可视化配置检查策略，或直接编辑 `~/.hoplane/policies/*.yaml`；
3. 添加主机，并在同一表单内配置密码、私钥或 SSH Agent 与权限策略；
4. 点击“测试”，核对并信任首次出现的 SHA-256 主机指纹；
5. 测试成功后再开启“允许 AI 访问”。

新的或发生变化的主机指纹只能由管理界面确认，MCP 无权接受。

主机列表可以随时停用或重新启用节点。停用会立即断开现有连接，并从 AI 可见主机列表移除；即使 Agent 保留了旧主机 ID，连接测试、命令执行和文件传输也会返回 `HOST_DISABLED`。

点击主机名称或“只读终端”可进入该节点的实时监控页。页面显示 AI/MCP、CLI 和 UI 发起的命令、策略判断、stdout、stderr、退出码与耗时，但不提供输入或执行入口。最近的命令与结果元数据来自审计库；stdout/stderr 仅在内存中保留有限事件窗口，关闭 Core 后不会恢复。

主机详情同时显示认证方式摘要。用户再次输入保险库主密码后，可以在 30 秒内查看和复制已保存的登录密码、私钥口令以及配置路径对应的私钥内容；复制后会在剪贴板内容未被替换的前提下尝试定时清除。该接口仅供同源 App 页面使用，不会注册为 MCP 或 CLI 能力，查看成功与失败都会进入本地审计。

## CLI

构建后运行：

```bash
pnpm cli -- host list
pnpm cli -- host test <host-id>
pnpm cli -- exec <host-id> --directory /opt/app -- df -h
pnpm cli -- upload <host-id> ./app.tar /opt/app/app.tar
pnpm cli -- download <host-id> /var/log/app.log ./app.log
```

CLI 会按需启动构建后的 Core。所有操作与 MCP 共用同一套策略和审计逻辑。

## MCP 配置

### Codex（推荐）

在 App 的“接入”页面点击“安装 Codex 集成”。Hoplane 会：

1. 将内置 `hoplane` Skill 安装到 `$CODEX_HOME/skills/hoplane`（默认 `~/.codex/skills/hoplane`）；
2. 备份已有的 `config.toml`，并把 `mcp_servers.hoplane` 更新为 stdio；
3. 使用当前安装的 Hoplane 可执行文件启动包内适配器，不依赖系统 Node 或源码路径；
4. 生成 Skill 诊断入口，并可在 App 内完成真实 stdio 握手和工具列表验证。

安装后完全退出并重新打开一次 Codex。之后“用 Hoplane 检查服务器”等请求会触发 Skill；Skill 优先调用 `list_hosts`，工具缺失时运行诊断，并禁止退回裸 `ssh` 或手写 localhost 请求。

生成的 macOS 配置形态如下，路径由 App 根据自身实际安装位置生成；Windows 使用相同结构和当前 `Hoplane.exe` 路径：

```toml
[mcp_servers.hoplane]
command = "/Applications/Hoplane.app/Contents/MacOS/Hoplane"
args = ["/Applications/Hoplane.app/Contents/Resources/app.asar/dist/packages/mcp-adapter/src/index.js"]
env = { ELECTRON_RUN_AS_NODE = "1" }
startup_timeout_sec = 30
tool_timeout_sec = 310
```

如果移动或重新安装 App，重新点击“安装 Codex 集成”即可刷新路径。

### Streamable HTTP（其他 Agent）

在 App 的“接入”页面解锁保险库并开启本地 MCP 服务，然后点击“复制 MCP 配置”。配置形态如下，实际 Token 由 App 自动生成并保存在本地加密保险库：

```json
{
  "mcpServers": {
    "hoplane": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:21722/mcp",
      "headers": {
        "Authorization": "Bearer hpl_..."
      }
    }
  }
}
```

HTTP MCP 只监听本机、默认关闭、校验 Bearer Token 和 `Host` 请求头。接入页还可以复制自然语言安装说明，交给支持自主配置 MCP 的 Agent。

暴露的工具：

- `list_hosts`
- `test_host`
- `execute_command`
- `upload_file`
- `download_file`

MCP 只会列出同时满足 `enabled=true` 和 `aiAccessEnabled=true` 的主机。

## 安全语义

- Policy 默认决策为 `DENY`；
- 黑名单优先于白名单；
- 默认禁止换行、`;`、管道、重定向、`&&`、`||`、反引号和 `$()`；
- 本地路径使用 `realpath` 后检查目录边界；
- 远端 SFTP 路径在词法检查后再次通过服务器 `realpath` 校验；
- 下载先写入权限为 `0600` 的临时文件，再原子移动；
- 命令超时会关闭 SSH channel；
- 审计摘要会脱敏并限制长度；
- 只读终端的实时输出按行脱敏、限制总输出和内存事件数量，不持久化 stdout/stderr；
- Core API 与 MCP 只监听 `127.0.0.1`；MCP 使用存放在本地加密保险库中的独立随机 Token；
- 本地保险库使用 scrypt（独立随机盐）和 AES-256-GCM（每次写入使用新 IV），主密钥只驻留进程内存；
- MCP HTTP 严格校验 `127.0.0.1`/`localhost` Host 头，拒绝跨源与 DNS 重绑定访问；
- 管理界面与 Core 同源，不允许跨源 API 请求。

正则策略不是服务器端最小权限的替代品。生产服务器仍应为 AI 使用单独的低权限 SSH 账号。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:app
```

测试覆盖策略默认拒绝、shell 组合符拦截、目录边界、数据库迁移与连接 revision、主机指纹信任、审计脱敏和 SSH Config 基础解析。

## 当前边界

- 不支持交互式 PTY、Vim、Top、GDB 或持久终端会话；
- 不支持 MFA、SOCKS、ProxyJump 和团队同步；
- SSH Config 导入支持具体 Host、HostName、Port、User、IdentityFile，忽略通配符和复杂 Match/Include；
- macOS 构建尚未签名、公证，Windows 构建尚未进行代码签名；
- MCP HTTP 当前使用单个本机 Agent Token，不支持多客户端独立吊销和过期时间；
- 本地主密码不可恢复，当前不支持修改主密码；忘记密码只能重建保险库并重新录入凭据；
- Node.js `node:sqlite` 在运行时可能输出实验性 API 提示，不影响当前功能。

完整实现说明参见 [docs/MVP实现说明.md](docs/MVP实现说明.md)。
