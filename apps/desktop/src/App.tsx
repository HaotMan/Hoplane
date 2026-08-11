import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ArrowClockwise,
  CaretDown,
  CheckCircle,
  ClockCounterClockwise,
  Desktop,
  MagnifyingGlass,
  Moon,
  PencilSimple,
  Sun,
  Tag,
  TerminalWindow,
  Trash,
  X
} from "@phosphor-icons/react";
import { COMMAND_BLACKLIST_CATALOG, DEFAULT_POLICY_TEMPLATE, findPolicyTemplate, findPolicyTemplateByName, POLICY_TEMPLATES } from "../../../packages/shared/src/policy-templates";
import { policySourceSchema } from "../../../packages/shared/src/schemas";
import { parseDocument, stringify } from "yaml";
import { api, ApiError, patch, post, put, remove } from "./api";
import { groupHosts, selectedHostCopyText } from "./host-list";
import { HostTerminalPage } from "./host-terminal";
import { Breadcrumb, PageHeader } from "./page-chrome";
import type { AuditLog, Credential, Host, HostLogin, HostMonitorEvent, Policy, PolicyCommandRule, PolicyDocument, RevealedCredential } from "./types";

type Page = "hosts" | "policies" | "audit" | "settings";
type ThemePreference = "system" | "dark" | "light";
type IntegrationChannel = "codex" | "cursor" | "claude-code" | "workbuddy" | "other";
const JSON_AGENT_NAMES = { cursor: "Cursor", "claude-code": "Claude Code", workbuddy: "WorkBuddy" } as const;
type JsonAgentChannel = keyof typeof JSON_AGENT_NAMES;
function agentStateKey(agent: JsonAgentChannel): "cursor" | "claudeCode" | "workbuddy" {
  return agent === "claude-code" ? "claudeCode" : agent;
}
interface VaultState { localInitialized: boolean; unlocked: boolean }
const THEME_STORAGE_KEY = "hoplane.theme";
const pages: Array<{ id: Page; label: string }> = [
  { id: "hosts", label: "主机" },
  { id: "policies", label: "策略" }, { id: "audit", label: "审计" },
  { id: "settings", label: "接入" }
];

export function App() {
  const [page, setPage] = useState<Page>("hosts");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "system" || saved === "dark" || saved === "light" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const notify = useCallback((kind: "ok" | "error", text: string) => { setNotice({ kind, text }); window.setTimeout(() => setNotice(null), 4500); }, []);
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const changed = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    document.documentElement.dataset.theme = themePreference === "system" ? systemDark ? "dark" : "light" : themePreference;
    document.documentElement.dataset.themePreference = themePreference;
  }, [themePreference, systemDark]);
  useEffect(() => { void api<VaultState>("/v1/vault-settings").then(setVaultState).catch((error) => notify("error", message(error))); }, [notify]);
  return <div className="app-shell">
    <header className="topbar">
      <button type="button" className="brand" onClick={() => setPage("hosts")} aria-label="返回主机页面">Hoplane</button>
      <nav aria-label="主导航">{pages.map((item) => <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => setPage(item.id)}>{item.label}</button>)}</nav>
      <div className="topbar-tools">
        <div className="security-note"><span className="pulse" />Core 本地运行</div>
        <ThemeCycleButton value={themePreference} onChange={setThemePreference} />
      </div>
    </header>
    <main>
      {page === "hosts" && <HostsPage notify={notify} />}
      {page === "policies" && <PoliciesPage notify={notify} />}
      {page === "audit" && <AuditPage notify={notify} />}
      {page === "settings" && <SettingsPage notify={notify} vaultState={vaultState} onVaultChanged={setVaultState} />}
    </main>
    {vaultState && !vaultState.unlocked && <VaultGate state={vaultState} notify={notify} onReady={setVaultState} />}
    {notice && <div className={`toast ${notice.kind}`}>{notice.text}</div>}
  </div>;
}

function ThemeCycleButton({ value, onChange }: { value: ThemePreference; onChange(value: ThemePreference): void }) {
  const cycle: ThemePreference[] = ["system", "dark", "light"];
  const labels: Record<ThemePreference, string> = { system: "跟随系统", dark: "深色", light: "浅色" };
  const nextValue = cycle[(cycle.indexOf(value) + 1) % cycle.length]!;
  const description = `当前外观：${labels[value]}；点击切换为${labels[nextValue]}`;
  return <button type="button" className="theme-cycle" title={description} aria-label={description} onClick={() => onChange(nextValue)}>
    {value === "system" ? <Desktop size={20} weight="regular" aria-hidden="true" /> : value === "dark" ? <Moon size={20} weight="regular" aria-hidden="true" /> : <Sun size={20} weight="regular" aria-hidden="true" />}
  </button>;
}

