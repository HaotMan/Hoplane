# Hoplane

> 让 AI 安全地操作你的 SSH 主机，而不把密码、私钥和无限制 Shell 交给 AI。

Hoplane 是一个面向 AI Agent 的本地 SSH 安全网关。它在 Agent 与远程服务器之间提供统一的凭据保险库、主机管理、权限策略、操作审计和文件传输能力，并可一键接入 Codex、Cursor、Claude Code 等客户端。

Hoplane 不是另一个聊天窗口，也不是传统交互式 SSH 终端。它的目标是把远程操作收敛为可控制、可停止、可追踪的工具调用：Agent 只能看到被授权的主机，只能执行策略允许的操作，并且永远不会获得登录凭据。

## 为什么选择 Hoplane

| 能力 | 直接让 Agent 使用 SSH | 常见单配置 SSH MCP | Hoplane |
| --- | --- | --- | --- |
| 凭据与 Agent 隔离 | 通常不能保证 | 取决于实现 | 本地加密保险库，MCP/CLI 不返回凭据 |
| 多主机图形化管理 | 无 | 通常依赖配置文件 | 分组、标签、启停、状态和批量复制 |
| 每台主机独立授权 | 无 | 通常较弱 | 主机级 AI 开关和独立策略 |
| Docker / Kubernetes 策略 | 无 | 通常依赖手写命令规则 | 内置场景模板和可视化黑名单 |
| 文件传输边界 | 无 | 取决于实现 | 路径、大小、覆盖和符号链接复核 |
| Agent 接入 | 依赖 Agent Shell 权限 | 手动配置 MCP | Codex、Cursor、Claude Code 一键集成 |
| 操作追踪 | Shell 历史有限 | 取决于实现 | 策略判断、结果、耗时和错误统一审计 |
| 紧急停止 | 需要回收密钥 | 通常需要改配置 | 停用主机或关闭 AI 访问立即生效 |

核心优势：

- **凭据不进入 Agent 上下文**：密码、私钥口令和 MCP Token 保存在本地 AES-256-GCM 加密保险库中，数据库只保存引用。
- **所有入口共用同一条安全链路**：MCP、CLI 和桌面界面都必须经过主机状态检查、策略判断、SSH 执行和审计记录。
- **权限可以被人理解**：通过可视化界面配置系统、Docker、Compose、Kubernetes 和文件传输黑名单，高级用户仍可直接编辑 YAML。
- **主机随时可撤销**：停用主机后立即断开连接、从 AI 主机列表移除，并拒绝 Agent 保存的旧主机 ID。
- **本地优先**：Core、数据库、策略和凭据全部保存在本机，不依赖 Hoplane 云服务。
- **既适合 Agent，也保留人的控制权**：用户可以查看指令记录、策略结果和有限实时输出，但监控页面不提供远程输入入口。

## 界面预览

### 多主机、分组与独立授权

主机可以分组折叠、启用或停用，并分别设置 AI 访问权限、默认目录和策略。多选模式支持批量选择并复制主机名称或地址。

![Hoplane 主机分组与权限管理](docs/images/hoplane-hosts.jpg)

### 可视化策略与 YAML 双向编辑

内置错误追溯、系统巡检、容器排障、容器运维、完全禁用和全权限模板。策略既可以通过操作开关配置，也可以直接编辑本地 YAML 文件。

![Hoplane 可视化权限策略](docs/images/hoplane-policies.jpg)

### 统一操作审计

成功、拒绝、失败和超时都会记录来源、主机、请求摘要、策略判断、错误码和耗时。审计记录不会写入密码、私钥、口令或 Token。

![Hoplane 操作审计](docs/images/hoplane-audit.jpg)

### 多 Agent 一键接入

App 可以扫描有限的常见配置位置，也支持手动选择目录。Codex、Cursor 和 Claude Code 均可安装 Hoplane Skill 和稳定的 stdio MCP；其他客户端可以使用 Streamable HTTP 配置。

![Hoplane Agent 接入](docs/images/hoplane-integrations.jpg)

