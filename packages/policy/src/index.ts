import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import * as posix from "node:path/posix";
import type { PolicyDocument, PolicyResult } from "../../shared/src/index.js";

export class PolicyService {
  evaluateCommand(policy: PolicyDocument, command: string, _directory?: string): PolicyResult {
    if (!command.trim()) return deny("COMMAND_EMPTY", "Command is empty");
    for (const rule of policy.commandBlacklist) {
      if (new RegExp(rule.pattern, "u").test(command)) {
        return deny("COMMAND_BLACKLISTED", rule.description ?? "Command matched a blacklist rule", rule.pattern);
      }
    }
    return allow("BLACKLIST_CLEAR", "Command did not match any blacklist rule");
  }

  async evaluateUpload(policy: PolicyDocument, localPath: string, remotePath: string): Promise<PolicyResult & { canonicalLocalPath?: string; normalizedRemotePath?: string; size?: number }> {
    const files = policy.files;
    if (!files.allowUpload) return deny("UPLOAD_DISABLED", "Uploads are disabled by this policy");
    let local: { path: string; size: number };
    try { local = await canonicalExistingFile(localPath); }
    catch { return deny("LOCAL_PATH_INVALID", "Local upload source does not exist or is not a regular file"); }
    if (!insideAnyLocalRoot(local.path, files.allowedLocalPaths)) return deny("LOCAL_PATH_NOT_ALLOWED", "Local path is outside allowed roots");
    if (local.size > files.maxUploadBytes) return deny("FILE_TOO_LARGE", "Upload exceeds the configured size limit");
    const remote = normalizeRemote(remotePath);
    const remoteDecision = evaluateRemotePath(remote, files.allowedRemoteUploadPaths);
    if (remoteDecision.decision === "DENY") return remoteDecision;
    return { ...allow("UPLOAD_ALLOWED", "Upload is permitted"), canonicalLocalPath: local.path, normalizedRemotePath: remote, size: local.size };
  }

  async evaluateDownload(policy: PolicyDocument, remotePath: string, localPath: string): Promise<PolicyResult & { canonicalLocalPath?: string; normalizedRemotePath?: string }> {
    const files = policy.files;
    if (!files.allowDownload) return deny("DOWNLOAD_DISABLED", "Downloads are disabled by this policy");
    let local: string;
    try { local = await canonicalDestination(localPath); }
    catch { return deny("LOCAL_PATH_INVALID", "Local destination parent does not exist or is not accessible"); }
    if (!insideAnyLocalRoot(local, files.allowedLocalPaths)) return deny("LOCAL_PATH_NOT_ALLOWED", "Local path is outside allowed roots");
    const remote = normalizeRemote(remotePath);
    const remoteDecision = evaluateRemotePath(remote, files.allowedRemoteDownloadPaths);
    if (remoteDecision.decision === "DENY") return remoteDecision;
    return { ...allow("DOWNLOAD_ALLOWED", "Download is permitted"), canonicalLocalPath: local, normalizedRemotePath: remote };
  }

  evaluateCanonicalRemote(path: string, allowedRoots: string[]): PolicyResult { return evaluateRemotePath(path, allowedRoots); }
}

function evaluateRemotePath(path: string, roots: string[]): PolicyResult {
  let normalizedPath: string;
  try { normalizedPath = normalizeRemote(path); }
  catch { return deny("REMOTE_PATH_INVALID", "Remote path must be an absolute POSIX path"); }
  if (roots.length === 0) return deny("NO_ALLOWED_REMOTE_ROOTS", "No remote paths are allowed");
  const valid = roots.some((root) => { try { return insidePosix(normalizedPath, normalizeRemote(root)); } catch { return false; } });
  return valid ? allow("REMOTE_PATH_ALLOWED", "Remote path is within an allowed root") : deny("REMOTE_PATH_NOT_ALLOWED", "Remote path is outside allowed roots");
}

export function normalizeRemote(path: string): string {
  if (!posix.isAbsolute(path) || path.includes("\0")) throw new Error("invalid remote path");
  return posix.normalize(path);
}

function insidePosix(path: string, root: string): boolean { return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`); }
async function canonicalExistingFile(path: string): Promise<{ path: string; size: number }> { const canonical = await realpath(resolve(path)); const info = await stat(canonical); if (!info.isFile()) throw new Error("not a file"); return { path: canonical, size: info.size }; }
async function canonicalDestination(path: string): Promise<string> { const absolute = resolve(path); try { return await realpath(absolute); } catch { const parent = await realpath(dirname(absolute)); return resolve(parent, absolute.slice(dirname(absolute).length + 1)); } }
function insideAnyLocalRoot(path: string, roots: string[]): boolean { return roots.some((root) => { if (!isAbsolute(root)) return false; const normalizedRoot = normalize(resolve(root)); const rel = relative(normalizedRoot, normalize(path)); return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)); }); }
function allow(reasonCode: string, reason: string): PolicyResult { return { decision: "ALLOW", reasonCode, reason }; }
function deny(reasonCode: string, reason: string, matchedRule?: string): PolicyResult { return { decision: "DENY", reasonCode, reason, ...(matchedRule ? { matchedRule } : {}) }; }