function HostsPage({ notify }: { notify: Notify }) {
  const [hosts, setHosts] = useState<Host[]>([]);
  const [hostLogins, setHostLogins] = useState<HostLogin[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [editing, setEditing] = useState<Host | "new" | null>(null);
  const [monitorHostId, setMonitorHostId] = useState<string | null>(null);
  const [terminalHostId, setTerminalHostId] = useState<string | null>(null);
  const [testingHostId, setTestingHostId] = useState<string | null>(null);
  const [updatingHostId, setUpdatingHostId] = useState<string | null>(null);
  const [proxyConfiguringHost, setProxyConfiguringHost] = useState<Host | null>(null);
  const [deletingHost, setDeletingHost] = useState<Host | null>(null);
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [multiSelectMode, setMultiSelectMode] = useState(false);
  const [selectedHostIds, setSelectedHostIds] = useState<Set<string>>(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [connectionFilter, setConnectionFilter] = useState("");
  const [accessFilter, setAccessFilter] = useState("");
  const [policyFilter, setPolicyFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [testResults, setTestResults] = useState<Record<string, { kind: "ok" | "error" | "pending"; text: string }>>({});
  const load = useCallback(async () => {
    try {
      const [h, l, c, p] = await Promise.all([api<Host[]>("/v1/hosts"), api<HostLogin[]>("/v1/host-logins"), api<Credential[]>("/v1/credentials"), api<Policy[]>("/v1/policies")]);
      setHosts(h); setHostLogins(l); setCredentials(c); setPolicies(p);
    } catch (error) { notify("error", message(error)); }
  }, [notify]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => {
    const available = new Set(hosts.map((host) => host.id));
    setSelectedHostIds((current) => new Set([...current].filter((id) => available.has(id))));
  }, [hosts]);

  function selectHost(hostId: string, selected: boolean) {
    setSelectedHostIds((current) => {
      const next = new Set(current);
      if (selected) next.add(hostId); else next.delete(hostId);
      return next;
    });
  }
  function selectHosts(hostIds: string[], selected: boolean) {
    setSelectedHostIds((current) => {
      const next = new Set(current);
      for (const id of hostIds) if (selected) next.add(id); else next.delete(id);
      return next;
    });
  }
  function toggleGroup(groupKey: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
      return next;
    });
  }
  function leaveMultiSelectMode() {
    setMultiSelectMode(false);
    setSelectedHostIds(new Set());
  }
  async function copySelectedHostNames() {
    const value = selectedHostCopyText(hosts, selectedHostIds);
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      notify("ok", `已复制 ${selectedHostIds.size} 台主机的名称和地址`);
    } catch { notify("error", "无法写入剪贴板，请检查系统剪贴板权限"); }
  }

  async function test(host: Host) {
    if (testingHostId) return;
    setTestingHostId(host.id);
    setTestResults(current => ({ ...current, [host.id]: { kind: "pending", text: "正在连接…" } }));
    try {
      const result = await post<{ durationMs: number }>(`/v1/hosts/${host.id}/test`, { clientType: "UI", clientId: "desktop" });
      setTestResults(current => ({ ...current, [host.id]: { kind: "ok", text: `连接成功 · ${result.durationMs} ms` } }));
      notify("ok", `${host.name} 连接成功（${result.durationMs} ms）`);
      await load();
    }
    catch (error) {
      if (error instanceof ApiError && (error.code === "SSH_HOST_KEY_UNTRUSTED" || error.code === "SSH_HOST_KEY_CHANGED")) {
        const fingerprint = String(error.details?.observedFingerprint ?? "");
        const warning = error.code === "SSH_HOST_KEY_CHANGED" ? "警告：主机指纹发生变化。确认服务器已合法更换密钥后才能继续。" : "首次连接需要信任主机指纹。";
        if (fingerprint && window.confirm(`${warning}\n\nSHA256: ${fingerprint}\n\n是否信任？`)) {
          await post(`/v1/hosts/${host.id}/trust-key`, { fingerprint });
          setTestResults(current => ({ ...current, [host.id]: { kind: "pending", text: "指纹已信任，正在重试…" } }));
          const result = await post<{ durationMs: number }>(`/v1/hosts/${host.id}/test`, { clientType: "UI", clientId: "desktop" });
          setTestResults(current => ({ ...current, [host.id]: { kind: "ok", text: `连接成功 · ${result.durationMs} ms` } }));
          notify("ok", `${host.name} 指纹已信任，连接成功（${result.durationMs} ms）`);
          await load();
          return;
        }
      }
      const text = friendlyConnectionError(error);
      setTestResults(current => ({ ...current, [host.id]: { kind: "error", text } }));
      notify("error", `${host.name}：${text}`);
    } finally {
      setTestingHostId(null);
    }
  }
  async function toggleHost(host: Host) {
    if (updatingHostId) return;
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}`, { enabled: !host.enabled });
      await load();
      notify("ok", host.enabled ? `${host.name} 已停用，AI 将无法访问` : `${host.name} 已启用`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function activateLogin(host: Host, loginId: string) {
    if (updatingHostId || loginId === host.activeLoginId) return;
    setUpdatingHostId(host.id);
    try {
      const login = hostLogins.find((item) => item.id === loginId);
      await post(`/v1/hosts/${host.id}/logins/${loginId}/activate`);
      setTestResults((current) => {
        const next = { ...current };
        delete next[host.id];
        return next;
      });
      await load();
      notify("ok", `${host.name} 已切换为 ${login?.username ?? "所选用户"}，AI 后续连接只使用该身份`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function changePolicy(host: Host, policyId: string) {
    if (updatingHostId || (host.policyId ?? "") === policyId) return;
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}`, { policyId: policyId || null });
      await load();
      const policyName = policies.find((policy) => policy.id === policyId)?.name;
      notify("ok", policyId ? `${host.name} 策略已切换为“${policyName ?? "所选策略"}”` : `${host.name} 已取消策略绑定`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function toggleSudo(host: Host, login: HostLogin) {
    if (updatingHostId) return;
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}/logins/${login.id}/sudo`, { sudoEnabled: !login.sudoEnabled });
      await load();
      notify("ok", login.sudoEnabled ? `${host.name} 已禁止 ${login.username} 使用 sudo` : `${host.name} 已允许 ${login.username} 使用 sudo`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function toggleHostTransfer(host: Host) {
    if (updatingHostId) return;
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}`, { hostTransferEnabled: !host.hostTransferEnabled });
      await load();
      notify("ok", host.hostTransferEnabled ? `${host.name} 已关闭主机间文件传输` : `${host.name} 已允许主机间文件传输`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function toggleProxy(host: Host) {
    if (updatingHostId) return;
    if (!host.proxyEnabled) {
      setProxyConfiguringHost(host);
      return;
    }
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}`, { proxyEnabled: false });
      await load();
      notify("ok", `${host.name} 已关闭本机代理`);
    } catch (error) { notify("error", message(error)); }
    finally { setUpdatingHostId(null); }
  }
  async function configureProxy(host: Host, settings: { proxyLocalHost: string; proxyLocalPort: number; proxyRemotePort: number }) {
    if (updatingHostId) return;
    setUpdatingHostId(host.id);
    try {
      await patch(`/v1/hosts/${host.id}`, { proxyEnabled: true, ...settings });
      setProxyConfiguringHost(null);
      await load();
      notify("ok", `${host.name} 正在通过 ${settings.proxyLocalHost}:${settings.proxyLocalPort} 建立本机代理隧道`);
    } finally { setUpdatingHostId(null); }
  }
  async function renameGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renamingGroup) return;
    const value = String(new FormData(event.currentTarget).get("newName") ?? "").trim();
    if (!value || value === renamingGroup) { setRenamingGroup(null); return; }
    try {
      await patch("/v1/host-groups", { oldName: renamingGroup, newName: value });
      setRenamingGroup(null);
      await load();
      notify("ok", `分组已重命名为“${value}”`);
    } catch (error) { notify("error", message(error)); }
  }
  async function confirmDeleteHost() {
    if (!deletingHost || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await remove(`/v1/hosts/${deletingHost.id}`);
      const deletedName = deletingHost.name;
      setDeletingHost(null);
      await load();
      notify("ok", `${deletedName} 已删除`);
    } catch (error) {
      notify("error", `删除失败：${message(error)}`);
    } finally { setDeleteBusy(false); }
  }
  const monitoredHost = monitorHostId ? hosts.find((host) => host.id === monitorHostId) : undefined;
  const monitoredCredential = monitoredHost?.credentialId ? credentials.find((credential) => credential.id === monitoredHost.credentialId) : undefined;
  if (monitorHostId && monitoredHost) return <HostMonitorPage host={monitoredHost} credential={monitoredCredential} onBack={() => setMonitorHostId(null)} onHostChanged={load} notify={notify} />;
  const terminalHost = terminalHostId ? hosts.find((host) => host.id === terminalHostId) : undefined;
  if (terminalHostId && terminalHost) return <HostTerminalPage key={terminalHost.id} host={terminalHost} logins={hostLogins.filter((login) => login.hostId === terminalHost.id)} onBack={() => setTerminalHostId(null)} />;
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredHosts = hosts.filter((host) => {
    const activeLogin = hostLogins.find((login) => login.hostId === host.id && login.id === host.activeLoginId);
    const searchable = [host.name, host.hostname, host.groupName ?? "", activeLogin?.username ?? "", ...host.tags].join(" ").toLocaleLowerCase("zh-CN");
    if (normalizedQuery && !searchable.includes(normalizedQuery)) return false;
    if (connectionFilter === "connected" && host.status !== "CONNECTED") return false;
    if (connectionFilter === "disconnected" && host.status === "CONNECTED") return false;
    if (accessFilter === "allowed" && !(host.enabled && host.aiAccessEnabled)) return false;
    if (accessFilter === "blocked" && host.enabled && host.aiAccessEnabled) return false;
    if (policyFilter && (host.policyId ?? "none") !== policyFilter) return false;
    if (tagFilter && !host.tags.includes(tagFilter)) return false;
    return true;
  });
  const groups = groupHosts(filteredHosts);
  const allGroups = groupHosts(hosts);
  const visibleHostIds = filteredHosts.map((host) => host.id);
  const selectedVisibleCount = visibleHostIds.filter((id) => selectedHostIds.has(id)).length;
  const allSelected = visibleHostIds.length > 0 && selectedVisibleCount === visibleHostIds.length;
  const someSelected = selectedVisibleCount > 0 && !allSelected;
  const existingGroupNames = allGroups.filter((group) => !group.ungrouped).map((group) => group.name);
  const tags = [...new Set(hosts.flatMap((host) => host.tags))].sort((left, right) => left.localeCompare(right, "zh-CN"));
  const connectedCount = hosts.filter((host) => host.status === "CONNECTED").length;
  const aiAllowedCount = hosts.filter((host) => host.enabled && host.aiAccessEnabled).length;
  return <section><PageHeader title="SSH 主机"><button className="primary" onClick={() => setEditing("new")}>添加主机</button></PageHeader>
    <p className="host-summary">{hosts.length} 台主机，{connectedCount} 台已连接，{aiAllowedCount} 台允许 AI 访问 · 数据仅保存在本地 Core。</p>
    <div className="host-filter-bar" aria-label="主机筛选">
      <label className="host-search"><MagnifyingGlass size={19} weight="regular" aria-hidden="true" /><span className="sr-only">搜索主机</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主机、地址或用户" /></label>
      <select aria-label="筛选连接状态" value={connectionFilter} onChange={(event) => setConnectionFilter(event.target.value)}><option value="">连接状态：全部</option><option value="connected">已连接</option><option value="disconnected">未连接</option></select>
      <select aria-label="筛选 AI 访问" value={accessFilter} onChange={(event) => setAccessFilter(event.target.value)}><option value="">AI 访问：全部</option><option value="allowed">允许</option><option value="blocked">未允许</option></select>
      <select aria-label="筛选权限策略" value={policyFilter} onChange={(event) => setPolicyFilter(event.target.value)}><option value="">策略：全部</option><option value="none">未配置</option>{orderPolicies(policies).map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</select>
      <label className="tag-filter"><Tag size={18} aria-hidden="true" /><span className="sr-only">筛选标签</span><select aria-label="筛选标签" value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}><option value="">标签：全部</option>{tags.map((tag) => <option key={tag}>{tag}</option>)}</select></label>
      <button className="icon-button" type="button" title="刷新主机" aria-label="刷新主机" onClick={() => void load()}><ArrowClockwise size={19} /></button>
    </div>
    {hosts.length > 0 && <div className="host-list-toolbar"><div><strong>{multiSelectMode ? selectedHostIds.size > 0 ? `已选择 ${selectedHostIds.size} 台主机` : "请选择主机" : `显示 ${filteredHosts.length} 台主机`}</strong><small>{multiSelectMode ? "复制内容为显示名称和主机地址，每行一台" : `${groups.length} 个分组 · 行尾图标可直接操作`}</small></div><div>{multiSelectMode ? <><button onClick={() => selectHosts(visibleHostIds, !allSelected)}>{allSelected ? "取消全选" : "全选当前结果"}</button><button className="primary" disabled={selectedHostIds.size === 0} onClick={() => void copySelectedHostNames()}>复制名称和地址</button><button onClick={leaveMultiSelectMode}>完成</button></> : <button onClick={() => setMultiSelectMode(true)}>多选</button>}</div></div>}
    <div className="panel table-panel host-table-panel">
      <table><thead><tr>{multiSelectMode && <th className="host-select-cell"><SelectionCheckbox label="选择筛选结果中的全部主机" checked={allSelected} indeterminate={someSelected} disabled={filteredHosts.length === 0} onChange={(selected) => selectHosts(visibleHostIds, selected)} /></th>}<th className="host-name-column">主机</th><th className="host-status-column">连接</th><th className="host-access-column">AI 访问</th><th className="host-user-column">当前用户</th><th className="host-policy-column">策略</th><th className="host-actions-column" /></tr></thead>
      <tbody>{groups.map((group) => {
        const groupIds = group.hosts.map((host) => host.id);
        const selectedInGroup = groupIds.filter((id) => selectedHostIds.has(id)).length;
        const groupSelected = selectedInGroup === group.hosts.length;
        const collapsed = collapsedGroups.has(group.key);
        return <GroupRows key={group.key} groupName={group.name} ungrouped={group.ungrouped} hosts={group.hosts} hostLogins={hostLogins} collapsed={collapsed} selectionMode={multiSelectMode} selectedIds={selectedHostIds} groupSelected={groupSelected} groupIndeterminate={selectedInGroup > 0 && !groupSelected} policies={policies} testResults={testResults} testingHostId={testingHostId} updatingHostId={updatingHostId} onToggleGroup={() => toggleGroup(group.key)} onRenameGroup={() => setRenamingGroup(group.name)} onSelectGroup={(selected) => selectHosts(groupIds, selected)} onSelectHost={selectHost} onActivateLogin={activateLogin} onChangePolicy={changePolicy} onToggleSudo={toggleSudo} onToggleHostTransfer={toggleHostTransfer} onToggleProxy={toggleProxy} onOpenTerminal={setTerminalHostId} onMonitor={setMonitorHostId} onTest={test} onToggleHost={toggleHost} onEdit={setEditing} onDelete={setDeletingHost} />;
      })}</tbody></table>{hosts.length === 0 ? <Empty text="还没有主机。添加主机时可以直接填写密码、私钥或 SSH Agent。" /> : filteredHosts.length === 0 && <Empty text="没有符合当前筛选条件的主机。" />}</div>
    {editing && <HostDialog host={editing === "new" ? null : editing} credentials={credentials} policies={policies} groupNames={existingGroupNames} onAccountsChanged={load} onClose={() => setEditing(null)} onSaved={async (saved, created) => {
      setEditing(null);
      await load();
      notify("ok", created ? "主机已保存，正在自动测试连接…" : "主机已保存");
      if (created) void test(saved);
    }} />}
    {proxyConfiguringHost && <ProxySettingsDialog host={proxyConfiguringHost} onClose={() => setProxyConfiguringHost(null)} onSave={(settings) => configureProxy(proxyConfiguringHost, settings)} />}
    {renamingGroup && <Modal title="重命名分组" onClose={() => setRenamingGroup(null)}><form onSubmit={renameGroup} className="form-grid"><label className="span-2">新的分组名称<input name="newName" required maxLength={120} autoFocus defaultValue={renamingGroup} /></label><div className="form-actions span-2"><button type="button" onClick={() => setRenamingGroup(null)}>取消</button><button className="primary">保存名称</button></div></form></Modal>}
    {deletingHost && <Modal title="删除主机" onClose={() => !deleteBusy && setDeletingHost(null)}><div className="confirmation-copy"><strong>确定删除“{deletingHost.name}”吗？</strong><p>该主机的连接配置、专属凭据和信任记录会被删除，已有审计记录仍会保留。</p></div><div className="form-actions"><button onClick={() => setDeletingHost(null)} disabled={deleteBusy}>取消</button><button className="danger-button" onClick={() => void confirmDeleteHost()} disabled={deleteBusy}>{deleteBusy ? "删除中…" : "确认删除"}</button></div></Modal>}
  </section>;
}

function GroupRows({ groupName, ungrouped, hosts, hostLogins, collapsed, selectionMode, selectedIds, groupSelected, groupIndeterminate, policies, testResults, testingHostId, updatingHostId, onToggleGroup, onRenameGroup, onSelectGroup, onSelectHost, onActivateLogin, onChangePolicy, onToggleSudo, onToggleHostTransfer, onToggleProxy, onOpenTerminal, onMonitor, onTest, onToggleHost, onEdit, onDelete }: { groupName: string; ungrouped: boolean; hosts: Host[]; hostLogins: HostLogin[]; collapsed: boolean; selectionMode: boolean; selectedIds: ReadonlySet<string>; groupSelected: boolean; groupIndeterminate: boolean; policies: Policy[]; testResults: Record<string, { kind: "ok" | "error" | "pending"; text: string }>; testingHostId: string | null; updatingHostId: string | null; onToggleGroup(): void; onRenameGroup(): void; onSelectGroup(selected: boolean): void; onSelectHost(hostId: string, selected: boolean): void; onActivateLogin(host: Host, loginId: string): Promise<void>; onChangePolicy(host: Host, policyId: string): Promise<void>; onToggleSudo(host: Host, login: HostLogin): Promise<void>; onToggleHostTransfer(host: Host): Promise<void>; onToggleProxy(host: Host): Promise<void>; onOpenTerminal(hostId: string): void; onMonitor(hostId: string): void; onTest(host: Host): Promise<void>; onToggleHost(host: Host): Promise<void>; onEdit(host: Host): void; onDelete(host: Host): void }) {
  return <>
    <tr className="host-group-row">{selectionMode && <td className="host-select-cell"><SelectionCheckbox label={`选择${groupName}中的全部主机`} checked={groupSelected} indeterminate={groupIndeterminate} onChange={onSelectGroup} /></td>}<td colSpan={6}><div className="host-group-line"><button className="host-group-toggle" aria-expanded={!collapsed} onClick={onToggleGroup}><CaretDown className={`host-group-caret ${collapsed ? "collapsed" : ""}`} size={17} weight="bold" aria-hidden="true" /><strong>{groupName}</strong><span>{hosts.length} 台</span>{selectionMode && hosts.some((host) => selectedIds.has(host.id)) && <em>{hosts.filter((host) => selectedIds.has(host.id)).length} 台已选</em>}</button>{!ungrouped && !selectionMode && <button className="host-group-rename" onClick={onRenameGroup}>重命名</button>}</div></td></tr>
    {!collapsed && hosts.map((host) => {
      const availableLogins = hostLogins.filter((login) => login.hostId === host.id);
      const activeLoginAvailable = availableLogins.some((login) => login.id === host.activeLoginId);
      const activeLogin = availableLogins.find((login) => login.id === host.activeLoginId);
      const terminalLabel = host.enabled ? "打开终端" : "打开终端（主机已停用）";
      const testLabel = testingHostId === host.id ? "测试中…" : "测试连接";
      const toggleLabel = updatingHostId === host.id ? "处理中…" : host.enabled ? "停用主机" : "启用主机";
      return <tr key={host.id} className={`host-member-row ${selectedIds.has(host.id) ? "host-row-selected" : ""}`}>
          {selectionMode && <td className="host-select-cell"><SelectionCheckbox label={`选择主机 ${host.name}`} checked={selectedIds.has(host.id)} onChange={(selected) => onSelectHost(host.id, selected)} /></td>}
          <td className="host-member-cell"><div className="host-member-main"><div className="host-name-text"><Desktop size={20} weight="regular" aria-hidden="true" /><span><strong>{host.name}</strong><small title={host.proxyState?.errorMessage}>{host.hostname}:{host.port}{host.proxyEnabled ? ` · 代理 ${proxyStatusLabel(host.proxyState?.status)} · ${host.proxyLocalHost}:${host.proxyLocalPort}` : ""}</small></span></div><div className="host-row-switches" aria-label={`${host.name} 快捷开关`}><HostRowSwitch label="启用主机" checked={host.enabled} ariaLabel={`${host.name}：${toggleLabel}`} title={toggleLabel} disabled={testingHostId !== null || updatingHostId !== null} onClick={() => void onToggleHost(host)} />{activeLogin && activeLogin.username !== "root" && <HostRowSwitch label="启用sudo" checked={activeLogin.sudoEnabled} ariaLabel={`${activeLogin.username} 的 sudo 权限`} title={activeLogin.sudoEnabled ? `点击禁止 ${activeLogin.username} 使用 sudo` : `点击允许 ${activeLogin.username} 使用 sudo`} disabled={updatingHostId !== null} onClick={() => void onToggleSudo(host, activeLogin)} />}<HostRowSwitch label="文件传输通道" checked={host.hostTransferEnabled} ariaLabel={`${host.name} 的文件传输`} title={host.hostTransferEnabled ? "关闭主机间文件传输" : "允许主机间文件传输"} disabled={updatingHostId !== null} onClick={() => void onToggleHostTransfer(host)} /><HostRowSwitch label="使用本机代理" checked={host.proxyEnabled} ariaLabel={`${host.name} 的本机代理`} title={host.proxyEnabled ? `关闭本机代理（${proxyStatusLabel(host.proxyState?.status)}${host.proxyState?.errorMessage ? `：${host.proxyState.errorMessage}` : ""}）` : "配置本机 SOCKS5 代理并开启反向隧道"} disabled={!host.enabled || updatingHostId !== null} onClick={() => void onToggleProxy(host)} /></div></div></td>
          <td className="host-status-cell"><div className="host-status-line"><Status value={host.enabled ? host.status : "DISABLED"} /><button className="host-action-icon host-status-test" aria-label={`${host.name}：${testLabel}`} data-tooltip={testLabel} disabled={!host.enabled || testingHostId !== null || updatingHostId !== null} onClick={() => void onTest(host)}><ArrowClockwise size={16} aria-hidden="true" /></button></div>{testResults[host.id] && <small className={`test-result ${testResults[host.id]!.kind}`}>{testResults[host.id]!.text}</small>}</td>
          <td><span className={host.enabled && host.aiAccessEnabled ? "access-state allow" : "access-state"}>{host.enabled && host.aiAccessEnabled ? <CheckCircle size={17} weight="regular" /> : null}{!host.enabled ? "主机停用" : host.aiAccessEnabled ? "允许" : "未允许"}</span></td>
          <td className="host-user-cell"><div className="host-inline-select-shell host-user-select-shell"><span className="host-select-badge" aria-hidden="true">SSH</span><select className="host-inline-select" title="切换 AI 使用的 SSH 登录用户" aria-label={`${host.name} 当前登录用户`} value={activeLoginAvailable ? host.activeLoginId! : ""} disabled={updatingHostId !== null || availableLogins.length === 0} onChange={(event) => void onActivateLogin(host, event.target.value)}>{!activeLoginAvailable && <option value="" disabled>{availableLogins.length === 0 ? "暂无可用用户" : "请选择登录用户"}</option>}{availableLogins.map((login) => <option key={login.id} value={login.id}>{login.username}</option>)}</select><CaretDown size={14} weight="bold" aria-hidden="true" /></div></td>
          <td className="host-policy-cell"><div className="host-inline-select-shell host-policy-select-shell"><span className="host-select-badge" aria-hidden="true">权限策略</span><select className="host-inline-select" title="切换该主机的权限策略" aria-label={`${host.name} 权限策略`} value={host.policyId ?? ""} disabled={updatingHostId !== null} onChange={(event) => void onChangePolicy(host, event.target.value)}><option value="">未配置</option>{orderPolicies(policies).map((policy) => <option key={policy.id} value={policy.id}>{policy.name}</option>)}</select><CaretDown size={14} weight="bold" aria-hidden="true" /></div></td>
          <td className="host-actions-column"><div className="host-inline-actions" aria-label={`${host.name} 操作`}>
            <button className="host-action-icon" aria-label={`${host.name}：${terminalLabel}`} data-tooltip={terminalLabel} disabled={!host.enabled} onClick={() => onOpenTerminal(host.id)}><TerminalWindow size={18} aria-hidden="true" /></button>
            <button className="host-action-icon" aria-label={`${host.name}：指令记录`} data-tooltip="指令记录" onClick={() => onMonitor(host.id)}><ClockCounterClockwise size={18} aria-hidden="true" /></button>
            <button className="host-action-icon" aria-label={`${host.name}：编辑`} data-tooltip="编辑" disabled={testingHostId === host.id || updatingHostId === host.id} onClick={() => onEdit(host)}><PencilSimple size={18} aria-hidden="true" /></button>
            <button className="host-action-icon danger-link" aria-label={`${host.name}：删除`} data-tooltip="删除" disabled={testingHostId === host.id || updatingHostId === host.id} onClick={() => onDelete(host)}><Trash size={18} aria-hidden="true" /></button>
          </div></td>
        </tr>;
    })}
  </>;
}

function HostRowSwitch({ label, checked, ariaLabel, title, disabled, onClick }: { label: string; checked: boolean; ariaLabel: string; title: string; disabled: boolean; onClick(): void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={ariaLabel} className={`host-row-switch ${checked ? "on" : ""}`} title={title} disabled={disabled} onClick={onClick}><span className="host-row-switch-label">{label}</span><span className="host-row-switch-track" aria-hidden="true"><span /></span></button>;
}

function ProxySettingsDialog({ host, onClose, onSave }: { host: Host; onClose(): void; onSave(settings: { proxyLocalHost: string; proxyLocalPort: number; proxyRemotePort: number }): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setErrorText("");
    const data = new FormData(event.currentTarget);
    try {
      await onSave({
        proxyLocalHost: String(data.get("proxyLocalHost") ?? "").trim(),
        proxyLocalPort: Number(data.get("proxyLocalPort")),
        proxyRemotePort: Number(data.get("proxyRemotePort"))
      });
    } catch (error) {
      setErrorText(message(error));
    } finally {
      setBusy(false);
    }
  }
  return <Modal title={`配置 ${host.name} 的本机代理`} onClose={() => !busy && onClose()}><form onSubmit={submit} className="form-grid">
    <label className="span-2">本机代理地址<input name="proxyLocalHost" required maxLength={255} defaultValue={host.proxyLocalHost || "127.0.0.1"} placeholder="127.0.0.1" autoFocus /></label>
    <label>本机代理端口<input name="proxyLocalPort" type="number" min="1" max="65535" required defaultValue={host.proxyLocalPort || 7890} /></label>
    <label>远端监听端口<input name="proxyRemotePort" type="number" min="1" max="65535" required defaultValue={host.proxyRemotePort || 7890} /></label>
    <p className="form-hint span-2">远端只监听 <code>127.0.0.1:远端端口</code>，并自动注入 <code>ALL_PROXY=socks5h://127.0.0.1:远端端口</code>；流量通过 SSH 隧道转发到上面的本机代理地址和端口。</p>
    {errorText && <div className="form-error span-2" role="alert">{errorText}</div>}
    <div className="form-actions span-2"><button type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy}>{busy ? "开启中…" : "保存并开启"}</button></div>
  </form></Modal>;
}

function SelectionCheckbox({ label, checked, indeterminate = false, disabled = false, onChange }: { label: string; checked: boolean; indeterminate?: boolean; disabled?: boolean; onChange(selected: boolean): void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
}

function HostMonitorPage({ host, credential, onBack, onHostChanged, notify }: { host: Host; credential?: Credential; onBack(): void; onHostChanged(): Promise<void>; notify: Notify }) {
  const [history, setHistory] = useState<AuditLog[]>([]);
  const [events, setEvents] = useState<HostMonitorEvent[]>([]);
  const [connection, setConnection] = useState<"CONNECTING" | "LIVE" | "RECONNECTING">("CONNECTING");
  const [showCredential, setShowCredential] = useState(false);
  const [togglingOutput, setTogglingOutput] = useState(false);
  const terminalRef = useRef<HTMLDivElement>(null);

  async function toggleOutput() {
    if (togglingOutput) return;
    setTogglingOutput(true);
    try {
      const next = !host.monitorOutputEnabled;
      await patch(`/v1/hosts/${host.id}`, { monitorOutputEnabled: next });
      if (!next) setEvents((current) => current.filter((event) => event.kind !== "STDOUT" && event.kind !== "STDERR"));
      await onHostChanged();
      notify("ok", next ? "已开启命令输出，内存回放使用用户保险库密钥加密" : "已隐藏命令输出，并清除了内存中的输出回放");
    } catch (error) { notify("error", message(error)); }
    finally { setTogglingOutput(false); }
  }

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    setHistory([]); setEvents([]); setConnection("CONNECTING");
    void api<AuditLog[]>(`/v1/audit-logs?hostId=${encodeURIComponent(host.id)}&limit=100`).then((logs) => {
      if (cancelled) return;
      setHistory([...logs].reverse());
      source = new EventSource(`/v1/hosts/${encodeURIComponent(host.id)}/events`);
      source.onopen = () => setConnection("LIVE");
      source.onerror = () => setConnection("RECONNECTING");
      source.onmessage = (messageEvent) => {
        const event = JSON.parse(messageEvent.data) as HostMonitorEvent;
        setEvents((current) => current.some((item) => item.id === event.id) ? current : [...current, event].slice(-500));
      };
    }).catch((error) => notify("error", `无法加载主机监控：${message(error)}`));
    return () => { cancelled = true; source?.close(); };
  }, [host.id, notify]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [history, events]);

  return <section className="monitor-page">
    <PageHeader breadcrumb={<Breadcrumb parentLabel="主机" current="指令记录" onBack={onBack} />} title={host.name}>
      <div className="header-actions"><span className={`monitor-state ${connection.toLowerCase()}`}><i />{connection === "LIVE" ? "实时连接" : connection === "CONNECTING" ? "正在连接" : "正在重连"}</span><button onClick={() => { setHistory([]); setEvents([]); }}>清空屏幕</button></div>
    </PageHeader>
    <div className="monitor-summary">
      <div><span>远程节点</span><code>{host.username}@{host.hostname}:{host.port}</code></div>
      <div><span>访问来源</span><strong>{!host.enabled ? "已停用 · AI 不可访问" : host.aiAccessEnabled ? "AI / UI / CLI" : "UI / CLI"}</strong></div>
      <div><span>模式</span><strong className="readonly-label">只读 · {host.monitorOutputEnabled ? "加密输出" : "输出隐藏"}</strong></div>
    </div>
    <div className="panel host-credential-summary">
      <div><span className="eyebrow">Authentication</span><strong>{credential ? credentialTypeLabel(credential.type) : "未配置认证"}</strong><small>{credential ? credentialSummary(credential) : "编辑主机以配置密码、私钥或 SSH Agent"}</small></div>
      {credential && credential.type !== "SSH_AGENT" && <button onClick={() => setShowCredential(true)}>查看 / 复制认证信息</button>}
    </div>
    <div className="terminal-shell panel">
      <div className="terminal-toolbar"><TerminalWindow size={18} aria-hidden="true" /><span>{host.name} / AI 操作流</span><div className="terminal-output-control"><small>{host.monitorOutputEnabled ? "用户密钥加密 · 仅内存" : "stdout / stderr 已隐藏"}</small><button className={`compact-toggle ${host.monitorOutputEnabled ? "enabled" : ""}`} disabled={togglingOutput} aria-pressed={host.monitorOutputEnabled} onClick={() => void toggleOutput()}>{togglingOutput ? "处理中…" : host.monitorOutputEnabled ? "隐藏运行结果" : "显示运行结果"}</button></div></div>
      <div className="terminal-output" ref={terminalRef} role="log" aria-live="polite" aria-label={`${host.name} 只读命令监控`}>
        {!host.monitorOutputEnabled && <div className="terminal-output-disabled">命令与执行状态仍可审计；stdout/stderr 默认隐藏。开启后，短暂回放会使用当前用户的保险库密钥加密。</div>}
        {history.map((log) => <HistoricalTerminalEntry key={log.id} log={log} />)}
        {events.map((event) => <LiveTerminalEntry key={event.id} event={event} />)}
        {history.length === 0 && events.length === 0 && <div className="terminal-empty"><span>等待 Hoplane 操作…</span><small>AI 通过 MCP 发送命令后，会在这里实时显示命令和策略判断；运行结果由上方开关控制。</small></div>}
      </div>
    </div>
    <p className="monitor-footnote">监控内容会自动脱敏并受输出上限保护。stdout/stderr 不写入数据库；开启显示时，Core 内存回放使用用户主密码派生密钥进行 AES-256-GCM 加密，刷新或关闭 Hoplane 后不会恢复。</p>
    {showCredential && credential && <RevealCredentialDialog host={host} credential={credential} notify={notify} onClose={() => setShowCredential(false)} />}
  </section>;
}

function RevealCredentialDialog({ host, credential, notify, onClose }: { host: Host; credential: Credential; notify: Notify; onClose(): void }) {
  const [revealed, setRevealed] = useState<RevealedCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => { setRevealed(null); onClose(); }, revealed.expiresInSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setErrorText("");
    try {
      setRevealed(await post<RevealedCredential>(`/v1/hosts/${host.id}/credential/reveal`, { masterPassword: data.get("masterPassword") }));
    } catch (error) { setErrorText(message(error)); }
    finally { setBusy(false); }
  }

  async function copySecret(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify("ok", `${label}已复制，30 秒后尝试从剪贴板清除`);
      window.setTimeout(async () => {
        try { if (await navigator.clipboard.readText() === value) await navigator.clipboard.writeText(""); }
        catch { /* Clipboard read permission is optional. */ }
      }, 30_000);
    } catch { notify("error", "无法写入剪贴板，请手动选择复制"); }
  }

  return <Modal title={`${host.name} · 认证信息`} onClose={onClose}>
    {!revealed ? <form onSubmit={unlock} className="vault-form credential-reauth">
      <p>为防止已解锁设备上的误操作，请再次输入 Hoplane 保险库主密码。查看行为会写入本地审计日志。</p>
      <label>保险库主密码<input name="masterPassword" type="password" required autoFocus autoComplete="current-password" /></label>
      {errorText && <div className="form-error" role="alert">{errorText}</div>}
      <button type="submit" className="primary" disabled={busy}>{busy ? "验证中…" : "验证并查看"}</button>
    </form> : <div className="revealed-credential">
      <div className="reveal-warning">明文仅在当前窗口显示 {revealed.expiresInSeconds} 秒。AI、MCP 和 CLI 无法调用此功能。</div>
      {revealed.secret !== null && <section><div className="secret-heading"><strong>{credential.type === "PASSWORD" ? "登录密码" : "私钥口令"}</strong><button onClick={() => void copySecret(revealed.secret!, credential.type === "PASSWORD" ? "密码" : "私钥口令")}>复制</button></div><pre>{revealed.secret}</pre></section>}
      {revealed.privateKey !== null && <section><div className="secret-heading"><div><strong>私钥</strong><small>{credential.metadata.privateKeyPath}</small></div><button onClick={() => void copySecret(revealed.privateKey!, "私钥")}>复制私钥</button></div><pre className="private-key-value">{revealed.privateKey}</pre></section>}
      {revealed.secret === null && revealed.privateKey === null && <div className="empty">该认证方式没有可显示的密码或私钥内容。</div>}
    </div>}
  </Modal>;
}

function credentialTypeLabel(type: Credential["type"]): string {
  return type === "PASSWORD" ? "密码认证" : type === "PRIVATE_KEY" ? "私钥认证" : "SSH Agent";
}

function credentialSummary(credential: Credential): string {
  const detail = credential.type === "PRIVATE_KEY" ? credential.metadata.privateKeyPath : credential.type === "SSH_AGENT" ? credential.metadata.agentSocket || "SSH_AUTH_SOCK" : "已保存在本地加密保险库";
  const sudo = credential.sudoMode === "LOGIN_PASSWORD" ? "sudo 复用登录密码" : credential.sudoMode === "CUSTOM_PASSWORD" ? "已配置独立 sudo 密码" : "未配置 sudo 验证";
  return `主机专属 · ${detail ?? "已配置"} · ${sudo}`;
}

function HistoricalTerminalEntry({ log }: { log: AuditLog }) {
  return <div className="terminal-entry historical">
    <div className="terminal-meta"><time>{terminalTime(log.createdAt)}</time><span className="source-tag">{log.clientType}</span><span>{operationLabel(log.operationType)}</span><span className="history-tag">历史</span></div>
    {log.requestSummary && <pre className="terminal-command"><span>$</span> {log.requestSummary}</pre>}
    <div className={`terminal-system ${terminalStatusClass(log.status)}`}>↳ {statusText(log.status, log)}{log.policyDecision ? ` · 策略 ${log.policyDecision}${log.decisionReasonCode ? ` (${log.decisionReasonCode})` : ""}` : ""}</div>
  </div>;
}

function LiveTerminalEntry({ event }: { event: HostMonitorEvent }) {
  if (event.kind === "STDOUT" || event.kind === "STDERR") return <pre className={`terminal-stream ${event.kind.toLowerCase()} ${event.truncated ? "truncated" : ""}`}>{event.content}</pre>;
  const isStart = Boolean(event.operationType);
  return <div className={`terminal-entry live ${isStart ? "operation-start" : "operation-update"}`}>
    {isStart && <><div className="terminal-meta"><time>{terminalTime(event.timestamp)}</time><span className="source-tag">{event.clientType ?? "—"}</span><span>{operationLabel(event.operationType ?? "OPERATION")}</span></div>{event.requestSummary ? <pre className="terminal-command"><span>$</span> {event.requestSummary}</pre> : <div className="terminal-system muted">↳ {operationLabel(event.operationType ?? "OPERATION")}已开始</div>}</>}
    {!isStart && <div className={`terminal-system ${terminalStatusClass(event.status)}`}><time>{terminalTime(event.timestamp)}</time> ↳ {event.policyDecision ? `策略 ${event.policyDecision}${event.decisionReasonCode ? ` (${event.decisionReasonCode})` : ""}` : statusText(event.status ?? "RECEIVED", event)}</div>}
  </div>;
}

function terminalTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour12: false }); }
function terminalStatusClass(status?: string): string { return status === "SUCCEEDED" ? "success" : ["FAILED", "DENIED", "TIMED_OUT"].includes(status ?? "") ? "failure" : "muted"; }
function operationLabel(value: string): string { return ({ EXECUTE_COMMAND: "执行命令", TEST_HOST: "连接测试", UPLOAD_FILE: "上传文件", DOWNLOAD_FILE: "下载文件", TRANSFER_FILE: "主机间传输", REVEAL_CREDENTIAL: "查看认证信息", TERMINAL_SESSION: "交互终端" } as Record<string, string>)[value] ?? value; }
function statusText(status: string, value: Pick<AuditLog, "exitCode" | "durationMs" | "bytesTransferred" | "errorCode" | "errorMessage"> | HostMonitorEvent): string {
  const labels: Record<string, string> = { RECEIVED: "已接收", EXECUTING: "远端执行中", SUCCEEDED: "执行完成", DENIED: "已拒绝", FAILED: "执行失败", TIMED_OUT: "执行超时", INTERRUPTED: "执行中断" };
  const details = [value.exitCode != null ? `退出码 ${value.exitCode}` : null, value.durationMs != null ? `${value.durationMs} ms` : null, value.bytesTransferred != null ? `${value.bytesTransferred} bytes` : null, value.errorCode ?? null, value.errorMessage ?? null].filter(Boolean);
  return `${labels[status] ?? status}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

function HostDialog({ host, credentials, policies, groupNames, onAccountsChanged, onClose, onSaved }: { host: Host | null; credentials: Credential[]; policies: Policy[]; groupNames: string[]; onAccountsChanged(): Promise<void>; onClose(): void; onSaved(saved: Host, created: boolean): Promise<void> }) {
  const currentCredential = host?.credentialId ? credentials.find((credential) => credential.id === host.credentialId) : undefined;
  const recommendedPolicyId = policies.find((policy) => policy.name === DEFAULT_POLICY_TEMPLATE.name)?.id ?? "";
  const [authMode, setAuthMode] = useState<"PASSWORD" | "PRIVATE_KEY" | "SSH_AGENT">(currentCredential?.type ?? "PASSWORD");
  const [sudoMode, setSudoMode] = useState<"NONE" | "LOGIN_PASSWORD" | "CUSTOM_PASSWORD">(currentCredential?.sudoMode ?? "NONE");
  const [sudoEnabled, setSudoEnabled] = useState(false);
  const [proxyEnabled, setProxyEnabled] = useState(host?.proxyEnabled ?? false);
  const [newUsername, setNewUsername] = useState("root");
  const [busy, setBusy] = useState(false);
  const [loginEditorActive, setLoginEditorActive] = useState(false);
  const [errorText, setErrorText] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loginEditorActive) { setErrorText("正在编辑登录用户，请先保存或取消用户编辑，再保存主机。"); return; }
    setBusy(true); setErrorText("");
    const data = new FormData(event.currentTarget);
    const name = String(data.get("name") ?? "");
    const secret = String(data.get("secret") ?? "");
    const credential = {
      mode: "INLINE",
      ...(currentCredential ? { credentialId: currentCredential.id } : {}),
      name: `${name} 登录凭据`,
      type: authMode,
      ...(secret ? { secret } : {}),
      sudoMode,
      ...(data.get("sudoSecret") ? { sudoSecret: data.get("sudoSecret") } : {}),
      metadata: {
        ...(authMode === "PRIVATE_KEY" ? { privateKeyPath: data.get("privateKeyPath") } : {}),
        ...(authMode === "SSH_AGENT" && data.get("agentSocket") ? { agentSocket: data.get("agentSocket") } : {})
      }
    };
    const payload = {
      name, hostname: data.get("hostname"), port: Number(data.get("port")),
      ...(!host ? { username: data.get("username"), credential, sudoEnabled } : {}),
      policyId: data.get("policyId") || null, groupName: data.get("groupName") || null,
      tags: String(data.get("tags") ?? "").split(",").map(v => v.trim()).filter(Boolean), defaultDirectory: data.get("defaultDirectory") || null,
      enabled: data.get("enabled") === "on", aiAccessEnabled: data.get("aiAccessEnabled") === "on",
      hostTransferEnabled: data.get("hostTransferEnabled") === "on",
      proxyEnabled,
      proxyLocalHost: String(data.get("proxyLocalHost") ?? "").trim(),
      proxyLocalPort: Number(data.get("proxyLocalPort")),
      proxyRemotePort: Number(data.get("proxyRemotePort"))
    };
    try {
      const saved = host ? await patch<Host>(`/v1/hosts/${host.id}`, payload) : await post<Host>("/v1/hosts", payload);
      await onSaved(saved, !host);
    }
    catch (error) { setErrorText(message(error)); }
    finally { setBusy(false); }
  }
  function requestClose() {
    if (busy) return;
    if (loginEditorActive && !window.confirm("登录用户还在编辑中，关闭后未保存的修改会丢失。确定关闭吗？")) return;
    onClose();
  }
  return <Modal title={host ? "编辑主机" : "添加主机"} onClose={requestClose}><div className="host-dialog-layout"><form id="host-settings-form" onSubmit={submit} className="form-grid">
    <label>显示名称<input name="name" required defaultValue={host?.name} /></label><label>分组<input name="groupName" list="host-group-options" defaultValue={host?.groupName ?? ""} placeholder="选择已有分组或输入新分组" /><datalist id="host-group-options">{groupNames.map((groupName) => <option key={groupName} value={groupName} />)}</datalist></label>
    <label className="span-2">主机地址<input name="hostname" required defaultValue={host?.hostname} placeholder="server.example.com" /></label>
    <label>端口<input name="port" type="number" min="1" max="65535" required defaultValue={host?.port ?? 22} /></label>{!host && <label>用户名<input name="username" required value={newUsername} onChange={(event) => setNewUsername(event.target.value)} /></label>}
    {!host && <><div className="span-2 auth-section">
      <div className="auth-section-head"><div><strong>认证方式</strong><small>认证信息只属于当前主机，并保存在本地加密保险库。</small></div><select aria-label="认证方式" value={authMode} onChange={event => { const next = event.target.value as typeof authMode; setAuthMode(next); if (next !== "PASSWORD" && sudoMode === "LOGIN_PASSWORD") setSudoMode("NONE"); }}><option value="PASSWORD">密码</option><option value="PRIVATE_KEY">私钥</option><option value="SSH_AGENT">SSH Agent</option></select></div>
      <div className="auth-fields">
        {authMode === "PRIVATE_KEY" && <label>私钥路径<input name="privateKeyPath" required defaultValue={currentCredential?.type === "PRIVATE_KEY" ? currentCredential.metadata.privateKeyPath : ""} placeholder="~/.ssh/id_ed25519" /></label>}
        {authMode === "SSH_AGENT" && <label>Agent Socket（留空使用 SSH_AUTH_SOCK）<input name="agentSocket" defaultValue={currentCredential?.type === "SSH_AGENT" ? currentCredential.metadata.agentSocket : ""} /></label>}
        {authMode !== "SSH_AGENT" && <label>{authMode === "PASSWORD" ? "登录密码" : "私钥口令（可选）"}<input name="secret" type="password" required={authMode === "PASSWORD" && !(currentCredential?.type === "PASSWORD" && currentCredential.hasSecret)} autoComplete="new-password" placeholder={currentCredential?.type === authMode && currentCredential.hasSecret ? "留空表示保持不变" : ""} /></label>}
      </div>
    </div>
    {newUsername.trim() !== "root" && <div className="span-2 auth-section sudo-auth-section">
      <label className="check"><input type="checkbox" checked={sudoEnabled} onChange={(event) => { setSudoEnabled(event.target.checked); if (!event.target.checked) setSudoMode("NONE"); else if (authMode === "PASSWORD") setSudoMode("LOGIN_PASSWORD"); }} />允许该非 root 用户执行 sudo</label>
      <div className="auth-section-head"><div><strong>sudo 验证</strong><small>AI 只发送 sudo 命令，Hoplane 在远端提示时安全写入密码，密码不会返回给 AI。</small></div><select aria-label="sudo 验证方式" value={sudoMode} onChange={event => setSudoMode(event.target.value as typeof sudoMode)}><option value="NONE">不提供密码（仅 NOPASSWD）</option>{authMode === "PASSWORD" && <option value="LOGIN_PASSWORD">复用登录密码</option>}<option value="CUSTOM_PASSWORD">使用独立 sudo 密码</option></select></div>
      {sudoMode === "CUSTOM_PASSWORD" && <div className="auth-fields"><label>sudo 密码<input name="sudoSecret" type="password" required={!(currentCredential?.sudoMode === "CUSTOM_PASSWORD" && currentCredential.hasSudoSecret)} autoComplete="new-password" placeholder={currentCredential?.sudoMode === "CUSTOM_PASSWORD" && currentCredential.hasSudoSecret ? "留空表示保持不变" : "输入远端用户的 sudo 密码"} /></label></div>}
      <p className="form-hint">仅处理以 <code>sudo</code> 开头的非交互命令。未配置密码时 Hoplane 使用 <code>sudo -n</code>，避免等待输入；主机策略仍需允许该 sudo 命令。</p>
    </div>}</>}
    <label>权限策略<select name="policyId" defaultValue={host?.policyId ?? recommendedPolicyId}><option value="">请选择</option>{orderPolicies(policies).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><span className="field-recommendation">新主机默认推荐“{DEFAULT_POLICY_TEMPLATE.name}”</span></label>
    <label className="span-2">默认工作目录<input name="defaultDirectory" defaultValue={host?.defaultDirectory ?? ""} placeholder="/opt/app" /></label>
    <label className="span-2">标签<input name="tags" defaultValue={host?.tags.join(", ")} placeholder="production, api" /></label>
    <label className="check"><input name="enabled" type="checkbox" defaultChecked={host?.enabled ?? true} />启用主机</label>
    <label className="check"><input name="aiAccessEnabled" type="checkbox" defaultChecked={host?.aiAccessEnabled ?? false} />允许 AI 访问</label>
    <label className="check span-2"><input name="hostTransferEnabled" type="checkbox" defaultChecked={host?.hostTransferEnabled ?? false} />允许主机间文件传输</label>
    <p className="form-hint span-2">文件传输开关属于当前主机且默认关闭；路径、大小、上传下载和覆盖限制仍由所选策略控制。</p>
    <div className="span-2 auth-section">
      <label className="check"><input name="proxyEnabled" type="checkbox" checked={proxyEnabled} onChange={(event) => setProxyEnabled(event.target.checked)} />使用本机 SOCKS5 代理</label>
      {proxyEnabled && <div className="auth-fields">
        <label>本机代理地址<input name="proxyLocalHost" required maxLength={255} defaultValue={host?.proxyLocalHost ?? "127.0.0.1"} placeholder="127.0.0.1" /></label>
        <label>本机代理端口<input name="proxyLocalPort" type="number" min="1" max="65535" required defaultValue={host?.proxyLocalPort ?? 7890} /></label>
        <label>远端监听端口<input name="proxyRemotePort" type="number" min="1" max="65535" required defaultValue={host?.proxyRemotePort ?? 7890} /></label>
      </div>}
      {!proxyEnabled && <><input name="proxyLocalHost" type="hidden" value={host?.proxyLocalHost ?? "127.0.0.1"} /><input name="proxyLocalPort" type="hidden" value={host?.proxyLocalPort ?? 7890} /><input name="proxyRemotePort" type="hidden" value={host?.proxyRemotePort ?? 7890} /></>}
      <p className="form-hint">开启后，Hoplane 将远端回环端口映射到指定的本机代理地址和端口，并为远端命令和交互终端注入 <code>ALL_PROXY=socks5h://127.0.0.1:远端端口</code>。隧道不可用时命令会失败，不会静默直连。</p>
    </div>
    <p className="form-hint span-2">AI 和 MCP 只会收到主机 ID，不会得到密码、私钥、口令或保险库内容。</p>
    {errorText && <div className="form-error span-2" role="alert">{errorText}</div>}
  </form>{host && <HostLoginsEditor host={host} onChanged={onAccountsChanged} onEditingChange={setLoginEditorActive} />}
    <div className="form-actions host-dialog-actions"><button type="button" onClick={requestClose} disabled={busy}>取消</button><button type="submit" form="host-settings-form" className="primary" disabled={busy || loginEditorActive}>{busy ? "保存中…" : loginEditorActive ? "请先保存或取消用户编辑" : "保存主机"}</button></div>
  </div></Modal>;
}

