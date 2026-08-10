import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, stat, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, normalize, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z, ZodError } from "zod";
import {
  AppError, asAppError, commandRequestSchema, credentialInputSchema, DEFAULT_POLICY_TEMPLATE, hostInputSchema, hostLoginInputSchema, hostPatchSchema,
  policyInputSchema, transferRequestSchema, hostTransferRequestSchema
} from "../../shared/src/index.js";
import type { Credential, Host } from "../../shared/src/index.js";
import { loadConfig, ensurePrivateDirectory, getOrCreateCoreToken } from "./config.js";
import { HoplaneDatabase } from "./database.js";
import { LocalCredentialVaultManager } from "./vault-manager.js";
import { PolicyService } from "../../policy/src/index.js";
import { SSHConnectionManager } from "../../ssh-core/src/connection-manager.js";
import { OperationService } from "./operation-service.js";
import { parseSshConfig } from "./ssh-config-import.js";
import { McpServiceManager } from "./mcp-service.js";
import { HostMonitor } from "./host-monitor.js";
import { CodexIntegrationService, JsonAgentIntegrationService } from "./codex-integration.js";
import { PolicySourceService } from "./policy-source.js";
import { attachTerminalGateway } from "./terminal-service.js";

const credentialBindingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("NONE") }),
  z.object({
    mode: z.literal("INLINE"),
    credentialId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(120),
    type: z.enum(["PASSWORD", "PRIVATE_KEY", "SSH_AGENT"]),
    secret: z.string().max(16_384).optional(),
    sudoMode: z.enum(["NONE", "LOGIN_PASSWORD", "CUSTOM_PASSWORD"]).optional(),
    sudoSecret: z.string().max(16_384).optional(),
    metadata: z.object({
      privateKeyPath: z.string().trim().max(4096).optional(),
      agentSocket: z.string().trim().max(4096).optional()
    }).default({})
  })
]);

type CredentialBinding = z.infer<typeof credentialBindingSchema>;

export interface CoreRuntime {
  url: string;
  server: Server;
  close(): Promise<void>;
}

/*
 * Core 可能被三种方式启动：项目根目录下的 dev/CLI、编译产物 node dist/...、以及被
 * MCP 适配器以任意 cwd 直接拉起（打包 app 内也是如此）。因此静态 UI 目录不能只依赖
 * process.cwd()，还要按模块自身位置向上找。
 */
function resolveDefaultStaticRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "apps", "desktop", "dist"),
    resolvePath(moduleDir, "..", "..", "..", "apps", "desktop", "dist"),
    resolvePath(moduleDir, "..", "..", "..", "..", "apps", "desktop", "dist")
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}

export async function computeUiBuildId(staticRoot: string): Promise<string | null> {
  try {
    const index = await readFile(join(staticRoot, "index.html"));
    return createHash("sha256").update(index).digest("hex").slice(0, 16);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function startCore(options: { staticRoot?: string; registerProcessSignals?: boolean } = {}): Promise<CoreRuntime> {
const config = loadConfig();
await ensurePrivateDirectory(config.dataDir);
const token = await getOrCreateCoreToken(config);
const database = new HoplaneDatabase(config.databasePath);
const policySources = new PolicySourceService(config, database);
await policySources.initialize();
database.interruptStaleOperations();
const vault = new LocalCredentialVaultManager(config);
const ssh = new SSHConnectionManager(database, vault, config.outputLimitBytes);
const monitor = new HostMonitor(500, vault.local);
const operations = new OperationService(database, new PolicyService(), ssh, monitor);
const mcpService = new McpServiceManager(config, database, vault, operations);
const savedCodexHome = database.getSetting<string | null>("codex.home", null);
const codexIntegration = new CodexIntegrationService(savedCodexHome ? { codexHome: savedCodexHome } : {});
const savedCursorDirectory = database.getSetting<string | null>("integration.cursor.directory", null);
const savedClaudeCodeDirectory = database.getSetting<string | null>("integration.claude-code.directory", null);
const savedWorkbuddyDirectory = database.getSetting<string | null>("integration.workbuddy.directory", null);
const cursorIntegration = new JsonAgentIntegrationService("cursor", savedCursorDirectory ? { configDirectory: savedCursorDirectory } : {});
const claudeCodeIntegration = new JsonAgentIntegrationService("claude-code", savedClaudeCodeDirectory ? { configDirectory: savedClaudeCodeDirectory } : {});
const workbuddyIntegration = new JsonAgentIntegrationService("workbuddy", savedWorkbuddyDirectory ? { configDirectory: savedWorkbuddyDirectory } : {});
const jsonAgentIntegrations = { cursor: cursorIntegration, "claude-code": claudeCodeIntegration, workbuddy: workbuddyIntegration } as const;
const staticRoot = options.staticRoot ?? resolveDefaultStaticRoot();
const uiBuildId = await computeUiBuildId(staticRoot);

const server = createServer(async (request, response) => {
  try {
    applySecurityHeaders(response);
    const url = new URL(request.url ?? "/", `http://${config.host}:${config.port}`);
    if (url.pathname === "/health" && request.method === "GET") return json(response, 200, { status: "ok", version: "0.1.4", uiBuildId, mcpEnabled: mcpService.isEnabled() });
    if (url.pathname === "/mcp") {
      const parsed = request.method === "POST" ? await body(request) : undefined;
      return await mcpService.handle(request, response, parsed);
    }
    if (url.pathname.startsWith("/v1/")) {
      authorize(request);
      return await routeApi(request, response, url);
    }
    if (request.method === "GET") return await serveStatic(response, url.pathname);
    throw new AppError("NOT_FOUND", "Route not found", false, undefined, undefined, 404);
  } catch (error) {
    const appError = normalizeHttpError(error);
    json(response, appError.statusCode, appError.toJSON());
  }
});

server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
const terminalGateway = attachTerminalGateway(server, { database, ssh, isSameOriginUiRequest });
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, resolve);
});
await writeFile(config.pidPath, `${process.pid}\n`, { mode: 0o600 });
process.stderr.write(`Hoplane Core listening on http://${config.host}:${config.port}\n`);

