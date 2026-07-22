import type { HostMonitorEvent } from "../../shared/src/index.js";

type MonitorEventInput = Omit<HostMonitorEvent, "id" | "timestamp">;
type Listener = (event: HostMonitorEvent) => void;
type StoredMonitorEvent = Omit<HostMonitorEvent, "content"> & { content?: string; encryptedContent?: string };

export interface HostMonitorCipher {
  isUnlocked(): boolean;
  encryptTransient(cleartext: string, context: string): string;
  decryptTransient(ciphertext: string, context: string): string;
}

/**
 * An in-memory event fan-out for the read-only host monitor. Output is never
 * persisted here or in the audit database and the retained window is bounded.
 */
export class HostMonitor {
  private sequence = 0;
  private readonly history = new Map<string, StoredMonitorEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly retainedEventsPerHost = 500,
    private readonly cipher?: HostMonitorCipher
  ) {}

  publish(input: MonitorEventInput): HostMonitorEvent {
    const event: HostMonitorEvent = {
      ...input,
      id: String(++this.sequence),
      timestamp: new Date().toISOString()
    };
    let stored: StoredMonitorEvent = event;
    if (event.content !== undefined && this.cipher) {
      try {
        const { content, ...metadata } = event;
        stored = { ...metadata, encryptedContent: this.cipher.encryptTransient(content, eventContext(event)) };
      } catch {
        return event;
      }
    }
    const history = this.history.get(input.hostId) ?? [];
    history.push(stored);
    if (history.length > this.retainedEventsPerHost) history.splice(0, history.length - this.retainedEventsPerHost);
    this.history.set(input.hostId, history);
    for (const listener of this.listeners.get(input.hostId) ?? []) listener(event);
    return event;
  }

  after(hostId: string, lastEventId: string): HostMonitorEvent[] {
    const sequence = Number(lastEventId);
    if (!Number.isSafeInteger(sequence)) return [];
    return (this.history.get(hostId) ?? [])
      .filter((event) => Number(event.id) > sequence)
      .map((event) => this.materialize(event))
      .filter((event): event is HostMonitorEvent => event !== null);
  }

  isOutputEncryptionAvailable(): boolean { return !this.cipher || this.cipher.isUnlocked(); }

  clearOutput(hostId: string): void {
    const retained = (this.history.get(hostId) ?? []).filter((event) => event.kind !== "STDOUT" && event.kind !== "STDERR");
    if (retained.length) this.history.set(hostId, retained); else this.history.delete(hostId);
  }

  clearAllOutput(): void {
    for (const hostId of this.history.keys()) this.clearOutput(hostId);
  }

  subscribe(hostId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(hostId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(hostId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(hostId);
    };
  }

  private materialize(stored: StoredMonitorEvent): HostMonitorEvent | null {
    const { encryptedContent, ...event } = stored;
    if (encryptedContent === undefined) return event;
    if (!this.cipher) return null;
    try { return { ...event, content: this.cipher.decryptTransient(encryptedContent, eventContext(event)) }; }
    catch { return null; }
  }
}

function eventContext(event: Pick<HostMonitorEvent, "hostId" | "operationId" | "id" | "kind">): string {
  return `${event.hostId}:${event.operationId}:${event.id}:${event.kind}`;
}
