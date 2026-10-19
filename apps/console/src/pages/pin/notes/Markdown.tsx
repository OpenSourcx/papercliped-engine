import { Fragment, useState, type ReactNode } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { httpUrl } from "../../../lib/safeUrl.ts";

/**
 * Notes' Markdown, rendered as React elements. Nothing is ever put into the page as HTML: text is text, raw `<tags>` in
 * a note show up as the characters they are, links are only http(s) without credentials and open with `noopener`, and
 * images are not loaded (no third-party requests, the page's CSP stays as strict as it is). Supported: headings, paragraphs,
 * bold, italic, strikethrough, inline code, code blocks (with a copy button), bullet, numbered, nested and task lists, tables,
 * quotes, rules and links. Pin's chat uses it too, so what a model writes in Markdown shows up formatted.
 */

const SECRET = /⟦redacted:([a-z-]+):s\d+⟧/g;
const KIND_WORD: Record<string, string> = { password: "password", token: "token", "api-key": "API key", "private-key": "private key", "url-credentials": "URL password", hash: "password hash", "high-entropy": "secret" };

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  // code, link, bold, italic, secret placeholder, bare address: first match wins at each position
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![\w_])__([^_\n]+)__(?![\w_])|~~([^~\n]+)~~|(?<![\w*])\*([^*\n]+)\*(?![\w*])|(?<![\w_])_([^_\n]+)_(?![\w_])|⟦redacted:([a-z-]+):s\d+⟧|\bhttps?:\/\/[^\s<>"')\]]+/g;
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const k = `${key}${n++}`;
    if (m[1] !== undefined) out.push(<code key={k} className="font-mono text-compact bg-code rounded-sm px-1 py-0.5 break-words">{m[1]}</code>);
    else if (m[2] !== undefined) {
      const safe = httpUrl(m[3]);
      out.push(safe ? <a key={k} href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2 break-words">{m[2]}</a> : <Fragment key={k}>{m[2]}</Fragment>);
    } else if (m[4] !== undefined || m[5] !== undefined) out.push(<strong key={k} className="font-semibold">{inline((m[4] ?? m[5])!, k)}</strong>);
    else if (m[6] !== undefined) out.push(<del key={k} className="text-ink-3">{inline(m[6], k)}</del>);
    else if (m[7] !== undefined || m[8] !== undefined) out.push(<em key={k}>{inline((m[7] ?? m[8])!, k)}</em>);
    else if (m[9] !== undefined) out.push(<span key={k} className="inline-flex items-center gap-1 rounded-sm bg-warning/10 text-warning px-1.5 text-compact align-baseline"><KeyRound className="h-3 w-3" aria-hidden />{KIND_WORD[m[9]] ?? "secret"} removed</span>);
    else {
      const safe = httpUrl(m[0]);
      out.push(safe ? <a key={k} href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2 break-all">{m[0]}</a> : m[0]);
    }
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "list"; ordered: boolean; items: { text: string; task: boolean | null; depth: number }[] }
  | { t: "table"; head: string[]; align: ("left" | "center" | "right")[]; rows: string[][] };

const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const isDivider = (line: string | undefined) => !!line && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|");

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      i++;
      blocks.push({ t: "code", lang: fence[2], text: body.join("\n") });
    } else if (!line.trim()) i++;
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: "hr" });
      i++;
    } else if (/^#{1,6}\s/.test(line)) {
      const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)!;
      blocks.push({ t: "h", level: m[1].length, text: m[2] });
      i++;
    } else if (/^\s*>/.test(line)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ""));
      blocks.push({ t: "quote", text: q.join("\n") });
    } else if (line.includes("|") && isDivider(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left") as "left" | "center" | "right");
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes("|"); i++) rows.push(cells(lines[i]));
      blocks.push({ t: "table", head, align, rows });
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; task: boolean | null; depth: number }[] = [];
      for (; i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const body = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
        const task = /^\[([ xX])\]\s+/.exec(body);
        const depth = Math.min(2, Math.floor((/^\s*/.exec(lines[i])![0].replace(/\t/g, "  ").length) / 2));
        items.push({ text: task ? body.slice(task[0].length) : body, task: task ? task[1] !== " " : null, depth });
      }
      blocks.push({ t: "list", ordered, items });
    } else {
      const p: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|(?:[-*+]|\d+[.)])\s+)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !(lines[i].includes("|") && isDivider(lines[i + 1])); i++) p.push(lines[i]);
      if (!p.length) {
        p.push(lines[i]);
        i++;
      }
      blocks.push({ t: "p", text: p.join("\n") });
    }
  }
  return blocks;
}

