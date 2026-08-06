import { describe, expect, it } from "vitest";
import { groupHosts, selectedHostCopyText, UNGROUPED_HOSTS_KEY } from "../apps/desktop/src/host-list.js";
import type { Host } from "../apps/desktop/src/types.js";

function host(id: string, name: string, groupName: string | null): Host {
  return {
    id, name, groupName, hostname: `${id}.example.test`, port: 22, username: "root",
    credentialId: null, policyId: null, tags: [], defaultDirectory: null,
    enabled: true, aiAccessEnabled: true, hostTransferEnabled: false, monitorOutputEnabled: false, status: "DISCONNECTED"
  };
}

describe("host list grouping", () => {
  it("groups and sorts named hosts while placing ungrouped hosts last", () => {
    const groups = groupHosts([
      host("3", "数据库", null), host("2", "应用 B", "生产环境"),
      host("1", "应用 A", "生产环境"), host("4", "测试机", "测试环境")
    ]);
    expect(groups.map((group) => [group.key, group.name, group.hosts.map((item) => item.name)])).toEqual([
      ["named:测试环境", "测试环境", ["测试机"]],
      ["named:生产环境", "生产环境", ["应用 A", "应用 B"]],
      [UNGROUPED_HOSTS_KEY, "未分组", ["数据库"]]
    ]);
  });

  it("copies selected display names and host addresses in current host order", () => {
    const hosts = [host("1", "应用 A", "生产环境"), host("2", "数据库", null), host("3", "缓存", "生产环境")];
    expect(selectedHostCopyText(hosts, new Set(["1", "3"]))).toBe("应用 A\t1.example.test\n缓存\t3.example.test");
    expect(selectedHostCopyText(hosts, new Set())).toBe("");
  });
});
