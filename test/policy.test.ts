import { describe, expect, it } from "vitest";
import { PolicyService } from "../packages/policy/src/index.js";
import { findPolicyTemplate, policyDocumentSchema, type PolicyDocument } from "../packages/shared/src/index.js";

function policy(commandBlacklist: PolicyDocument["commandBlacklist"] = []): PolicyDocument {
  return {
    schemaVersion: 4,
    commandBlacklist,
    files: {
      allowUpload: false, allowDownload: false, allowOverwrite: false,
      maxUploadBytes: 1024, maxDownloadBytes: 1024,
      allowedLocalPaths: [], allowedRemoteUploadPaths: [], allowedRemoteDownloadPaths: []
    }
  };
}

describe("PolicyService V3 blacklist mode", () => {
  const service = new PolicyService();

  it("allows commands by default and denies only matching blacklist rules", () => {
    const document = policy([{ pattern: "^\\s*shutdown(?:\\s|$)", description: "禁止关机" }]);
    expect(service.evaluateCommand(document, "uptime").reasonCode).toBe("BLACKLIST_CLEAR");
    expect(service.evaluateCommand(document, "shutdown now")).toMatchObject({
      decision: "DENY", reasonCode: "COMMAND_BLACKLISTED", matchedRule: "^\\s*shutdown(?:\\s|$)"
    });
  });

  it("treats an empty blacklist as unrestricted command access", () => {
    const fullAccess = findPolicyTemplate("full-access")!.document;
    expect(fullAccess.commandBlacklist).toEqual([]);
    for (const command of [
      "systemctl list-units --state=failed",
      "systemctl restart nginx",
      "docker exec api sh",
      "kubectl delete pod api",
      "echo ok && whoami"
    ]) expect(service.evaluateCommand(fullAccess, command).decision).toBe("ALLOW");
  });

  it("keeps diagnostic templates permissive for queries and blocks mutations", () => {
    const tracing = findPolicyTemplate("error-tracing")!.document;
    expect(service.evaluateCommand(tracing, "journalctl -u nginx -n 100 --no-pager").decision).toBe("ALLOW");
    expect(service.evaluateCommand(tracing, "systemctl list-units --state=failed").decision).toBe("ALLOW");
    expect(service.evaluateCommand(tracing, "systemctl restart nginx").decision).toBe("DENY");
    expect(service.evaluateCommand(tracing, "shutdown now").decision).toBe("DENY");
    expect(service.evaluateCommand(tracing, "docker restart api").decision).toBe("DENY");
    expect(service.evaluateCommand(tracing, "kubectl delete pod api").decision).toBe("DENY");
    expect(tracing.files).toMatchObject({ allowUpload: false, allowDownload: false, allowOverwrite: false });
  });

  it("combines Docker and Kubernetes permissions into container templates", () => {
    const readOnly = findPolicyTemplate("container-readonly")!.document;
    expect(service.evaluateCommand(readOnly, "docker ps").decision).toBe("ALLOW");
    expect(service.evaluateCommand(readOnly, "docker restart api").decision).toBe("DENY");
    expect(service.evaluateCommand(readOnly, "kubectl get pods").decision).toBe("ALLOW");
    expect(service.evaluateCommand(readOnly, "kubectl scale deployment api --replicas=2").decision).toBe("DENY");

    const operations = findPolicyTemplate("container-operations")!.document;
    expect(service.evaluateCommand(operations, "docker restart api").decision).toBe("ALLOW");
    expect(service.evaluateCommand(operations, "docker exec api sh").decision).toBe("DENY");
    expect(service.evaluateCommand(operations, "kubectl scale deployment api --replicas=2").decision).toBe("ALLOW");
    expect(service.evaluateCommand(operations, "kubectl exec api -- sh").decision).toBe("DENY");
  });

  it("supports a match-all blacklist for completely disabled policies", () => {
    expect(service.evaluateCommand(findPolicyTemplate("deny-all")!.document, "uptime").decision).toBe("DENY");
  });

  it("cannot be bypassed by quote splitting, escapes, prefixes or chained commands", () => {
    const document = policy([{ pattern: "^\\s*(?:rm|dd)(?:\\s|$)", description: "禁止删除" }]);
    expect(service.evaluateCommand(document, "rm -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "r''m -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "r\"\"m -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "r\\m -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "VAR=x rm -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "echo ok; rm -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "time rm -rf /").decision).toBe("DENY");
    expect(service.evaluateCommand(document, "echo \"$(rm -rf /)\"").decision).toBe("DENY");
  });

  it("still allows deletion commands that only appear as quoted arguments", () => {
    const document = policy([{ pattern: "^\\s*(?:rm|dd)(?:\\s|$)", description: "禁止删除" }]);
    expect(service.evaluateCommand(document, "echo 'rm -rf /'").decision).toBe("ALLOW");
    expect(service.evaluateCommand(document, "echo \"a$() rm -rf /\"").decision).toBe("ALLOW");
    expect(service.evaluateCommand(document, "grep rm /var/log/app.log").decision).toBe("ALLOW");
    expect(service.evaluateCommand(document, "myrm file").decision).toBe("ALLOW");
  });

  it("applies source and destination file constraints to host transfers", () => {
    const source = policy();
    source.files.allowedRemoteDownloadPaths = ["/exports"];
    expect(service.evaluateHostTransferSource(source, "/exports/release.tar").reasonCode).toBe("SOURCE_DOWNLOAD_DISABLED");
    source.files.allowDownload = true;
    expect(service.evaluateHostTransferSource(source, "/exports/release.tar")).toMatchObject({ decision: "ALLOW", normalizedRemotePath: "/exports/release.tar" });
    expect(service.evaluateHostTransferSource(source, "/private/release.tar").reasonCode).toBe("SOURCE_REMOTE_PATH_NOT_ALLOWED");

    const destination = policy();
    destination.files.allowUpload = true;
    destination.files.allowedRemoteUploadPaths = ["/imports"];
    expect(service.evaluateHostTransferDestination(destination, "/imports/release.tar").decision).toBe("ALLOW");
    expect(service.evaluateHostTransferDestination(destination, "/outside/release.tar").reasonCode).toBe("DESTINATION_REMOTE_PATH_NOT_ALLOWED");
    expect(service.evaluateHostTransferSize(source, destination, 1025).reasonCode).toBe("SOURCE_FILE_TOO_LARGE");
  });

  it("normalizes legacy policy documents without retaining the host transfer switch", () => {
    const current = policy();
    const upgraded = policyDocumentSchema.parse({ ...current, schemaVersion: 3, files: { ...current.files, allowHostTransfer: true } });
    expect(upgraded).toMatchObject({ schemaVersion: 4 });
    expect(upgraded.files).not.toHaveProperty("allowHostTransfer");
  });
});
