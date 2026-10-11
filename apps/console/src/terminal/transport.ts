import { DemoShell, type ShellMachine } from "./demoShell.ts";

/**
 * How a terminal talks to a machine. The terminal only sends raw keystrokes and writes what comes back, exactly like a
 * real TTY, so the same component works with:
 *  - a live session: the broker opens Proxmox's terminal proxy for the guest (termproxy + vncwebsocket) and relays the
 *    websocket; the browser never sees the Proxmox token. Access is checked against the user's `guests.console` tool.
 *  - the demo: a local line discipline in front of DemoShell.
 */
export interface TerminalTransport {
  readonly live: boolean;
  open(write: (data: string) => void, onExit: () => void): void;
  input(data: string): void;
  resize?(cols: number, rows: number): void;
  close(): void;
}

/**
 * A live terminal through the host service's console relay (/api/console/...), speaking Proxmox's termproxy framing.
 * The service authorises it with the session cookie and opens Proxmox's terminal proxy as the signed-in user.
 */
export class LiveTransport implements TerminalTransport {
  readonly live = true;
  private ws: WebSocket | null = null;
  private ping: ReturnType<typeof setInterval> | undefined;
  private size: [number, number] | null = null;
  private readonly path: string;
  private readonly enc = new TextEncoder();

  constructor(path: "/api/console/node" | `/api/console/guests/${number}`) {
    this.path = path;
  }

  open(write: (data: string) => void, onExit: () => void) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${window.location.host}${this.path}`);
    this.ws = ws;
    write("\x1b[2mConnecting…\x1b[0m\r\n");
    ws.onopen = () => {
      if (this.size) this.resize(...this.size);
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send("2"), 30_000);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") write(e.data);
      else (e.data as Blob).text().then(write);
    };
    ws.onclose = (e) => {
      clearInterval(this.ping);
      if (e.code === 1006) write("\r\n\x1b[31mCouldn't connect to the console. Your session may have ended.\x1b[0m\r\n");
      else if (e.code !== 4000) write("\r\n\x1b[2mSession ended.\x1b[0m\r\n");
      onExit();
    };
  }

  input(data: string) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(`0:${this.enc.encode(data).length}:${data}`);
  }

  resize(cols: number, rows: number) {
    this.size = [cols, rows];
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(`1:${cols}:${rows}:`);
  }

  close() {
    clearInterval(this.ping);
    this.ws?.close();
  }
}

export class DemoTransport implements TerminalTransport {
  readonly live = false;
  private shell: DemoShell;
  private line = "";
  private cursor = 0;
  private hist = -1;
  private write: (d: string) => void = () => {};
  private onExit: () => void = () => {};
  private closed = false;

  constructor(machine: ShellMachine) {
    this.shell = new DemoShell(machine);
  }

  open(write: (data: string) => void, onExit: () => void) {
    this.write = write;
    this.onExit = onExit;
    this.write(this.shell.banner() + "\r\n" + this.shell.prompt());
  }

  private redraw() {
    // Return to the start of the line, clear it, print prompt and line, then put the cursor back.
    this.write(`\r\x1b[K${this.shell.prompt()}${this.line}`);
    const back = this.line.length - this.cursor;
    if (back > 0) this.write(`\x1b[${back}D`);
  }

  input(data: string) {
    if (this.closed) return;
    if (data === "\r") {
      this.write("\r\n");
      const res = this.shell.run(this.line);
      this.line = "";
      this.cursor = 0;
      this.hist = -1;
      if (res.clear) this.write("\x1b[2J\x1b[H");
      if (res.out) this.write(res.out + "\r\n");
      if (res.exit) {
        this.closed = true;
        this.write("\r\n\x1b[2mSession ended.\x1b[0m\r\n");
        this.onExit();
        return;
      }
      this.write(this.shell.prompt());
      return;
    }
    if (data === "\x7f") {
      if (this.cursor > 0) {
        this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
        this.cursor--;
        this.redraw();
      }
      return;
    }
    if (data === "\x03") {
      this.write("^C\r\n" + this.shell.prompt());
      this.line = "";
      this.cursor = 0;
      return;
    }
    if (data === "\x0c") {
      this.write("\x1b[2J\x1b[H");
      this.redraw();
      return;
    }
    if (data === "\t") {
      const options = this.shell.complete(this.line);
      if (options.length === 1) {
        this.line = options[0] + (options[0].split(/\s+/).length === 1 ? " " : "");
        this.cursor = this.line.length;
        this.redraw();
      } else if (options.length > 1) {
        this.write("\r\n" + options.map((o) => o.split(/\s+/).pop()).join("  ") + "\r\n");
        this.redraw();
      }
      return;
    }
    if (data === "\x1b[A" || data === "\x1b[B") {
      const h = this.shell.history;
      if (!h.length) return;
      this.hist = data === "\x1b[A" ? (this.hist < 0 ? h.length - 1 : Math.max(0, this.hist - 1)) : this.hist < 0 ? -1 : this.hist + 1;
      if (this.hist >= h.length) this.hist = -1;
      this.line = this.hist < 0 ? "" : h[this.hist];
      this.cursor = this.line.length;
      this.redraw();
      return;
    }
    if (data === "\x1b[D") {
      if (this.cursor > 0) { this.cursor--; this.write(data); }
      return;
    }
    if (data === "\x1b[C") {
      if (this.cursor < this.line.length) { this.cursor++; this.write(data); }
      return;
    }
    if (data.startsWith("\x1b")) return; // other control sequences are ignored
    const printable = data.replace(/[\x00-\x1f]/g, "");
    if (!printable) return;
    this.line = this.line.slice(0, this.cursor) + printable + this.line.slice(this.cursor);
    this.cursor += printable.length;
    this.redraw();
  }

  close() {
    this.closed = true;
  }
}
