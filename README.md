# smolsql

A SQL query engine built from scratch in TypeScript. No dependencies. No parser libraries. No ORM magic.

Just a hand-written lexer, a recursive-descent parser, a logical query planner, and a volcano-model execution engine — all in ~1,800 lines of code.

```
smolsql> SELECT dept, COUNT(*) as headcount, AVG(salary) as avg_salary
   ...>   FROM users
   ...>   WHERE age > 25
   ...>   GROUP BY dept
   ...>   ORDER BY avg_salary DESC;

+-------------+-----------+--------------------+
| dept        | headcount | avg_salary         |
+-------------+-----------+--------------------+
| Product     | 3         | 100000             |
| Engineering | 4         | 91500              |
| Sales       | 2         | 81500              |
+-------------+-----------+--------------------+
(3 rows)

Time: 1ms
```

---

## What it supports

| Feature | Status |
|---|---|
| `SELECT`, `FROM`, `WHERE` | ✓ |
| `INNER JOIN`, `LEFT JOIN` | ✓ |
| `GROUP BY` + `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` | ✓ |
| `HAVING` | ✓ |
| `ORDER BY` + `LIMIT` | ✓ |
| `DISTINCT` | ✓ |
| Subqueries in `FROM` | ✓ |
| `IN`, `BETWEEN`, `LIKE`, `IS NULL` | ✓ |
| `CASE WHEN` | ✓ |
| String functions: `UPPER`, `LOWER`, `LENGTH`, `TRIM`, `SUBSTR`, `CONCAT` | ✓ |
| Math functions: `ROUND`, `ABS`, `COALESCE` | ✓ |
| Table aliases | ✓ |
| JSON + CSV data sources | ✓ |
| Window functions | planned |
| CTEs (`WITH`) | planned |
| `INSERT`, `UPDATE`, `DELETE` | planned |
| Indexes | planned |

---

## Quick start

```bash
git clone https://github.com/yourusername/smolsql
cd smolsql
npm install
npm run repl          # interactive REPL, loads ./data automatically
```

Run a one-shot query:
```bash
npm run query -- "SELECT name, salary FROM users ORDER BY salary DESC LIMIT 3"
```

Run the test suite:
```bash
npm test
```

---

## Architecture

The engine is split into two phases — **frontend** (parsing) and **backend** (execution) — separated by a logical plan tree. This mirrors how real databases like PostgreSQL and DuckDB are structured.

```
SQL string
    │
    ▼
 Lexer          character scanner → Token[]
    │
    ▼
 Parser         recursive descent → AST (discriminated union)
    │
    ▼
 Planner        AST walker → LogicalPlan tree
    │
    ▼
 Executor       volcano/iterator model → Row[][]
    │
    ▼
Result set
```

### Lexer (`src/lexer.ts`)

A hand-written character scanner with a position cursor. No regex. Reads the input character-by-character, emitting typed `Token` objects into a flat array. Keywords are normalized to uppercase at lex time so the parser never worries about case sensitivity.

```typescript
interface Token {
  type: TokenType;   // SELECT | FROM | WHERE | IDENT | NUMBER | ...
  value: string;
  pos: number;
}
```

### Parser (`src/parser.ts`)

A recursive-descent parser. One method per grammar production rule. The entire SQL grammar is encoded in the call graph — `parseSelect` calls `parseWhere`, which calls `parseOr`, which calls `parseAnd`, down to `parsePrimary` at the leaves.

The output is a discriminated union AST:

```typescript
type ASTNode =
  | { kind: 'SelectStmt'; columns: SelectCol[]; from?: FromClause; where?: ASTNode; ... }
  | { kind: 'BinaryOp'; op: string; left: ASTNode; right: ASTNode }
  | { kind: 'FunctionCall'; name: string; args: ASTNode[]; distinct: boolean }
  | { kind: 'Identifier'; table?: string; name: string }
  | { kind: 'Literal'; value: string | number | boolean | null }
  | ...
```

TypeScript's exhaustive union checks mean the compiler will catch any unhandled node kind at compile time.

### Query planner (`src/planner.ts`)

Walks the AST and produces a tree of logical operators. This is the stage most tutorials skip — it separates *what the user asked for* from *how to compute it*.

