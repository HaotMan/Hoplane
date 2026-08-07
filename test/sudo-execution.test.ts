import { describe, expect, it } from "vitest";
import { findSudoInvocations, prepareSudoExecution, SudoPromptFilter } from "../packages/ssh-core/src/connection-manager.js";

describe("sudo invocation detection", () => {
  it("finds sudo at the start of the command and after chain separators", () => {
    expect(findSudoInvocations("systemctl status ssh")).toEqual([]);
    expect(findSudoInvocations("sudo systemctl restart ssh")).toEqual([0]);
    expect(findSudoInvocations("sudo apt-get update && sudo apt-get install -y nginx")).toEqual([0, 23]);
    expect(findSudoInvocations("cd /opt && sudo make install")).toEqual([11]);
    expect(findSudoInvocations("echo x | sudo tee /etc/motd; sudo sync")).toEqual([9, 29]);
    expect(findSudoInvocations("(sudo id)\nsudo whoami")).toEqual([1, 10]);
    expect(findSudoInvocations("time sudo id")).toEqual([5]);
    expect(findSudoInvocations("time -p sudo whoami")).toEqual([8]);
  });

  it("ignores sudo inside quotes or in argument position", () => {
    expect(findSudoInvocations("echo \"a && sudo b\"")).toEqual([]);
    expect(findSudoInvocations("echo 'sudo reboot'")).toEqual([]);
    expect(findSudoInvocations("grep sudo /etc/group")).toEqual([]);
    expect(findSudoInvocations("cat /var/log/sudo.log")).toEqual([]);
    expect(findSudoInvocations("visudo")).toEqual([]);
    expect(findSudoInvocations("echo time sudo id")).toEqual([]);
  });
});

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

  it("rewrites every sudo in a chained command so each invocation authenticates", () => {
    const prepared = prepareSudoExecution("sudo apt-get update && sudo apt-get install -y nginx", true, "HOPLANE_TEST_PROMPT");
    expect(prepared.command).toBe("sudo -S -p 'HOPLANE_TEST_PROMPT' apt-get update && sudo -S -p 'HOPLANE_TEST_PROMPT' apt-get install -y nginx");
  });

  it("handles sudo that does not start the command", () => {
    const prepared = prepareSudoExecution("cd /opt && sudo make install", true, "HOPLANE_TEST_PROMPT");
    expect(prepared.command).toBe("cd /opt && sudo -S -p 'HOPLANE_TEST_PROMPT' make install");
    expect(prepareSudoExecution("cd /opt && sudo make install", false)).toEqual({ command: "cd /opt && sudo -n make install" });
  });

  it("rewrites sudo wrapped by the shell time keyword", () => {
    expect(prepareSudoExecution("time sudo whoami", true, "HOPLANE_TEST_PROMPT")).toEqual({
      command: "time sudo -S -p 'HOPLANE_TEST_PROMPT' whoami",
      promptMarker: "HOPLANE_TEST_PROMPT"
    });
    expect(prepareSudoExecution("time -p sudo whoami 2>&1", false)).toEqual({
      command: "time -p sudo -n whoami 2>&1"
    });
  });

  it("does not rewrite sudo mentioned inside quoted text", () => {
    const prepared = prepareSudoExecution("sudo sh -c 'echo sudo done' && echo \"try sudo later\"", true, "HOPLANE_TEST_PROMPT");
    expect(prepared.command).toBe("sudo -S -p 'HOPLANE_TEST_PROMPT' sh -c 'echo sudo done' && echo \"try sudo later\"");
  });
});

describe("sudo prompt filter", () => {
  it("recognizes a prompt split across packets and removes it from output", () => {
    const filter = new SudoPromptFilter("HOPLANE_TEST_PROMPT");
    const first = filter.push(Buffer.from("notice\nHOPLANE_TEST_"));
    const second = filter.push(Buffer.from("PROMPTwarning\n"));
    expect(first.prompted).toBe(0);
    expect(second.prompted).toBe(1);
    expect(Buffer.concat([first.visible, second.visible, filter.flush()]).toString("utf8")).toBe("notice\nwarning\n");
  });

  it("answers each prompt of a chained command", () => {
    const filter = new SudoPromptFilter("HOPLANE_TEST_PROMPT");
    const both = filter.push(Buffer.from("HOPLANE_TEST_PROMPTHOPLANE_TEST_PROMPT"));
    expect(both.prompted).toBe(2);
    const later = filter.push(Buffer.from("step done\nHOPLANE_TEST_PROMPT"));
    expect(later.prompted).toBe(1);
    expect(Buffer.concat([both.visible, later.visible, filter.flush()]).toString("utf8")).toBe("step done\n");
  });
});
