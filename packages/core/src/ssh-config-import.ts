import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface ImportedSshHost {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile?: string;
  proxyJump?: string;
}

export interface SshConfigParseResult {
  hosts: ImportedSshHost[];
  warnings: string[];
}

const MAX_INCLUDE_DEPTH = 5;

export async function parseSshConfig(path = "~/.ssh/config"): Promise<SshConfigParseResult> {
  const warnings: string[] = [];
  const visited = new Set<string>();
  const lines = await expandConfigFile(expandHome(path), 0, warnings, visited);
  return { hosts: parseConfigLines(lines), warnings };
}

/*
 * Include 展开采用行级文本展开：Include 指令按出现位置替换为其引用文件的内容，
 * 随后统一交给块解析器。主配置文件读取失败沿用原错误路径；被 Include 的文件
 * 缺失只记录警告，不中断解析。
 */
async function expandConfigFile(file: string, depth: number, warnings: string[], visited: Set<string>): Promise<string[]> {
  const canonical = resolve(file);
  if (visited.has(canonical)) {
    warnings.push(`SSH 配置存在循环 Include，已跳过：${canonical}`);
    return [];
  }
  if (depth > MAX_INCLUDE_DEPTH) {
    warnings.push(`Include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层，已跳过：${canonical}`);
    return [];
  }
  let content: string;
  try {
    content = await readFile(canonical, "utf8");
  } catch (error) {
    if (depth === 0) throw error;
    warnings.push(`Include 文件无法读取：${canonical}`);
    return [];
  }
  visited.add(canonical);
  const expanded: string[] = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.*)$/u);
    if (!match) continue;
    if (match[1]!.toLowerCase() === "include") {
      expanded.push(...await expandIncludePaths(unquote(match[2]!.trim()), dirname(canonical), depth, warnings, visited));
    } else {
      expanded.push(line);
    }
  }
  return expanded;
}

async function expandIncludePaths(value: string, baseDir: string, depth: number, warnings: string[], visited: Set<string>): Promise<string[]> {
  const expanded: string[] = [];
  for (const token of value.split(/\s+/u)) {
    if (!token) continue;
    const pattern = expandHome(token);
    const absolute = isAbsolute(pattern) ? pattern : join(baseDir, pattern);
    const files = /[*?]/u.test(absolute) ? await globExpand(absolute) : [absolute];
    if (files.length === 0) warnings.push(`Include 未匹配到任何文件：${absolute}`);
    for (const file of files) expanded.push(...await expandConfigFile(file, depth + 1, warnings, visited));
  }
  return expanded;
}

/* 最小 glob：仅支持 * 与 ?（不跨目录段），按字典序返回。 */
async function globExpand(absolute: string): Promise<string[]> {
  const segments = absolute.split(/[\\/]+/u);
  let prefixes: string[];
  if (/^[A-Za-z]:$/u.test(segments[0]!)) {
    prefixes = [`${segments[0]!}\\`];
    segments.shift();
  } else if (absolute.startsWith("/")) {
    prefixes = ["/"];
    segments.shift();
  } else {
    prefixes = [""];
  }
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      prefixes = prefixes.map((prefix) => dirname(prefix));
      continue;
    }
    if (/[*?]/u.test(segment)) {
      const matcher = globSegmentRegExp(segment);
      const found = await Promise.all(prefixes.map(async (prefix) => {
        try {
          const entries = await readdir(prefix || ".", { withFileTypes: true });
          return entries.filter((entry) => matcher.test(entry.name)).map((entry) => join(prefix || ".", entry.name));
        } catch {
          return [] as string[];
        }
      }));
      prefixes = found.flat().sort();
    } else {
      prefixes = prefixes.map((prefix) => join(prefix || ".", segment));
    }
    if (prefixes.length === 0) return [];
  }
  return prefixes;
}

function globSegmentRegExp(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/\\\\]*")
    .replace(/\?/gu, "[^/\\\\]");
  return new RegExp(`^${escaped}$`, "u");
}

/*
 * 块解析：Host 行开启新块（支持多别名）；Match 行开启跳过模式直到下一个 Host 行，
 * 避免 Match 块内的指令被错误并入上一个 Host 块；首个生效值优先（values[key] === undefined）。
 */
function parseConfigLines(lines: string[]): ImportedSshHost[] {
  const hosts: ImportedSshHost[] = [];
  let aliases: string[] = [];
  let values: Record<string, string> = {};
  let skipping = false;

  const flush = () => {
    for (const alias of aliases) {
      if (/[*?!]/u.test(alias) || alias.startsWith("!")) continue;
      const proxyJump = values.proxyjump ? parseProxyJump(values.proxyjump) : undefined;
      hosts.push({
        alias,
        hostname: values.hostname ?? alias,
        port: Number(values.port ?? 22),
        username: values.user ?? process.env.USER ?? process.env.USERNAME ?? "root",
        ...(values.identityfile ? { identityFile: expandHome(values.identityfile.split(/\s+/u)[0]!) } : {}),
        ...(proxyJump ? { proxyJump } : {})
      });
    }
  };

  for (const line of lines) {
    const match = line.match(/^(\S+)\s+(.*)$/u);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = unquote(match[2]!.trim());
    if (key === "host") {
      flush();
      aliases = value.split(/\s+/u);
      values = {};
      skipping = false;
    } else if (key === "match") {
      flush();
      aliases = [];
      values = {};
      skipping = true;
    } else if (skipping) {
      continue;
    } else if (aliases.length > 0 && values[key] === undefined) {
      values[key] = value;
    }
  }
  flush();
  return hosts.filter((host) => Number.isInteger(host.port) && host.port > 0 && host.port <= 65535);
}

/*
 * ProxyJump 仅取首跳的 host 部分（"user@host:port" / "[user@][host]:port"）。
 * "none" 表示显式禁用；多级跳与 ProxyCommand 不支持，由导入端点降级为直连。
 */
function parseProxyJump(value: string): string | undefined {
  const first = value.split(/,/u)[0]!.trim();
  if (!first || /^none$/iu.test(first)) return undefined;
  const withoutUser = first.includes("@") ? first.slice(first.lastIndexOf("@") + 1) : first;
  const bracketEnd = withoutUser.indexOf("]");
  const host = withoutUser.startsWith("[")
    ? bracketEnd > 1 ? withoutUser.slice(1, bracketEnd) : undefined
    : withoutUser.split(":")[0]!;
  return host && host.length > 0 ? host : undefined;
}

function expandHome(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path; }
function unquote(value: string): string { return value.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2"); }
