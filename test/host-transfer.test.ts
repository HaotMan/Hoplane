import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HoplaneDatabase } from "../packages/core/src/database.js";
import { HostMonitor } from "../packages/core/src/host-monitor.js";
import { OperationService } from "../packages/core/src/operation-service.js";
import { PolicyService } from "../packages/policy/src/index.js";
import type { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import type { HostMonitorEvent, PolicyDocument } from "../packages/shared/src/index.js";

const dirs: string[] = [];
afterEach(async () => { while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }); });

async function fixture(sourceTransferEnabled = true, destinationTransferEnabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "hoplane-transfer-test-")); dirs.push(dir);
  const database = new HoplaneDatabase(join(dir, "test.sqlite3"));
  const base = database.listPolicies()[0]!.document;
  const sourceDocument: PolicyDocument = {
    ...base,
    files: {
      ...base.files,
      allowDownload: true,
      maxDownloadBytes: 4096,
      allowedRemoteDownloadPaths: ["/exports"]
    }
  };
  const destinationDocument: PolicyDocument = {
    ...base,
    files: {
      ...base.files,
      allowUpload: true,
      allowOverwrite: false,
      maxUploadBytes: 4096,
      allowedRemoteUploadPaths: ["/imports"]
    }
  };
  const sourcePolicy = database.createPolicy("transfer source", sourceDocument);
  const destinationPolicy = database.createPolicy("transfer destination", destinationDocument);
  const source = database.createHost({
    name: "source", hostname: "source.test", port: 22, username: "source", credentialId: null,
    policyId: sourcePolicy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true,
    hostTransferEnabled: sourceTransferEnabled
  });
  const destination = database.createHost({
    name: "destination", hostname: "destination.test", port: 22, username: "destination", credentialId: null,
    policyId: destinationPolicy.id, groupName: null, tags: [], defaultDirectory: null, enabled: true, aiAccessEnabled: true,
    hostTransferEnabled: destinationTransferEnabled
  });
  const relayFile = vi.fn(async () => ({ bytesTransferred: 2048, transport: "SFTP" as const }));
  const ssh = {
    getStatus: () => "CONNECTED",
    getProxyState: () => ({ status: "DISABLED" }),
    resolveRemotePathForRelay: async (_hostId: string, path: string) => path,
    getRemoteRegularFileInfoForRelay: async () => ({ size: 2048 }),
    relayFile
  } as unknown as SSHConnectionManager;
  const monitor = new HostMonitor();
  return { database, source, destination, sourcePolicy, destinationPolicy, relayFile, ssh, monitor };
}

