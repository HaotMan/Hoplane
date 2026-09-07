# Hoplane MVP 实现说明

> 版本：V0.1  
> 日期：2026-07-20

## 1. 实现范围

本版本完成 Electron App、本地 Core、SQLite、本地加密保险库、SSH/SFTP、Policy、Audit、MCP Streamable HTTP/stdio、CLI 和 React 管理界面组成的安全闭环。

桌面 App 内嵌 Core 运行时，关闭窗口后继续驻留菜单栏，因此 AI 调用不受窗口显示状态影响。Core 也可以作为独立进程运行；只有 Core 可以打开数据库、读取本地加密保险库和建立 SSH 连接。

```text
AI Agent ── Streamable HTTP + MCP Token ─┐
React UI / Electron ──────────────────────┼── Hoplane Core ── SSH/SFTP
aiterm CLI / MCP stdio ─ Local API Token ─┘         │
                                                   ├─ SQLite
                                                   └─ Local Encrypted Vault
```

## 2. 代码结构

```text
apps/
  cli/                 aiterm CLI
  desktop/             React 管理界面与 Electron 主进程/托盘
packages/
  shared/              类型、校验、错误和 Core API 客户端
  core/                HTTP、数据层、本地加密 Vault 和 Operation Service
  ssh-core/            SSH 连接池、SFTP 与 POSIX Exec 文件流回退
  policy/              命令和路径策略
  audit/               审计脱敏
  mcp-adapter/          可复用 MCP 工具与 stdio 适配器
integrations/
  codex/hoplane/        App 内置并安装的 Hoplane Skill
test/                   单元和数据层测试
```

## 3. Core 生命周期

- Core 固定绑定 `127.0.0.1`；
- 默认端口为 `21722`；
- Electron 启动时内嵌 Core；端口已有健康 Core 时复用现有实例；
- 关闭窗口只隐藏到托盘，应用退出时关闭 HTTP 连接、SSH 连接和数据库；
- CLI 和 MCP 在 Core 不可用时启动构建后的 Core；
- Core 是 SQLite 和 SSH 连接的唯一所有者；
- Core 启动时将残留的 `RECEIVED`、`EXECUTING` 操作修正为 `INTERRUPTED`；
- `SIGINT` 或 `SIGTERM` 时关闭全部 SSH 连接并移除 PID 文件。

## 4. 策略顺序

命令检查顺序：

```text
读取 commandBlacklist
→ 按顺序匹配整条命令正则
→ 命中任一规则：拒绝
→ 未命中：允许
```

策略使用 `schemaVersion: 4` 的黑名单模型。系统、Docker、Compose 和 Kubernetes 命令默认允许，仅由 `commandBlacklist` 中的正则规则过滤；“全权限（高风险）”模板的命令黑名单为空。主机间中继由源、目标主机各自默认关闭的 `hostTransferEnabled` 总闸控制，不写入共享策略；策略继续负责源端下载、目标端上传、大小、覆盖与路径范围校验。

主机间中继优先建立两端 SFTP；仅当 SFTP 子系统启动失败时，Core 才使用固定生成的 POSIX SSH Exec 命令，以 `cat` 的 stdout/stdin 在两条 SSH 连接之间流式传输。路径、权限和覆盖错误不会触发回退；Exec 或所需基础命令也不可用时返回 `FILE_TRANSFER_TRANSPORT_UNAVAILABLE`。

主机可以单独开启本机 SOCKS5 代理。首次开启会要求配置 `proxyLocalHost`、`proxyLocalPort` 和 `proxyRemotePort`，之后也可在主机编辑页修改。Core 使用池化 SSH 连接在远端 `127.0.0.1:<proxyRemotePort>` 与指定的本机代理端点之间建立反向 TCP 隧道，并为 Hoplane 发起的远端命令和人工交互终端自动注入 `ALL_PROXY=socks5h://127.0.0.1:<proxyRemotePort>`。远端只监听回环地址；隧道或本机代理不可用时命令按 fail-closed 方式失败，不会静默直连。该能力只代理显式读取代理环境变量的 TCP 客户端，不修改远端持久化配置，也不接管 UDP 或整机流量。

