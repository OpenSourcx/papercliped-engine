import { describe, expect, it } from "vitest";
import { scanSecrets, restoreSecrets, placeholdersIn } from "../src/features/notes-secrets.ts";
import { classify, matchLinks, splitBlob, type Inventory } from "../src/features/notes-rules.ts";
import { crc32, exportFiles, importFiles, readZip, writeZip } from "../src/features/notes-zip.ts";
import { parseModelAnswer } from "../src/features/notes-sort.ts";
import { cleanFolder, cleanTag, cleanTags, search, folderCounts, type Note } from "../src/features/notes-core.ts";

const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";

describe("secret detection", () => {
  const cases: [string, string, string][] = [
    ["a private key block", `keep this\n${PEM}\nafter`, "b3BlbnNzaC1rZXktdjE"],
    ["a GitHub token", "token is ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["an AWS key", "AKIAIOSFODNN7EXAMPLE in the env", "AKIAIOSFODNN7EXAMPLE"],
    ["key: value", "db_password: Tr0ub4dor&3", "Tr0ub4dor&3"],
    ["key = value in quotes", 'API_KEY = "abc123def456"', "abc123def456"],
    ["json", '{"client_secret": "s3cr3t-value"}', "s3cr3t-value"],
    ["a sentence", "the root password is hunter2 for now", "hunter2"],
    ["a command line flag", "mysql --password=Sup3rSecret -u root", "Sup3rSecret"],
    ["URL credentials", "mount smb://admin:p4ssw0rd@nas.lan/share", "p4ssw0rd"],
    ["a bearer token", "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'", "abcdefghijklmnopqrstuvwxyz123456"],
    ["a Proxmox API token", "Authorization: PVEAPIToken=root@pam!ci=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ["a crypt hash", "root:$6$rounds=5000$saltsalt$Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH:19000", "$6$rounds=5000$saltsalt$"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9"],
    ["a random-looking string", "paste: Zk3qP9xT7vLm2WcR8yHnB5aJdE4gUsFo", "Zk3qP9xT7vLm2WcR8yHnB5aJdE4gUsFo"],
  ];
  for (const [name, text, secret] of cases) {
    it(`finds ${name} and the redacted text no longer holds it`, () => {
      const r = scanSecrets(text);
      expect(r.findings.length).toBeGreaterThan(0);
      expect(r.findings.some((f) => f.value.includes(secret.replace(/^\$6\$.*/, "$6$")))).toBe(true);
      expect(r.redacted).not.toContain(secret);
      expect(r.redacted).toMatch(/⟦redacted:/);
      // Scanning the redacted text again finds nothing new, and the originals can be put back.
      expect(scanSecrets(r.redacted).findings).toHaveLength(0);
      expect(restoreSecrets(r.redacted, r.findings)).toBe(text);
    });
  }

  it("keeps the key's name, numbers findings in text order and reports lines", () => {
    const r = scanSecrets("hello\nsmtp_password: aaaa1111\nnote\napi_token: bbbb2222");
    expect(r.redacted).toBe("hello\nsmtp_password: ⟦redacted:password:s1⟧\nnote\napi_token: ⟦redacted:password:s2⟧");
    expect(r.findings.map((f) => [f.id, f.line, f.label])).toEqual([["s1", 2, "smtp_password"], ["s2", 4, "api_token"]]);
    expect(placeholdersIn(r.redacted)).toEqual(["s1", "s2"]);
    expect(scanSecrets("pwd: abcd1234", 5).findings[0].id).toBe("s6");
  });

  it("does not cry wolf on ordinary text", () => {
    for (const t of ["max_tokens: 4096", "author: Bob", "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "the password policy is documented in the wiki", "token: true", "path /var/lib/vz/template/iso/debian-12.4.0-amd64-netinst.iso", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample user@host", "uuid 123e4567-e89b-12d3-a456-426614174000", "password: <your password>", "compass: north"]) {
      expect(scanSecrets(t).findings, t).toHaveLength(0);
    }
  });
});

describe("splitting and the keyword sorter", () => {
  it("cuts at separators, top-level headings and blank-line gaps, never inside a code fence", () => {
    const blob = ["# Backup runbook", "1. stop the job", "2. restore from pbs", "", "", "ssh root@10.0.0.5", "", "---", "```", "line one", "", "", "line two", "```", "", "## Next", "todo: renew certs and more words here"].join("\n");
    const parts = splitBlob(blob);
    expect(parts.some((p) => p.includes("line one") && p.includes("line two"))).toBe(true);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts[0]).toContain("Backup runbook");
  });

  it("files a pasted piece by what it is about", () => {
    expect(classify("# Runbook: fail over the web container\nProcedure:\n1. Shut the old node down\n2. Start it on the spare node\n3. Verify the checklist")).toMatchObject({ folder: "Runbooks" });
    expect(classify("The gateway is 10.0.0.1, vlan 20 uses subnet 10.0.20.0/24 and DNS 10.0.0.53")).toMatchObject({ folder: "Networking" });
    expect(classify("- [ ] renew the certificate\n- [ ] order disks\n- [x] update the host")).toMatchObject({ folder: "To-do" });
    expect(classify("https://pve.proxmox.com/wiki/Backup\nhttps://forum.proxmox.com/threads/1\nhttps://github.com/x/y")).toMatchObject({ folder: "Links", confidence: 0.9 });
    expect(classify("2026-10-01T10:00:00 kernel: error: I/O failure on sda\nTraceback (most recent call last)")).toMatchObject({ folder: "Logs and errors" });
    const none = classify("lunch was good");
    expect(none).toMatchObject({ folder: "Inbox" });
    expect(none.confidence).toBeLessThan(0.5);
  });

  it("recognises only machines, storage and organizations from the inventory it is given", () => {
    const inv: Inventory = { machines: [{ vmid: 101, name: "web", type: "lxc", ips: ["10.0.0.21"] }, { vmid: 200, name: "database", type: "qemu", ips: [] }], storages: ["local-lvm", "local"], orgs: [{ id: "c1", name: "Northwind" }] };
    const ids = (t: string) => matchLinks(t, inv).map((l) => `${l.kind}:${l.id}`);
    expect(ids("restart ct 101 then check")).toEqual(["machine:101"]);
    expect(ids("qm start 200")).toEqual(["machine:200"]);
    expect(ids("ping 10.0.0.21 fails")).toEqual(["machine:101"]);
    expect(ids("the database host is slow; backups go to local-lvm for Northwind")).toEqual(["machine:200", "storage:local-lvm", "org:c1"]);
    expect(ids("vmid 999 and ping 10.9.9.9")).toEqual([]);
    expect(ids("the local disk is full")).toEqual([]);
    expect(ids("storage local is full")).toEqual(["storage:local"]);
  });
});

