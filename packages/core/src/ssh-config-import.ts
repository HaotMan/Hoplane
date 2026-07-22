import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface ImportedSshHost {
  alias: string;
  hostname: string;
  port: number;
  username: string;
  identityFile?: string;
}

export async function parseSshConfig(path = "~/.ssh/config"): Promise<ImportedSshHost[]> {
  const resolved = expandHome(path);
  const content = await readFile(resolved, "utf8");
  const hosts: ImportedSshHost[] = [];
  let aliases: string[] = [];
  let values: Record<string, string> = {};

  const flush = () => {
    for (const alias of aliases) {
      if (/[*?!]/u.test(alias) || alias.startsWith("!")) continue;
      hosts.push({
        alias,
        hostname: values.hostname ?? alias,
        port: Number(values.port ?? 22),
        username: values.user ?? process.env.USER ?? process.env.USERNAME ?? "root",
        ...(values.identityfile ? { identityFile: expandHome(values.identityfile.split(/\s+/u)[0]!) } : {})
      });
    }
  };

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+#.*$/u, "").trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+)\s+(.*)$/u);
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = unquote(match[2]!.trim());
    if (key === "host") {
      flush();
      aliases = value.split(/\s+/u);
      values = {};
    } else if (aliases.length > 0 && values[key] === undefined) {
      values[key] = value;
    }
  }
  flush();
  return hosts.filter((host) => Number.isInteger(host.port) && host.port > 0 && host.port <= 65535);
}

function expandHome(path: string): string { return path === "~" ? homedir() : path.startsWith("~/") ? `${homedir()}/${path.slice(2)}` : path; }
function unquote(value: string): string { return value.replace(/^(?:"(.*)"|'(.*)')$/u, "$1$2"); }