> 截图使用独立演示数据和 [RFC 5737](https://datatracker.ietf.org/doc/html/rfc5737) 保留地址，不包含真实服务器信息。

## 工作方式

```text
Codex / Cursor / Claude Code / Other Agents
                    │
              MCP stdio / HTTP
                    │
                    ▼
┌──────────────────────────────────────────┐
│              Hoplane Core                │
│                                          │
│  Host Registry  →  Policy Engine         │
│         │                 │               │
│  Encrypted Vault  →  Operation Service   │
│                           │              │
│                    Audit + Monitor        │
└───────────────────────────┬──────────────┘
                            │ SSH / SFTP
                            ▼
                    Remote Hosts
```

一次远程操作必须经过：

```text
Agent 提交请求
→ 检查主机是否启用以及是否允许 AI 访问
→ 加载该主机绑定的策略
→ 检查命令、目录或文件路径
→ 从保险库解析凭据
→ 执行 SSH / SFTP
→ 脱敏并写入审计
→ 返回结构化结果
```

Agent 不能确认新的 SSH 主机指纹、查看凭据或绕过已停用的主机。

## 功能

### 主机管理

- 新增、编辑、删除和测试 SSH 主机；
- 支持密码、私钥/口令和 SSH Agent；
- 主机分组、标签、折叠、排序和多选复制；
- 每台主机独立设置默认工作目录、权限策略和 AI 访问开关；
- 主机启用/停用立即影响 MCP 可见性和已有连接；
- 从 SSH Config 导入具体主机配置；
- 首次连接显示 SHA-256 指纹，指纹变化时阻止连接并要求用户重新确认。

### 本地加密保险库

- 使用 scrypt 从主密码派生密钥；
- 使用 AES-256-GCM 对本地保险库进行认证加密；
- 每次写入使用新的随机 IV，主密钥只保留在进程内存中；
- 默认保存到 `~/.hoplane/vault.enc`，不依赖系统钥匙串；
- 锁定保险库时关闭 SSH 连接并清除 MCP Token 缓存；
- 用户重新验证主密码后，可以在 30 秒内查看和复制自己的登录密码、私钥口令或私钥内容；
- 查看凭据只允许来自同源 App 页面，并且成功和失败都会进入审计。

### Policy V3

Policy V3 使用黑名单模型：未命中规则的命令默认允许，命中任意黑名单规则时拒绝；“全权限”模板的命令黑名单为空。

内置模板：

- **错误追溯（推荐）**：允许常见查询，阻止系统、Docker 和 Kubernetes 变更；
- **系统巡检（只读）**：允许系统查询，阻止系统修改及容器编排命令；
- **容器排障（只读）**：允许 Docker/Kubernetes 查询，阻止状态变更和高风险操作；
- **容器运维（受限）**：允许常规运维，阻止远程执行、删除、构建和资源写入；
- **完全禁用**：所有命令和文件传输均拒绝；
- **全权限（高风险）**：命令黑名单为空，只适用于隔离环境、低权限账号或人工监督场景。

策略特性：

- 系统、Docker/Compose、Kubernetes、Shell 包装和组合符分组配置；
- 上传、下载、覆盖、单文件大小和允许路径控制；
- 可视化配置与 YAML 源码共享同一份草稿；
- 每个策略对应 `~/.hoplane/policies/*.yaml`；
- 严格 Schema 校验，未知字段和错误枚举不会生效；
- 外部合法修改自动生成新版本，无效修改继续使用上一有效快照；
- 文件缺失或策略停用时，绑定主机的操作统一拒绝。

> 黑名单和正则策略不能替代服务器端最小权限。生产环境仍应为 AI 使用独立的低权限 SSH 账号，并优先选择受限模板。

### 命令与文件操作

- 非交互式远程命令执行；
- 命令工作目录和最长执行时间控制；
- 最多 20 个并发 SSH 连接；
- stdout、stderr、请求体和超时上限；
- SFTP 上传和下载；
- 本地路径 `realpath` 边界检查；
- 远端路径词法校验和服务器端 `realpath` 二次检查；
- 下载先写入权限为 `0600` 的临时文件，再原子移动；
- 超时会主动关闭对应 SSH channel。

### 指令记录与审计

- 每台主机提供独立的只读“指令记录”页面；
- 显示 AI/MCP、CLI 和 UI 发起的命令、策略判断、stdout、stderr、退出码和耗时；
- 是否显示实时命令输出可以按主机关闭；
- 实时输出使用用户保险库派生的密钥保护，仅在内存中保留有限事件窗口；
- stdout/stderr 不持久化，Core 退出后不会恢复；
- 审计数据库保留请求摘要、策略结果、状态和脱敏错误信息。

### Agent 集成

- Codex、Cursor、Claude Code 配置目录有限扫描和手动选择；
- 一键安装 Hoplane Skill；
- 一键写入或刷新稳定的 stdio MCP 启动入口；
- App 内运行诊断和真实工具列表验证；
- 可选 Streamable HTTP MCP，默认关闭且只监听本机；
- `aiterm` CLI 与 MCP 共用策略和审计逻辑。

MCP 工具：

```text
list_hosts
test_host
execute_command
upload_file
download_file
```

`list_hosts` 只列出同时满足 `enabled=true` 和 `aiAccessEnabled=true` 的主机，所有操作都使用 `host_id` 指定目标主机。

## 快速开始

### 使用安装包

发布文件位于 GitHub Release：

```text
Hoplane-<version>-macos-arm64-installer.dmg
Hoplane-<version>-windows-x64-installer.exe
Hoplane-<version>-windows-x64.zip
```

当前构建尚未进行代码签名。系统首次打开时可能显示未知开发者或未知发布者提示。

首次使用：

1. 启动 Hoplane 并创建本地保险库主密码；
2. 添加主机，在同一表单中填写连接信息和认证方式；
3. 测试连接并核对首次出现的 SSH 主机指纹；
4. 为主机选择策略，测试成功后再开启“允许 AI 访问”；
5. 在“接入”页面选择 Agent 和配置目录，点击一键安装；
6. 完全退出并重新打开 Agent 客户端，让新 Skill 和 MCP 配置生效。

之后可以直接对 Agent 说：

```text
用 Hoplane 检查 Production API 上失败的 systemd 服务。
用 Hoplane 查看 Kubernetes Control 的 Pod 状态。
用 Hoplane 下载应用日志到本地 Downloads 目录。
```

### 从源码运行

构建要求：

- Node.js 24；
- pnpm 11；
- 可访问的 SSH 服务器用于真实连接测试。

```bash
pnpm install
pnpm build
pnpm app
```

开发模式：

```bash
pnpm dev:core
pnpm dev:desktop
```

构建当前平台安装包：

```bash
pnpm build:app
```

构建 Windows x64 安装包和免安装 ZIP：

```bash
pnpm build:app:win
```

桌面 App 会启动内置 Core 并驻留托盘。关闭窗口不会停止 MCP；需要通过托盘菜单“退出”才能结束进程。也可以运行 `pnpm core` 单独启动浏览器版本。

## CLI

构建后可以运行：

```bash
pnpm cli -- host list
pnpm cli -- host test <host-id>
pnpm cli -- exec <host-id> --directory /opt/app -- df -h
pnpm cli -- upload <host-id> ./app.tar /opt/app/app.tar
pnpm cli -- download <host-id> /var/log/app.log ./app.log
```

CLI 会按需启动构建后的 Core，不直接调用 SSH Connection Manager。

## 数据目录

默认数据保存在 `~/.hoplane`：

```text
hoplane.sqlite3  主机、策略版本和审计数据
core.token       本地 API 随机 Token（权限 0600）
core.pid         Core 进程 ID
vault.enc        本地加密凭据保险库（权限 0600）
policies/        可直接编辑的策略 YAML 文件
```

可以使用以下环境变量覆盖测试实例的数据目录和端口：

```text
HOPLANE_DATA_DIR
HOPLANE_CORE_PORT
HOPLANE_OUTPUT_LIMIT_BYTES
```

## 安全边界

- Core API、管理界面和 HTTP MCP 只监听 `127.0.0.1`；
- HTTP MCP 默认关闭，使用保险库中的独立随机 Bearer Token；
- HTTP MCP 校验 `127.0.0.1`/`localhost` Host 头，阻止跨源访问和 DNS 重绑定；
- 新的或发生变化的 SSH 主机指纹只能由管理界面确认，MCP 无权接受；
- MCP 和 CLI 无法调用凭据查看接口；
- 审计摘要和实时输出经过脱敏并限制长度；
- 管理界面与 Core 同源，不开放任意系统命令 IPC。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm build:app
```

自动化测试覆盖策略匹配、Shell 绕过、目录边界、数据库迁移、YAML 同步、版本冲突、连接 revision、主机指纹、保险库、审计脱敏、操作监控、SSH Config 解析和 MCP HTTP 鉴权。

## 当前边界

- 不支持交互式 PTY、Vim、Top、GDB 或持久终端会话；
- 不支持 MFA、SOCKS、ProxyJump 和团队同步；
- SSH Config 导入暂不支持复杂的 `Include`、`Match`、`ProxyJump` 和通配符继承；
- HTTP MCP 当前使用单个本机 Agent Token，不支持每个客户端独立过期和吊销；
- 本地主密码不可恢复且暂不支持修改，忘记密码需要重建保险库并重新录入凭据；
- 当前安装包尚未签名或公证；
- Node.js `node:sqlite` 仍可能输出实验性 API 提示。

## 进一步了解

- [MVP 需求文档](docs/AI远程终端管理器-MVP需求文档.md)
- [MVP 设计文档](docs/AI远程终端管理器-MVP设计文档.md)
- [实现说明与后续计划](docs/MVP实现说明.md)