describe("the model's answer is data, strictly read", () => {
  it("keeps only known fields and valid, unused chunk numbers", () => {
    const raw = 'Sure! ```json\n{"action":"delete_machines","notes":[{"chunks":[0,0,7,-1,1.5],"title":"A","folder":"Runbooks","tags":["#ZFS","a b"],"confidence":7,"run":"rm -rf"},{"chunks":[0],"title":"dup"},{"chunks":[1],"title":"B","confidence":"high"}]}\n```';
    expect(parseModelAnswer(raw, 2)).toEqual([
      { chunks: [0], title: "A", folder: "Runbooks", tags: ["zfs", "a-b"], confidence: 1 },
      { chunks: [1], title: "B", folder: "", tags: [], confidence: 0.5 },
    ]);
    expect(parseModelAnswer("no json here", 3)).toEqual([]);
    expect(parseModelAnswer('{"notes":"x"}', 3)).toEqual([]);
  });
});

describe("names", () => {
  it("cleans folders, tags", () => {
    expect(cleanFolder("  Runbooks // Networking ")).toBe("Runbooks/Networking");
    expect(cleanFolder("")).toBe("Inbox");
    expect(cleanFolder("../..")).toBe("Inbox");
    expect(() => cleanFolder("a/b/c/d")).toThrow(/3 levels/);
    expect(cleanTag("#My Tag!")).toBe("my-tag");
    expect(cleanTags(["a", "A", "b"])).toEqual(["a", "b"]);
    expect(() => cleanTags(Array.from({ length: 13 }, (_, i) => `t${i}`))).toThrow(/12 tags/);
  });

  it("searches words in titles first and filters", () => {
    const mk = (id: string, title: string, body: string, extra: Partial<Note> = {}): Note => ({ id, title, body, folder: "Inbox", tags: [], pinned: false, links: [], share: null, vault: [], source: "manual", createdAt: 1, updatedAt: 1, ...extra });
    const notes = [mk("a", "ZFS scrub", "weekly"), mk("b", "Weekly", "run a zfs scrub", { folder: "Runbooks/Storage", tags: ["zfs"] }), mk("c", "Other", "nothing", { pinned: true, links: [{ kind: "machine", id: "101", label: "web" }] })];
    expect(search(notes, { q: "zfs scrub" }).map((n) => n.id)).toEqual(["a", "b"]);
    expect(search(notes, { folder: "Runbooks" }).map((n) => n.id)).toEqual(["b"]);
    expect(search(notes, { tag: "zfs" }).map((n) => n.id)).toEqual(["b"]);
    expect(search(notes, { pinned: true }).map((n) => n.id)).toEqual(["c"]);
    expect(search(notes, { machine: "101" }).map((n) => n.id)).toEqual(["c"]);
    expect(folderCounts({ notes, folders: ["Empty"] }).map((f) => f.path)).toEqual(["Inbox", "Empty", "Runbooks", "Runbooks/Storage"]);
  });
});

