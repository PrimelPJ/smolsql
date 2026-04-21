import { parse } from './parser.js';
import { buildPlan, Row } from './planner.js';
import { execute, QueryResult } from './executor.js';
import * as fs from 'fs';
import * as path from 'path';

export type Catalog = Map<string, Row[]>;

export function query(sql: string, catalog: Catalog): QueryResult {
  const ast = parse(sql);
  const plan = buildPlan(ast, catalog);
  return execute(plan);
}

export function loadJSON(filePath: string): Row[] {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return Array.isArray(data) ? data : [data];
}

export function loadCSV(filePath: string): Row[] {
  const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = line.split(',').map(v => v.trim());
    const row: Row = {};
    headers.forEach((h, i) => {
      const v = values[i] ?? null;
      row[h] = v === '' || v === 'null' ? null : isNaN(Number(v)) ? v : Number(v);
    });
    return row;
  });
}

export function formatTable(result: QueryResult): string {
  if (result.rows.length === 0) return '(0 rows)\n';
  const cols = result.columns;
  const widths = cols.map(c => c.length);
  for (const row of result.rows) {
    cols.forEach((c, i) => {
      const v = String(row[c] ?? 'NULL');
      widths[i] = Math.max(widths[i], v.length);
    });
  }
  const sep = '+' + widths.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const header = '|' + cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|') + '|';
  const dataRows = result.rows.map(row =>
    '|' + cols.map((c, i) => {
      const v = String(row[c] ?? 'NULL');
      return ` ${v.padEnd(widths[i])} `;
    }).join('|') + '|'
  );
  return [sep, header, sep, ...dataRows, sep, `(${result.rows.length} row${result.rows.length !== 1 ? 's' : ''})\n`].join('\n');
}

// CLI entry point
if (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts')) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node dist/index.js <data-dir> "<SQL>"');
    console.log('       Loads all .json and .csv files in <data-dir> as tables.\n');
    console.log('Example:');
    console.log('  node dist/index.js ./data "SELECT name, age FROM users WHERE age > 25 ORDER BY age DESC"');
    process.exit(0);
  }
  const dataDir = args[0];
  const sql = args[1];
  const catalog: Catalog = new Map();
  for (const file of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, file);
    const name = path.basename(file, path.extname(file));
    if (file.endsWith('.json')) catalog.set(name, loadJSON(full));
    else if (file.endsWith('.csv')) catalog.set(name, loadCSV(full));
  }
  try {
    const result = query(sql, catalog);
    console.log(formatTable(result));
  } catch (e: unknown) {
    console.error('Error:', (e as Error).message);
    process.exit(1);
  }
}
