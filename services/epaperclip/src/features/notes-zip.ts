import { deflateRawSync, inflateRawSync } from "node:zlib";
import { INBOX, LIMITS, bad, cleanBody, cleanFolder, cleanLinks, cleanTags, oneLine, titleFrom, type Note, type NoteLink } from "./notes-core.ts";

/**
 * Export and import as Markdown folders in a zip, so notes are never locked in. Each note is one `.md` file in its folder
 * with a small front matter block (title, tags, pinned, links, dates; values are JSON, which is also valid YAML). A zip
 * is read defensively: entry count, sizes and compression ratios are capped, names are sanitised (no absolute paths, no
 * `..`), encrypted and zip64 archives are refused, and each file's checksum is verified.
 *
 * Secrets moved to the vault are not exported (only their placeholders are); shared-with-organization state is not
 * exported either.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const IMPORT_LIMITS = { zipBytes: 8 * 1024 * 1024, entries: 1000, entryBytes: 256 * 1024, totalBytes: 12 * 1024 * 1024 } as const;

export interface ZipFile {
  name: string;
  data: Buffer;
}

export function writeZip(files: ZipFile[], when = new Date()): Buffer {
  const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((Math.max(1980, when.getFullYear()) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const comp = deflateRawSync(f.data);
    const useDeflate = comp.length < f.data.length;
    const body = useDeflate ? comp : f.data;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(useDeflate ? 8 : 0, 10);
    c.writeUInt16LE(dosTime, 12);
    c.writeUInt16LE(dosDate, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export function readZip(buf: Buffer): ZipFile[] {
  if (buf.length > IMPORT_LIMITS.zipBytes) throw bad("That zip is too large to import.", "too_large");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad("That doesn't look like a zip file.", "bad_zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw bad("Zip64 archives aren't supported. Export as a normal zip.", "bad_zip");
  if (count > IMPORT_LIMITS.entries) throw bad(`That zip holds more than ${IMPORT_LIMITS.entries} files.`, "too_large");
  const out: ZipFile[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad("That zip is damaged.", "bad_zip");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw bad("Encrypted zips can't be imported.", "bad_zip");
    if (csize === 0xffffffff || usize === 0xffffffff) throw bad("Zip64 archives aren't supported.", "bad_zip");
    if (usize > IMPORT_LIMITS.entryBytes) continue; // an oversized file is skipped, not unpacked
    total += usize;
    if (total > IMPORT_LIMITS.totalBytes) throw bad("That zip unpacks to too much text.", "too_large");
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw bad("That zip is damaged.", "bad_zip");
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw bad("That zip is damaged.", "bad_zip");
    const raw = buf.subarray(start, start + csize);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: IMPORT_LIMITS.entryBytes });
      } catch {
        throw bad("That zip is damaged or unpacks to far too much.", "bad_zip");
      }
    } else throw bad("That zip uses a compression method that isn't supported.", "bad_zip");
    if (data.length !== usize || crc32(data) !== crc) throw bad("That zip is damaged (a checksum didn't match).", "bad_zip");
    out.push({ name, data });
  }
  return out;
}

// ---- Markdown files

const slug = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80) || "note";

export function noteToMarkdown(n: Note): string {
  const fm = [
    "---",
    `title: ${JSON.stringify(n.title)}`,
    `tags: ${JSON.stringify(n.tags)}`,
    `pinned: ${n.pinned}`,
    `links: ${JSON.stringify(n.links.map((l) => ({ kind: l.kind, id: l.id, label: l.label })))}`,
    `created: ${JSON.stringify(new Date(n.createdAt).toISOString())}`,
    `updated: ${JSON.stringify(new Date(n.updatedAt).toISOString())}`,
    "---",
    "",
  ];
  return `${fm.join("\n")}${n.body}\n`;
}

/** The zip's files for these notes: `Folder/Sub/Title.md`. */
export function exportFiles(notes: Note[]): ZipFile[] {
  const used = new Set<string>();
  const files: ZipFile[] = [];
  for (const n of notes) {
    const dir = n.folder.split("/").map(slug).join("/");
    let base = `${dir}/${slug(n.title)}`;
    let name = `${base}.md`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base}-${i}.md`;
    used.add(name.toLowerCase());
    files.push({ name, data: Buffer.from(noteToMarkdown(n), "utf8") });
  }
  files.push({ name: "README.txt", data: Buffer.from("Exported from ePaperclip Notes. Each .md file is one note; the folders are the note folders. Import this zip back from the Notes page.\n", "utf8") });
  return files;
}

export interface ImportedNote {
  title: string;
  body: string;
  folder: string;
  tags: string[];
  pinned: boolean;
  links: NoteLink[];
}

function parseFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const raw = line.slice(at + 1).trim();
    try {
      meta[key] = JSON.parse(raw);
    } catch {
      meta[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Notes found in a zip's files. Anything that isn't text Markdown is skipped; nothing is executed or fetched. */
export function importFiles(files: ZipFile[]): { notes: ImportedNote[]; skipped: number } {
  const notes: ImportedNote[] = [];
  let skipped = 0;
  for (const f of files) {
    const parts = f.name.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== ".." && !p.startsWith("__MACOSX"));
    const file = parts.pop() ?? "";
    if (!/\.(md|markdown|txt)$/i.test(file) || /^readme\.txt$/i.test(file) && !parts.length || file.startsWith("._")) {
      skipped++;
      continue;
    }
    const text = cleanBody(f.data.toString("utf8")).replace(/^﻿/, "");
    const { meta, body } = parseFrontMatter(text);
    const trimmed = body.replace(/^\n+/, "").replace(/\s+$/, "").slice(0, LIMITS.body);
    if (!trimmed.trim()) {
      skipped++;
      continue;
    }
    let folder = INBOX;
    try {
      folder = cleanFolder(parts.slice(0, LIMITS.folderDepth).join("/"));
    } catch {
      folder = INBOX;
    }
    let tags: string[] = [];
    let links: NoteLink[] = [];
    try {
      tags = cleanTags(Array.isArray(meta.tags) ? meta.tags.slice(0, LIMITS.tags) : typeof meta.tags === "string" ? meta.tags.split(/[ ,]+/).slice(0, LIMITS.tags) : []);
    } catch {
      tags = [];
    }
    try {
      links = cleanLinks(Array.isArray(meta.links) ? meta.links.slice(0, LIMITS.links) : []);
    } catch {
      links = [];
    }
    notes.push({ title: oneLine(meta.title, LIMITS.title) || oneLine(file.replace(/\.[^.]+$/, ""), LIMITS.title) || titleFrom(trimmed), body: trimmed, folder, tags, pinned: meta.pinned === true, links });
  }
  return { notes, skipped };
}
