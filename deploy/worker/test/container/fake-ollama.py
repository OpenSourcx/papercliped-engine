#!/usr/bin/env python3
"""A stand-in for the real `ollama` binary, used ONLY by container.sh so the bootstrap flow can be tested without downloading 1.5 GB.
It speaks the handful of endpoints the worker uses (version, tags, ps, pull, delete) and honours OLLAMA_HOST like the real one."""
import json, os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer
DB = os.environ.get("FAKE_OLLAMA_DB", "/var/lib/ollama/fake-models.json")
def models():
    try: return json.load(open(DB))
    except Exception: return []
def save(m):
    os.makedirs(os.path.dirname(DB), exist_ok=True); json.dump(m, open(DB, "w"))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def send(self, obj, code=200):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def body(self):
        n = int(self.headers.get("content-length") or 0); return json.loads(self.rfile.read(n) or b"{}")
    def do_GET(self):
        if self.path == "/api/version": return self.send({"version": "0.0.1"})
        if self.path == "/api/tags": return self.send({"models": [{"name": n, "size": 1000 * 1048576} for n in models()]})
        if self.path == "/api/ps": return self.send({"models": []})
        self.send({}, 404)
    def do_POST(self):
        if self.path == "/api/pull":
            name = self.body().get("name"); m = models()
            if name not in m: m.append(name); save(m)
            lines = b'{"status":"pulling manifest"}\n{"status":"downloading","total":100,"completed":50}\n{"status":"success"}\n'
            self.send_response(200); self.send_header("content-length", str(len(lines))); self.end_headers(); self.wfile.write(lines); return
        self.send({}, 404)
    def do_DELETE(self):
        if self.path == "/api/delete":
            name = self.body().get("name"); m = models()
            if name not in m: return self.send({}, 404)
            m.remove(name); save(m); return self.send({})
        self.send({}, 404)
def main():
    a = sys.argv[1:]
    if a[:1] == ["--version"]: print("ollama version is 0.0.1"); return
    host = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434")
    if a[:1] == ["serve"]:
        h, p = host.rsplit(":", 1); HTTPServer((h, int(p)), H).serve_forever()
    if a[:1] == ["pull"]:
        import urllib.request
        urllib.request.urlopen(urllib.request.Request(f"http://{host}/api/pull", data=json.dumps({"name": a[1]}).encode(), method="POST")).read(); print("success"); return
    print("usage: ollama serve|pull", file=sys.stderr); sys.exit(2)
main()