function HostLoginsEditor({ host, onChanged, onEditingChange }: { host: Host; onChanged(): Promise<void>; onEditingChange(editing: boolean): void }) {
  const [logins, setLogins] = useState<HostLogin[]>([]);
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [editing, setEditing] = useState<HostLogin | "new" | null>(null);
  const [errorText, setErrorText] = useState("");
  const load = useCallback(async () => {
    const [items, allCredentials] = await Promise.all([
      api<HostLogin[]>(`/v1/hosts/${host.id}/logins`),
      api<Credential[]>("/v1/credentials")
    ]);
    setLogins(items); setCredentials(allCredentials);
  }, [host.id]);
  useEffect(() => { void load().catch((error) => setErrorText(message(error))); }, [load]);
  useEffect(() => { onEditingChange(editing !== null); }, [editing, onEditingChange]);
  async function changed() {
    await Promise.all([load(), onChanged()]);
  }
  async function activate(login: HostLogin) {
    try {
      await post(`/v1/hosts/${host.id}/logins/${login.id}/activate`);
      await changed();
    } catch (error) { setErrorText(message(error)); }
  }
  async function deleteLogin(login: HostLogin) {
    if (!window.confirm(`删除用户“${login.username}”及其专属认证信息？`)) return;
    try {
      await remove(`/v1/hosts/${host.id}/logins/${login.id}`);
      await changed();
    } catch (error) { setErrorText(message(error)); }
  }
  return <section className="host-logins-editor">
    <header><div><strong>登录用户</strong><small>切换后的用户是 AI 唯一可用的 SSH 身份；每套密码独立保存在本地加密保险库。</small></div><button type="button" onClick={() => setEditing("new")}>添加用户</button></header>
    <div className="host-login-list">{logins.map((login) => <div key={login.id} className={login.active ? "active" : ""}>
      <div className="host-login-avatar">{login.username.slice(0, 1).toUpperCase()}</div>
      <div><strong>{login.username}</strong><small>{login.active ? "当前 AI 身份" : "备用身份"}{login.username !== "root" ? login.sudoEnabled ? " · 已允许 sudo" : " · 禁止 sudo" : " · root"}</small></div>
      <div className="host-login-actions">{!login.active && <button type="button" onClick={() => void activate(login)}>切换到此用户</button>}<button type="button" onClick={() => setEditing(login)}>编辑</button>{!login.active && <button type="button" className="danger-link" onClick={() => void deleteLogin(login)}>删除</button>}</div>
    </div>)}</div>
    {editing && <HostLoginForm host={host} login={editing === "new" ? null : editing} credential={editing === "new" || !editing.credentialId ? undefined : credentials.find((item) => item.id === editing.credentialId)} onCancel={() => setEditing(null)} onSaved={async () => { setEditing(null); await changed(); }} />}
    {errorText && <div className="form-error" role="alert">{errorText}</div>}
  </section>;
}

