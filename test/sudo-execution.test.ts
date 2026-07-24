import { describe, expect, it } from "vitest";
import { prepareSudoExecution, SudoPromptFilter } from "../packages/ssh-core/src/connection-manager.js";

describe("managed sudo execution", () => {
  it("leaves ordinary commands unchanged and makes unconfigured sudo non-interactive", () => {
    expect(prepareSudoExecution("systemctl status ssh", false)).toEqual({ command: "systemctl status ssh" });
    expect(prepareSudoExecution("sudo systemctl restart ssh", false)).toEqual({ command: "sudo -n systemctl restart ssh" });
  });

  it("adds a random prompt without putting the password in the command", () => {
    const prepared = prepareSudoExecution("sudo -u root systemctl restart ssh", true, "HOPLANE_TEST_PROMPT");
    expect(prepared.promptMarker).toBe("HOPLANE_TEST_PROMPT");
    expect(prepared.command).toBe("sudo -S -p 'HOPLANE_TEST_PROMPT' -u root systemctl restart ssh");
    expect(prepared.command).not.toContain("server-password");
  });

  it("recognizes a prompt split across packets, removes it from output, and answers only once", () => {
    const filter = new SudoPromptFilter("HOPLANE_TEST_PROMPT");
    const first = filter.push(Buffer.from("notice\nHOPLANE_TEST_"));
    const second = filter.push(Buffer.from("PROMPTwarning\nHOPLANE_TEST_PROMPT"));
    expect(first.prompted).toBe(false);
    expect(second.prompted).toBe(true);
    expect(Buffer.concat([first.visible, second.visible, filter.flush()]).toString("utf8")).toBe("notice\nwarning\n");

    const repeated = filter.push(Buffer.from("HOPLANE_TEST_PROMPT"));
    expect(repeated.prompted).toBe(false);
    expect(Buffer.concat([repeated.visible, filter.flush()]).toString("utf8")).toBe("");
  });
});
