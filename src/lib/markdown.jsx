// Tiny, dependency-free markdown → JSX renderer.
// Covers: headings (# ## ###), bold, italic, inline code, fenced code blocks,
// bullet + numbered lists, links [t](u), horizontal rules. Raw HTML is never
// injected, so this is safe to use on model output.

import React, { useMemo } from "react";
import api from "./api.js";

export function MarkdownBlock({ text, className }) {
  const nodes = useMemo(() => renderMarkdown(text || ""), [text]);
  return <div className={className || ""}>{nodes}</div>;
}

export function renderMarkdown(src) {
  const lines = (src || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (/^```/.test(line)) {
      const closeIdx = lines.findIndex((l, j) => j > i && /^```/.test(l));
      const end = closeIdx === -1 ? lines.length : closeIdx;
      const code = lines.slice(i + 1, end).join("\n");
      out.push(<pre key={key++}><code>{code}</code></pre>);
      i = end + 1;
      continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length, 3);
      const Tag = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
      out.push(<Tag key={key++}>{renderInline(h[2], key++)}</Tag>);
      i++;
      continue;
    }

    // Bullet list (collect consecutive)
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      out.push(
        <ul key={key++}>
          {items.map((t, idx) => <li key={idx}>{renderInline(t, idx)}</li>)}
        </ul>,
      );
      continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      out.push(
        <ol key={key++}>
          {items.map((t, idx) => <li key={idx}>{renderInline(t, idx)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blank line: paragraph break
    if (line.trim() === "") { i++; continue; }

    // Paragraph
    const paraLines = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*---+\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    out.push(<p key={key++}>{renderInline(paraLines.join(" "), key++)}</p>);
  }
  return out;
}

export function renderInline(text, baseKey = 0) {
  const parts = [];
  let rest = text;
  let k = 0;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]+\))/;
  while (rest.length) {
    const m = rest.match(pattern);
    if (!m) { parts.push(<span key={`${baseKey}-${k++}`}>{rest}</span>); break; }
    const idx = m.index;
    if (idx > 0) parts.push(<span key={`${baseKey}-${k++}`}>{rest.slice(0, idx)}</span>);
    const tok = m[0];
    if (tok.startsWith("`")) {
      parts.push(<code key={`${baseKey}-${k++}`}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      parts.push(<strong key={`${baseKey}-${k++}`}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      parts.push(<em key={`${baseKey}-${k++}`}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (mm) {
        parts.push(
          <a
            key={`${baseKey}-${k++}`}
            href={mm[2]}
            onClick={(e) => { e.preventDefault(); if (api?.ext?.open) api.ext.open(mm[2]); }}
          >{mm[1]}</a>,
        );
      } else {
        parts.push(<span key={`${baseKey}-${k++}`}>{tok}</span>);
      }
    }
    rest = rest.slice(idx + tok.length);
  }
  return parts;
}

export default MarkdownBlock;