function HostLoginForm({ host, login, credential, onCancel, onSaved }: { host: Host; login: HostLogin | null; credential?: Credential; onCancel(): void; onSaved(): Promise<void> }) {
  const [authMode, setAuthMode] = useState<Credential["type"]>(credential?.type ?? "PASSWORD");
  const [sudoEnabled, setSudoEnabled] = useState(login?.sudoEnabled ?? false);
  const [sudoMode, setSudoMode] = useState<Credential["sudoMode"]>(credential?.sudoMode ?? "LOGIN_PASSWORD");
  const [username, setUsername] = useState(login?.username ?? "");
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const root = username.trim() === "root";
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setErrorText("");
    const data = new FormData(event.currentTarget);
    const secret = String(data.get("secret") ?? "");
    const effectiveSudoEnabled = root ? true : sudoEnabled;
    const effectiveSudoMode = root || !effectiveSudoEnabled ? "NONE" : sudoMode;
    const payload = {
      username,
      sudoEnabled: effectiveSudoEnabled,
      credential: {
        mode: "INLINE",
        ...(credential ? { credentialId: credential.id } : {}),
        name: `${host.name} ${username} 登录凭据`,
        type: authMode,
        ...(secret ? { secret } : {}),
        sudoMode: effectiveSudoMode,
        ...(data.get("sudoSecret") ? { sudoSecret: data.get("sudoSecret") } : {}),
        metadata: {
          ...(authMode === "PRIVATE_KEY" ? { privateKeyPath: data.get("privateKeyPath") } : {}),
          ...(authMode === "SSH_AGENT" && data.get("agentSocket") ? { agentSocket: data.get("agentSocket") } : {})
        }
      }
    };
    try {
      if (login) await patch(`/v1/hosts/${host.id}/logins/${login.id}`, payload);
      else await post(`/v1/hosts/${host.id}/logins`, payload);
      await onSaved();
    } catch (error) { setErrorText(message(error)); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit} className="host-login-form">
    <div className="host-login-form-head"><strong>{login ? `编辑 ${login.username}` : "添加登录用户"}</strong><button type="button" onClick={onCancel}>取消</button></div>
    <div className="host-login-fields"><label>用户名<input required value={username} onChange={(event) => setUsername(event.target.value)} /></label><label>认证方式<select value={authMode} onChange={(event) => { const next = event.target.value as Credential["type"]; setAuthMode(next); if (next !== "PASSWORD" && sudoMode === "LOGIN_PASSWORD") setSudoMode("CUSTOM_PASSWORD"); }}><option value="PASSWORD">密码</option><option value="PRIVATE_KEY">私钥</option><option value="SSH_AGENT">SSH Agent</option></select></label></div>
    {authMode === "PRIVATE_KEY" && <label>私钥路径<input name="privateKeyPath" required defaultValue={credential?.type === "PRIVATE_KEY" ? credential.metadata.privateKeyPath : ""} placeholder="~/.ssh/id_ed25519" /></label>}
    {authMode === "SSH_AGENT" && <label>Agent Socket（留空使用 SSH_AUTH_SOCK）<input name="agentSocket" defaultValue={credential?.type === "SSH_AGENT" ? credential.metadata.agentSocket : ""} /></label>}
    {authMode !== "SSH_AGENT" && <label>{authMode === "PASSWORD" ? "登录密码" : "私钥口令（可选）"}<input name="secret" type="password" required={authMode === "PASSWORD" && !(credential?.type === "PASSWORD" && credential.hasSecret)} autoComplete="new-password" placeholder={credential?.type === authMode && credential.hasSecret ? "留空表示保持不变" : ""} /></label>}
    {!root && <div className="host-login-sudo"><label className="check"><input type="checkbox" checked={sudoEnabled} onChange={(event) => setSudoEnabled(event.target.checked)} />允许 AI 使用 sudo</label>{sudoEnabled && <><label>sudo 验证方式<select value={sudoMode} onChange={(event) => setSudoMode(event.target.value as Credential["sudoMode"])}><option value="NONE">仅允许 NOPASSWD</option>{authMode === "PASSWORD" && <option value="LOGIN_PASSWORD">复用登录密码</option>}<option value="CUSTOM_PASSWORD">独立 sudo 密码</option></select></label>{sudoMode === "CUSTOM_PASSWORD" && <label>sudo 密码<input name="sudoSecret" type="password" required={!(credential?.sudoMode === "CUSTOM_PASSWORD" && credential.hasSudoSecret)} placeholder={credential?.hasSudoSecret ? "留空表示保持不变" : ""} /></label>}</>}</div>}
    {errorText && <div className="form-error" role="alert">{errorText}</div>}
    <div className="form-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button className="primary" disabled={busy}>{busy ? "保存中…" : "保存用户"}</button></div>
  </form>;
}

