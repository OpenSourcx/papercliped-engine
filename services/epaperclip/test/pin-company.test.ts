import { describe, expect, it } from "vitest";
import { parseDraft } from "../src/features/pin-company.ts";

describe("reading a model's draft", () => {
  it("takes the JSON out of a fenced or chatty answer and cleans it", () => {
    expect(parseDraft('Sure!\n```json\n{"name":"Ada","title":"Chief of staff","summary":"Plans the first week."}\n```')).toEqual({ name: "Ada", title: "Chief of staff", summary: "Plans the first week." });
    expect(parseDraft('{"name":"\\"Max\\"","title":"Ops\\nlead","summary":""}')).toEqual({ name: "Max", title: "Ops lead", summary: "" });
  });
  it("refuses an answer that has no usable name and title", () => {
    expect(parseDraft("I would call them Ada.")).toBeNull();
    expect(parseDraft('{"name":"","title":"x"}')).toBeNull();
    expect(parseDraft('{"title":"x"}')).toBeNull();
    expect(parseDraft("{not json}")).toBeNull();
  });
});
