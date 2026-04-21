import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { query, loadJSON, loadCSV, formatTable, Catalog } from './index.js';
import { parse } from './parser.js';
import { buildPlan } from './planner.js';

const catalog: Catalog = new Map();
const dataDir = process.argv[2] ?? './data';

// Load data dir on startup
if (fs.existsSync(dataDir)) {
  for (const file of fs.readdirSync(dataDir)) {
    const full = path.join(dataDir, file);
    const name = path.basename(file, path.extname(file));
    if (file.endsWith('.json')) { catalog.set(name, loadJSON(full)); console.log(`  loaded table '${name}' (${catalog.get(name)!.length} rows)`); }
    else if (file.endsWith('.csv')) { catalog.set(name, loadCSV(full)); console.log(`  loaded table '${name}' (${catalog.get(name)!.length} rows)`); }
  }
}

const BANNER = `
 _____ __  __  ___  _     ____   ___  _
/ ____|  \\/  |/ _ \\| |   / ___| / _ \\| |
\\___  \\ |\\/| | | | | |   \\___ \\| | | | |
  __) | |  | | |_| | |___ ___) | |_| | |___
|____/|_|  |_|\\___/|_____|____/ \\__\\_\\_____|

  SQL engine built from scratch. Zero dependencies.
  Type .help for commands, .exit to quit.
`;

console.log(BANNER);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let buffer = '';

const HELP = `
Commands:
  .tables          list loaded tables
  .load <file>     load a JSON or CSV file as a table
  .explain <sql>   print the logical plan tree
  .clear           clear the current buffer
  .exit            quit

SQL examples:
  SELECT * FROM users;
  SELECT name, age FROM users WHERE age > 25 ORDER BY age DESC LIMIT 5;
  SELECT dept, COUNT(*) as count, AVG(salary) as avg_salary FROM employees GROUP BY dept;
  SELECT u.name, o.amount FROM users u INNER JOIN orders o ON u.id = o.user_id;
`;

function printPlan(plan: ReturnType<typeof buildPlan>, indent = 0): void {
  const pad = '  '.repeat(indent);
  switch (plan.op) {
    case 'Scan': console.log(`${pad}Scan(${plan.alias}, ${plan.rows.length} rows)`); break;
    case 'Filter': console.log(`${pad}Filter`); printPlan(plan.child, indent+1); break;
    case 'Project': console.log(`${pad}Project(${plan.columns.map(c=>c.alias??'expr').join(', ')})`); printPlan(plan.child, indent+1); break;
    case 'HashJoin': console.log(`${pad}HashJoin(${plan.kind})`); printPlan(plan.left, indent+1); printPlan(plan.right, indent+1); break;
    case 'Aggregate': console.log(`${pad}Aggregate(keys=[${plan.keys.join(', ')}])`); printPlan(plan.child, indent+1); break;
    case 'Sort': console.log(`${pad}Sort(${plan.clauses.map(c=>c.dir).join(', ')})`); printPlan(plan.child, indent+1); break;
    case 'Limit': console.log(`${pad}Limit(${plan.n})`); printPlan(plan.child, indent+1); break;
    case 'Distinct': console.log(`${pad}Distinct`); printPlan(plan.child, indent+1); break;
    case 'Subquery': console.log(`${pad}Subquery(${plan.alias})`); printPlan(plan.child, indent+1); break;
  }
}

function runCommand(input: string): void {
  const trimmed = input.trim();
  if (!trimmed) return;

  if (trimmed === '.exit' || trimmed === '.quit') { console.log('Bye.'); rl.close(); process.exit(0); }
  if (trimmed === '.help') { console.log(HELP); return; }
  if (trimmed === '.tables') {
    if (catalog.size === 0) { console.log('  (no tables loaded)'); return; }
    for (const [name, rows] of catalog) console.log(`  ${name}  (${rows.length} rows)`);
    return;
  }
  if (trimmed === '.clear') { buffer = ''; return; }
  if (trimmed.startsWith('.load ')) {
    const file = trimmed.slice(6).trim();
    if (!fs.existsSync(file)) { console.error(`  File not found: ${file}`); return; }
    const name = path.basename(file, path.extname(file));
    if (file.endsWith('.json')) catalog.set(name, loadJSON(file));
    else if (file.endsWith('.csv')) catalog.set(name, loadCSV(file));
    else { console.error('  Unsupported format. Use .json or .csv'); return; }
    console.log(`  loaded table '${name}' (${catalog.get(name)!.length} rows)`);
    return;
  }
  if (trimmed.startsWith('.explain ')) {
    const sql = trimmed.slice(9);
    try {
      const ast = parse(sql);
      const plan = buildPlan(ast, catalog);
      console.log('\nLogical plan:');
      printPlan(plan);
      console.log();
    } catch(e: unknown) { console.error('Error:', (e as Error).message); }
    return;
  }

  const start = Date.now();
  try {
    const result = query(trimmed, catalog);
    console.log(formatTable(result));
    console.log(`Time: ${Date.now() - start}ms`);
  } catch(e: unknown) {
    console.error('Error:', (e as Error).message);
  }
}

const prompt = () => rl.question(buffer ? '   ...> ' : 'smolsql> ', (line: string) => {
  if (line.startsWith('.')) { runCommand(line); buffer = ''; prompt(); return; }
  buffer += (buffer ? ' ' : '') + line;
  if (buffer.trimEnd().endsWith(';') || buffer.trim() === '') {
    if (buffer.trim()) runCommand(buffer.trim());
    buffer = '';
  }
  prompt();
});

prompt();