if (options.registerProcessSignals) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown().finally(() => process.exit(0)));
  }
}

let shutdownPromise: Promise<void> | null = null;
function shutdown(): Promise<void> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<void> {
  terminalGateway.closeAll();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await ssh.closeAll();
  await policySources.close();
  vault.local.lock();
  database.close();
  await unlink(config.pidPath).catch(() => undefined);
}

async function prepareCredentialBinding(host: Host | null, binding: CredentialBinding, hostName: string, editableCredentialId = host?.credentialId ?? null): Promise<{ credentialId: string | null; createdCredentialId: string | null }> {
  if (binding.mode === "NONE") return { credentialId: null, createdCredentialId: null };

  const current = binding.credentialId ? database.getCredential(binding.credentialId) : null;
  const belongsToHost = Boolean(host && current && current.id === editableCredentialId && database.hostOwnsCredential(host.id, current.id));
  if (binding.credentialId && !belongsToHost) {
    throw new AppError("CREDENTIAL_NOT_EDITABLE", "This credential does not belong to the host", false, undefined, undefined, 409);
  }
  const updateCurrent = Boolean(current && belongsToHost && database.credentialUsageCount(current.id) <= 1);
  validateInlineCredential(binding, belongsToHost ? current : null);
  const sudoMode = binding.sudoMode ?? current?.sudoMode ?? "NONE";
  const metadata = binding.type === "PRIVATE_KEY"
    ? { privateKeyPath: binding.metadata.privateKeyPath }
    : binding.type === "SSH_AGENT" && binding.metadata.agentSocket
      ? { agentSocket: binding.metadata.agentSocket }
      : {};
  const name = binding.name.trim() || `${hostName} login`;

  if (updateCurrent && current) {
    const previousRef = current.secretRef;
    const previousSudoRef = current.sudoSecretRef;
    const retainsSecret = binding.secret === undefined && binding.type === current.type && binding.type !== "SSH_AGENT";
    let nextRef = retainsSecret ? previousRef : null;
    let nextSudoRef = sudoMode === "CUSTOM_PASSWORD" && binding.sudoSecret === undefined ? previousSudoRef : null;
    let previousSecret: string | null = null;
    let previousSudoSecret: string | null = null;
    if (binding.secret !== undefined) {
      nextRef = previousRef ?? randomUUID();
      if (previousRef) previousSecret = await vault.resolve(previousRef);
      await vault.save(nextRef, binding.secret);
    }
    if (sudoMode === "CUSTOM_PASSWORD" && binding.sudoSecret !== undefined) {
      nextSudoRef = previousSudoRef ?? randomUUID();
      if (previousSudoRef) previousSudoSecret = await vault.resolve(previousSudoRef);
      await vault.save(nextSudoRef, binding.sudoSecret);
    }
    try {
      database.updateCredential(current.id, name, binding.type, nextRef, metadata, sudoMode, nextSudoRef);
    } catch (error) {
      if (binding.secret !== undefined && nextRef) {
        if (previousRef && previousSecret !== null) await vault.save(previousRef, previousSecret);
        else await vault.delete(nextRef);
      }
      if (binding.sudoSecret !== undefined && nextSudoRef) {
        if (previousSudoRef && previousSudoSecret !== null) await vault.save(previousSudoRef, previousSudoSecret);
        else await vault.delete(nextSudoRef);
      }
      throw error;
    }
    if (previousRef && previousRef !== nextRef) await vault.delete(previousRef);
    if (previousSudoRef && previousSudoRef !== nextSudoRef) await vault.delete(previousSudoRef);
    return { credentialId: current.id, createdCredentialId: null };
  }

  const clonedSecret = binding.secret === undefined && current?.type === binding.type && current.secretRef
    ? await vault.resolve(current.secretRef)
    : binding.secret;
  const secretRef = clonedSecret !== undefined ? randomUUID() : null;
  const sudoSecretRef = sudoMode === "CUSTOM_PASSWORD" && binding.sudoSecret !== undefined ? randomUUID() : null;
  if (secretRef) await vault.save(secretRef, clonedSecret!);
  if (sudoSecretRef) await vault.save(sudoSecretRef, binding.sudoSecret!);
  try {
    const credential = database.createCredential(name, binding.type, secretRef, metadata, sudoMode, sudoSecretRef);
    return { credentialId: credential.id, createdCredentialId: credential.id };
  } catch (error) {
    if (secretRef) await vault.delete(secretRef);
    if (sudoSecretRef) await vault.delete(sudoSecretRef);
    throw error;
  }
}

