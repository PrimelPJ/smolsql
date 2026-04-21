import { query, loadJSON, formatTable, Catalog } from './index.js';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

const catalog: Catalog = new Map([
  ['users', loadJSON(path.join(dataDir, 'users.json'))],
  ['orders', loadJSON(path.join(dataDir, 'orders.json'))],
]);

let passed = 0, failed = 0;

function test(name: string, sql: string, check: (rows: Record<string,unknown>[]) => boolean) {
  try {
    const result = query(sql, catalog);
    if (check(result.rows)) { console.log(`  PASS  ${name}`); passed++; }
    else { console.log(`  FAIL  ${name}`); console.log(formatTable(result)); failed++; }
  } catch(e: unknown) { console.log(`  ERR   ${name}: ${(e as Error).message}`); failed++; }
}

console.log('\nRunning smolsql test suite...\n');

test('SELECT *', 'SELECT * FROM users', r => r.length === 10);
test('WHERE =', 'SELECT name FROM users WHERE dept = \'Engineering\'', r => r.length === 4);
test('WHERE >', 'SELECT name FROM users WHERE age > 30', r => r.length === 5);
test('WHERE AND', 'SELECT name FROM users WHERE age > 25 AND dept = \'Engineering\'', r => r.length === 3);
test('ORDER BY DESC', 'SELECT name, age FROM users ORDER BY age DESC LIMIT 3', r => (r[0].age as number) >= (r[1].age as number));
test('LIMIT', 'SELECT * FROM users LIMIT 3', r => r.length === 3);
test('COUNT *', 'SELECT COUNT(*) as total FROM users', r => r[0].total === 10);
test('GROUP BY', 'SELECT dept, COUNT(*) as n FROM users GROUP BY dept', r => r.length === 3);
test('AVG', 'SELECT dept, AVG(salary) as avg_sal FROM users GROUP BY dept', r => r.every(row => typeof row.avg_sal === 'number'));
test('INNER JOIN', 'SELECT u.name, o.product FROM users u INNER JOIN orders o ON u.id = o.user_id', r => r.length >= 5);
test('IN list', 'SELECT name FROM users WHERE city IN (\'Calgary\', \'Vancouver\')', r => r.length === 5);
test('LIKE', 'SELECT name FROM users WHERE name LIKE \'A%\'', r => r.length === 1);
test('BETWEEN', 'SELECT name FROM users WHERE age BETWEEN 28 AND 35', r => r.length === 4);
test('DISTINCT', 'SELECT DISTINCT dept FROM users', r => r.length === 3);
test('HAVING', 'SELECT dept, COUNT(*) as n FROM users GROUP BY dept HAVING n > 2', r => r.every(row => (row.n as number) > 2));
test('Subquery', 'SELECT name FROM (SELECT * FROM users WHERE age > 30) sub WHERE sub.dept = \'Sales\'', r => r.length > 0);
test('CASE WHEN', "SELECT name, CASE WHEN age < 30 THEN 'junior' ELSE 'senior' END as level FROM users", r => r.every(row => row.level === 'junior' || row.level === 'senior'));
test('String fn UPPER', "SELECT UPPER(name) as uname FROM users LIMIT 1", r => r[0].uname === r[0].uname?.toString().toUpperCase());
test('COALESCE', "SELECT COALESCE(NULL, 'fallback') as val FROM users LIMIT 1", r => r[0].val === 'fallback');
test('IS NULL', 'SELECT name FROM users WHERE city IS NOT NULL', r => r.length === 10);

console.log(`\n  ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
