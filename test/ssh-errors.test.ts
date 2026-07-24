import { describe, expect, it } from "vitest";
import { classifySshError } from "../packages/ssh-core/src/connection-manager.js";

describe("SSH network error classification", () => {
  it.each([
    ["EHOSTUNREACH", "SSH_HOST_UNREACHABLE"],
    ["ENETUNREACH", "SSH_HOST_UNREACHABLE"],
    ["ECONNREFUSED", "SSH_CONNECTION_REFUSED"],
    ["ETIMEDOUT", "SSH_CONNECTION_TIMEOUT"],
    ["ENOTFOUND", "SSH_HOST_NOT_FOUND"]
  ])("maps %s to an actionable application error", (networkCode, expectedCode) => {
    const error = Object.assign(new Error(`connect ${networkCode} server.example:22`), { code: networkCode });
    expect(classifySshError(error)).toMatchObject({ code: expectedCode, retriable: true });
  });

  it("keeps authentication failures separate from network failures", () => {
    expect(classifySshError(new Error("All configured authentication methods failed"))).toMatchObject({ code: "SSH_AUTH_FAILED", retriable: false });
  });
});