function validateInlineCredential(binding: Extract<CredentialBinding, { mode: "INLINE" }>, current: Credential | null): void {
  const canRetainPassword = current?.type === "PASSWORD" && current.hasSecret;
  if (binding.type === "PASSWORD" && binding.secret === undefined && !canRetainPassword) {
    throw new AppError("INVALID_ARGUMENT", "Password is required for password authentication");
  }
  if (binding.type === "PRIVATE_KEY" && !binding.metadata.privateKeyPath) {
    throw new AppError("INVALID_ARGUMENT", "Private key path is required for private key authentication");
  }
  const sudoMode = binding.sudoMode ?? current?.sudoMode ?? "NONE";
  if (sudoMode === "LOGIN_PASSWORD" && binding.type !== "PASSWORD") {
    throw new AppError("INVALID_ARGUMENT", "Only password-authenticated hosts can reuse the login password for sudo");
  }
  const canRetainSudoSecret = current?.sudoMode === "CUSTOM_PASSWORD" && current.hasSudoSecret;
  if (sudoMode === "CUSTOM_PASSWORD" && binding.sudoSecret === undefined && !canRetainSudoSecret) {
    throw new AppError("INVALID_ARGUMENT", "Sudo password is required when managed sudo authentication is enabled");
  }
}

async function removeUnusedCredential(credentialId: string): Promise<void> {
  const credential = database.getCredential(credentialId);
  if (!credential || database.credentialUsageCount(credentialId) > 0) return;
  if (credential.secretRef) await vault.delete(credential.secretRef);
  if (credential.sudoSecretRef) await vault.delete(credential.sudoSecretRef);
  database.deleteCredential(credentialId);
}