上传和下载执行双阶段检查：

```text
主机传输总闸、策略上传/下载开关与大小限制
→ 本地 realpath / 远端词法规范化
→ 允许目录检查
→ 建立 SFTP
→ 远端 realpath
→ 再次检查允许目录
→ 传输
```

## 5. 主机指纹

SSH 使用 SHA-256 主机指纹：

1. 首次看到的指纹记录为 `PENDING` 并拒绝连接；
2. 用户只能通过管理 API/UI 将已观察的指纹设为 `TRUSTED`；
3. 指纹发生变化时，新指纹记录为 `PENDING`，连接返回 `SSH_HOST_KEY_CHANGED`；
4. 信任新指纹会撤销该主机旧的受信指纹；
5. MCP 没有信任指纹的工具。

## 6. 审计状态

```text
RECEIVED
  ├─ DENIED
  ├─ EXECUTING ─ SUCCEEDED
  │             ├─ FAILED
  │             └─ TIMED_OUT
  └─ INTERRUPTED（Core 异常退出恢复）
```

Operation Service 在主机、策略和参数检查前创建 `operation_id`，因此未知主机、权限拒绝和执行失败都能留下记录。

### 6.1 逐主机只读终端

- 主机详情页先读取最近 100 条审计元数据，再通过 SSE 订阅该主机的新事件；
- `EXECUTE_COMMAND` 会实时发送命令、策略结果、退出码和耗时；用户为主机开启“显示运行结果”后才会发送 stdout/stderr，连接测试与文件传输也会显示生命周期状态；
- SSE 使用递增事件 ID，浏览器断线重连时可补发内存窗口内遗漏的事件，并每 15 秒发送保活；
- stdout/stderr 在 UTF-8 解码后按行脱敏，只在 Core 内存中为每台主机保留最近 500 个事件；回放内容使用用户主密码派生的保险库密钥进行 AES-256-GCM 加密；
- 页面没有输入框和执行 API，不会形成绕过策略的交互式 SSH 会话；
- stdout/stderr 不写入 SQLite；关闭显示开关或锁定保险库会清除对应内存回放，历史视图只恢复请求摘要、策略、结果、退出码、耗时和错误元数据。

## 7. API

管理接口：

```text
GET/POST       /v1/hosts
PATCH/DELETE   /v1/hosts/:id
POST           /v1/hosts/:id/test
GET            /v1/hosts/:id/events  SSE 只读实时事件流
POST           /v1/hosts/:id/trust-key
POST           /v1/hosts/:id/credential/reveal  App 同源限定、主密码二次验证
POST           /v1/hosts/ssh-config/preview
POST           /v1/hosts/import-ssh-config
GET/POST       /v1/credentials
PATCH/DELETE   /v1/credentials/:id
GET/POST       /v1/policies
PATCH/DELETE   /v1/policies/:id
GET            /v1/audit-logs
GET/PATCH      /v1/mcp-settings
POST           /v1/mcp-settings/regenerate-token
GET            /v1/codex-integration
POST           /v1/codex-integration/select
POST           /v1/codex-integration/install
POST           /v1/codex-integration/diagnose
GET            /v1/agent-integrations
POST           /v1/agent-integrations/:agent/install  agent=cursor|claude-code
GET            /v1/vault-settings
POST           /v1/vault/setup
POST           /v1/vault/unlock
POST           /v1/vault/lock
POST           /v1/config/export
POST           /v1/config/import
```

操作接口：

```text
POST /v1/operations/execute
POST /v1/operations/upload
POST /v1/operations/download
POST /v1/operations/transfer
```

MCP 协议端点：

```text
POST /mcp  Streamable HTTP（默认关闭、Bearer Token、Host 校验）
```

MCP 开关和保险库引用存入 `app_settings`；实际 `hpl_...` Token 只保存在本地加密保险库。HTTP 与 stdio 使用同一套工具注册和 Operation Service，避免出现两套权限路径。

