import { describe, expect, it, vi } from "vitest";
import { Duplex, PassThrough, Readable, Writable } from "node:stream";
import type { ClientChannel, SFTPWrapper, Stats } from "ssh2";
import type { HoplaneDatabase } from "../packages/core/src/database.js";
import type { CredentialVault } from "../packages/core/src/vault.js";
import { SSHConnectionManager } from "../packages/ssh-core/src/connection-manager.js";
import { AppError } from "../packages/shared/src/index.js";

type Entry = { data: Buffer; type: "file" | "directory" | "symlink"; mode: number };

class MemorySftp {
  readonly files = new Map<string, Entry>();
  readonly ended = vi.fn();
  readonly atomicRenames: Array<[string, string]> = [];
  slowWrites = false;
  failReads = false;
  supportsAtomicReplace = true;

  file(path: string, data: Buffer | string, type: Entry["type"] = "file", mode = 0o644): this {
    this.files.set(path, { data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data), type, mode });
    return this;
  }

  stat(path: string, callback: (error: Error | undefined, stats: Stats) => void): void {
    this.respondWithStats(path, callback);
  }

  lstat(path: string, callback: (error: Error | undefined, stats: Stats) => void): void {
    this.respondWithStats(path, callback);
  }

  createReadStream(path: string): Readable {
    const entry = this.files.get(path)!;
    if (this.failReads) {
      let emitted = false;
      return new Readable({
        read() {
          if (!emitted) { emitted = true; this.push(entry.data.subarray(0, Math.ceil(entry.data.length / 2))); return; }
          this.destroy(new Error("source disconnected"));
        }
      });
    }
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < entry.data.length; offset += 16 * 1024) chunks.push(entry.data.subarray(offset, offset + 16 * 1024));
    return Readable.from(chunks);
  }

  createWriteStream(path: string, options?: { flags?: string; mode?: number }): Writable {
    if (options?.flags === "wx" && this.files.has(path)) {
      const failed = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("File exists"), { code: "EEXIST" })); } });
      return failed;
    }
    this.files.set(path, { data: Buffer.alloc(0), type: "file", mode: options?.mode ?? 0o666 });
    return new Writable({
      highWaterMark: 1024,
      write: (chunk: Buffer, _encoding, callback) => {
        const entry = this.files.get(path)!;
        entry.data = Buffer.concat([entry.data, Buffer.from(chunk)]);
        if (this.slowWrites) setTimeout(callback, 1); else callback();
      }
    });
  }

  rename(sourcePath: string, destinationPath: string, callback: (error?: Error) => void): void {
    if (this.files.has(destinationPath)) {
      queueMicrotask(() => callback(Object.assign(new Error("File exists"), { code: "EEXIST" })));
      return;
    }
    this.move(sourcePath, destinationPath);
    queueMicrotask(() => callback());
  }

  ext_openssh_rename(sourcePath: string, destinationPath: string, callback: (error?: Error) => void): void {
    if (!this.supportsAtomicReplace) {
      queueMicrotask(() => callback(new Error("Operation unsupported")));
      return;
    }
    this.atomicRenames.push([sourcePath, destinationPath]);
    this.move(sourcePath, destinationPath);
    queueMicrotask(() => callback());
  }

  unlink(path: string, callback: (error?: Error) => void): void {
    this.files.delete(path);
    queueMicrotask(() => callback());
  }

  end(): void { this.ended(); }

  private move(sourcePath: string, destinationPath: string): void {
    const entry = this.files.get(sourcePath)!;
    this.files.set(destinationPath, entry);
    this.files.delete(sourcePath);
  }

  private respondWithStats(path: string, callback: (error: Error | undefined, stats: Stats) => void): void {
    const entry = this.files.get(path);
    if (!entry) {
      queueMicrotask(() => callback(Object.assign(new Error("No such file"), { code: "ENOENT" }), undefined as unknown as Stats));
      return;
    }
    const stats = {
      mode: entry.mode, uid: 0, gid: 0, size: entry.data.length, atime: 0, mtime: 0,
      isFile: () => entry.type === "file",
      isDirectory: () => entry.type === "directory",
      isSymbolicLink: () => entry.type === "symlink",
      isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false
    } satisfies Stats;
    queueMicrotask(() => callback(undefined, stats));
  }
}

