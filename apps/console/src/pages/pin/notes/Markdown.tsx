import { Fragment, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { httpUrl } from "../../../lib/safeUrl.ts";

/**
 * Notes' Markdown, rendered as React elements. Nothing is ever put into the page as HTML: text is text, raw `<tags>` in
 * a note show up as the characters they are, links are only http(s) without credentials and open with `noopener`, and
 * images are not loaded (no third-party requests, the page's CSP stays as strict as it is). Supported: headings, paragraphs,
 * bold, italic, inline code, code blocks, bullet, numbered and task lists, quotes, rules and links.
 */

const SECRET = /⟦redacted:([a-z-]+):s\d+⟧/g;
const KIND_WORD: Record<string, string> = { password: "password", token: "token", "api-key": "API key", "private-key": "private key", "url-credentials": "URL password", hash: "password hash", "high-entropy": "secret" };

function inline(text: string, key = ""): ReactNode[] {
  const out: ReactNode[] = [];
  // code, link, bold, italic, secret placeholder, bare address: first match wins at each position
  const re = /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|(?<![\w*])\*([^*\n]+)\*(?![\w*])|⟦redacted:([a-z-]+):s\d+⟧|\bhttps?:\/\/[^\s<>"')\]]+/g;
  let at = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    const k = `${key}${n++}`;
    if (m[1] !== undefined) out.push(<code key={k} className="font-mono text-compact bg-code rounded-sm px-1 py-0.5 break-words">{m[1]}</code>);
    else if (m[2] !== undefined) {
      const safe = httpUrl(m[3]);
      out.push(safe ? <a key={k} href={safe} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline underline-offset-2 break-words">{m[2]}</a> : <Fragment key={k}>{m[2]}</Fragment>);
    } else if (m[4] !== undefined) out.push(<strong key={k} className="font-semibold">{inline(m[4], k)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], k)}</em>);
    else if (m[6] !== undefined) out.push(<span key={k} className="inline-flex items-center gap-1 rounded-sm bg-warning/10 text-warning px-1.5 text-compact align-baseline"><KeyRound className="h-3 w-3" aria-hidden />{KIND_WORD[m[6]] ?? "secret"} removed</span>);
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
  | { t: "list"; ordered: boolean; items: { text: string; task: boolean | null }[] };

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
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: { text: string; task: boolean | null }[] = [];
      for (; i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const body = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
        const task = /^\[([ xX])\]\s+/.exec(body);
        items.push({ text: task ? body.slice(task[0].length) : body, task: task ? task[1] !== " " : null });
      }
      blocks.push({ t: "list", ordered, items });
    } else {
      const p: string[] = [];
      for (; i < lines.length && lines[i].trim() && !/^\s*(```|~~~|#{1,6}\s|>|(?:[-*+]|\d+[.)])\s+)/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]); i++) p.push(lines[i]);
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

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? "space-y-3 text-sm text-ink leading-relaxed break-words"}>
      {parseBlocks(text).map((b, i) => {
        switch (b.t) {
          case "h":
            return <div key={i} role="heading" aria-level={Math.min(6, b.level + 1)} className={`${HEADING[b.level - 1]} font-semibold tracking-tight pt-1`}>{inline(b.text, `h${i}`)}</div>;
          case "p":
            return <p key={i} className="whitespace-pre-line text-pretty">{inline(b.text, `p${i}`)}</p>;
          case "code":
            return <pre key={i} className="bg-code border border-line rounded-lg p-3 overflow-x-auto text-compact font-mono whitespace-pre" data-lang={b.lang || undefined}><code>{b.text}</code></pre>;
          case "quote":
            return <blockquote key={i} className="border-l-2 border-line-strong pl-3 text-ink-2 whitespace-pre-line">{inline(b.text, `q${i}`)}</blockquote>;
          case "hr":
            return <hr key={i} className="border-line" />;
          case "list": {
            const Tag = b.ordered ? "ol" : "ul";
            return (
              <Tag key={i} className={b.ordered ? "list-decimal pl-5 space-y-1" : b.items.some((x) => x.task !== null) ? "space-y-1" : "list-disc pl-5 space-y-1"}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.task !== null ? "flex items-start gap-2" : undefined}>
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
