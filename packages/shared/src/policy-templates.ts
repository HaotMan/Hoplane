import type { PolicyCommandRule, PolicyDocument } from "./types.js";

export type PolicyRisk = "LOW" | "MEDIUM" | "HIGH";

export interface PolicyTemplate {
  key: string;
  name: string;
  scenario: string;
  description: string;
  risk: PolicyRisk;
  recommended: boolean;
  document: PolicyDocument;
}

export interface BlacklistCatalogItem extends PolicyCommandRule {
  key: string;
  group: "SYSTEM" | "DOCKER" | "KUBERNETES" | "SHELL";
  label: string;
  risk: "MEDIUM" | "HIGH";
}

export const COMMAND_BLACKLIST_CATALOG: readonly BlacklistCatalogItem[] = [
  { key: "power", group: "SYSTEM", label: "关机与重启系统", risk: "HIGH", pattern: "^\\s*(?:shutdown|reboot|halt|poweroff|init)(?:\\s|$)", description: "禁止关机、重启和切换 init 级别" },
  { key: "packages", group: "SYSTEM", label: "安装与删除软件包", risk: "HIGH", pattern: "^\\s*(?:apt|apt-get|yum|dnf|rpm|dpkg|pacman|zypper)(?:\\s|$)", description: "禁止系统包管理命令" },
  { key: "filesystem", group: "SYSTEM", label: "文件与磁盘变更", risk: "HIGH", pattern: "^\\s*(?:rm|mv|cp|chmod|chown|chgrp|truncate|dd|mkfs(?:\\.\\w+)?|fdisk|parted|mount|umount)(?:\\s|$)", description: "禁止常见文件、权限、磁盘和挂载变更" },
  { key: "users", group: "SYSTEM", label: "用户与用户组变更", risk: "HIGH", pattern: "^\\s*(?:useradd|usermod|userdel|groupadd|groupmod|groupdel|passwd|chpasswd)(?:\\s|$)", description: "禁止修改系统账号" },
  { key: "signals", group: "SYSTEM", label: "终止进程", risk: "MEDIUM", pattern: "^\\s*(?:kill|pkill|killall)(?:\\s|$)", description: "禁止向进程发送终止信号" },
  { key: "systemctl-mutate", group: "SYSTEM", label: "systemctl 变更操作", risk: "HIGH", pattern: "^\\s*systemctl\\s+(?:start|stop|restart|reload|enable|disable|mask|unmask|daemon-reload|edit|set-property|kill|reset-failed)(?:\\s|$)", description: "禁止启动、停止、重启或修改 systemd 单元" },
  { key: "docker-change", group: "DOCKER", label: "Docker 常规变更", risk: "MEDIUM", pattern: "^\\s*docker\\s+(?:(?:--(?:config|context|host|log-level)(?:=\\S+|\\s+\\S+)|-H\\s+\\S+)\\s+)*(?:start|stop|restart|rename|pause|unpause|update)(?:\\s|$)", description: "禁止改变现有容器状态" },
  { key: "docker-danger", group: "DOCKER", label: "Docker 高风险操作", risk: "HIGH", pattern: "^\\s*docker\\s+(?:(?:--(?:config|context|host|log-level)(?:=\\S+|\\s+\\S+)|-H\\s+\\S+)\\s+)*(?:exec|run|rm|rmi|build|commit|import|load|pull|push|system\\s+prune|volume\\s+(?:rm|prune)|network\\s+(?:rm|prune)|compose\\s+(?:up|down|rm|run|exec|build|pull|push))(?:\\s|$)", description: "禁止容器内执行、创建、删除、构建和清理" },
  { key: "docker-all", group: "DOCKER", label: "全部 Docker 命令", risk: "HIGH", pattern: "^\\s*docker(?:\\s|$)", description: "禁止所有 Docker 与 Compose 命令" },
  { key: "k8s-change", group: "KUBERNETES", label: "Kubernetes 常规变更", risk: "MEDIUM", pattern: "^\\s*kubectl(?:\\s+(?:--context(?:=\\S+|\\s+\\S+)|-n\\s+\\S+|--namespace(?:=\\S+|\\s+\\S+)))*\\s+(?:rollout\\s+restart|scale|set)(?:\\s|$)", description: "禁止重启、扩缩容和 set 操作" },
  { key: "k8s-danger", group: "KUBERNETES", label: "Kubernetes 高风险操作", risk: "HIGH", pattern: "^\\s*kubectl(?:\\s+(?:--context(?:=\\S+|\\s+\\S+)|-n\\s+\\S+|--namespace(?:=\\S+|\\s+\\S+)))*\\s+(?:exec|apply|create|replace|patch|delete|edit|port-forward|cp|drain|cordon|uncordon|taint)(?:\\s|$)", description: "禁止远程执行、写入资源、删除和节点维护" },
  { key: "k8s-all", group: "KUBERNETES", label: "全部 kubectl 命令", risk: "HIGH", pattern: "^\\s*kubectl(?:\\s|$)", description: "禁止所有 Kubernetes 命令" },
  { key: "shell-operators", group: "SHELL", label: "Shell 组合符", risk: "MEDIUM", pattern: "(?:\\r|\\n|&&|\\|\\||[;|<>`]|\\$\\()", description: "禁止管道、重定向、命令替换和多命令组合" },
  { key: "shell-wrappers", group: "SHELL", label: "sudo/env/Shell 包装", risk: "HIGH", pattern: "^\\s*(?:sudo|env|sh|bash|zsh|dash|fish)(?:\\s|$)", description: "禁止通过提权、环境或 Shell 包装执行" }
];

