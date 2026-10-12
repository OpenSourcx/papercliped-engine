import { describe, expect, it } from "vitest";
import { parseSse, SseParser } from "../src/pin/sse.ts";

describe("server-sent events parser", () => {
  it("reads named events with JSON data", () => {
    expect(parseSse('event: delta\ndata: {"text":"Hi"}\n\nevent: done\ndata: {}\n\n')).toEqual([
      { event: "delta", data: '{"text":"Hi"}' },
      { event: "done", data: "{}" },
    ]);
  });

  it("joins multi-line data, skips comments, defaults to message, keeps ids", () => {
    expect(parseSse(": keep-alive\nid: 7\ndata: one\ndata:two\n\n")).toEqual([{ event: "message", data: "one\ntwo", id: "7" }]);
  });

  it("handles CRLF and CR line endings", () => {
    expect(parseSse("event: delta\r\ndata: a\r\n\r\nevent: delta\rdata: b\r\r")).toEqual([
      { event: "delta", data: "a" },
      { event: "delta", data: "b" },
    ]);
  });

  it("survives chunks split anywhere, including between \\r and \\n", () => {
    const text = 'event: delta\r\ndata: {"text":"Hello"}\r\n\r\nevent: tool\r\ndata: {"id":"t1"}\r\n\r\n';
    for (let size = 1; size <= 7; size++) {
      const p = new SseParser();
      const out = [];
      for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
      expect(out, `chunk size ${size}`).toEqual([
        { event: "delta", data: '{"text":"Hello"}' },
        { event: "tool", data: '{"id":"t1"}' },
      ]);
    }
  });

  it("drops an event that never finished and ignores empty events", () => {
    expect(parseSse("event: delta\n\ndata: half")).toEqual([]);
  });

  it("strips exactly one leading space from values", () => {
    expect(parseSse("data:  two spaces\n\n")[0].data).toBe(" two spaces");
  });
});
