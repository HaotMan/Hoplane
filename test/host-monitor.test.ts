import { describe, expect, it, vi } from "vitest";
import { HostMonitor } from "../packages/core/src/host-monitor.js";

describe("host monitor", () => {
  it("fans out host-scoped events and stops after unsubscribe", () => {
    const monitor = new HostMonitor();
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe("host-a", listener);

    monitor.publish({ hostId: "host-b", operationId: "other", kind: "STDOUT", content: "ignored" });
    const event = monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "hello" });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);

    unsubscribe();
    monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "later" });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("retains a bounded replay window for SSE reconnection", () => {
    const monitor = new HostMonitor(2);
    const first = monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "one" });
    const second = monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "two" });
    const third = monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "three" });

    expect(monitor.after("host-a", first.id)).toEqual([second, third]);
    expect(monitor.after("host-a", second.id)).toEqual([third]);
    expect(monitor.after("host-b", first.id)).toEqual([]);
  });

  it("stores output through the user-key cipher and decrypts only for replay", () => {
    const encrypted: string[] = [];
    const cipher = {
      isUnlocked: () => true,
      encryptTransient: (content: string, context: string) => {
        const value = `${context}:${Buffer.from(content).toString("base64")}`;
        encrypted.push(value);
        return value;
      },
      decryptTransient: (value: string, context: string) => Buffer.from(value.slice(context.length + 1), "base64").toString("utf8")
    };
    const monitor = new HostMonitor(10, cipher);
    const published = monitor.publish({ hostId: "host-a", operationId: "op-1", kind: "STDOUT", content: "sensitive output" });

    expect(encrypted).toHaveLength(1);
    expect(encrypted[0]).not.toContain("sensitive output");
    expect(monitor.after("host-a", "0")).toEqual([published]);
  });
});
