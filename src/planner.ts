import { ASTNode, SelectCol, FromClause, OrderClause } from './parser.js';

export type Row = Record<string, unknown>;

export type LogicalPlan =
  | { op:'Scan'; alias:string; rows:Row[] }
  | { op:'Filter'; predicate:ASTNode; child:LogicalPlan }
  | { op:'Project'; columns:SelectCol[]; child:LogicalPlan }
  | { op:'HashJoin'; kind:'INNER'|'LEFT'; on:ASTNode; left:LogicalPlan; right:LogicalPlan }
  | { op:'Aggregate'; keys:string[]; aggregates:SelectCol[]; projections:SelectCol[]; child:LogicalPlan; having?:ASTNode }
  | { op:'Distinct'; child:LogicalPlan }
  | { op:'Sort'; clauses:OrderClause[]; child:LogicalPlan }
  | { op:'Limit'; n:number; child:LogicalPlan }
  | { op:'Subquery'; alias:string; child:LogicalPlan }

type Catalog = Map<string, Row[]>;

export function buildPlan(ast:ASTNode, catalog:Catalog):LogicalPlan {
  if(ast.kind!=='SelectStmt') throw new Error('Only SELECT statements are supported');
  const { distinct, columns, from, where, groupBy, having, orderBy, limit } = ast;

  let plan:LogicalPlan = from ? buildFrom(from, catalog) : { op:'Scan', alias:'__empty', rows:[{}] };

  if(where) plan = { op:'Filter', predicate:where, child:plan };

  const hasAgg = columns.some(c=>containsAggregate(c.expr)) || (groupBy && groupBy.length>0);
  if(hasAgg) {
    const aggCols = columns.filter(c=>containsAggregate(c.expr));
    const projCols = columns;
    plan = { op:'Aggregate', keys:groupBy??[], aggregates:aggCols, projections:projCols, child:plan, having };
  } else {
    plan = { op:'Project', columns, child:plan };
  }

  if(distinct) plan = { op:'Distinct', child:plan };
  if(orderBy && orderBy.length>0) plan = { op:'Sort', clauses:orderBy, child:plan };
  if(limit !== undefined) plan = { op:'Limit', n:limit, child:plan };

  return plan;
}

function buildFrom(from:FromClause, catalog:Catalog):LogicalPlan {
  if(from.type==='Table'){
    const rows = catalog.get(from.name) ?? catalog.get(from.name.toLowerCase());
    if(!rows) throw new Error(`Unknown table: ${from.name}`);
    return { op:'Scan', alias:from.alias??from.name, rows };
  }
  if(from.type==='Subquery'){
    const inner = buildPlan(from.query, catalog);
    return { op:'Subquery', alias:from.alias, child:inner };
  }
  if(from.type==='Join'){
    const left = buildFrom(from.left, catalog);
    const right = buildFrom(from.right, catalog);
    return { op:'HashJoin', kind:from.kind, on:from.on, left, right };
  }
  throw new Error('Unknown from clause type');
}

function containsAggregate(node:ASTNode):boolean {
  if(node.kind==='FunctionCall'){
    const aggs=['COUNT','SUM','AVG','MIN','MAX','COUNT_DISTINCT'];
    if(aggs.includes(node.name)) return true;
  }
  if('left' in node && node.left) if(containsAggregate(node.left as ASTNode)) return true;
  if('right' in node && node.right) if(containsAggregate(node.right as ASTNode)) return true;
  if('expr' in node && node.expr) if(containsAggregate(node.expr as ASTNode)) return true;
  if('args' in node && node.args) for(const a of node.args) if(containsAggregate(a)) return true;
  return false;
}
