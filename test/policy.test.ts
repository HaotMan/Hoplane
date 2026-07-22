import { describe, expect, it } from "vitest";
import { PolicyService } from "../packages/policy/src/index.js";
import { findPolicyTemplate, type PolicyDocument } from "../packages/shared/src/index.js";

function policy(commandBlacklist: PolicyDocument["commandBlacklist"] = []): PolicyDocument {
  return {
    schemaVersion: 3,
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

  it("uses progressively narrower Docker and Kubernetes blacklists", () => {
    const dockerReadOnly = findPolicyTemplate("docker-readonly")!.document;
    const dockerOperations = findPolicyTemplate("docker-operations")!.document;
    expect(service.evaluateCommand(dockerReadOnly, "docker ps").decision).toBe("ALLOW");
    expect(service.evaluateCommand(dockerReadOnly, "docker restart api").decision).toBe("DENY");
    expect(service.evaluateCommand(dockerOperations, "docker restart api").decision).toBe("ALLOW");
    expect(service.evaluateCommand(dockerOperations, "docker exec api sh").decision).toBe("DENY");

    const k8sReadOnly = findPolicyTemplate("kubernetes-readonly")!.document;
    const k8sOperations = findPolicyTemplate("kubernetes-operations")!.document;
    expect(service.evaluateCommand(k8sReadOnly, "kubectl get pods").decision).toBe("ALLOW");
    expect(service.evaluateCommand(k8sReadOnly, "kubectl scale deployment api --replicas=2").decision).toBe("DENY");
    expect(service.evaluateCommand(k8sOperations, "kubectl scale deployment api --replicas=2").decision).toBe("ALLOW");
    expect(service.evaluateCommand(k8sOperations, "kubectl exec api -- sh").decision).toBe("DENY");
  });

  it("supports a match-all blacklist for completely disabled policies", () => {
    expect(service.evaluateCommand(findPolicyTemplate("deny-all")!.document, "uptime").decision).toBe("DENY");
  });
});
