import type { Host } from "./types";

export const UNGROUPED_HOSTS_KEY = "ungrouped";

export interface HostGroup {
  key: string;
  name: string;
  hosts: Host[];
  ungrouped: boolean;
}

export function groupHosts(hosts: Host[]): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  for (const host of hosts) {
    const groupName = host.groupName?.trim() ?? "";
    const key = groupName ? `named:${groupName}` : UNGROUPED_HOSTS_KEY;
    const group = groups.get(key) ?? { key, name: groupName || "未分组", hosts: [], ungrouped: !groupName };
    group.hosts.push(host);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, hosts: [...group.hosts].sort(compareHost) }))
    .sort((left, right) => Number(left.ungrouped) - Number(right.ungrouped) || left.name.localeCompare(right.name, "zh-CN"));
}

export function selectedHostCopyText(hosts: Host[], selectedIds: ReadonlySet<string>): string {
  return hosts.filter((host) => selectedIds.has(host.id)).map((host) => `${host.name}\t${host.hostname}`).join("\n");
}

function compareHost(left: Host, right: Host): number {
  return left.name.localeCompare(right.name, "zh-CN") || left.hostname.localeCompare(right.hostname);
}