async function routeApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/v1/vault-settings") {
    return json(response, 200, await vault.getState());
  }
  if (method === "POST" && url.pathname === "/v1/vault/setup") {
    const input = z.object({ password: z.string().min(10).max(1024) }).parse(await body(request));
    const state = await vault.setupLocal(input.password);
    mcpService.clearTokenCache();
    return json(response, 200, state);
  }
  if (method === "POST" && url.pathname === "/v1/vault/unlock") {
    const input = z.object({ password: z.string().min(1).max(1024) }).parse(await body(request));
    const state = await vault.unlockLocal(input.password);
    mcpService.clearTokenCache();
    return json(response, 200, state);
  }
  if (method === "POST" && url.pathname === "/v1/vault/lock") {
    await ssh.closeAll();
    monitor.clearAllOutput();
    const state = await vault.lockLocal();
    mcpService.clearTokenCache();
    return json(response, 200, state);
  }
  if (method === "GET" && url.pathname === "/v1/mcp-settings") {
    return json(response, 200, await mcpService.getState());
  }
  if (method === "PATCH" && url.pathname === "/v1/mcp-settings") {
    const input = z.object({ enabled: z.boolean() }).parse(await body(request));
    return json(response, 200, await mcpService.setEnabled(input.enabled));
  }
  if (method === "POST" && url.pathname === "/v1/mcp-settings/regenerate-token") {
    return json(response, 200, await mcpService.regenerateToken());
  }
  if (method === "GET" && url.pathname === "/v1/codex-integration") {
    return json(response, 200, await codexIntegration.getState());
  }
  if (method === "POST" && url.pathname === "/v1/codex-integration/install") {
    return json(response, 200, await codexIntegration.install());
  }
  if (method === "POST" && url.pathname === "/v1/codex-integration/select") {
    const input = z.object({ path: z.string().trim().min(1).max(4096) }).parse(await body(request));
    const state = await codexIntegration.selectCodexHome(input.path);
    database.setSetting("codex.home", state.codexHome);
    return json(response, 200, state);
  }
  if (method === "POST" && url.pathname === "/v1/codex-integration/diagnose") {
    return json(response, 200, await codexIntegration.diagnose());
  }
  if (method === "GET" && url.pathname === "/v1/agent-integrations") {
    const [cursor, claudeCode, workbuddy] = await Promise.all([cursorIntegration.getState(), claudeCodeIntegration.getState(), workbuddyIntegration.getState()]);
    return json(response, 200, { cursor, claudeCode, workbuddy });
  }
  if (method === "POST" && url.pathname.startsWith("/v1/agent-integrations/") && url.pathname.endsWith("/select")) {
    const agent = z.enum(["cursor", "claude-code", "workbuddy"]).parse(url.pathname.split("/")[3]);
    const input = z.object({ path: z.string().trim().min(1).max(4096) }).parse(await body(request));
    const state = await jsonAgentIntegrations[agent].selectConfigDirectory(input.path);
    database.setSetting(`integration.${agent}.directory`, state.configDirectory);
    return json(response, 200, state);
  }
  if (method === "POST" && url.pathname.startsWith("/v1/agent-integrations/") && url.pathname.endsWith("/install")) {
    const agent = z.enum(["cursor", "claude-code", "workbuddy"]).parse(url.pathname.split("/")[3]);
    return json(response, 200, await jsonAgentIntegrations[agent].install());
  }
  if (method === "GET" && url.pathname === "/v1/hosts") {
    return json(response, 200, operations.listHosts(url.searchParams.get("aiOnly") === "true"));
  }
  if (method === "GET" && url.pathname === "/v1/host-logins") {
    return json(response, 200, database.listHostLogins());
  }
  if (method === "PATCH" && url.pathname === "/v1/host-groups") {
    const input = z.object({
      oldName: z.string().trim().min(1).max(120),
      newName: z.string().trim().min(1).max(120)
    }).parse(await body(request));
    return json(response, 200, { updated: database.renameHostGroup(input.oldName, input.newName) });
  }
  if (method === "POST" && url.pathname === "/v1/hosts") {
    const raw = z.object({ credential: credentialBindingSchema.optional(), sudoEnabled: z.boolean().optional() }).passthrough().parse(await body(request));
    const input = hostInputSchema.parse(raw);
    if (!raw.credential && input.credentialId) {
      throw new AppError("CREDENTIAL_REUSE_DISABLED", "Configure authentication directly on the host", false, undefined, undefined, 409);
    }
    const bindingResult = raw.credential
      ? await prepareCredentialBinding(null, raw.credential, input.name)
      : { credentialId: null, createdCredentialId: null };
    try {
      return json(response, 201, database.createHost({
        ...input,
        credentialId: bindingResult.credentialId, policyId: input.policyId ?? null, groupName: input.groupName ?? null,
        defaultDirectory: input.defaultDirectory ?? null,
        sudoEnabled: input.username === "root" ? true : raw.sudoEnabled ?? false
      }));
    } catch (error) {
      if (bindingResult.createdCredentialId) await removeUnusedCredential(bindingResult.createdCredentialId);
      throw error;
    }
  }
  if (method === "POST" && url.pathname === "/v1/hosts/import-ssh-config") {
    const input = z.object({ path: z.string().max(4096).default("~/.ssh/config") }).parse(await body(request));
    const imported = await parseSshConfig(input.path);
    const defaultPolicy = database.listPolicies().find((policy) => policy.name === DEFAULT_POLICY_TEMPLATE.name)
      ?? database.listPolicies()[0];
    const created = [];
    for (const item of imported) {
      let credentialId: string | null = null;
      if (item.identityFile) {
        credentialId = database.createCredential(`${item.alias} key`, "PRIVATE_KEY", null, { privateKeyPath: item.identityFile }).id;
      } else if (process.env.SSH_AUTH_SOCK) {
        credentialId = database.createCredential(`${item.alias} agent`, "SSH_AGENT", null, {}).id;
      }
      created.push(database.createHost({
        name: item.alias, hostname: item.hostname, port: item.port, username: item.username, credentialId,
        policyId: defaultPolicy?.id ?? null, groupName: "SSH Config", tags: ["imported"], defaultDirectory: null,
        enabled: true, aiAccessEnabled: false
      }));
    }
    return json(response, 201, { imported: created.length, hosts: created });
  }
  const hostMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)$/u);
  if (hostMatch && method === "PATCH") {
    const raw = z.object({ credential: credentialBindingSchema.optional() }).passthrough().parse(await body(request));
    const patch = hostPatchSchema.parse(raw);
    const before = database.getHost(hostMatch[1]!);
    if (!before) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    const previousCredentialId = before.credentialId;
    if (!raw.credential && patch.credentialId && patch.credentialId !== before.credentialId) {
      throw new AppError("CREDENTIAL_REUSE_DISABLED", "Configure authentication directly on the host", false, undefined, undefined, 409);
    }
    const fallbackBinding = !raw.credential && patch.credentialId === null ? { mode: "NONE" } as const : null;
    const bindingResult = raw.credential || fallbackBinding
      ? await prepareCredentialBinding(before, raw.credential ?? fallbackBinding!, patch.name ?? before.name)
      : null;
    let updated: Host;
    try {
      updated = database.updateHost(hostMatch[1]!, {
        ...patch,
        ...(bindingResult ? { credentialId: bindingResult.credentialId } : {})
      });
    } catch (error) {
      if (bindingResult?.createdCredentialId) await removeUnusedCredential(bindingResult.createdCredentialId);
      throw error;
    }
    if (previousCredentialId && previousCredentialId !== updated.credentialId) await removeUnusedCredential(previousCredentialId);
    if (before.monitorOutputEnabled && !updated.monitorOutputEnabled) monitor.clearOutput(updated.id);
    if (before && (before.hostname !== updated.hostname || before.port !== updated.port || before.username !== updated.username || before.credentialId !== updated.credentialId || !updated.enabled)) {
      await ssh.disconnect(updated.id);
    }
    return json(response, 200, updated);
  }
  if (hostMatch && method === "DELETE") {
    const existing = database.getHost(hostMatch[1]!);
    if (!existing) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    const credentialIds = database.listHostLogins(existing.id).flatMap((login) => login.credentialId ? [login.credentialId] : []);
    await ssh.disconnect(hostMatch[1]!);
    database.deleteHost(hostMatch[1]!);
    for (const credentialId of new Set(credentialIds)) await removeUnusedCredential(credentialId);
    return json(response, 200, { deleted: true });
  }
  const hostLoginsMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/logins$/u);
  if (hostLoginsMatch && method === "GET") {
    if (!database.getHost(hostLoginsMatch[1]!)) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    return json(response, 200, database.listHostLogins(hostLoginsMatch[1]!));
  }
  if (hostLoginsMatch && method === "POST") {
    const host = database.getHost(hostLoginsMatch[1]!);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    const raw = z.object({ credential: credentialBindingSchema, username: z.string(), sudoEnabled: z.boolean().optional() }).parse(await body(request));
    const input = hostLoginInputSchema.parse(raw);
    const binding = await prepareCredentialBinding(host, raw.credential, `${host.name} ${input.username}`, null);
    try {
      const login = database.createHostLogin(host.id, input.username, binding.credentialId, input.username === "root" ? true : input.sudoEnabled);
      return json(response, 201, login);
    } catch (error) {
      if (binding.createdCredentialId) await removeUnusedCredential(binding.createdCredentialId);
      throw error;
    }
  }
  const hostLoginMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/logins\/([0-9a-f-]+)$/u);
  if (hostLoginMatch && method === "PATCH") {
    const host = database.getHost(hostLoginMatch[1]!);
    const login = database.getHostLogin(hostLoginMatch[2]!);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    if (!login || login.hostId !== host.id) throw new AppError("HOST_LOGIN_NOT_FOUND", "Host login not found", false, undefined, undefined, 404);
    const raw = z.object({ credential: credentialBindingSchema, username: z.string(), sudoEnabled: z.boolean().optional() }).parse(await body(request));
    const input = hostLoginInputSchema.parse(raw);
    const previousCredentialId = login.credentialId;
    const binding = await prepareCredentialBinding(host, raw.credential, `${host.name} ${input.username}`, login.credentialId);
    let updated;
    try {
      updated = database.updateHostLogin(login.id, {
        username: input.username,
        credentialId: binding.credentialId,
        sudoEnabled: input.username === "root" ? true : input.sudoEnabled
      });
    } catch (error) {
      if (binding.createdCredentialId) await removeUnusedCredential(binding.createdCredentialId);
      throw error;
    }
    if (login.active) await ssh.disconnect(host.id);
    if (previousCredentialId && previousCredentialId !== updated.credentialId) await removeUnusedCredential(previousCredentialId);
    return json(response, 200, updated);
  }
  if (hostLoginMatch && method === "DELETE") {
    const login = database.deleteHostLogin(hostLoginMatch[1]!, hostLoginMatch[2]!);
    if (login.credentialId) await removeUnusedCredential(login.credentialId);
    return json(response, 200, { deleted: true });
  }
  const loginSudoMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/logins\/([0-9a-f-]+)\/sudo$/u);
  if (loginSudoMatch && method === "PATCH") {
    const host = database.getHost(loginSudoMatch[1]!);
    const login = database.getHostLogin(loginSudoMatch[2]!);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    if (!login || login.hostId !== host.id) throw new AppError("HOST_LOGIN_NOT_FOUND", "Host login not found", false, undefined, undefined, 404);
    if (login.username === "root") throw new AppError("ROOT_SUDO_FIXED", "The root login always has full privileges", false, undefined, undefined, 409);
    const input = z.object({ sudoEnabled: z.boolean() }).parse(await body(request));
    const updated = database.updateHostLogin(login.id, { sudoEnabled: input.sudoEnabled });
    return json(response, 200, updated);
  }
  const activateLoginMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/logins\/([0-9a-f-]+)\/activate$/u);
  if (activateLoginMatch && method === "POST") {
    const updated = database.activateHostLogin(activateLoginMatch[1]!, activateLoginMatch[2]!);
    await ssh.disconnect(updated.id);
    return json(response, 200, updated);
  }
  const testMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/test$/u);
  if (testMatch && method === "POST") {
    const input = z.object({ clientType: z.enum(["MCP", "CLI", "UI"]).default("UI"), clientId: z.string().optional() }).parse(await optionalBody(request));
    return json(response, 200, await operations.testHost(testMatch[1]!, input.clientType, input.clientId));
  }
  const eventsMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/events$/u);
  if (eventsMatch && method === "GET") {
    const hostId = eventsMatch[1]!;
    if (!database.getHost(hostId)) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    return streamHostEvents(request, response, hostId);
  }
  const trustMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/trust-key$/u);
  if (trustMatch && method === "POST") {
    const input = z.object({ fingerprint: z.string().min(8).max(512) }).parse(await body(request));
    database.trustHostKey(trustMatch[1]!, input.fingerprint);
    await ssh.disconnect(trustMatch[1]!);
    return json(response, 200, { trusted: true });
  }

  const revealCredentialMatch = url.pathname.match(/^\/v1\/hosts\/([0-9a-f-]+)\/credential\/reveal$/u);
  if (revealCredentialMatch && method === "POST") {
    requireSameOriginUi(request);
    const input = z.object({ masterPassword: z.string().min(1).max(1024) }).parse(await body(request));
    const host = database.getHost(revealCredentialMatch[1]!);
    if (!host) throw new AppError("HOST_NOT_FOUND", "Host not found", false, undefined, undefined, 404);
    if (!host.credentialId) throw new AppError("CREDENTIAL_NOT_FOUND", "Host has no assigned credential", false, undefined, undefined, 404);
    const credential = database.getCredential(host.credentialId);
    if (!credential) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    const auditId = randomUUID();
    database.createAudit({
      id: auditId, clientType: "UI", clientId: "desktop", hostId: host.id, hostNameSnapshot: host.name,
      operationType: "REVEAL_CREDENTIAL", requestSummary: credential.type === "PASSWORD" ? "查看登录密码" : credential.type === "PRIVATE_KEY" ? "查看私钥认证信息" : "查看 SSH Agent 配置"
    });
    try {
      await vault.verifyLocalPassword(input.masterPassword);
      const secret = credential.secretRef ? await vault.resolve(credential.secretRef) : null;
      const privateKey = credential.type === "PRIVATE_KEY" && credential.metadata.privateKeyPath
        ? await readPrivateKeyFile(credential.metadata.privateKeyPath)
        : null;
      database.updateAudit(auditId, { status: "SUCCEEDED", finished: true });
      return json(response, 200, {
        credential: publicCredential(credential),
        secret,
        privateKey,
        expiresInSeconds: 30
      });
    } catch (error) {
      const appError = asAppError(error, "CREDENTIAL_REVEAL_FAILED");
      database.updateAudit(auditId, { status: "FAILED", errorCode: appError.code, errorMessage: appError.message, finished: true });
      throw error;
    }
  }

  if (method === "GET" && url.pathname === "/v1/credentials") return json(response, 200, database.listCredentials().map(publicCredential));
  if (method === "POST" && url.pathname === "/v1/credentials") {
    const input = credentialInputSchema.parse(await body(request));
    const secretRef = input.secret ? randomUUID() : null;
    const sudoSecretRef = input.sudoMode === "CUSTOM_PASSWORD" && input.sudoSecret ? randomUUID() : null;
    if (secretRef) await vault.save(secretRef, input.secret!);
    if (sudoSecretRef) await vault.save(sudoSecretRef, input.sudoSecret!);
    try {
      return json(response, 201, publicCredential(database.createCredential(input.name, input.type, secretRef, input.metadata, input.sudoMode, sudoSecretRef)));
    } catch (error) {
      if (secretRef) await vault.delete(secretRef);
      if (sudoSecretRef) await vault.delete(sudoSecretRef);
      throw error;
    }
  }
  const credentialMatch = url.pathname.match(/^\/v1\/credentials\/([0-9a-f-]+)$/u);
  if (credentialMatch && method === "PATCH") {
    const current = database.getCredential(credentialMatch[1]!);
    if (!current) throw new AppError("CREDENTIAL_NOT_FOUND", "Credential not found", false, undefined, undefined, 404);
    const input = z.object({
      name: z.string().trim().min(1).max(120).optional(),
      type: z.enum(["PASSWORD", "PRIVATE_KEY", "SSH_AGENT"]).optional(),
      secret: z.string().max(16_384).optional(),
      sudoMode: z.enum(["NONE", "LOGIN_PASSWORD", "CUSTOM_PASSWORD"]).optional(),
      sudoSecret: z.string().max(16_384).optional(),
      metadata: z.object({ privateKeyPath: z.string().max(4096).optional(), agentSocket: z.string().max(4096).optional() }).optional()
    }).parse(await body(request));
    let secretRef = current.secretRef;
    if (input.secret !== undefined) {
      secretRef ??= randomUUID();
      await vault.save(secretRef, input.secret);
    }
    const sudoMode = input.sudoMode ?? current.sudoMode;
    let sudoSecretRef = sudoMode === "CUSTOM_PASSWORD" ? current.sudoSecretRef : null;
    if (input.sudoSecret !== undefined) {
      sudoSecretRef ??= randomUUID();
      await vault.save(sudoSecretRef, input.sudoSecret);
    }
    if (sudoMode === "LOGIN_PASSWORD" && (input.type ?? current.type) !== "PASSWORD") throw new AppError("INVALID_ARGUMENT", "Only password-authenticated hosts can reuse the login password for sudo");
    if (sudoMode === "CUSTOM_PASSWORD" && !sudoSecretRef) throw new AppError("INVALID_ARGUMENT", "Sudo password is required");
    const updated = database.updateCredential(current.id, input.name ?? current.name, input.type ?? current.type, secretRef, input.metadata ?? current.metadata, sudoMode, sudoSecretRef);
    if (current.sudoSecretRef && current.sudoSecretRef !== sudoSecretRef) await vault.delete(current.sudoSecretRef);
    for (const host of database.listHosts().filter((candidate) => candidate.credentialId === current.id)) await ssh.disconnect(host.id);
    return json(response, 200, publicCredential(updated));
  }
  if (credentialMatch && method === "DELETE") {
    const deleted = database.deleteCredential(credentialMatch[1]!);
    if (deleted.secretRef) await vault.delete(deleted.secretRef);
    if (deleted.sudoSecretRef) await vault.delete(deleted.sudoSecretRef);
    return json(response, 200, { deleted: true });
  }

  if (method === "GET" && url.pathname === "/v1/policies") return json(response, 200, database.listPolicies());
  if (method === "GET" && url.pathname === "/v1/policies/settings") return json(response, 200, { directory: config.policyDir });
  if (method === "POST" && url.pathname === "/v1/policies/rescan") return json(response, 200, await policySources.rescan());
  if (method === "POST" && url.pathname === "/v1/policies") {
    const input = policyInputSchema.parse(await body(request));
    return json(response, 201, await policySources.create(input.name, input.document));
  }
  const policySourceMatch = url.pathname.match(/^\/v1\/policies\/([0-9a-f-]+)\/source$/u);
  if (policySourceMatch && method === "GET") return json(response, 200, await policySources.getSource(policySourceMatch[1]!));
  if (policySourceMatch && method === "PUT") {
    const input = z.object({ yaml: z.string().min(1).max(1024 * 1024), expectedVersion: z.number().int().positive() }).parse(await body(request));
    return json(response, 200, await policySources.saveSource(policySourceMatch[1]!, input.yaml, input.expectedVersion));
  }
  const policyRestoreMatch = url.pathname.match(/^\/v1\/policies\/([0-9a-f-]+)\/restore$/u);
  if (policyRestoreMatch && method === "POST") return json(response, 200, await policySources.restore(policyRestoreMatch[1]!));
  const policyMatch = url.pathname.match(/^\/v1\/policies\/([0-9a-f-]+)$/u);
  if (policyMatch && method === "PATCH") {
    const input = policyInputSchema.parse(await body(request));
    return json(response, 200, await policySources.saveDocument(policyMatch[1]!, input.name, input.document, input.expectedVersion ?? database.getPolicy(policyMatch[1]!)?.version ?? 0));
  }
  if (policyMatch && method === "DELETE") {
    const policy = database.getPolicy(policyMatch[1]!);
    database.deletePolicy(policyMatch[1]!);
    if (policy?.sourcePath) await unlink(policy.sourcePath).catch(() => undefined);
    return json(response, 200, { deleted: true });
  }

  if (method === "GET" && url.pathname === "/v1/audit-logs") {
    return json(response, 200, database.listAudit({
      hostId: url.searchParams.get("hostId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 100), offset: Number(url.searchParams.get("offset") ?? 0)
    }));
  }
  if (method === "POST" && url.pathname === "/v1/operations/execute") {
    return json(response, 200, await operations.executeCommand(commandRequestSchema.parse(await body(request))));
  }
  if (method === "POST" && url.pathname === "/v1/operations/upload") {
    return json(response, 200, await operations.uploadFile(transferRequestSchema.parse(await body(request))));
  }
  if (method === "POST" && url.pathname === "/v1/operations/download") {
    return json(response, 200, await operations.downloadFile(transferRequestSchema.parse(await body(request))));
  }
  if (method === "POST" && url.pathname === "/v1/operations/transfer") {
    return json(response, 200, await operations.transferFile(hostTransferRequestSchema.parse(await body(request))));
  }
  throw new AppError("NOT_FOUND", "Route not found", false, undefined, undefined, 404);
}

