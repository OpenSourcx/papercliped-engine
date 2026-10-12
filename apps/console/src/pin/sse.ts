/**
 * A server-sent events parser (the text/event-stream format, as the HTML spec defines it), fed chunk by chunk.
 * Chunks may split anywhere, including inside a line or between \r and \n. Comments (":") and unknown fields are
 * ignored; several "data:" lines join with "\n"; an event without "event:" is a "message".
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  private sawCr = false;

  /** Feeds a chunk of text and returns the events it completed. */
  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    let text = chunk;
    // A chunk that starts with \n right after a chunk that ended in \r is one CRLF line ending, not two.
    if (this.sawCr && text.startsWith("\n")) text = text.slice(1);
    this.sawCr = text.endsWith("\r");
    this.buf += text;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A lone \r at the very end might be the first half of \r\n: wait for the next chunk to decide.
      if (m[0] === "\r" && m.index === this.buf.length - 1) {
        const line = this.buf.slice(0, m.index);
        this.buf = "";
        this.line(line, out);
        break;
      }
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      this.line(line, out);
    }
    return out;
  }

  /** Ends the stream: a final event without a trailing blank line is dropped, as the spec says. */
  end(): SseEvent[] {
    this.buf = "";
    this.data = [];
    this.event = "";
    return [];
  }

  private line(line: string, out: SseEvent[]) {
    if (line === "") {
      if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id !== undefined ? { id: this.id } : {}) });
      this.data = [];
      this.event = "";
      return;
    }
    if (line.startsWith(":")) return;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }
}

/** Parses a whole stream at once (tests and small bodies). */
export function parseSse(text: string): SseEvent[] {
  const p = new SseParser();
  return [...p.push(text), ...p.end()];
}
