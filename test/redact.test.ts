import { describe, expect, it } from "vitest";
import { redact } from "../packages/audit/src/redact.js";

describe("audit redaction", () => {
  it("redacts common inline secrets", () => {
    const result = redact("curl x token=supersecret password=hunter2 Authorization: Bearer abc.def.ghi");
    expect(result).not.toContain("supersecret"); expect(result).not.toContain("hunter2"); expect(result).not.toContain("abc.def.ghi");
  });
  it("limits log length", () => expect(redact("x".repeat(5000), 100)).toHaveLength(112));
});
