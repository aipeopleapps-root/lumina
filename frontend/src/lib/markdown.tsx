import React from 'react';

/**
 * Lightweight markdown renderer for the Agent Design (LLD) document and the
 * Planning Assistant chat. Extends the feature set of the hand-rolled parsers
 * already duplicated in ConsultantChat.tsx / ClientView.tsx / PolicyAdvisor.tsx
 * (headings, bold, bullets, numbered lists, hr, inline code) with h1/h3 and
 * GFM-style table support, needed for the LLD doc's "Tools & Function Calls"
 * table. Intentionally not a refactor of those three — this is a separate,
 * purpose-built function for the new Process Intelligence surfaces.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={`${keyPrefix}-${i}`} className="font-semibold">{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={`${keyPrefix}-${i}`} className="bg-slate-100 text-slate-700 px-1 py-0.5 rounded text-[0.9em] font-mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part ? <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment> : null;
  });
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(c => c.trim());
}

function Table({ lines, keyPrefix }: { lines: string[]; keyPrefix: string }) {
  const header = parseTableRow(lines[0]);
  const rows = lines.slice(2).map(parseTableRow);
  return (
    <div key={keyPrefix} className="overflow-x-auto my-2">
      <table className="min-w-full text-xs border-collapse">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} className="text-left font-semibold text-slate-700 border-b border-slate-300 px-2 py-1.5 whitespace-nowrap">
                {renderInline(h, `${keyPrefix}-th${i}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-b border-slate-100">
              {row.map((cell, ci) => (
                <td key={ci} className="align-top text-slate-700 px-2 py-1.5">
                  {renderInline(cell, `${keyPrefix}-r${ri}c${ci}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function renderMarkdown(text: string): React.ReactNode {
  const lines = (text || '').split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Table block: header row + separator row + N data rows
    if (isTableRow(line) && lines[i + 1] && isTableSeparator(lines[i + 1])) {
      const block: string[] = [line, lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        block.push(lines[j]);
        j++;
      }
      elements.push(<Table key={i} lines={block} keyPrefix={`tbl${i}`} />);
      i = j;
      continue;
    }

    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="text-sm font-semibold text-slate-800 mt-4 mb-1 first:mt-0">{renderInline(line.slice(4), `h3-${i}`)}</h3>);
    } else if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="text-base font-bold text-slate-900 mt-5 mb-2 first:mt-0 pb-1 border-b border-slate-200">{renderInline(line.slice(3), `h2-${i}`)}</h2>);
    } else if (line.startsWith('# ')) {
      elements.push(<h1 key={i} className="text-lg font-bold text-slate-900 mt-2 mb-1">{renderInline(line.slice(2), `h1-${i}`)}</h1>);
    } else if (/^-\s+\[[ xX]\]\s+/.test(line)) {
      const checked = /^-\s+\[[xX]\]/.test(line);
      const content = line.replace(/^-\s+\[[ xX]\]\s+/, '');
      elements.push(
        <div key={i} className="flex items-start gap-2 text-sm text-slate-700 py-0.5">
          <input type="checkbox" checked={checked} readOnly className="mt-1 flex-shrink-0" />
          <span>{renderInline(content, `chk-${i}`)}</span>
        </div>
      );
    } else if (line.startsWith('- ') || line.startsWith('• ')) {
      elements.push(
        <li key={i} className="flex items-start gap-1.5 text-sm text-slate-700 ml-1">
          <span className="text-slate-400 mt-0.5 flex-shrink-0">·</span>
          <span>{renderInline(line.slice(2), `li-${i}`)}</span>
        </li>
      );
    } else if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\.\s/)?.[1];
      elements.push(
        <li key={i} className="flex items-start gap-1.5 text-sm text-slate-700 ml-1">
          <span className="text-slate-400 mt-0.5 flex-shrink-0 w-4">{num}.</span>
          <span>{renderInline(line.replace(/^\d+\.\s/, ''), `ol-${i}`)}</span>
        </li>
      );
    } else if (line.startsWith('---')) {
      elements.push(<hr key={i} className="border-slate-200 my-3" />);
    } else if (line.trim() === '') {
      if (elements.length > 0) elements.push(<div key={i} className="h-1.5" />);
    } else {
      elements.push(<p key={i} className="text-sm text-slate-700 leading-relaxed">{renderInline(line, `p-${i}`)}</p>);
    }
    i++;
  }

  return <div className="space-y-0.5">{elements}</div>;
}