const HEADING = ["text-title", "text-xl", "text-lg", "text-lead", "text-body", "text-sm"];

const DEPTH = ["", "ml-5", "ml-10"];
const ALIGN = { left: "text-left", center: "text-center", right: "text-right" };

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => undefined);
  };
  return (
    <div className="group relative">
      <pre className="bg-code border border-line rounded-lg p-3 overflow-x-auto text-compact font-mono whitespace-pre" data-lang={lang || undefined}><code>{text}</code></pre>
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy code"} className="transition-control absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-surface-2/90 border border-line px-1.5 py-1 text-micro text-ink-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-ink">
        {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
        {copied ? "Copied" : lang || "Copy"}
      </button>
    </div>
  );
}

/** `chat` sets it for a conversation: tighter spacing and headings no bigger than the words around them. */
export function Markdown({ text, className, chat }: { text: string; className?: string; chat?: boolean }) {
  return (
    <div className={className ?? (chat ? "space-y-2.5 text-sm text-ink leading-relaxed break-words" : "space-y-3 text-sm text-ink leading-relaxed break-words")}>
      {parseBlocks(text).map((b, i) => {
        switch (b.t) {
          case "h":
            return <div key={i} role="heading" aria-level={Math.min(6, b.level + 1)} className={`${chat ? (b.level <= 2 ? "text-body" : "text-sm") : HEADING[b.level - 1]} font-semibold tracking-tight pt-1`}>{inline(b.text, `h${i}`)}</div>;
          case "p":
            return <p key={i} className="whitespace-pre-line text-pretty">{inline(b.text, `p${i}`)}</p>;
          case "code":
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case "table":
            return (
              <div key={i} className="max-w-full overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-compact border-collapse">
                  <thead className="bg-surface-2">
                    <tr>{b.head.map((h, c) => <th key={c} scope="col" className={`px-3 py-1.5 font-semibold border-b border-line-strong ${ALIGN[b.align[c] ?? "left"]}`}>{inline(h, `th${i}-${c}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => <tr key={j} className="border-b border-line last:border-b-0">{b.head.map((_, c) => <td key={c} className={`px-3 py-1.5 align-top ${ALIGN[b.align[c] ?? "left"]}`}>{inline(r[c] ?? "", `td${i}-${j}-${c}`)}</td>)}</tr>)}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return <blockquote key={i} className="border-l-2 border-line-strong pl-3 text-ink-2 whitespace-pre-line">{inline(b.text, `q${i}`)}</blockquote>;
          case "hr":
            return <hr key={i} className="border-line" />;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={b.ordered ? "list-decimal pl-5 space-y-1" : b.items.some((x) => x.task !== null) ? "space-y-1" : "list-disc pl-5 space-y-1"}>
                {b.items.map((it, j) => (
                  <li key={j} className={`${it.task !== null ? "flex items-start gap-2 " : ""}${DEPTH[it.depth]}`.trim() || undefined}>
                    {it.task !== null && <input type="checkbox" checked={it.task} readOnly disabled aria-label={it.task ? "Done" : "Not done"} className="mt-1 accent-(--accent)" />}
                    <span className={it.task ? "text-ink-3 line-through" : undefined}>{inline(it.text, `l${i}-${j}`)}</span>
                  </li>
                ))}
              </Tag>
            );
          }
        }
      })}
    </div>
  );
}
