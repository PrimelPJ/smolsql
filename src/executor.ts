import { ASTNode } from './parser.js';
import { LogicalPlan, Row } from './planner.js';

// ─── Expression evaluator ───────────────────────────────────────────────────

function evalExpr(node:ASTNode, row:Row): unknown {
  switch(node.kind) {
    case 'Literal': return node.value;
    case 'Star': return '*';
    case 'Identifier': {
      if(node.table) {
        const qualified = `${node.table}.${node.name}`;
        if(qualified in row) return row[qualified];
        return row[node.name] ?? null;
      }
      if(node.name in row) return row[node.name];
      // case-insensitive fallback
      const key = Object.keys(row).find(k=>k.toLowerCase()===node.name.toLowerCase());
      return key ? row[key] : null;
    }
    case 'UnaryOp': {
      const v = evalExpr(node.expr, row);
      if(node.op==='-') return -(v as number);
      if(node.op==='NOT') return !isTruthy(v);
      return v;
    }
    case 'BinaryOp': {
      if(node.op==='AND') return isTruthy(evalExpr(node.left,row)) && isTruthy(evalExpr(node.right,row));
      if(node.op==='OR')  return isTruthy(evalExpr(node.left,row)) || isTruthy(evalExpr(node.right,row));
      const l=evalExpr(node.left,row), r=evalExpr(node.right,row);
      switch(node.op){
        case '=':   return l===r || (l!=null&&r!=null&&String(l)===String(r)&&Number(l)===Number(r)) || l==r;
        case '!=': case '<>': return l!==r;
        case '<':  return (l as number)<(r as number);
        case '>':  return (l as number)>(r as number);
        case '<=': return (l as number)<=(r as number);
        case '>=': return (l as number)>=(r as number);
        case '+':  return (l as number)+(r as number);
        case '-':  return (l as number)-(r as number);
        case '*':  return (l as number)*(r as number);
        case '/':  return (r as number)!==0?(l as number)/(r as number):null;
        case '%':  return (l as number)%(r as number);
        default: return null;
      }
    }
    case 'IsNull': {
      const v=evalExpr(node.expr,row);
      return node.not ? v!==null && v!==undefined : v===null||v===undefined;
    }
    case 'InList': {
      const v=evalExpr(node.expr,row);
      const inSet=node.list.some(item=>evalExpr(item,row)==v);
      return node.not ? !inSet : inSet;
    }
    case 'Between': {
      const v=evalExpr(node.expr,row) as number;
      const lo=evalExpr(node.low,row) as number;
      const hi=evalExpr(node.high,row) as number;
      const inRange=v>=lo&&v<=hi;
      return node.not?!inRange:inRange;
    }
    case 'Like': {
      const v=String(evalExpr(node.expr,row));
      const pattern=String(evalExpr(node.pattern,row));
      const regex=new RegExp('^'+pattern.replace(/%/g,'.*').replace(/_/g,'.')+'$','i');
      const match=regex.test(v);
      return node.not?!match:match;
    }
    case 'Case': {
      for(const branch of node.branches){
        const cond=node.operand
          ? evalExpr(node.operand,row)==evalExpr(branch.when,row)
          : isTruthy(evalExpr(branch.when,row));
        if(cond) return evalExpr(branch.then,row);
      }
      return node.else ? evalExpr(node.else,row) : null;
    }
    case 'FunctionCall': {
      const args=node.args.map(a=>evalExpr(a,row));
      switch(node.name){
        case 'UPPER': return String(args[0]??'').toUpperCase();
        case 'LOWER': return String(args[0]??'').toLowerCase();
        case 'LENGTH': return String(args[0]??'').length;
        case 'TRIM': return String(args[0]??'').trim();
        case 'ROUND': return Math.round(args[0] as number);
        case 'ABS': return Math.abs(args[0] as number);
        case 'COALESCE': return args.find(a=>a!==null&&a!==undefined)??null;
        case 'CONCAT': return args.map(String).join('');
        case 'SUBSTR': case 'SUBSTRING': {
          const s=String(args[0]??'');
          const start=(args[1] as number??1)-1;
          const len=args[2] as number;
          return len!==undefined?s.substr(start,len):s.substr(start);
        }
        default: return null;
      }
    }
    default: return null;
  }
}