async function streamHostEvents(request: IncomingMessage, response: ServerResponse, hostId: string): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  response.write("retry: 1500\n\n");

  const send = (event: import("../../shared/src/index.js").HostMonitorEvent) => {
    if (!response.destroyed) response.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = monitor.subscribe(hostId, send);
  const lastEventId = Array.isArray(request.headers["last-event-id"])
    ? request.headers["last-event-id"][0]
    : request.headers["last-event-id"];
  if (lastEventId) for (const event of monitor.after(hostId, lastEventId)) send(event);
  const keepAlive = setInterval(() => {
    if (!response.destroyed) response.write(`: keepalive ${Date.now()}\n\n`);
  }, 15_000);

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      unsubscribe();
      resolve();
    };
    request.once("close", close);
    response.once("close", close);
  });
}

function authorize(request: IncomingMessage): void {
  const requestToken = request.headers.authorization?.replace(/^Bearer\s+/iu, "");
  if (requestToken && equalSecret(requestToken, token)) return;
  if (isSameOriginUiRequest(request) && (request.method === "GET" || request.method === "HEAD" || request.headers["content-type"]?.startsWith("application/json"))) return;
  throw new AppError("UNAUTHORIZED", "A valid local Core token is required", false, undefined, undefined, 401);
}

function isSameOriginUiRequest(request: IncomingMessage): boolean {
  const allowedOrigin = `http://${config.host}:${config.port}`;
  return request.headers.origin === allowedOrigin || (request.headers["sec-fetch-site"] === "same-origin" && request.headers.host === `${config.host}:${config.port}`);
}