class ExecChannel extends Duplex {
  readonly stderr = new PassThrough();
  readonly received: Buffer[] = [];
  private emitted = false;
  private completionEmitted = false;

  constructor(private readonly role: "source" | "destination", private readonly payload = Buffer.alloc(0)) {
    super({ emitClose: false });
  }

  _read(): void {
    if (this.emitted) return;
    this.emitted = true;
    if (this.role === "source") this.push(this.payload);
    this.push(null);
    if (this.role === "source") this.finish(0);
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.received.push(Buffer.from(chunk));
    callback();
  }

  _final(callback: (error?: Error | null) => void): void {
    callback();
    if (this.role === "destination") this.finish(0);
  }

  close(): void { this.finish(null); }

  private finish(exitCode: number | null): void {
    if (this.completionEmitted) return;
    this.completionEmitted = true;
    this.stderr.end();
    setImmediate(() => this.emit("close", exitCode));
  }
}

function managerWith(source: MemorySftp, destination: MemorySftp): SSHConnectionManager {
  const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
  const getSftp = vi.fn()
    .mockResolvedValueOnce(source as unknown as SFTPWrapper)
    .mockResolvedValueOnce(destination as unknown as SFTPWrapper);
  Object.defineProperty(manager, "getSftp", { value: getSftp });
  return manager;
}

const relayInput = {
  sourceHostId: "source",
  sourcePath: "/exports/file",
  destinationHostId: "destination",
  destinationPath: "/imports/file",
  expectedSize: 3,
  allowOverwrite: false,
  operationId: "fallback-operation"
};