```typescript
type LogicalPlan =
  | { op: 'Scan';      alias: string; rows: Row[] }
  | { op: 'Filter';    predicate: ASTNode; child: LogicalPlan }
  | { op: 'Project';   columns: SelectCol[]; child: LogicalPlan }
  | { op: 'HashJoin';  kind: 'INNER'|'LEFT'; on: ASTNode; left: LogicalPlan; right: LogicalPlan }
  | { op: 'Aggregate'; keys: string[]; aggregates: SelectCol[]; child: LogicalPlan }
  | { op: 'Sort';      clauses: OrderClause[]; child: LogicalPlan }
  | { op: 'Limit';     n: number; child: LogicalPlan }
  | ...
```

### Executor (`src/executor.ts`)

Implements the [volcano/iterator model](https://dl.acm.org/doi/10.1145/627259.627290) (Graefe, 1994). Every operator exposes a single `next(): Row | null` method. The engine calls `next()` on the root plan node; operators pull rows from their children on demand.

```typescript
interface Operator {
  next(): Row | null;
}
```

This means rows flow lazily through the pipeline. A `LIMIT 5` at the root will cause the executor to stop pulling after 5 rows — the `Scan` at the bottom never processes the rest of the table. This is the same model used in PostgreSQL, MySQL, and SQLite.

The expression evaluator (`evalExpr`) is a recursive function over `ASTNode` that handles arithmetic, comparisons, boolean logic, string functions, and aggregate accumulators.

---

## REPL commands

```
.tables              list loaded tables
.load <file>         load a .json or .csv file as a table
.explain <sql>       print the logical plan tree
.clear               clear multi-line buffer
.exit                quit
```

Example `.explain` output:

```
smolsql> .explain SELECT dept, COUNT(*) FROM users WHERE age > 25 GROUP BY dept

Logical plan:
Aggregate(keys=[dept])
  Filter
    Scan(users, 10 rows)
```

---

## Loading your own data

Drop any `.json` or `.csv` file into `./data/` and it becomes a table named after the file:

```bash
cp ~/my-data/products.csv ./data/
npm run repl
smolsql> SELECT category, SUM(price) FROM products GROUP BY category;
```

Or load at runtime:

```
smolsql> .load ./path/to/invoices.json
  loaded table 'invoices' (842 rows)
smolsql> SELECT * FROM invoices WHERE amount > 1000;
```

---

## What I learned

The volcano model was the real insight. A `SELECT` statement looks like instructions, but it's actually a declaration — it describes a result set, not a procedure. The planner's job is to build the cheapest procedure that produces that result. The executor's job is to run it one row at a time without loading everything into memory first. That's the entire intellectual core of every relational database ever built.

The second thing: operator composition is powerful. Once you have `Filter`, `Project`, `Sort`, and `Scan` as independent units, you can combine them into arbitrarily complex query plans without writing new code. The primitives do the work.

---

## What's next

- Cost-based optimizer (selectivity estimation, join reordering)
- `EXPLAIN ANALYZE` with real timing per operator
- B-tree indexes over in-memory tables
- `WITH` (CTEs)
- `INSERT` / `UPDATE` / `DELETE` with mutable table state
- Disk-backed storage with a page cache

---

## Project structure

```
smolsql/
├── src/
│   ├── lexer.ts       tokenizer — SQL string → Token[]
│   ├── parser.ts      recursive-descent parser — Token[] → AST
│   ├── planner.ts     logical planner — AST → LogicalPlan tree
│   ├── executor.ts    volcano executor — LogicalPlan → Row[][]
│   ├── index.ts       public API + CLI entry point
│   ├── repl.ts        interactive REPL
│   └── test.ts        test suite (20 cases)
├── data/
│   ├── users.json     sample table
│   └── orders.json    sample table
├── package.json
└── tsconfig.json
```

---

## References

- Graefe, G. (1994). *Volcano — An Extensible and Parallel Query Evaluation System.* IEEE TKDE.
- Ramakrishnan & Gehrke. *Database Management Systems.* (the textbook)
- DuckDB internals blog series — modern take on the same ideas
