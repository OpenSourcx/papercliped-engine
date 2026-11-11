import { describe, expect, it, vi } from "vitest";

vi.mock("node:os", () => ({
  networkInterfaces: () => { throw Object.assign(new Error("A system error occurred: uv_interface_addresses returned Unknown system error 13"), { code: "ERR_SYSTEM_ERROR" }); },
}));

import { realNetInfo } from "../src/fabric/net.ts";

describe("realNetInfo (ERR-CON-003)", () => {
  it("returns no interfaces instead of throwing when the OS refuses to list them, so /api/fabric answers 200", () => {
    expect(realNetInfo(null).interfaces).toEqual([]);
  });
});
