import { writeFileSync } from 'node:fs';

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      out[key] = v.every((x) => x === null || typeof x !== 'object') ? v.join('|') : JSON.stringify(v);
    } else if (v && typeof v === 'object') {
      flatten(v, key, out);
    } else {
      out[key] = v;
    }
  }
  return out;
}

function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const flat = rows.map((r) => flatten(r));
  const columns = [];
  for (const r of flat) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const lines = [columns.join(',')];
  for (const r of flat) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + (flat.length ? '\r\n' : '');
}

export function toNdjson(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

export function toJson(rows) {
  return JSON.stringify(rows, null, 2) + '\n';
}

export function formatTable(rows, columns, { maxWidth = 60 } = {}) {
  const cell = (v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > maxWidth ? s.slice(0, maxWidth - 1) + '…' : s;
  };
  const grid = [columns.map(String), ...rows.map((r) => columns.map((c) => cell(c.split('.').reduce((o, k) => o?.[k], r))))];
  const widths = columns.map((_, i) => Math.max(...grid.map((row) => row[i].length)));
  return grid.map((row) => row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd()).join('\n');
}

export function serialize(rows, format) {
  switch (format) {
    case 'json': return toJson(rows);
    case 'ndjson': return toNdjson(rows);
    case 'csv': return toCsv(rows);
    default: throw new Error(`Unknown format ${format}`);
  }
}

export function writeOutput(rows, { format = 'json', out } = {}) {
  const text = serialize(rows, format);
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