function PoliciesPage({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<Policy[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draft, setDraft] = useState<PolicyDocument | null>(null);
  const [yaml, setYaml] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [baseVersion, setBaseVersion] = useState(0);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<"visual" | "yaml">("visual");
  const [conflict, setConflict] = useState(false);
  const [externalYaml, setExternalYaml] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const selected = items.find((policy) => policy.id === selectedId) ?? null;

  const hydrate = useCallback(async (policy: Policy) => {
    const source = await api<PolicySourceView>(`/v1/policies/${policy.id}/source`);
    setSelectedId(policy.id); setDraftName(policy.name); setDraft(clonePolicy(policy.document)); setYaml(source.yaml);
    setSourcePath(source.path); setSourceError(source.error); setYamlError(null); setBaseVersion(policy.version);
    setConflict(false); setExternalYaml(null);
  }, []);

  const load = useCallback(async () => {
    try {
      const result = orderPolicies(await api<Policy[]>("/v1/policies"));
      setItems(result);
      const current = selectedId ? result.find((policy) => policy.id === selectedId) : null;
      if (!current) {
        const initial = result.find((policy) => policy.name === DEFAULT_POLICY_TEMPLATE.name) ?? result[0];
        if (initial) await hydrate(initial);
      } else if (editing && current.version !== baseVersion) {
        setConflict(true);
      } else if (editing && current.sourceError !== sourceError) {
        setSourceError(current.sourceError);
      } else if (!editing && (current.version !== baseVersion || current.sourceError !== sourceError)) {
        await hydrate(current);
      }
    } catch (error) { notify("error", message(error)); }
  }, [baseVersion, editing, hydrate, notify, selectedId, sourceError]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 3000); return () => window.clearInterval(timer); }, [load]);

  async function choose(policy: Policy) {
    if (editing && !window.confirm("当前修改尚未保存，确定切换策略吗？")) return;
    setEditing(false); await hydrate(policy);
  }
  function updateDraft(next: PolicyDocument) {
    setDraft(next); setYaml(serializeDraft(selectedId ?? undefined, draftName, next)); setYamlError(null);
  }
  function updateName(name: string) {
    setDraftName(name); if (draft) setYaml(serializeDraft(selectedId ?? undefined, name, draft));
  }
  function updateYaml(value: string) {
    setYaml(value);
    try { const parsed = parsePolicySource(value); setDraftName(parsed.name); setDraft(parsed.document); setYamlError(null); }
    catch (error) { setYamlError(message(error)); }
  }
  async function save(expectedVersion = baseVersion) {
    if (!selected || !draft || !editing) return;
    if (yamlError) { notify("error", yamlError); return; }
    try {
      const updated = tab === "yaml"
        ? await put<Policy>(`/v1/policies/${selected.id}/source`, { yaml, expectedVersion })
        : await patch<Policy>(`/v1/policies/${selected.id}`, { name: draftName, document: draft, expectedVersion });
      setItems(current => orderPolicies(current.map((item) => item.id === updated.id ? updated : item)));
      setEditing(false); await hydrate(updated); notify("ok", `策略已更新至 v${updated.version}`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "POLICY_VERSION_CONFLICT") setConflict(true);
      notify("error", message(error));
    }
  }
  async function reloadCurrent() { const current = items.find((policy) => policy.id === selectedId); if (current) { setEditing(false); await hydrate(current); } }
  async function showExternal() { if (!selected) return; const source = await api<PolicySourceView>(`/v1/policies/${selected.id}/source`); setExternalYaml(source.yaml); }
  async function rescan() { const result = await post<{ scanned: number; updated: number; errors: number }>("/v1/policies/rescan", {}); await load(); notify(result.errors ? "error" : "ok", `扫描 ${result.scanned} 个文件，更新 ${result.updated} 个，错误 ${result.errors} 个`); }
  async function restore() { if (!selected) return; const restored = await post<Policy>(`/v1/policies/${selected.id}/restore`, {}); await hydrate(restored); await load(); notify("ok", "已从上一有效版本恢复 YAML 文件"); }
  async function openDirectory() {
    if (window.hoplane?.openPoliciesDirectory) { await window.hoplane.openPoliciesDirectory(); return; }
    const directory = (await api<{ directory: string }>("/v1/policies/settings")).directory;
    await navigator.clipboard.writeText(directory); notify("ok", "策略目录路径已复制");
  }
  const selectedTemplate = selected ? findPolicyTemplateByName(selected.name) : undefined;
  return <section><PageHeader eyebrow="Guardrails" title="权限策略"><div className="header-actions"><button onClick={() => void openDirectory()}>打开策略目录</button><button onClick={() => void rescan()}>重新扫描</button><button className="primary" onClick={() => setShowCreate(true)}>新建策略</button></div></PageHeader>
    <div className="split policy-split"><div className="policy-list">{items.map(item => { const template = findPolicyTemplateByName(item.name); return <button key={item.id} className={selectedId === item.id ? "selected" : ""} onClick={() => void choose(item)}><div className="policy-list-title"><strong>{item.name}</strong><PolicySyncBadge policy={item} /></div><span>{template ? `${riskLabel(template.risk)} · ${template.scenario}` : "自定义策略"}</span><small>Version {item.version}</small></button>; })}</div>
      <div className={`panel policy-workbench ${editing ? "editing" : "readonly"}`}>
        <div className="editor-bar"><div><input aria-label="策略名称" value={draftName} readOnly={!editing} onChange={(event) => updateName(event.target.value)} /></div><div className="policy-meta"><span>v{selected?.version ?? "—"}</span>{selected && <PolicySyncBadge policy={selected} />}</div></div>
        {selectedTemplate && <div className="policy-editor-context"><strong>适合：{selectedTemplate.scenario}</strong><span>{selectedTemplate.description}</span></div>}
        {(selected?.sourceStatus === "ERROR" || selected?.sourceStatus === "MISSING") && <div className="policy-source-alert"><strong>{selected?.sourceStatus === "MISSING" ? "策略文件缺失，当前策略已停用" : "外部 YAML 校验失败，继续使用上一有效版本"}</strong><span>{sourceError ?? selected.sourceError}</span>{selected?.sourceStatus === "MISSING" && <button onClick={() => void restore()}>恢复文件</button>}</div>}
        {conflict && <div className="policy-conflict"><div><strong>外部版本已经生效</strong><span>当前草稿基于 v{baseVersion}，服务器现在是 v{selected?.version}。保存前请选择处理方式。</span></div><div><button onClick={() => void showExternal()}>查看外部 YAML</button><button onClick={() => void reloadCurrent()}>重新加载</button><button className="primary" onClick={() => selected && void save(selected.version)}>用当前草稿覆盖</button></div></div>}
        {externalYaml !== null && <details className="external-yaml" open><summary>当前外部版本</summary><pre>{externalYaml}</pre></details>}
        <div className="policy-tabs" role="tablist"><button className={tab === "visual" ? "selected" : ""} onClick={() => setTab("visual")}>可视化配置</button><button className={tab === "yaml" ? "selected" : ""} onClick={() => setTab("yaml")}>YAML 源码</button><code title={sourcePath}>{sourcePath || "尚未生成文件"}</code></div>
        <div className="policy-editor-body">
          {tab === "visual" && draft && <StructuredPolicyEditor value={draft} disabled={!editing} onChange={updateDraft} />}
          {tab === "yaml" && <div className="yaml-source-editor"><div className="yaml-lines" aria-hidden="true">{Array.from({ length: Math.max(1, yaml.split("\n").length) }, (_, index) => <span key={index}>{index + 1}</span>)}</div><textarea style={{ height: `${Math.max(620, yaml.split("\n").length * 18.7 + 34)}px` }} aria-label="策略 YAML" spellCheck={false} readOnly={!editing} value={yaml} onChange={(event) => updateYaml(event.target.value)} /></div>}
          {yamlError && <div className="form-error yaml-error" role="alert">{yamlError}</div>}
        </div>
        <div className="editor-actions">{editing ? <><button onClick={() => void reloadCurrent()}>取消</button><button className="primary" disabled={Boolean(yamlError || conflict)} onClick={() => void save()}>保存新版本</button></> : <button className="primary" disabled={!selected || !selected.enabled} onClick={() => setEditing(true)}>编辑策略</button>}</div>
      </div>
    </div>
    {showCreate && <CreatePolicyDialog notify={notify} onClose={() => setShowCreate(false)} onCreated={async (created) => { setItems(current => orderPolicies([...current, created])); setShowCreate(false); setEditing(false); await hydrate(created); notify("ok", `策略“${created.name}”已创建`); }} />}
  </section>;
}