const catalog = new Map(COMMAND_BLACKLIST_CATALOG.map((rule) => [rule.key, rule]));
const blacklist = (...keys: string[]): PolicyCommandRule[] => keys.map((key) => {
  const rule = catalog.get(key)!;
  return { pattern: rule.pattern, description: rule.description };
});
const commonMutation = ["power", "packages", "filesystem", "users", "signals", "systemctl-mutate", "shell-operators", "shell-wrappers"];

function base(commandBlacklist: PolicyCommandRule[] = [], files: Partial<PolicyDocument["files"]> = {}): PolicyDocument {
  return {
    schemaVersion: 3,
    commandBlacklist,
    files: {
      allowUpload: false, allowDownload: false, allowOverwrite: false,
      maxUploadBytes: 100 * 1024 * 1024, maxDownloadBytes: 100 * 1024 * 1024,
      allowedLocalPaths: [], allowedRemoteUploadPaths: [], allowedRemoteDownloadPaths: [],
      ...files
    }
  };
}

const fullFiles: PolicyDocument["files"] = {
  allowUpload: true, allowDownload: true, allowOverwrite: true,
  maxUploadBytes: 10 * 1024 * 1024 * 1024, maxDownloadBytes: 10 * 1024 * 1024 * 1024,
  allowedLocalPaths: ["/"], allowedRemoteUploadPaths: ["/"], allowedRemoteDownloadPaths: ["/"]
};

export const POLICY_TEMPLATES: readonly PolicyTemplate[] = [
  { key: "error-tracing", name: "错误追溯（推荐）", scenario: "应用报错、服务异常、线上问题定位", description: "默认允许排障查询，黑名单阻止系统、Docker 和 Kubernetes 变更。", risk: "LOW", recommended: true, document: base(blacklist(...commonMutation, "docker-change", "docker-danger", "k8s-change", "k8s-danger")) },
  { key: "system-inspection", name: "系统巡检（只读）", scenario: "资源、进程、网络和磁盘巡检", description: "允许系统查询，黑名单阻止系统变更及全部容器编排命令。", risk: "LOW", recommended: false, document: base(blacklist(...commonMutation, "docker-all", "k8s-all")) },
  { key: "docker-readonly", name: "Docker 排障（只读）", scenario: "容器状态、日志、资源和配置排查", description: "允许 Docker 查询，黑名单阻止容器变更和 Kubernetes 命令。", risk: "LOW", recommended: false, document: base(blacklist(...commonMutation, "docker-change", "docker-danger", "k8s-all")) },
  { key: "docker-operations", name: "Docker 运维（受限）", scenario: "查看并启停或重启容器", description: "允许 Docker 常规运维，黑名单阻止高风险容器操作和 Kubernetes 命令。", risk: "MEDIUM", recommended: false, document: base(blacklist(...commonMutation, "docker-danger", "k8s-all")) },
  { key: "kubernetes-readonly", name: "Kubernetes 排障（只读）", scenario: "工作负载、事件、日志和发布状态排查", description: "允许 Kubernetes 查询，黑名单阻止集群变更和 Docker 命令。", risk: "LOW", recommended: false, document: base(blacklist(...commonMutation, "docker-all", "k8s-change", "k8s-danger")) },
  { key: "kubernetes-operations", name: "Kubernetes 应用运维（受限）", scenario: "应用重启、扩缩容和发布状态检查", description: "允许常规应用运维，黑名单阻止高风险集群操作和 Docker 命令。", risk: "MEDIUM", recommended: false, document: base(blacklist(...commonMutation, "docker-all", "k8s-danger")) },
  { key: "deny-all", name: "完全禁用", scenario: "待审批、隔离观察或临时冻结", description: "使用匹配所有命令的黑名单规则，并关闭文件传输。", risk: "LOW", recommended: false, document: base([{ pattern: "[\\s\\S]*", description: "禁止所有命令" }]) },
  { key: "full-access", name: "全权限（高风险）", scenario: "隔离环境、低权限账号或人工监督操作", description: "命令黑名单为空，允许任意命令；文件传输允许任意路径。", risk: "HIGH", recommended: false, document: base([], fullFiles) }
];

export const DEFAULT_POLICY_TEMPLATE = POLICY_TEMPLATES[0]!;
export function findPolicyTemplateByName(name: string): PolicyTemplate | undefined { return POLICY_TEMPLATES.find((template) => template.name === name); }
export function findPolicyTemplate(key: string): PolicyTemplate | undefined { return POLICY_TEMPLATES.find((template) => template.key === key); }