describe("SSH host-to-host relay", () => {
  it("streams a large file through a slow destination and atomically publishes it", async () => {
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
    const source = new MemorySftp().file("/exports/release.tar", payload);
    const destination = new MemorySftp();
    destination.slowWrites = true;
    const manager = managerWith(source, destination);

    const result = await manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/release.tar",
      destinationHostId: "destination", destinationPath: "/imports/release.tar",
      expectedSize: payload.length, allowOverwrite: false, operationId: "operation-1"
    });

    expect(result).toEqual({ bytesTransferred: payload.length, transport: "SFTP" });
    expect(destination.files.get("/imports/release.tar")?.data.equals(payload)).toBe(true);
    expect(destination.files.get("/imports/release.tar")?.mode).toBe(0o600);
    expect(destination.files.has("/imports/.hoplane-part-operation-1")).toBe(false);
    expect(source.ended).toHaveBeenCalledOnce();
    expect(destination.ended).toHaveBeenCalledOnce();
  });

  it("rejects overwrite when policy disallows it and preserves the destination", async () => {
    const source = new MemorySftp().file("/exports/file", "new");
    const destination = new MemorySftp().file("/imports/file", "old");
    const manager = managerWith(source, destination);
    await expect(manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/file", destinationHostId: "destination", destinationPath: "/imports/file",
      expectedSize: 3, allowOverwrite: false, operationId: "operation-2"
    })).rejects.toMatchObject({ code: "REMOTE_FILE_EXISTS" });
    expect(destination.files.get("/imports/file")?.data.toString()).toBe("old");
  });

  it("uses atomic replacement and never exposes the temporary file after success", async () => {
    const source = new MemorySftp().file("/exports/file", "new");
    const destination = new MemorySftp().file("/imports/file", "old");
    const manager = managerWith(source, destination);
    await manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/file", destinationHostId: "destination", destinationPath: "/imports/file",
      expectedSize: 3, allowOverwrite: true, operationId: "operation-3"
    });
    expect(destination.files.get("/imports/file")?.data.toString()).toBe("new");
    expect(destination.atomicRenames).toEqual([["/imports/.hoplane-part-operation-3", "/imports/file"]]);
  });

  it("keeps the original destination when atomic replacement is unsupported", async () => {
    const source = new MemorySftp().file("/exports/file", "new");
    const destination = new MemorySftp().file("/imports/file", "old");
    destination.supportsAtomicReplace = false;
    const manager = managerWith(source, destination);
    await expect(manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/file", destinationHostId: "destination", destinationPath: "/imports/file",
      expectedSize: 3, allowOverwrite: true, operationId: "operation-4"
    })).rejects.toMatchObject({ code: "DESTINATION_ATOMIC_REPLACE_UNSUPPORTED" });
    expect(destination.files.get("/imports/file")?.data.toString()).toBe("old");
    expect(destination.files.has("/imports/.hoplane-part-operation-4")).toBe(false);
  });

  it("removes a partial temporary file when the source stream disconnects", async () => {
    const source = new MemorySftp().file("/exports/file", Buffer.alloc(128 * 1024, 1));
    source.failReads = true;
    const destination = new MemorySftp();
    const manager = managerWith(source, destination);
    await expect(manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/file", destinationHostId: "destination", destinationPath: "/imports/file",
      expectedSize: 128 * 1024, allowOverwrite: false, operationId: "operation-5"
    })).rejects.toMatchObject({ code: "SSH_CONNECTION_FAILED" });
    expect(destination.files.has("/imports/.hoplane-part-operation-5")).toBe(false);
    expect(destination.files.has("/imports/file")).toBe(false);
  });

  it("rejects a destination symlink before writing", async () => {
    const source = new MemorySftp().file("/exports/file", "new");
    const destination = new MemorySftp().file("/imports/file", "target", "symlink");
    const manager = managerWith(source, destination);
    await expect(manager.relayFile({
      sourceHostId: "source", sourcePath: "/exports/file", destinationHostId: "destination", destinationPath: "/imports/file",
      expectedSize: 3, allowOverwrite: true, operationId: "operation-6"
    })).rejects.toMatchObject({ code: "DESTINATION_SYMLINK_UNSAFE" });
    expect(destination.files.get("/imports/file")?.type).toBe("symlink");
  });

  it("falls back to SSH streaming only after SFTP is confirmed unavailable", async () => {
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    const sftpRelay = vi.fn(async () => { throw new AppError("SFTP_UNAVAILABLE", "no subsystem"); });
    const sshRelay = vi.fn(async () => 3);
    Object.defineProperty(manager, "relayFileViaSftp", { value: sftpRelay });
    Object.defineProperty(manager, "relayFileViaSsh", { value: sshRelay });
    await expect(manager.relayFile(relayInput)).resolves.toEqual({ bytesTransferred: 3, transport: "SSH_STREAM" });
    expect(sftpRelay).toHaveBeenCalledOnce();
    expect(sshRelay).toHaveBeenCalledOnce();
  });

  it("pipes bytes through fixed SSH exec channels when SFTP is unavailable", async () => {
    const payload = Buffer.alloc(512 * 1024, 0x2a);
    const sourceChannel = new ExecChannel("source", payload);
    const destinationChannel = new ExecChannel("destination");
    const commands: Array<{ hostId: string; command: string }> = [];
    const clients = {
      source: { exec: (command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
        commands.push({ hostId: "source", command }); callback(undefined, sourceChannel as unknown as ClientChannel);
      } },
      destination: { exec: (command: string, _options: unknown, callback: (error: Error | undefined, stream: ClientChannel) => void) => {
        commands.push({ hostId: "destination", command }); callback(undefined, destinationChannel as unknown as ClientChannel);
      } }
    };
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    Object.defineProperty(manager, "relayFileViaSftp", { value: vi.fn(async () => { throw new AppError("SFTP_UNAVAILABLE", "no subsystem"); }) });
    Object.defineProperty(manager, "getConnection", { value: vi.fn(async (hostId: "source" | "destination") => clients[hostId]) });

    await expect(manager.relayFile({ ...relayInput, expectedSize: payload.length })).resolves.toEqual({
      bytesTransferred: payload.length,
      transport: "SSH_STREAM"
    });
    expect(Buffer.concat(destinationChannel.received).equals(payload)).toBe(true);
    expect(commands.find((item) => item.hostId === "source")?.command).toContain("cat '/exports/file'");
    const destinationCommand = commands.find((item) => item.hostId === "destination")?.command ?? "";
    expect(destinationCommand).toContain("umask 077");
    expect(destinationCommand).toContain(".hoplane-part-fallback-operation");
    expect(destinationCommand).toContain("trap 'rm -f \"$tmp\"'");
  });

  it("does not downgrade an SFTP path or permission failure to SSH exec", async () => {
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    const sftpRelay = vi.fn(async () => { throw new AppError("REMOTE_FILE_EXISTS", "destination exists"); });
    const sshRelay = vi.fn(async () => 3);
    Object.defineProperty(manager, "relayFileViaSftp", { value: sftpRelay });
    Object.defineProperty(manager, "relayFileViaSsh", { value: sshRelay });
    await expect(manager.relayFile(relayInput)).rejects.toMatchObject({ code: "REMOTE_FILE_EXISTS" });
    expect(sshRelay).not.toHaveBeenCalled();
  });

  it("returns one clear capability error when neither transport is available", async () => {
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    Object.defineProperty(manager, "relayFileViaSftp", { value: vi.fn(async () => { throw new AppError("SFTP_UNAVAILABLE", "no subsystem", false, undefined, { reason: "disabled" }); }) });
    Object.defineProperty(manager, "relayFileViaSsh", { value: vi.fn(async () => { throw new AppError("SSH_STREAM_UNAVAILABLE", "no exec", false, undefined, { reason: "forced command" }); }) });
    await expect(manager.relayFile(relayInput)).rejects.toMatchObject({
      code: "FILE_TRANSFER_TRANSPORT_UNAVAILABLE",
      details: { sftpReason: "disabled", sshReason: "forced command" }
    });
  });

  it("uses SSH path resolution when the server rejects the SFTP subsystem request", async () => {
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    const client = { sftp: (callback: (error: Error) => void) => callback(new Error("Unable to start subsystem: sftp")) };
    Object.defineProperty(manager, "getConnection", { value: vi.fn(async () => client) });
    const sshFallback = vi.fn(async () => "/physical/exports/file");
    Object.defineProperty(manager, "resolveRemotePathViaSsh", { value: sshFallback });
    await expect(manager.resolveRemotePathForRelay("source", "/exports/file", false)).resolves.toBe("/physical/exports/file");
    expect(sshFallback).toHaveBeenCalledWith("source", "/exports/file", false);
  });

  it("does not treat an ordinary SSH connection failure as missing SFTP", async () => {
    const manager = new SSHConnectionManager({} as HoplaneDatabase, {} as CredentialVault, 1024);
    const client = { sftp: (callback: (error: Error) => void) => callback(new Error("Not connected")) };
    Object.defineProperty(manager, "getConnection", { value: vi.fn(async () => client) });
    const sshFallback = vi.fn(async () => "/exports/file");
    Object.defineProperty(manager, "resolveRemotePathViaSsh", { value: sshFallback });
    await expect(manager.resolveRemotePathForRelay("source", "/exports/file", false)).rejects.toMatchObject({ code: "SSH_CONNECTION_FAILED" });
    expect(sshFallback).not.toHaveBeenCalled();
  });
});