function CreatePolicyDialog({ notify, onClose, onCreated }: { notify: Notify; onClose(): void; onCreated(policy: Policy): void }) {
  const [templateKey, setTemplateKey] = useState(DEFAULT_POLICY_TEMPLATE.key as string);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  const template = findPolicyTemplate(templateKey) ?? DEFAULT_POLICY_TEMPLATE;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setErrorText("");
    try {
      const created = await post<Policy>("/v1/policies", { name: data.get("name"), document: template.document });
      onCreated(created);
    } catch (error) {
      const text = message(error);
      setErrorText(text); notify("error", `策略创建失败：${text}`);
    } finally {
      setBusy(false);
    }
  }
  function changeTemplate(value: string) {
    const next = findPolicyTemplate(value) ?? DEFAULT_POLICY_TEMPLATE;
    setTemplateKey(next.key);
  }
  return <Modal title="新建权限策略" onClose={onClose}><form onSubmit={submit} className="form-grid">
    <label className="span-2">策略名称<input name="name" required maxLength={120} placeholder={`例如：生产环境${template.name}`} /></label>
    <label className="span-2">策略模板<select value={templateKey} onChange={event => changeTemplate(event.target.value)}>{POLICY_TEMPLATES.map((item) => <option key={item.key} value={item.key}>{item.name} · {riskLabel(item.risk)}</option>)}</select><span className="field-recommendation">适合：{template.scenario}</span></label>
    {template.risk === "HIGH" && <div className="policy-danger span-2" role="alert"><strong>高风险模板</strong><span>允许任意命令和 Shell 操作符，并允许在本机与远端任意路径上传、下载和覆盖文件。只应绑定到隔离环境或专用低权限 SSH 账号。</span></div>}
    {template.risk === "MEDIUM" && <div className="policy-caution span-2"><strong>包含变更操作</strong><span>该模板放开了部分 Docker 或 Kubernetes 变更命令。建议复制模板后继续增加适合目标环境的黑名单。</span></div>}
    <div className="policy-template-preview span-2"><strong>{template.name}</strong><span>{template.description}</span><small>创建后可使用可视化配置或直接编辑 YAML。</small></div>
    {errorText && <div className="form-error span-2" role="alert">{errorText}</div>}
    <div className="form-actions span-2"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary" disabled={busy}>{busy ? "创建中…" : "创建策略"}</button></div>
  </form></Modal>;
}

interface PolicySourceView { id: string; yaml: string; path: string; version: number; status: Policy["sourceStatus"]; error: string | null }

function PolicySyncBadge({ policy }: { policy: Policy }) {
  const labels: Record<Policy["sourceStatus"], string> = { SYNCED: "已同步", ERROR: "配置错误", MISSING: "文件缺失", DISABLED: "已停用" };
  return <em className={`policy-sync ${policy.sourceStatus.toLowerCase()}`}>{labels[policy.sourceStatus]}</em>;
}

function StructuredPolicyEditor({ value, disabled, onChange }: { value: PolicyDocument; disabled: boolean; onChange(value: PolicyDocument): void }) {
  const update = <K extends keyof PolicyDocument>(key: K, next: PolicyDocument[K]) => onChange({ ...value, [key]: next });
  const catalogPatterns = new Set(COMMAND_BLACKLIST_CATALOG.map((rule) => rule.pattern));
  const customRules = value.commandBlacklist.filter((rule) => !catalogPatterns.has(rule.pattern));
  function toggleCatalog(pattern: string, enabled: boolean) {
    const without = value.commandBlacklist.filter((rule) => rule.pattern !== pattern);
    const catalogRule = COMMAND_BLACKLIST_CATALOG.find((rule) => rule.pattern === pattern);
    update("commandBlacklist", enabled && catalogRule ? [...without, { pattern: catalogRule.pattern, description: catalogRule.description }] : without);
  }
  function updateCustom(rules: PolicyCommandRule[]) {
    update("commandBlacklist", [...value.commandBlacklist.filter((rule) => catalogPatterns.has(rule.pattern)), ...rules]);
  }
  return <div className="structured-policy">
    <div className="policy-danger"><strong>黑名单模式</strong><span>所有命令默认允许，只有命中下列规则时拒绝。全权限策略的黑名单为空。</span></div>
    <PolicySection title="系统命令黑名单" description="勾选需要禁止的系统变更类别；查询命令和未匹配命令默认允许。">
      <BlacklistGroup group="SYSTEM" value={value.commandBlacklist} disabled={disabled} onToggle={toggleCatalog} />
    </PolicySection>
    <PolicySection title="Docker / Compose 黑名单" description="按风险层级禁止容器变更；未勾选的 Docker 子命令默认允许。">
      <BlacklistGroup group="DOCKER" value={value.commandBlacklist} disabled={disabled} onToggle={toggleCatalog} />
    </PolicySection>
    <PolicySection title="Kubernetes 黑名单" description="禁止常规变更、高风险操作或全部 kubectl；未命中的命令默认允许。">
      <BlacklistGroup group="KUBERNETES" value={value.commandBlacklist} disabled={disabled} onToggle={toggleCatalog} />
    </PolicySection>
    <PolicySection title="Shell 黑名单" description="阻止组合符和包装执行；未勾选时相应命令默认允许。">
      <BlacklistGroup group="SHELL" value={value.commandBlacklist} disabled={disabled} onToggle={toggleCatalog} />
    </PolicySection>
    <PolicySection title="文件传输约束" description="控制上传、下载、覆盖、路径和单文件大小；是否允许主机间传输由每台主机自己的开关控制。">
      <div className="permission-toggles"><Toggle label="允许上传" checked={value.files.allowUpload} disabled={disabled} onChange={(allowUpload) => update("files", { ...value.files, allowUpload })} /><Toggle label="允许下载" checked={value.files.allowDownload} disabled={disabled} onChange={(allowDownload) => update("files", { ...value.files, allowDownload })} /><Toggle label="允许覆盖" danger checked={value.files.allowOverwrite} disabled={disabled} onChange={(allowOverwrite) => update("files", { ...value.files, allowOverwrite })} /></div>
      <div className="policy-field-grid"><TextList label="允许的本地路径" value={value.files.allowedLocalPaths} disabled={disabled} placeholder="/Users/name/Downloads" onChange={(allowedLocalPaths) => update("files", { ...value.files, allowedLocalPaths })} /><TextList label="远端上传路径" value={value.files.allowedRemoteUploadPaths} disabled={disabled} placeholder="/opt/app/uploads" onChange={(allowedRemoteUploadPaths) => update("files", { ...value.files, allowedRemoteUploadPaths })} /><TextList label="远端下载路径" value={value.files.allowedRemoteDownloadPaths} disabled={disabled} placeholder="/var/log/app" onChange={(allowedRemoteDownloadPaths) => update("files", { ...value.files, allowedRemoteDownloadPaths })} /><label>最大上传 MB<input disabled={disabled} type="number" min="1" max="10240" value={Math.round(value.files.maxUploadBytes / 1024 / 1024)} onChange={(event) => update("files", { ...value.files, maxUploadBytes: Math.max(1, Number(event.target.value)) * 1024 * 1024 })} /></label><label>最大下载 MB<input disabled={disabled} type="number" min="1" max="10240" value={Math.round(value.files.maxDownloadBytes / 1024 / 1024)} onChange={(event) => update("files", { ...value.files, maxDownloadBytes: Math.max(1, Number(event.target.value)) * 1024 * 1024 })} /></label></div>
    </PolicySection>
    <PolicySection title="自定义命令黑名单" description="正则匹配整条命令；命中任意一条即拒绝，不存在允许规则。"><RulesEditor label="拒绝正则" value={customRules} disabled={disabled} onChange={updateCustom} /></PolicySection>
  </div>;
}

function PolicySection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="policy-section"><header><div><h3>{title}</h3><p>{description}</p></div></header><div className="policy-section-content">{children}</div></section>; }
function Toggle({ label, checked, disabled, danger, onChange }: { label: string; checked: boolean; disabled: boolean; danger?: boolean; onChange(value: boolean): void }) { return <label className={`check policy-toggle ${danger ? "danger" : ""}`}><input type="checkbox" disabled={disabled} checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label>; }
function BlacklistGroup({ group, value, disabled, onToggle }: { group: "SYSTEM" | "DOCKER" | "KUBERNETES" | "SHELL"; value: PolicyCommandRule[]; disabled: boolean; onToggle(pattern: string, enabled: boolean): void }) { const rules = COMMAND_BLACKLIST_CATALOG.filter((rule) => rule.group === group); return <div className="capability-group danger"><span>勾选表示拒绝</span><div>{rules.map((rule) => <label key={rule.key} title={rule.description}><input type="checkbox" disabled={disabled} checked={value.some((item) => item.pattern === rule.pattern)} onChange={(event) => onToggle(rule.pattern, event.target.checked)} />{rule.label}</label>)}</div>{rules.some((rule) => value.some((item) => item.pattern === rule.pattern)) && <small>已启用的规则会在命令发送到 SSH 前拒绝匹配请求。</small>}</div>; }
function TextList({ label, value, disabled, placeholder, onChange }: { label: string; value: string[]; disabled: boolean; placeholder: string; onChange(value: string[]): void }) { return <label className="text-list">{label}<textarea disabled={disabled} rows={Math.max(2, Math.min(4, value.length || 2))} placeholder={placeholder} value={value.join("\n")} onChange={(event) => onChange(splitLines(event.target.value))} /></label>; }
function RulesEditor({ label, value, disabled, onChange }: { label: string; value: PolicyCommandRule[]; disabled: boolean; onChange(value: PolicyCommandRule[]): void }) {
  return <div className="rules-editor"><strong>{label}</strong><TextList label="每行一个正则" value={value.map((rule) => rule.pattern)} disabled={disabled} placeholder="^\\s*危险命令(?:\\s|$)" onChange={(patterns) => onChange(patterns.map((pattern) => ({ pattern })))} /></div>;
}

function clonePolicy(document: PolicyDocument): PolicyDocument { return JSON.parse(JSON.stringify(document)) as PolicyDocument; }
function splitLines(value: string): string[] { return value.split(/\r?\n|,/gu).map((item) => item.trim()).filter(Boolean); }
function serializeDraft(id: string | undefined, name: string, document: PolicyDocument): string { return stringify({ ...(id ? { id } : {}), name, ...document }, { indent: 2, lineWidth: 0 }); }
function parsePolicySource(yaml: string): { name: string; document: PolicyDocument } {
  const parsed = parseDocument(yaml, { prettyErrors: true, strict: true });
  if (parsed.errors.length) throw new Error(parsed.errors.map((error) => error.message).join("; "));
  const result = policySourceSchema.safeParse(parsed.toJS());
  if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const { id: _id, name, ...document } = result.data;
  return { name, document };
}

function orderPolicies(policies: Policy[]): Policy[] {
  const ranks = new Map(POLICY_TEMPLATES.map((template, index) => [template.name, index]));
  return [...policies].sort((left, right) => {
    const leftRank = ranks.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = ranks.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.name.localeCompare(right.name, "zh-CN");
  });
}