Codex 集成安装器只检查 `CODEX_HOME`、`~/.codex`、XDG/macOS/Windows 应用数据目录等有限候选位置，不递归扫描用户目录。界面会校验候选目录、`config.toml` 基础结构和可写性；发现多个目录时由用户选择，也支持手动输入绝对路径，选择结果持久化到本地设置。安装器将 Skill 安装到选定 Codex Home，并以托管区块更新 `config.toml` 中的 `mcp_servers.hoplane`。已有配置会保留，第一次修改前写入 `config.toml.hoplane-backup`。安装包使用 Electron 的 `ELECTRON_RUN_AS_NODE=1` 模式启动包内 stdio 入口，因此 macOS 和 Windows 都不依赖外部 Node。App 诊断会实际启动该入口、完成 MCP 初始化并核对六个工具；Skill 自带的诊断入口负责检查 Core、保险库和允许 AI 访问的主机。

Agent 接入页按 Codex、Cursor、Claude Code、WorkBuddy、Trae、其他 Agent 分为六个标签。前五者都使用安装包内稳定的 stdio 入口并一键安装 Hoplane Skill：Cursor 写入 `~/.cursor/skills/hoplane` 与 `~/.cursor/mcp.json`，Claude Code 写入 `~/.claude/skills/hoplane` 与用户级 `~/.claude.json`，WorkBuddy 写入 `~/.workbuddy`，Trae 则分别写入全局 Skill 目录和平台用户配置目录中的 `User/mcp.json`；其配置目录候选同时覆盖 Trae、Trae 国内版和 TRAE SOLO，TRAE SOLO 沿用 Trae Skill 目录；修改已有 JSON 前保留 `.hoplane-backup`，其他字段和 MCP 服务不变。“其他 Agent”继续通过默认关闭的本机 Streamable HTTP 服务复制配置和安装说明。界面支持跟随系统、深色、浅色三档主题并在本机持久化。

策略页只保留左侧策略列表，右侧提供可视化配置和 YAML 源码两个标签，编辑、取消和保存新版本按钮位于内容区右下角。每个策略写入 `~/.hoplane/policies/<slug>--<uuid>.yaml`，Core 使用 SQLite 保存最后一次验证通过的运行快照。文件监听会自动导入合法新增文件和应用合法修改；无效 YAML 显示错误并保留上一有效版本，文件删除则停用对应策略。更新接口使用 `expectedVersion` 防止覆盖外部变更。

API 请求体最大 1 MiB；命令最长 32 KiB；命令超时范围为 100 毫秒到 5 分钟；stdout 和 stderr 默认各最多返回 1 MiB。

## 8. 凭据保险库

- 新安装默认使用 `~/.hoplane/vault.enc`；
- 创建和编辑主机时直接配置认证；每台主机拥有独立认证信息，删除主机后同步删除凭据和保险库密文；
- scrypt 使用随机盐派生 256 位密钥，保险库内容通过 AES-256-GCM 认证加密；
- 主密码和派生密钥不写入磁盘，退出或锁定时清除内存密钥；
- 保险库文件以临时文件写入后原子替换，目录权限为 `0700`、文件权限为 `0600`；
- 本地保险库锁定时关闭现有 SSH 连接并清除 MCP Token 缓存。
- 查看密码、私钥口令或私钥文件要求再次验证保险库主密码，返回值禁止缓存并由界面在 30 秒后清除；MCP、CLI 和 Bearer Token 调用不能访问该 App 同源接口。

## 9. 已知限制与后续工作

1. 为 Electron 安装包增加正式图标、Developer ID 签名、公证和自动更新；
2. 增加 Core 锁文件和单实例 IPC，进一步强化跨进程竞争处理；
3. 增加连接空闲 TTL 和显式操作取消；
4. 增加真实 SSH 容器的集成测试；
5. 支持 SSH Config 的 Match 条件求值与 Host 通配符继承；
6. 增加审计保留周期、导出和数据库容量管理；
7. 为策略编辑器增加保存前命令模拟测试。
8. 增加每个 Agent 独立 Token、过期时间和单独吊销能力。