function requireSameOriginUi(request: IncomingMessage): void {
  if (!isSameOriginUiRequest(request)) {
    throw new AppError("UI_ONLY_OPERATION", "Credential secrets can only be viewed from the Hoplane App", false, undefined, undefined, 403);
  }
}

function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk as Uint8Array);
    size += value.length;
    if (size > 1024 * 1024) throw new AppError("REQUEST_TOO_LARGE", "Request body exceeds 1 MiB", false, undefined, undefined, 413);
    chunks.push(value);
  }
  if (chunks.length === 0) throw new AppError("INVALID_ARGUMENT", "JSON request body is required");
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("INVALID_ARGUMENT", "Request body must be valid JSON"); }
}

async function optionalBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) === 0) return {};
  return body(request);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  const content = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(content) });
  response.end(content);
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const requested = pathname === "/" ? "index.html" : normalize(pathname).replace(/^[/\\]+/u, "");
  if (requested.includes("..")) throw new AppError("NOT_FOUND", "File not found", false, undefined, undefined, 404);
  let file = join(staticRoot, requested);
  try {
    if (!(await stat(file)).isFile()) file = join(staticRoot, "index.html");
  } catch {
    file = join(staticRoot, "index.html");
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, { "content-type": mime(extname(file)), "content-length": content.length });
    response.end(content);
  } catch {
    throw new AppError("UI_NOT_BUILT", "Desktop UI has not been built. Run pnpm build:desktop.", false, undefined, undefined, 503);
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
  response.setHeader("cache-control", "no-store");
}

function normalizeHttpError(error: unknown): AppError {
  if (error instanceof ZodError) return new AppError("INVALID_ARGUMENT", "Request validation failed", false, undefined, { issues: error.issues }, 400);
  return asAppError(error);
}

function mime(extension: string): string {
  return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function publicCredential(credential: Credential): Omit<Credential, "secretRef" | "sudoSecretRef"> {
  const { secretRef: _secretRef, sudoSecretRef: _sudoSecretRef, ...value } = credential;
  return value;
}

async function readPrivateKeyFile(path: string): Promise<string> {
  const resolved = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  try {
    const file = await stat(resolved);
    if (!file.isFile()) throw new Error("Not a regular file");
    if (file.size > 1024 * 1024) throw new AppError("PRIVATE_KEY_TOO_LARGE", "Private key file exceeds 1 MiB", false, undefined, undefined, 413);
    return await readFile(resolved, "utf8");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("PRIVATE_KEY_READ_FAILED", "Configured private key file could not be read", false, undefined, undefined, 409);
  }
}

return { url: `http://${config.host}:${config.port}`, server, close: shutdown };
}

const isMain = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]!).href === import.meta.url;
if (isMain) await startCore({ registerProcessSignals: true });