describe("zip export and import", () => {
  const note = (title: string, body: string, folder = "Inbox"): Note => ({ id: title, title, body, folder, tags: ["x"], pinned: true, links: [{ kind: "machine", id: "101", label: "web #101" }], share: null, vault: [], source: "manual", createdAt: 1, updatedAt: 2 });

  it("round-trips notes as Markdown files in folders", () => {
    const files = exportFiles([note("Backup plan", "# Plan\n\ntext é ☃", "Runbooks/Storage"), note("Backup plan", "second", "Runbooks/Storage")]);
    expect(files.map((f) => f.name).sort()).toEqual(["README.txt", "Runbooks/Storage/Backup plan-2.md", "Runbooks/Storage/Backup plan.md"]);
    const zip = writeZip(files);
    const back = importFiles(readZip(zip));
    expect(back.notes).toHaveLength(2);
    expect(back.notes.find((n) => n.body.startsWith("# Plan"))).toMatchObject({ title: "Backup plan", folder: "Runbooks/Storage", tags: ["x"], pinned: true, links: [{ kind: "machine", id: "101", label: "web #101" }] });
    expect(back.skipped).toBe(1);
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });

  it("sanitises hostile names and refuses damaged, encrypted and oversized archives", () => {
    const zip = writeZip([{ name: "../../etc/passwd.md", data: Buffer.from("x note") }, { name: "/abs/Deep/a/b/c/d/e.md", data: Buffer.from("deep note") }, { name: "run.sh", data: Buffer.from("rm -rf /") }, { name: "__MACOSX/._a.md", data: Buffer.from("junk") }]);
    const got = importFiles(readZip(zip));
    expect(got.notes.map((n) => [n.folder, n.title])).toEqual([["etc", "passwd"], ["abs/Deep/a", "e"]]);
    expect(got.skipped).toBe(2);
    const bad = Buffer.from(zip);
    bad[bad.indexOf(Buffer.from("x note"))] ^= 0xff;
    expect(() => readZip(bad)).toThrow(/checksum|damaged/);
    expect(() => readZip(Buffer.from("not a zip at all"))).toThrow(/zip/);
    const enc = Buffer.from(zip);
    const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    enc.writeUInt16LE(1, cd + 8);
    expect(() => readZip(enc)).toThrow(/Encrypted/);
    // One file inflating far beyond its limit is refused; a bomb never gets unpacked.
    const big = writeZip([{ name: "big.md", data: Buffer.alloc(300 * 1024, 97) }]);
    expect(importFiles(readZip(big)).notes).toHaveLength(0);
  });
});
