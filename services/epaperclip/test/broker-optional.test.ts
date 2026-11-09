import { describe, expect, it } from "vitest";
import { brokerOptionalUnavailable } from "../src/app.ts";
import { HttpError } from "../src/http.ts";

/**
 * The broker is optional. A missing or silent broker must leave the organization ready with a skipped step; only a
 * broker that answered and refused the policy may fail the step. This is the decision miah1 asked for after the
 * real-host qualification, where the disabled broker marked an otherwise valid resource group "failed".
 */
describe("broker availability is not an organization failure", () => {
  it("skips a broker that is not configured", () => {
    expect(brokerOptionalUnavailable(new HttpError(409, "broker_not_configured", "not configured"))).toBe(true);
  });

  it("skips a broker that is configured but not answering", () => {
    expect(brokerOptionalUnavailable(new HttpError(503, "broker_unavailable", "not answering"))).toBe(true);
  });

  it("does not hide a broker that answered and refused the policy", () => {
    expect(brokerOptionalUnavailable(new HttpError(502, "broker_error", "policy refused"))).toBe(false);
    expect(brokerOptionalUnavailable(new Error("something else"))).toBe(false);
  });
});