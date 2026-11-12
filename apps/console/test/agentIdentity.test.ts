import { describe, expect, it } from "vitest";
import { agentIdentity } from "../src/ui/agentIdentity.ts";

describe("agent identity", () => {
  it("is the same for the same name, and always has a mood and a trait", () => {
    expect(agentIdentity("CEO")).toEqual(agentIdentity("CEO"));
    for (const n of ["CEO", "Ada", "", "Chief of staff"]) {
      const i = agentIdentity(n);
      expect(i.mood.length).toBeGreaterThan(2);
      expect(i.trait.endsWith(".")).toBe(true);
    }
  });
});