describe("host-to-host transfer operation", () => {
  it("applies both policies, relays once, and exposes one audit operation from both hosts", async () => {
    const current = await fixture();
    const sourceEvents: HostMonitorEvent[] = [];
    const destinationEvents: HostMonitorEvent[] = [];
    current.monitor.subscribe(current.source.id, (event) => sourceEvents.push(event));
    current.monitor.subscribe(current.destination.id, (event) => destinationEvents.push(event));
    const operations = new OperationService(current.database, new PolicyService(), current.ssh, current.monitor);
    expect(operations.listHosts(true).find((host) => host.id === current.source.id)?.capabilities).toEqual(expect.arrayContaining(["download", "transfer_source"]));
    expect(operations.listHosts(true).find((host) => host.id === current.destination.id)?.capabilities).toEqual(expect.arrayContaining(["upload", "transfer_destination"]));

    const result = await operations.transferFile({
      sourceHostId: current.source.id,
      sourcePath: "/exports/release.tar",
      destinationHostId: current.destination.id,
      destinationPath: "/imports/release.tar",
      clientType: "MCP",
      clientId: "agent-test"
    });

    expect(result.bytesTransferred).toBe(2048);
    expect(result.transport).toBe("SFTP");
    expect(current.relayFile).toHaveBeenCalledWith(expect.objectContaining({
      sourceHostId: current.source.id,
      sourcePath: "/exports/release.tar",
      destinationHostId: current.destination.id,
      destinationPath: "/imports/release.tar",
      expectedSize: 2048,
      allowOverwrite: false,
      operationId: result.operationId
    }));
    const sourceAudit = current.database.listAudit({ hostId: current.source.id, limit: 10 })[0]!;
    const destinationAudit = current.database.listAudit({ hostId: current.destination.id, limit: 10 })[0]!;
    expect(sourceAudit.id).toBe(result.operationId);
    expect(destinationAudit.id).toBe(result.operationId);
    expect(sourceAudit).toMatchObject({
      operationType: "TRANSFER_FILE",
      status: "SUCCEEDED",
      hostId: current.source.id,
      peerHostId: current.destination.id,
      policyId: current.sourcePolicy.id,
      peerPolicyId: current.destinationPolicy.id,
      bytesTransferred: 2048
    });
    expect(sourceEvents.some((event) => event.status === "SUCCEEDED")).toBe(true);
    expect(destinationEvents.some((event) => event.status === "SUCCEEDED")).toBe(true);
    current.database.close();
  });

  it("denies a disabled source relay before opening an SFTP stream", async () => {
    const current = await fixture(false);
    const operations = new OperationService(current.database, new PolicyService(), current.ssh, current.monitor);
    expect(operations.listHosts(true).find((host) => host.id === current.source.id)?.capabilities).toEqual(expect.not.arrayContaining(["transfer_source"]));
    await expect(operations.transferFile({
      sourceHostId: current.source.id,
      sourcePath: "/exports/release.tar",
      destinationHostId: current.destination.id,
      destinationPath: "/imports/release.tar",
      clientType: "MCP"
    })).rejects.toMatchObject({ code: "HOST_TRANSFER_DISABLED", details: { hostId: current.source.id, role: "source" } });
    expect(current.relayFile).not.toHaveBeenCalled();
    expect(current.database.listAudit({ hostId: current.destination.id, limit: 10 })[0]).toMatchObject({
      status: "DENIED", decisionReasonCode: "SOURCE_HOST_TRANSFER_DISABLED"
    });
    current.database.close();
  });

  it("requires the destination host switch as well", async () => {
    const current = await fixture(true, false);
    const operations = new OperationService(current.database, new PolicyService(), current.ssh, current.monitor);
    expect(operations.listHosts(true).find((host) => host.id === current.destination.id)?.capabilities).toEqual(expect.not.arrayContaining(["transfer_destination"]));
    await expect(operations.transferFile({
      sourceHostId: current.source.id,
      sourcePath: "/exports/release.tar",
      destinationHostId: current.destination.id,
      destinationPath: "/imports/release.tar",
      clientType: "MCP"
    })).rejects.toMatchObject({ code: "HOST_TRANSFER_DISABLED", details: { hostId: current.destination.id, role: "destination" } });
    expect(current.relayFile).not.toHaveBeenCalled();
    expect(current.database.listAudit({ hostId: current.source.id, limit: 10 })[0]).toMatchObject({
      status: "DENIED", decisionReasonCode: "DESTINATION_HOST_TRANSFER_DISABLED"
    });
    current.database.close();
  });

  it("rejects a same-host request before policy and SSH evaluation", async () => {
    const current = await fixture();
    const operations = new OperationService(current.database, new PolicyService(), current.ssh, current.monitor);
    await expect(operations.transferFile({
      sourceHostId: current.source.id,
      sourcePath: "/exports/release.tar",
      destinationHostId: current.source.id,
      destinationPath: "/exports/copy.tar",
      clientType: "MCP"
    })).rejects.toMatchObject({ code: "HOST_TRANSFER_SAME_HOST" });
    expect(current.relayFile).not.toHaveBeenCalled();
    current.database.close();
  });
});