function isTruthy(v:unknown):boolean {
  if(v===null||v===undefined||v===false) return false;
  if(typeof v==='number') return v!==0;
  return true;
}

function colKey(node:ASTNode, alias?:string):string {
  if(alias) return alias;
  if(node.kind==='Identifier') return node.table?`${node.table}.${node.name}`:node.name;
  if(node.kind==='FunctionCall'){
    const agg=node.name.toLowerCase();
    if(node.args.length===0||node.args[0].kind==='Star') return `${agg}(*)`;
    return `${agg}(${colKey(node.args[0])})`;
  }
  return '__col';
}

// ─── Volcano iterator model ──────────────────────────────────────────────────

interface Operator { next():Row|null; }

function buildOperator(plan:LogicalPlan): Operator {
  switch(plan.op) {

    case 'Scan': {
      const { alias, rows } = plan;
      let i=0;
      return { next(){
        if(i>=rows.length) return null;
        const raw=rows[i++];
        const out:Row={};
        for(const k in raw){
          out[`${alias}.${k}`]=raw[k];
          out[k]=raw[k];
        }
        return out;
      }};
    }

    case 'Subquery': {
      const inner = buildOperator(plan.child);
      const alias = plan.alias;
      return { next(){
        const row = inner.next();
        if(!row) return null;
        const out:Row={};
        for(const k in row){
          const bare=k.includes('.')?k.split('.').pop()!:k;
          out[`${alias}.${bare}`]=row[k];
          out[bare]=row[k];
        }
        return out;
      }};
    }

    case 'Filter': {
      const child = buildOperator(plan.child);
      return { next(){
        while(true){
          const row=child.next();
          if(!row) return null;
          if(isTruthy(evalExpr(plan.predicate,row))) return row;
        }
      }};
    }

    case 'Project': {
      const child = buildOperator(plan.child);
      return { next(){
        const row=child.next();
        if(!row) return null;
        const out:Row={};
        for(const col of plan.columns){
          if(col.expr.kind==='Star'){ Object.assign(out,row); continue; }
          const key=colKey(col.expr,col.alias);
          out[key]=evalExpr(col.expr,row);
        }
        return out;
      }};
    }

    case 'HashJoin': {
      const leftOp = buildOperator(plan.left);
      const rightOp = buildOperator(plan.right);
      // Build phase: materialise left
      const leftRows:Row[]=[];
      let r=leftOp.next();
      while(r){ leftRows.push(r); r=leftOp.next(); }
      let leftIdx=0;
      let rightRow:Row|null=rightOp.next();
      let innerIdx=0;

      if(plan.kind==='INNER'){
        return { next(){
          while(rightRow!==null){
            while(innerIdx<leftRows.length){
              const combined:Row={...leftRows[innerIdx++],...rightRow};
              if(isTruthy(evalExpr(plan.on,combined))) return combined;
            }
            rightRow=rightOp.next();
            innerIdx=0;
          }
          return null;
        }};
      } else {
        // LEFT JOIN
        const matched=new Set<number>();
        let probeMode=true;
        let unmatchedIdx=0;
        return { next(){
          if(probeMode){
            while(rightRow!==null){
              while(innerIdx<leftRows.length){
                const li=innerIdx++;
                const combined:Row={...leftRows[li],...rightRow};
                if(isTruthy(evalExpr(plan.on,combined))){ matched.add(li); return combined; }
              }
              rightRow=rightOp.next();
              innerIdx=0;
            }
            probeMode=false;
          }
          // Emit unmatched left rows with nulls for right
          while(unmatchedIdx<leftRows.length){
            const li=unmatchedIdx++;
            if(!matched.has(li)) return leftRows[li];
          }
          return null;
        }};
      }
    }

    case 'Aggregate': {
      const child = buildOperator(plan.child);
      // Materialise all rows
      const allRows:Row[]=[];
      let row=child.next();
      while(row){ allRows.push(row); row=child.next(); }

      // Group
      const groups=new Map<string,Row[]>();
      const keyOrder:string[]=[];
      for(const r of allRows){
        const gk = plan.keys.map(k=>{
          const v=r[k]??Object.values(r).find((_,i)=>Object.keys(r)[i].toLowerCase()===k.toLowerCase());
          return String(v??'');
        }).join('\x00');
        if(!groups.has(gk)){ groups.set(gk,[]); keyOrder.push(gk); }
        groups.get(gk)!.push(r);
      }
      if(keyOrder.length===0) keyOrder.push('');
      if(!groups.has('') && plan.keys.length===0) groups.set('',allRows);

      const results:Row[]=[];
      for(const gk of keyOrder){
        const gRows=groups.get(gk)??[];
        const out:Row={};
        // Set group keys from first row
        if(plan.keys.length>0 && gRows.length>0){
          for(const k of plan.keys){
            const fr=gRows[0];
            out[k]=fr[k]??Object.entries(fr).find(([ck])=>ck.toLowerCase()===k.toLowerCase())?.[1]??null;
          }
        }
        // Compute aggregates
        for(const col of plan.projections){
          const key=colKey(col.expr,col.alias);
          if(col.expr.kind==='Identifier'){
            out[key]=gRows[0]?.[col.expr.name]??null;
            continue;
          }
          if(col.expr.kind==='FunctionCall'){
            const fn=col.expr.name;
            const vals=gRows.map(r=>{
              if(col.expr.kind==='FunctionCall'&&col.expr.args[0]?.kind==='Star') return 1;
              if(col.expr.kind==='FunctionCall') return evalExpr(col.expr.args[0],r);
              return null;
            }).filter(v=>v!==null&&v!==undefined);
            if(fn==='COUNT') out[key]=vals.length;
            else if(fn==='SUM') out[key]=vals.reduce((a,b)=>(a as number)+(b as number),0);
            else if(fn==='AVG') out[key]=vals.length?vals.reduce((a,b)=>(a as number)+(b as number),0) as number/vals.length:null;
            else if(fn==='MIN') out[key]=vals.reduce((a,b)=>(a as number)<(b as number)?a:b,vals[0]??null);
            else if(fn==='MAX') out[key]=vals.reduce((a,b)=>(a as number)>(b as number)?a:b,vals[0]??null);
            else out[key]=null;
            continue;
          }
          out[key]=gRows[0]?evalExpr(col.expr,gRows[0]):null;
        }
        if(plan.having && !isTruthy(evalExpr(plan.having,out))) continue;
        results.push(out);
      }
      let ri=0;
      return { next(){ return ri<results.length?results[ri++]:null; }};
    }

    case 'Distinct': {
      const child = buildOperator(plan.child);
      const seen=new Set<string>();
      return { next(){
        while(true){
          const row=child.next();
          if(!row) return null;
          const key=JSON.stringify(row);
          if(!seen.has(key)){ seen.add(key); return row; }
        }
      }};
    }

    case 'Sort': {
      const child = buildOperator(plan.child);
      const all:Row[]=[];
      let r=child.next();
      while(r){ all.push(r); r=child.next(); }
      all.sort((a,b)=>{
        for(const {expr,dir} of plan.clauses){
          const av=evalExpr(expr,a) as number|string;
          const bv=evalExpr(expr,b) as number|string;
          if(av===bv) continue;
          if(av===null||av===undefined) return dir==='ASC'?1:-1;
          if(bv===null||bv===undefined) return dir==='ASC'?-1:1;
          const cmp=av<bv?-1:1;
          return dir==='ASC'?cmp:-cmp;
        }
        return 0;
      });
      let i=0;
      return { next(){ return i<all.length?all[i++]:null; }};
    }

    case 'Limit': {
      const child = buildOperator(plan.child);
      let count=0;
      return { next(){
        if(count>=plan.n) return null;
        const row=child.next();
        if(row) count++;
        return row;
      }};
    }
  }
}

// ─── Public execute ──────────────────────────────────────────────────────────

export interface QueryResult { columns:string[]; rows:Row[]; }

export function execute(plan:LogicalPlan): QueryResult {
  const op = buildOperator(plan);
  const rows:Row[]=[];
  let row=op.next();
  while(row){ rows.push(row); row=op.next(); }
  const columns = rows.length>0 ? Object.keys(rows[0]) : [];
  return { columns, rows };
}
