# AI 远程终端管理器 MVP 设计文档

> 版本：V0.1  
> 更新时间：2026-07-20

## 1. 设计目标

MVP 基于 `classfang/ssh-mcp-server` 开发一个带管理前端的 AI SSH 工具。

系统需要实现：

- 图形化管理多台 SSH 主机；
- AI 通过 MCP 或 CLI 指定主机执行命令；
- 每台主机使用独立权限；
- 凭据保存在本地安全存储；
- 所有操作经过统一权限检查和日志记录；
- 修改单台主机不影响其他连接。

## 2. MVP 架构

```text
┌─────────────────────────────┐
│ Desktop UI                  │
│ 主机 / 凭据 / 权限 / 日志  │
└──────────────┬──────────────┘
               │ IPC
               ▼
┌─────────────────────────────┐
│ Local Core                  │
│                             │
│ Host Service                │
│ Credential Vault            │
│ SSH Connection Manager      │
│ Policy Service              │
│ Operation Service           │
│ Audit Service               │
└─────────┬───────────┬───────┘
          │           │
     MCP Adapter   CLI Adapter
          │           │
          └─────┬─────┘
                ▼
          外部 AI Agent
                │
                ▼
          多台 SSH 服务器
```

## 3. 技术选型

### 桌面端

推荐：

- Tauri 2；
- React；
- TypeScript。

### Core

MVP 使用 Node.js 和 TypeScript，方便复用：

- `ssh-mcp-server`；
- `ssh2`；
- MCP TypeScript SDK。

### 数据库

SQLite。

### 凭据存储

- 本地 AES-256-GCM 加密保险库；
- Windows Credential Manager；
- Linux Secret Service。

### CLI

Node.js CLI，名称暂定：

```text
aiterm
```

## 4. 项目结构

```text
ai-terminal-manager/
├── apps/
│   ├── desktop/
│   └── cli/
├── services/
│   └── core/
├── packages/
│   ├── ssh-core/
│   ├── policy/
│   ├── mcp-adapter/
│   ├── audit/
│   └── shared/
├── migrations/
└── docs/
```

## 5. 模块设计

## 5.1 Host Service

负责：

- 主机新增、修改和删除；
- 主机分组和标签；
- SSH Config 导入；
- 主机状态；
- 凭据和策略绑定。

接口：

```ts
createHost(input)
updateHost(hostId, patch)
deleteHost(hostId)
getHost(hostId)
listHosts()
testHost(hostId)
```

## 5.2 Credential Vault

负责：

- 保存密码和私钥口令；
- 为每台主机独立保存认证信息；
- 读取凭据；
- 锁定和解锁；
- 凭据脱敏。
- 在主机详情的同源 UI 请求中二次验证主密码，并限时返回密码、口令或私钥内容；
- 主机删除或更换认证方式后回收不再使用的专属凭据。

接口：

```ts
createCredential(input, secret)
updateCredential(id, secret)
deleteCredential(id)
resolveCredential(id)
```

要求：

- secret 不保存到 SQLite；
- MCP 不获得 secret；
- 日志不记录 secret；
- 不通过启动参数传递密码。

## 5.3 SSH Connection Manager

基于 `ssh-mcp-server` 的连接代码改造。

负责：

- 按 `host_id` 管理 SSH 连接；
- 密码、私钥、SSH Agent 和 SSH Config；
- SOCKS、跳板机和 MFA；
- exec 命令；
- SFTP；
- keepalive；
- 超时；
- 自动重连。

接口：

```ts
connect(hostId)
disconnect(hostId)
testConnection(hostId)
execute(hostId, command, options)
upload(hostId, localPath, remotePath)
download(hostId, remotePath, localPath)
getStatus(hostId)
```

必须改造原项目的地方：

1. 不再使用一个全局配置文件作为唯一数据源；
2. 支持动态新增和修改主机；
3. 修改一台主机时只重连该主机；
4. 凭据从 Credential Vault 读取；
5. 连接状态通过事件发送给 GUI；
6. SSH 层不直接暴露给 MCP。

## 5.4 Policy Service

负责检查：

- 主机是否允许 AI 访问；
- 命令是否通过白名单和黑名单；
- 工作目录是否允许；
- 上传和下载是否允许；
- 文件路径是否允许。

接口：

```ts
evaluateCommand(context)
evaluateUpload(context)
evaluateDownload(context)
```

返回：

```json
{
  "decision": "ALLOW",
  "reason": "Matched host command whitelist"
}
```

决策类型：

```text
ALLOW
DENY
```

MVP 暂不实现人工审批。

## 5.5 Operation Service

所有操作统一经过此模块：

```text
接收请求
→ 查询主机
→ 权限检查
→ 执行 SSH 操作
→ 归一化结果
→ 写入日志
→ 返回结果
```

MCP 和 CLI 不得直接调用 SSH Connection Manager。

接口：

```ts
executeCommand(request)
uploadFile(request)
downloadFile(request)
testHost(request)
```

## 5.6 Audit Service

记录：

```text
operation_id
client_type
client_id
host_id
operation_type
request_summary
policy_decision
status
exit_code
duration_ms
error_code
created_at
```

默认只保存输出摘要，避免日志体积过大。

## 5.7 MCP Adapter

MVP 工具：

```text
list_hosts
test_host
execute_command
upload_file
download_file
```

MCP 参数使用 `host_id`，不使用 UI 当前选中主机。

MCP 默认通过：

- stdio；
- 或仅监听 `127.0.0.1` 的本地 HTTP。

## 5.8 CLI Adapter

示例：

