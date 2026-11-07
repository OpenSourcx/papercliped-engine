// A minimal remote MCP server (Streamable HTTP, JSON replies) for exercising the engine's real tool policy. No auth.
import http from "node:http";
const calls = [];
const tools = [
  { name: "read_note", description: "Read a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "write_note", description: "Write a note", inputSchema: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } } },
  { name: "delete_note", description: "Delete a note", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } },
];
http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    if (req.url === "/calls") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(calls)); }
    let m; try { m = JSON.parse(b); } catch { m = {}; }
    const reply = (result) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result })); };
    if (m.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-notes", version: "1.0.0" } });
    if (m.method === "notifications/initialized") { res.writeHead(202); return res.end(); }
    if (m.method === "tools/list") return reply({ tools });
    if (m.method === "tools/call") { calls.push({ tool: m.params.name, args: m.params.arguments }); return reply({ content: [{ type: "text", text: `ok ${m.params.name}` }] }); }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }));
  });
}).listen(3188, "127.0.0.1", () => console.log("fake mcp on 3188"));