function riskLabel(risk: "LOW" | "MEDIUM" | "HIGH"): string {
  return risk === "LOW" ? "低风险" : risk === "MEDIUM" ? "中风险" : "高风险";
}

function AuditPage({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<AuditLog[]>([]); const [status, setStatus] = useState("");
  const load = useCallback(async () => { try { setItems(await api(`/v1/audit-logs?limit=200${status ? `&status=${status}` : ""}`)); } catch(e) { notify("error", message(e)); } }, [notify, status]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
  return <section><PageHeader eyebrow="Traceability" title="操作审计"><select className="filter" aria-label="筛选审计结果" value={status} onChange={e => setStatus(e.target.value)}><option value="">全部结果</option><option>SUCCEEDED</option><option>DENIED</option><option>FAILED</option><option>TIMED_OUT</option></select></PageHeader>
    <div className="panel table-panel audit-table-panel"><table><thead><tr><th>时间</th><th>来源</th><th>主机 / 操作</th><th>请求摘要</th><th>策略</th><th>结果</th><th>耗时</th></tr></thead><tbody>{items.map(log => <tr key={log.id}><td>{new Date(log.createdAt).toLocaleString()}</td><td>{log.clientType}</td><td><strong>{log.peerHostNameSnapshot ? `${log.hostNameSnapshot ?? "—"} → ${log.peerHostNameSnapshot}` : log.hostNameSnapshot ?? "—"}</strong><small>{log.operationType}</small></td><td className="summary">{log.requestSummary ?? "—"}</td><td>{log.policyDecision ?? "—"}</td><td><Status value={log.status} detail={log.errorCode} /></td><td>{log.durationMs == null ? "—" : `${log.durationMs} ms`}</td></tr>)}</tbody></table>{items.length === 0 && <Empty text="暂无操作记录。拒绝和失败的请求也会显示在这里。" />}</div>
  </section>;
}

interface McpSettings { enabled: boolean; endpoint: string; token: string | null; transport: "streamable-http"; vaultLocked: boolean }
interface CodexIntegrationState {
  installed: boolean; skillInstalled: boolean; mcpConfigured: boolean; restartRequired: boolean;
  codexHome: string; skillPath: string; configPath: string; runtimeCommand: string; configSnippet: string;
  canInstall: boolean; candidates: CodexHomeCandidate[];
}
interface CodexHomeCandidate {
  path: string; label: string; source: "SELECTED" | "ENVIRONMENT" | "DEFAULT" | "COMMON";
  exists: boolean; isDirectory: boolean; configStatus: "VALID" | "MISSING" | "INVALID";
  configDetail: string; writable: boolean; selected: boolean;
}
interface CodexDiagnostic { ok: boolean; toolNames: string[]; checks: Array<{ name: string; ok: boolean; detail: string }> }
interface JsonAgentIntegrationState {
  agent: JsonAgentChannel; installed: boolean; skillInstalled: boolean; mcpConfigured: boolean; restartRequired: boolean;
  configDirectory: string; agentHome: string; skillPath: string; configPath: string; runtimeCommand: string; configSnippet: string;
  canInstall: boolean; configError: string | null; candidates: CodexHomeCandidate[];
}
interface AgentIntegrationsState { cursor: JsonAgentIntegrationState; claudeCode: JsonAgentIntegrationState; workbuddy: JsonAgentIntegrationState }

function VaultGate({ state, notify, onReady }: { state: VaultState; notify: Notify; onReady(state: VaultState): void }) {
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget); const password = String(data.get("password") ?? "");
    if (!state.localInitialized && password !== String(data.get("confirmation") ?? "")) { setErrorText("两次输入的主密码不一致"); return; }
    setBusy(true); setErrorText("");
    try {
      const next = await post<VaultState>(state.localInitialized ? "/v1/vault/unlock" : "/v1/vault/setup", { password });
      onReady(next); notify("ok", state.localInitialized ? "本地保险库已解锁" : "本地加密保险库已创建");
    } catch (error) { setErrorText(message(error)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop vault-backdrop"><div className="modal vault-modal"><div className="vault-emblem">Hoplane</div><span className="eyebrow">Encrypted local vault</span><h2>{state.localInitialized ? "解锁 Hoplane" : "创建本地主密码"}</h2><p>{state.localInitialized ? "输入主密码解锁 SSH 凭据和 MCP Token。主密码不会写入磁盘。" : "默认使用本地加密保险库。主密码无法恢复，请妥善保存。"}</p><form onSubmit={submit} className="vault-form">
    <label>主密码<input name="password" type="password" minLength={state.localInitialized ? 1 : 10} maxLength={1024} required autoFocus autoComplete={state.localInitialized ? "current-password" : "new-password"} /></label>
    {!state.localInitialized && <label>确认主密码<input name="confirmation" type="password" minLength={10} maxLength={1024} required autoComplete="new-password" /></label>}
    {errorText && <div className="form-error" role="alert">{errorText}</div>}
    <button type="submit" className="primary" disabled={busy}>{busy ? "处理中…" : state.localInitialized ? "解锁保险库" : "创建并解锁"}</button>
  </form></div></div>;
}

function SettingsPage({ notify, vaultState, onVaultChanged }: { notify: Notify; vaultState: VaultState | null; onVaultChanged(state: VaultState): void }) {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [codex, setCodex] = useState<CodexIntegrationState | null>(null);
  const [agentIntegrations, setAgentIntegrations] = useState<AgentIntegrationsState | null>(null);
  const [diagnostic, setDiagnostic] = useState<CodexDiagnostic | null>(null);
  const [busy, setBusy] = useState(false);
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [manualCodexHome, setManualCodexHome] = useState("");
  const [manualAgentDirectories, setManualAgentDirectories] = useState<Record<JsonAgentChannel, string>>({ cursor: "", "claude-code": "", workbuddy: "" });
  const [integrationChannel, setIntegrationChannel] = useState<IntegrationChannel>("codex");
  const load = useCallback(async () => {
    try {
      const [mcpState, codexState, agentStates] = await Promise.all([api<McpSettings>("/v1/mcp-settings"), api<CodexIntegrationState>("/v1/codex-integration"), api<AgentIntegrationsState>("/v1/agent-integrations")]);
      setSettings(mcpState); setCodex(codexState); setAgentIntegrations(agentStates); setManualCodexHome(codexState.codexHome);
      setManualAgentDirectories({ cursor: agentStates.cursor.configDirectory, "claude-code": agentStates.claudeCode.configDirectory, workbuddy: agentStates.workbuddy.configDirectory });
    }
    catch (error) { notify("error", message(error)); }
  }, [notify]);
  useEffect(() => { void load(); }, [load, vaultState?.unlocked]);

  const config = settings?.token ? JSON.stringify({
    mcpServers: {
      hoplane: {
        type: "streamable-http",
        url: settings.endpoint,
        headers: { Authorization: `Bearer ${settings.token}` }
      }
    }
  }, null, 2) : "正在读取本地配置…";
  const visibleConfig = settings?.token && !showToken ? config.replace(settings.token, `hpl_${"•".repeat(24)}`) : config;

  async function toggle() {
    if (!settings || !settings.token || busy) return;
    setBusy(true);
    try {
      const next = await patch<McpSettings>("/v1/mcp-settings", { enabled: !settings.enabled });
      setSettings(next);
      notify("ok", next.enabled ? "MCP 服务已开启" : "MCP 服务已关闭");
    } catch (error) { notify("error", message(error)); }
    finally { setBusy(false); }
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notify("ok", `${label}已复制`); }
    catch { notify("error", "无法写入剪贴板，请手动选择复制"); }
  }

  async function regenerate() {
    if (!settings?.token || busy || !confirm("重新生成后，已经连接 Hoplane 的 Agent 都需要更新 Token。继续吗？")) return;
    setBusy(true);
    try {
      const next = await post<McpSettings>("/v1/mcp-settings/regenerate-token", {});
      setSettings(next); setShowToken(true); notify("ok", "访问 Token 已更新");
    } catch (error) { notify("error", message(error)); }
    finally { setBusy(false); }
  }

  async function lockVault() {
    setBusy(true);
    try { onVaultChanged(await post<VaultState>("/v1/vault/lock", {})); notify("ok", "本地保险库已锁定"); }
    catch (error) { notify("error", message(error)); }
    finally { setBusy(false); }
  }

  async function installCodex() {
    if (integrationBusy) return;
    setIntegrationBusy(true); setDiagnostic(null);
    try {
      const next = await post<CodexIntegrationState>("/v1/codex-integration/install", {});
      setCodex(next);
      notify("ok", "Codex Skill 与 stdio MCP 已安装，请完全退出并重启 Codex 客户端后生效");
    } catch (error) { notify("error", `Codex 集成安装失败：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function selectCodexHome(path: string) {
    if (integrationBusy) return;
    setIntegrationBusy(true); setDiagnostic(null);
    try {
      const next = await post<CodexIntegrationState>("/v1/codex-integration/select", { path });
      setCodex(next); setManualCodexHome(next.codexHome);
      notify("ok", `已选择 Codex 目录：${next.codexHome}`);
    } catch (error) { notify("error", `Codex 目录不可用：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function refreshCodexHomes() {
    if (integrationBusy) return;
    setIntegrationBusy(true); setDiagnostic(null);
    try {
      const next = await api<CodexIntegrationState>("/v1/codex-integration");
      setCodex(next); setManualCodexHome(next.codexHome);
      notify("ok", "Codex 常见目录已重新扫描");
    } catch (error) { notify("error", `目录扫描失败：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function diagnoseCodex() {
    if (integrationBusy) return;
    setIntegrationBusy(true); setDiagnostic(null);
    try {
      const result = await post<CodexDiagnostic>("/v1/codex-integration/diagnose", {});
      setDiagnostic(result);
      notify(result.ok ? "ok" : "error", result.ok ? `stdio MCP 验证成功，已加载 ${result.toolNames.length} 个工具` : "Codex 集成诊断发现问题");
    } catch (error) { notify("error", `诊断失败：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function installJsonAgent(agent: JsonAgentChannel) {
    if (integrationBusy) return;
    const name = JSON_AGENT_NAMES[agent];
    setIntegrationBusy(true);
    try {
      const next = await post<JsonAgentIntegrationState>(`/v1/agent-integrations/${agent}/install`, {});
      setAgentIntegrations(current => current ? { ...current, [agentStateKey(agent)]: next } : current);
      notify("ok", `${name} Skill 与 stdio MCP 已安装，请完全退出并重启 ${name} 客户端后生效`);
    } catch (error) { notify("error", `一键集成失败：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function selectJsonAgentDirectory(agent: JsonAgentChannel, path: string) {
    if (integrationBusy) return;
    const name = JSON_AGENT_NAMES[agent];
    setIntegrationBusy(true);
    try {
      const next = await post<JsonAgentIntegrationState>(`/v1/agent-integrations/${agent}/select`, { path });
      setAgentIntegrations(current => current ? { ...current, [agentStateKey(agent)]: next } : current);
      setManualAgentDirectories(current => ({ ...current, [agent]: next.configDirectory }));
      notify("ok", `已选择 ${name} 配置目录：${next.configDirectory}`);
    } catch (error) { notify("error", `${name} 配置目录不可用：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  async function refreshJsonAgentDirectories() {
    if (integrationBusy) return;
    setIntegrationBusy(true);
    try {
      const next = await api<AgentIntegrationsState>("/v1/agent-integrations");
      setAgentIntegrations(next);
      setManualAgentDirectories({ cursor: next.cursor.configDirectory, "claude-code": next.claudeCode.configDirectory, workbuddy: next.workbuddy.configDirectory });
      notify("ok", "常见配置目录已重新扫描");
    } catch (error) { notify("error", `目录扫描失败：${message(error)}`); }
    finally { setIntegrationBusy(false); }
  }

  const integrationTabs: Array<{ id: IntegrationChannel; label: string; detail: string }> = [
    { id: "codex", label: "Codex", detail: "一键集成" },
    { id: "cursor", label: "Cursor", detail: "一键集成" },
    { id: "claude-code", label: "Claude Code", detail: "一键集成" },
    { id: "workbuddy", label: "WorkBuddy", detail: "一键集成" },
    { id: "other", label: "其他 Agent", detail: "通用配置" }
  ];

  const jsonChannel: JsonAgentChannel | null = integrationChannel === "cursor" || integrationChannel === "claude-code" || integrationChannel === "workbuddy" ? integrationChannel : null;
  const selectedAgentInstalled = jsonChannel ? agentIntegrations?.[agentStateKey(jsonChannel)]?.installed ?? false : false;

  return <section><PageHeader eyebrow="Integrations" title="Agent 接入">
    <span className={`service-state ${(integrationChannel === "codex" ? codex?.installed : integrationChannel === "other" ? settings?.enabled : selectedAgentInstalled) ? "on" : "off"}`}><i />{integrationChannel === "codex" ? codex?.installed ? "Codex 已配置" : "Codex 未配置" : integrationChannel === "other" ? settings?.enabled ? "本地 MCP 已开启" : "本地 MCP 未开启" : selectedAgentInstalled ? "一键集成已安装" : "一键集成未安装"}</span>
  </PageHeader>
    <article className="panel vault-setting"><div><span className="eyebrow">Credential storage</span><h2>凭据存储</h2><p>凭据统一存储在受主密码保护的本地 AES-256-GCM 加密文件中，派生密钥仅保留在内存中。</p></div><div className="vault-setting-actions"><span className="badge allow">本地加密保险库</span><button disabled={busy || !vaultState?.unlocked} onClick={() => void lockVault()}>立即锁定</button></div></article>
    <div className="integration-tabs" role="tablist" aria-label="Agent 接入方式">{integrationTabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={integrationChannel === tab.id} aria-controls={`integration-panel-${tab.id}`} id={`integration-tab-${tab.id}`} className={integrationChannel === tab.id ? "selected" : ""} onClick={() => setIntegrationChannel(tab.id)}><strong>{tab.label}</strong><span>{tab.detail}</span></button>)}</div>
    {integrationChannel === "codex" && <article className="panel codex-integration" id="integration-panel-codex" role="tabpanel" aria-labelledby="integration-tab-codex">
      <div className="codex-integration-head"><div><span className="eyebrow">Recommended · stdio</span><h2>Codex 一键集成</h2><p>安装 Hoplane Skill，并把使用当前 App 内置运行时的 stdio MCP 写入 Codex 配置。不依赖系统 Node、源码目录或 HTTP 传输。</p></div><span className={`badge integration-status-badge ${codex?.installed ? "allow" : ""}`}>{codex?.installed ? "已安装" : "未安装"}</span></div>
      <div className="codex-home-discovery">
        <div className="codex-home-head"><div><strong>Codex 配置目录</strong><span>仅检查有限的常见位置，不递归扫描用户目录。请选择要写入的配置。</span></div><button disabled={integrationBusy} onClick={() => void refreshCodexHomes()}>重新扫描</button></div>
        <div className="codex-home-list">{codex?.candidates.map((candidate) => <button type="button" key={candidate.path} className={candidate.selected ? "selected" : ""} disabled={integrationBusy || candidate.configStatus === "INVALID" || !candidate.writable} onClick={() => void selectCodexHome(candidate.path)}>
          <span className="codex-home-radio"><i /></span><span className="codex-home-info"><strong>{candidate.label}</strong><code>{candidate.path}</code><small>{candidate.configDetail}</small></span><span className="codex-home-badges"><em className={`config-${candidate.configStatus.toLowerCase()}`}>{candidate.configStatus === "VALID" ? "配置有效" : candidate.configStatus === "MISSING" ? "将新建配置" : "配置异常"}</em><em className={candidate.writable ? "writable" : "blocked"}>{candidate.writable ? "可写" : "不可写"}</em></span>
        </button>)}</div>
        <form className="codex-home-manual" onSubmit={(event) => { event.preventDefault(); void selectCodexHome(manualCodexHome); }}><label>手动选择目录<input value={manualCodexHome} onChange={(event) => setManualCodexHome(event.target.value)} required maxLength={4096} placeholder="/Users/name/.codex 或 C:\\Users\\name\\.codex" /></label><button type="submit" disabled={integrationBusy || !manualCodexHome.trim()}>使用此目录</button></form>
      </div>
      <pre>{codex?.configSnippet ?? "正在读取 Codex 配置…"}</pre>
      <div className="config-actions"><button className="primary" disabled={!codex?.canInstall || integrationBusy} onClick={() => void installCodex()}>{integrationBusy ? "处理中…" : codex?.installed ? "重新安装 / 刷新路径" : "安装 Codex 集成"}</button><button disabled={!codex || integrationBusy} onClick={() => void diagnoseCodex()}>运行诊断</button><button disabled={!codex} onClick={() => codex && void copy(codex.configSnippet, "Codex 配置")}>复制配置</button></div>
      {codex?.restartRequired && <div className="restart-notice">安装已完成。请完全退出 Codex 客户端（包括后台进程）并重新启动，新的 Skill 和 MCP 配置才会生效。</div>}
      {diagnostic && <div className="diagnostic-list">{diagnostic.checks.map(check => <div key={check.name} className={check.ok ? "ok" : "failed"}><i /> <strong>{check.name}</strong><span>{check.detail}</span></div>)}</div>}
      <p>安装位置：<code>{codex?.skillPath ?? "—"}</code>。如果移动或重新安装 Hoplane App，再点击一次“刷新路径”。</p>
    </article>}
    {jsonChannel && <AgentOneClickIntegration
      channel={jsonChannel}
      integration={agentIntegrations?.[agentStateKey(jsonChannel)] ?? null}
      busy={integrationBusy}
      manualDirectory={manualAgentDirectories[jsonChannel]}
      onInstall={() => void installJsonAgent(jsonChannel)}
      onRefresh={() => void refreshJsonAgentDirectories()}
      onSelect={(path) => void selectJsonAgentDirectory(jsonChannel, path)}
      onManualDirectoryChange={(path) => setManualAgentDirectories(current => ({ ...current, [jsonChannel]: path }))}
      onCopy={(value, label) => void copy(value, label)}
    />}
    {integrationChannel === "other" && <><div className="mcp-hero panel" id="integration-panel-other" role="tabpanel" aria-labelledby="integration-tab-other">
      <div><span className="eyebrow">Optional · Streamable HTTP</span><h2>兼容其他 AI Agent</h2><p>HTTP 服务只监听本机地址。Codex 推荐使用上面的 stdio 集成，不受此开关影响。</p></div>
      <button className={`service-toggle ${settings?.enabled ? "enabled" : ""}`} disabled={!settings?.token || busy} onClick={() => void toggle()} aria-pressed={settings?.enabled}>{busy ? "处理中…" : settings?.vaultLocked ? "保险库已锁定" : settings?.enabled ? "关闭服务" : "开启服务"}</button>
    </div>
    <div className="settings-grid mcp-settings">
      <article className="panel setting"><span className="step">01</span><h2>连接地址</h2><div className="copy-row"><code>{settings?.endpoint ?? "—"}</code><button disabled={!settings} onClick={() => settings && void copy(settings.endpoint, "地址")}>复制</button></div><p>仅接受来自 127.0.0.1 或 localhost 的请求，并校验 Host 头以防止 DNS 重绑定。</p></article>
      <article className="panel setting"><span className="step">02</span><h2>访问 Token</h2><div className="copy-row"><code>{settings?.token ? showToken ? settings.token : `hpl_${"•".repeat(24)}` : "保险库未解锁"}</code><button disabled={!settings?.token} onClick={() => setShowToken(value => !value)}>{showToken ? "隐藏" : "显示"}</button><button disabled={!settings?.token} onClick={() => settings?.token && void copy(settings.token, "Token")}>复制</button></div><button className="danger-link token-reset" disabled={!settings?.token || busy} onClick={() => void regenerate()}>重新生成 Token</button><p>Token 只保存在本地加密保险库中，不写入 Hoplane 数据库。请只粘贴给你信任的本机 Agent。</p></article>
      <article className="panel setting config-card"><span className="step">03</span><h2>复制给 AI Agent</h2><pre>{visibleConfig}</pre><div className="config-actions"><button className="primary" disabled={!settings?.token || !settings.enabled} onClick={() => void copy(config, "MCP 配置")}>复制 MCP 配置</button><button disabled={!settings?.token || !settings.enabled} onClick={() => settings?.token && void copy(`请连接这个本地 Streamable HTTP MCP 服务：${settings.endpoint}，请求头 Authorization: Bearer ${settings.token}。服务名为 hoplane。`, "Agent 安装说明")}>复制安装说明</button></div><p>{settings?.enabled ? "粘贴到支持远程 MCP 的 Agent 配置中即可连接。" : "请先解锁保险库并开启服务，再复制配置。"} Agent 只能看到已勾选“允许 AI 访问”的主机，所有操作仍受策略控制并进入审计。</p></article>
    </div></>}
  </section>;
}

function AgentOneClickIntegration({ channel, integration, busy, manualDirectory, onInstall, onRefresh, onSelect, onManualDirectoryChange, onCopy }: {
  channel: JsonAgentChannel;
  integration: JsonAgentIntegrationState | null;
  busy: boolean;
  manualDirectory: string;
  onInstall(): void;
  onRefresh(): void;
  onSelect(path: string): void;
  onManualDirectoryChange(path: string): void;
  onCopy(value: string, label: string): void;
}) {
  const name = JSON_AGENT_NAMES[channel];
  const directoryPlaceholder = channel === "cursor" ? "/Users/name/.cursor" : channel === "workbuddy" ? "/Users/name/.workbuddy" : "/Users/name";
  return <article className="panel codex-integration agent-native-integration" id={`integration-panel-${channel}`} role="tabpanel" aria-labelledby={`integration-tab-${channel}`}>
    <div className="codex-integration-head"><div><span className="eyebrow">Recommended · stdio</span><h2>{name} 一键集成</h2><p>自动安装 Hoplane Skill，并把 App 内置 stdio MCP 写入 {name} 的用户级配置。不依赖系统 Node、本地 HTTP 服务或访问 Token。</p></div><span className={`badge integration-status-badge ${integration?.installed ? "allow" : ""}`}>{integration?.installed ? "已安装" : "未安装"}</span></div>
    <div className="codex-home-discovery">
      <div className="codex-home-head"><div><strong>{name} 配置目录</strong><span>仅检查有限的常见位置，不递归扫描用户目录。请选择要写入 Skill 和 MCP 配置的位置。</span></div><button disabled={busy} onClick={onRefresh}>重新扫描</button></div>
      <div className="codex-home-list">{integration?.candidates.map((candidate) => <button type="button" key={candidate.path} className={candidate.selected ? "selected" : ""} disabled={busy || candidate.configStatus === "INVALID" || !candidate.writable} onClick={() => onSelect(candidate.path)}>
        <span className="codex-home-radio"><i /></span><span className="codex-home-info"><strong>{candidate.label}</strong><code>{candidate.path}</code><small>{candidate.configDetail}</small></span><span className="codex-home-badges"><em className={`config-${candidate.configStatus.toLowerCase()}`}>{candidate.configStatus === "VALID" ? "配置有效" : candidate.configStatus === "MISSING" ? "将新建配置" : "配置异常"}</em><em className={candidate.writable ? "writable" : "blocked"}>{candidate.writable ? "可写" : "不可写"}</em></span>
      </button>)}</div>
      <form className="codex-home-manual" onSubmit={(event) => { event.preventDefault(); onSelect(manualDirectory); }}><label>手动选择目录<input value={manualDirectory} onChange={(event) => onManualDirectoryChange(event.target.value)} required maxLength={4096} placeholder={directoryPlaceholder} /></label><button type="submit" disabled={busy || !manualDirectory.trim()}>使用此目录</button></form>
    </div>
    <div className="agent-install-summary"><div><span>Skill 安装位置</span><code>{integration?.skillPath ?? "正在检测…"}</code></div><div><span>MCP 配置文件</span><code>{integration?.configPath ?? "正在检测…"}</code></div></div>
    {integration?.configError && <div className="form-error" role="alert">配置文件暂不可自动修改：{integration.configError}</div>}
    <pre>{integration?.configSnippet ?? "正在生成 stdio MCP 配置…"}</pre>
    <div className="config-actions"><button className="primary" disabled={!integration?.canInstall || busy} onClick={onInstall}>{busy ? "处理中…" : integration?.installed ? "重新安装 / 刷新路径" : `安装 ${name} 集成`}</button><button disabled={!integration} onClick={() => integration && onCopy(integration.configSnippet, `${name} MCP 配置`)}>复制配置</button></div>
    {integration?.restartRequired && <div className="restart-notice">安装已完成。请完全退出 {name} 客户端（包括后台/托盘进程）并重新启动，新的 Skill 和 MCP 配置才会生效。</div>}
    <p>安装会保留现有配置，仅更新 <code>mcpServers.hoplane</code>；首次修改已有配置前会创建 <code>.hoplane-backup</code> 备份。</p>
  </article>;
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId}><div className="modal-head"><h2 id={titleId}>{title}</h2><button type="button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>{children}</div></div>;
}
function Empty({ text }: { text: string }) { return <div className="empty">{text}</div>; }
function Status({ value, detail }: { value: string; detail?: string | null }) {
  const good = value === "CONNECTED" || value === "SUCCEEDED";
  const bad = ["FAILED", "DENIED", "TIMED_OUT", "AUTH_FAILED", "HOST_KEY_BLOCKED", "DISABLED"].includes(value);
  const labels: Record<string, string> = {
    CONNECTED: "已连接", CONNECTING: "连接中", DISCONNECTED: "未连接", SUCCEEDED: "成功", FAILED: "失败",
    DENIED: "已拒绝", TIMED_OUT: "已超时", AUTH_FAILED: "认证失败", HOST_KEY_BLOCKED: "指纹异常", DISABLED: "已停用"
  };
  return <span className={`status ${good ? "good" : bad ? "bad" : "idle"}`}><i />{labels[value] ?? value}{detail ? ` · ${detail}` : ""}</span>;
}
function proxyStatusLabel(value?: NonNullable<Host["proxyState"]>["status"]): string {
  return ({
    DISABLED: "已关闭", WAITING_FOR_VAULT: "等待解锁", CONNECTING: "连接中", ACTIVE: "已连接", RETRYING: "重连中",
    LOCAL_PROXY_UNAVAILABLE: "本机端口不可用", FAILED: "失败"
  } as Record<string, string>)[value ?? "CONNECTING"] ?? value ?? "连接中";
}
type Notify = (kind: "ok" | "error", text: string) => void;
function message(error: unknown): string { return error instanceof Error ? error.message : "操作失败"; }
function friendlyConnectionError(error: unknown): string {
  if (!(error instanceof ApiError)) return message(error);
  const messages: Record<string, string> = {
    CREDENTIAL_NOT_FOUND: "未绑定可用凭据",
    VAULT_LOCKED: "本地保险库已锁定",
    SSH_AUTH_FAILED: "SSH 认证失败，请检查用户名和凭据",
    SSH_HOST_UNREACHABLE: "本机无法到达该服务器。请在系统设置中允许 Hoplane 访问本地网络，并检查当前网络或 VPN",
    SSH_CONNECTION_REFUSED: "服务器拒绝了连接，请确认 SSH 服务已启动且端口填写正确",
    SSH_CONNECTION_TIMEOUT: "连接服务器超时，请检查网络、防火墙和 SSH 端口",
    SSH_HOST_NOT_FOUND: "无法解析主机地址，请检查域名或 DNS 配置",
    SSH_CONNECTION_FAILED: "无法连接服务器，请检查地址、端口和网络",
    SSH_HOST_KEY_UNTRUSTED: "需要确认服务器指纹",
    SSH_HOST_KEY_CHANGED: "服务器指纹已变化，连接被阻止",
    HOST_DISABLED: "主机已停用"
  };
  return messages[error.code] ?? error.message;
}