```bash
aiterm host list --json
aiterm host test host-dev
aiterm exec host-dev -- df -h
aiterm upload host-dev ./app.tar /opt/app/
aiterm download host-dev /var/log/app.log ./
```

CLI 通过本地 IPC 调用 Core。

## 6. 数据模型

## 6.1 hosts

```sql
CREATE TABLE hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  credential_id TEXT,
  policy_id TEXT,
  group_name TEXT,
  tags_json TEXT,
  default_directory TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 6.2 credentials

```sql
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  secret_ref TEXT,
  private_key_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 6.3 policies

```sql
CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

策略示例：

```json
{
  "commandWhitelist": [
    "^ls( .*)?$",
    "^cat .*$",
    "^df.*$"
  ],
  "commandBlacklist": [
    "^shutdown.*",
    "^reboot.*"
  ],
  "allowUpload": true,
  "allowDownload": true,
  "allowedLocalPaths": [
    "/Users/user/projects"
  ],
  "allowedRemoteUploadPaths": [
    "/opt/app"
  ],
  "allowedRemoteDownloadPaths": [
    "/var/log/app"
  ]
}
```

## 6.4 audit_logs

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  client_type TEXT,
  client_id TEXT,
  host_id TEXT,
  operation_type TEXT NOT NULL,
  request_summary TEXT,
  policy_decision TEXT,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  error_code TEXT,
  created_at TEXT NOT NULL
);
```

## 7. MCP 接口

## 7.1 list_hosts

输出：

```json
[
  {
    "host_id": "host-dev",
    "name": "开发服务器",
    "group": "development",
    "status": "CONNECTED",
    "capabilities": [
      "execute",
      "upload",
      "download"
    ]
  }
]
```

## 7.2 execute_command

输入：

```json
{
  "host_id": "host-dev",
  "command": "df -h",
  "directory": "/opt/app",
  "timeout_ms": 30000
}
```

输出：

```json
{
  "operation_id": "op-001",
  "stdout": "...",
  "stderr": "",
  "exit_code": 0,
  "duration_ms": 312
}
```

## 7.3 upload_file

输入：

```json
{
  "host_id": "host-dev",
  "local_path": "/Users/user/projects/app.tar",
  "remote_path": "/opt/app/app.tar"
}
```

## 7.4 download_file

输入：

```json
{
  "host_id": "host-prod",
  "remote_path": "/var/log/app/app.log",
  "local_path": "/Users/user/Downloads/app.log"
}
```

## 8. 错误格式

统一错误：

```json
{
  "code": "POLICY_DENIED",
  "message": "Command is not allowed on this host",
  "retriable": false,
  "operation_id": "op-001"
}
```

主要错误码：

```text
HOST_NOT_FOUND
HOST_DISABLED
CREDENTIAL_NOT_FOUND
CREDENTIAL_LOCKED
SSH_CONNECTION_FAILED
SSH_AUTH_FAILED
SSH_HOST_KEY_CHANGED
COMMAND_TIMEOUT
POLICY_DENIED
PATH_NOT_ALLOWED
SFTP_UNAVAILABLE
INTERNAL_ERROR
```

## 9. 配置更新

修改主机时：

```text
修改名称、标签、策略
→ 不重连

修改地址、端口、用户名、凭据
→ 只断开并重连该主机
```

禁止更新一台主机时重启全部连接。

## 10. 安全设计

1. MCP 默认只允许本机访问；
2. 本地 HTTP MCP 必须使用随机 Token；
3. SSH 主机指纹变化时禁止继续连接；
4. 密码和口令保存在主密码保护的本地加密保险库；
5. 不通过命令行参数传递密码；
6. 命令和路径必须经过 Policy Service；
7. 建议为 AI 使用独立低权限 SSH 用户；
8. 正则规则不是唯一安全措施，服务器端权限仍然有效；
9. 日志必须脱敏；
10. Core 只在同源 App 页面再次验证保险库主密码后限时返回认证明文；MCP、CLI 和普通 Token 调用不能访问该能力。

## 11. 基于 ssh-mcp-server 的实施方式

### 直接复用

- SSH 认证；
- 多主机连接；
- `ssh2`；
- SFTP；
- SOCKS；
- MFA；
- keepalive；
- timeout；
- 命令白名单和黑名单；
- 路径限制；
- MCP 工具实现。

### 需要修改

- 配置改为 SQLite；
- 密码改为安全存储；
- 动态主机管理；
- 单主机重连；
- 增加统一 Operation Service；
- 增加审计日志；
- 增加 CLI；
- GUI 通过 IPC 管理 Core。

## 12. 开发顺序

### 第一步

- Fork `ssh-mcp-server`；
- 跑通多主机命令执行；
- 跑通上传下载；
- 验证 macOS 和 Windows。

### 第二步

- 建立 SQLite；
- 建立 Host Service；
- 建立 Credential Vault；
- 改造动态连接管理。

### 第三步

- 实现 Policy Service；
- 实现 Operation Service；
- 实现 Audit Service。

### 第四步

- 完成 Tauri 前端；
- 完成 MCP Adapter；
- 完成 CLI；
- 打包测试。

## 13. MVP 测试重点

- 密码认证；
- 私钥认证；
- SSH Config；
- 多主机切换；
- 单主机断线；
- 修改单台主机；
- 白名单和黑名单；
- 路径越界；
- 上传下载；
- 主机指纹变化；
- 凭据脱敏；
- MCP 重连；
- 操作日志完整性。

## 14. MVP 完成后的下一步

后续版本再增加：

- 交互式 PTY；
- `session_id`；
- 终端快照；
- 多终端并发；
- AI 与用户控制权切换；
- Full Terminal Use；
- 操作审批。
