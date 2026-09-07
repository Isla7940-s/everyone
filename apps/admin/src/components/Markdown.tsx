import React from 'react';

/** 轻量 markdown 渲染（标题/列表/引用/代码块/表格/粗体/链接） */
export function Markdown({ text }: { text: string }) {
  return <div className="md">{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): React.ReactNode[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (line.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push(<pre key={key++}><code>{buf.join('\n')}</code></pre>);
      continue;
    }
    // 表格
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const headCells = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      out.push(
        <table key={key++}>
          <thead><tr>{headCells.map((c, j) => <th key={j}>{inline(c)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
      continue;
    }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const content = inline(h[2]);
      out.push(level === 1 ? <h1 key={key++}>{content}</h1> : level === 2 ? <h2 key={key++}>{content}</h2> : <h3 key={key++}>{content}</h3>);
      i++;
      continue;
    }
    // 引用
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{buf.map((b, j) => <p key={j}>{inline(b)}</p>)}</blockquote>);
      continue;
    }
    // 列表
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      const kids = items.map((it, j) => <li key={j}>{inline(it)}</li>);
      out.push(ordered ? <ol key={key++}>{kids}</ol> : <ul key={key++}>{kids}</ul>);
      continue;
    }
    // 分割线
    if (/^\s*---+\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }
    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }
    // 段落（连续行合并）
    const buf: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\s*---+\s*$)/.test(lines[i]) && !lines[i].includes('|')) {
      buf.push(lines[i++]);
    }
    out.push(<p key={key++}>{inline(buf.join(' '))}</p>);
  }
  return out;
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 行内：**粗体**、`code`、[链接](url) */
export function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\(([^)]+)\))/;
  while (rest) {
    const m = rest.match(re);
    if (!m || m.index === undefined) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    if (m[2]) out.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[4]) out.push(<code key={key++}>{m[4]}</code>);
    else if (m[6]) out.push(<a key={key++} href={m[7]} target="_blank" rel="noreferrer">{m[6]}</a>);
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}
