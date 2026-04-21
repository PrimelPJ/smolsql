import { Token, TokenType, tokenize } from './lexer.js';

export type ASTNode =
  | { kind:'SelectStmt'; distinct:boolean; columns:SelectCol[]; from?:FromClause; where?:ASTNode; groupBy?:string[]; having?:ASTNode; orderBy?:OrderClause[]; limit?:number }
  | { kind:'BinaryOp'; op:string; left:ASTNode; right:ASTNode }
  | { kind:'UnaryOp'; op:string; expr:ASTNode }
  | { kind:'Identifier'; table?:string; name:string }
  | { kind:'Literal'; value:string|number|boolean|null }
  | { kind:'Star' }
  | { kind:'FunctionCall'; name:string; args:ASTNode[]; distinct:boolean }
  | { kind:'Alias'; expr:ASTNode; alias:string }
  | { kind:'IsNull'; expr:ASTNode; not:boolean }
  | { kind:'InList'; expr:ASTNode; list:ASTNode[]; not:boolean }
  | { kind:'Between'; expr:ASTNode; low:ASTNode; high:ASTNode; not:boolean }
  | { kind:'Like'; expr:ASTNode; pattern:ASTNode; not:boolean }
  | { kind:'Case'; operand?:ASTNode; branches:{when:ASTNode;then:ASTNode}[]; else?:ASTNode }

export interface SelectCol { expr:ASTNode; alias?:string }
export interface OrderClause { expr:ASTNode; dir:'ASC'|'DESC' }
export type FromClause =
  | { type:'Table'; name:string; alias?:string }
  | { type:'Join'; kind:'INNER'|'LEFT'; left:FromClause; right:FromClause; on:ASTNode }
  | { type:'Subquery'; query:ASTNode; alias:string }

class Parser {
  private tokens:Token[];
  private pos=0;
  constructor(sql:string){ this.tokens=tokenize(sql); }
  private peek(offset=0):Token{ return this.tokens[Math.min(this.pos+offset,this.tokens.length-1)]; }
  private consume():Token{ return this.tokens[this.pos++]; }
  private expect(type:TokenType):Token{
    const t=this.consume();
    if(t.type!==type)throw new Error(`Expected ${type} but got ${t.type} ('${t.value}') at pos ${t.pos}`);
    return t;
  }
  private match(...types:TokenType[]):boolean{
    if(types.includes(this.peek().type)){this.consume();return true;}return false;
  }
  private check(...types:TokenType[]):boolean{ return types.includes(this.peek().type); }

  parse():ASTNode{ const node=this.parseSelect(); return node; }

  private parseSelect():ASTNode{
    this.expect(TokenType.SELECT);
    const distinct=this.match(TokenType.DISTINCT);
    const columns=this.parseSelectList();
    let from:FromClause|undefined;
    if(this.match(TokenType.FROM)) from=this.parseFrom();
    let where:ASTNode|undefined;
    if(this.match(TokenType.WHERE)) where=this.parseExpr();
    let groupBy:string[]|undefined;
    if(this.check(TokenType.GROUP)&&this.peek(1).type===TokenType.BY){
      this.consume();this.consume();
      groupBy=[];
      do{ groupBy.push(this.expect(TokenType.IDENT).value); }while(this.match(TokenType.COMMA));
    }
    let having:ASTNode|undefined;
    if(this.match(TokenType.HAVING)) having=this.parseExpr();
    let orderBy:OrderClause[]|undefined;
    if(this.check(TokenType.ORDER)&&this.peek(1).type===TokenType.BY){
      this.consume();this.consume();
      orderBy=[];
      do{
        const expr=this.parseExpr();
        const dir=this.match(TokenType.DESC)?'DESC':'ASC';
        if(this.check(TokenType.ASC))this.consume();
        orderBy.push({expr,dir});
      }while(this.match(TokenType.COMMA));
    }
    let limit:number|undefined;
    if(this.match(TokenType.LIMIT)) limit=parseFloat(this.expect(TokenType.NUMBER).value);
    this.match(TokenType.SEMICOLON);
    return {kind:'SelectStmt',distinct,columns,from,where,groupBy,having,orderBy,limit};
  }

  private parseSelectList():SelectCol[]{
    const cols:SelectCol[]=[];
    do{
      if(this.check(TokenType.STAR)){ this.consume(); cols.push({expr:{kind:'Star'}}); }
      else{
        const expr=this.parseExpr();
        let alias:string|undefined;
        if(this.match(TokenType.AS)) alias=this.expect(TokenType.IDENT).value;
        else if(this.check(TokenType.IDENT)&&!this.check(TokenType.FROM,TokenType.WHERE,TokenType.GROUP,TokenType.ORDER,TokenType.LIMIT,TokenType.HAVING)){
          alias=this.consume().value;
        }
        cols.push({expr,alias});
      }
    }while(this.match(TokenType.COMMA));
    return cols;
  }

  private parseFrom():FromClause{
    let left=this.parseTableRef();
    while(this.check(TokenType.INNER,TokenType.LEFT,TokenType.JOIN)){
      const kind=this.check(TokenType.LEFT)?'LEFT':'INNER';
      if(this.check(TokenType.INNER,TokenType.LEFT))this.consume();
      this.expect(TokenType.JOIN);
      const right=this.parseTableRef();
      this.expect(TokenType.ON);
      const on=this.parseExpr();
      left={type:'Join',kind,left,right,on};
    }
    return left;
  }

  private parseTableRef():FromClause{
    if(this.check(TokenType.LPAREN)){
      this.consume();
      const query=this.parseSelect();
      this.expect(TokenType.RPAREN);
      this.match(TokenType.AS);
      const alias=this.expect(TokenType.IDENT).value;
      return{type:'Subquery',query,alias};
    }
    const name=this.expect(TokenType.IDENT).value;
    let alias:string|undefined;
    if(this.match(TokenType.AS)) alias=this.expect(TokenType.IDENT).value;
    else if(this.check(TokenType.IDENT)&&!this.check(TokenType.WHERE,TokenType.INNER,TokenType.LEFT,TokenType.JOIN,TokenType.ON,TokenType.GROUP,TokenType.ORDER,TokenType.LIMIT,TokenType.HAVING)){
      alias=this.consume().value;
    }
    return{type:'Table',name,alias};
  }

  private parseExpr():ASTNode{ return this.parseOr(); }

  private parseOr():ASTNode{
    let left=this.parseAnd();
    while(this.match(TokenType.OR)){
      const right=this.parseAnd();
      left={kind:'BinaryOp',op:'OR',left,right};
    }
    return left;
  }

  private parseAnd():ASTNode{
    let left=this.parseNot();
    while(this.match(TokenType.AND)){
      const right=this.parseNot();
      left={kind:'BinaryOp',op:'AND',left,right};
    }
    return left;
  }

  private parseNot():ASTNode{
    if(this.match(TokenType.NOT)){
      return{kind:'UnaryOp',op:'NOT',expr:this.parseNot()};
    }
    return this.parseComparison();
  }

  private parseComparison():ASTNode{
    let left=this.parseAddSub();
    const opMap:Partial<Record<TokenType,string>>={
      [TokenType.EQ]:'=',[TokenType.NEQ]:'!=',[TokenType.LT]:'<',
      [TokenType.GT]:'>',[TokenType.LTE]:'<=',[TokenType.GTE]:'>=',
    };
    if(this.check(TokenType.IS)){
      this.consume();
      const not=this.match(TokenType.NOT);
      this.expect(TokenType.NULL);
      return{kind:'IsNull',expr:left,not};
    }
    const notKw=this.check(TokenType.NOT);
    if(notKw&&this.peek(1).type===TokenType.BETWEEN){ this.consume(); this.consume(); const low=this.parseAddSub(); this.expect(TokenType.AND); const high=this.parseAddSub(); return{kind:'Between',expr:left,low,high,not:true}; }
    if(notKw&&this.peek(1).type===TokenType.IN){ this.consume(); this.consume(); this.expect(TokenType.LPAREN); const list=this.parseExprList(); this.expect(TokenType.RPAREN); return{kind:'InList',expr:left,list,not:true}; }
    if(notKw&&this.peek(1).type===TokenType.LIKE){ this.consume(); this.consume(); const pattern=this.parseAddSub(); return{kind:'Like',expr:left,pattern,not:true}; }
    if(this.match(TokenType.BETWEEN)){ const low=this.parseAddSub(); this.expect(TokenType.AND); const high=this.parseAddSub(); return{kind:'Between',expr:left,low,high,not:false}; }
    if(this.match(TokenType.IN)){ this.expect(TokenType.LPAREN); const list=this.parseExprList(); this.expect(TokenType.RPAREN); return{kind:'InList',expr:left,list,not:false}; }
    if(this.match(TokenType.LIKE)){ const pattern=this.parseAddSub(); return{kind:'Like',expr:left,pattern,not:false}; }
    const op=opMap[this.peek().type];
    if(op){ this.consume(); const right=this.parseAddSub(); return{kind:'BinaryOp',op,left,right}; }
    return left;
  }

  private parseExprList():ASTNode[]{
    const list:ASTNode[]=[];
    do{ list.push(this.parseExpr()); }while(this.match(TokenType.COMMA));
    return list;
  }

  private parseAddSub():ASTNode{
    let left=this.parseMulDiv();
    while(this.check(TokenType.PLUS,TokenType.MINUS)){
      const op=this.consume().value;
      const right=this.parseMulDiv();
      left={kind:'BinaryOp',op,left,right};
    }
    return left;
  }

  private parseMulDiv():ASTNode{
    let left=this.parseUnary();
    while(this.check(TokenType.STAR,TokenType.SLASH,TokenType.PERCENT)){
      const op=this.consume().value;
      const right=this.parseUnary();
      left={kind:'BinaryOp',op,left,right};
    }
    return left;
  }

  private parseUnary():ASTNode{
    if(this.match(TokenType.MINUS)) return{kind:'UnaryOp',op:'-',expr:this.parseUnary()};
    return this.parsePrimary();
  }

  private parsePrimary():ASTNode{
    const t=this.peek();
    if(t.type===TokenType.NUMBER){ this.consume(); return{kind:'Literal',value:parseFloat(t.value)}; }
    if(t.type===TokenType.STRING){ this.consume(); return{kind:'Literal',value:t.value}; }
    if(t.type===TokenType.TRUE){ this.consume(); return{kind:'Literal',value:true}; }
    if(t.type===TokenType.FALSE){ this.consume(); return{kind:'Literal',value:false}; }
    if(t.type===TokenType.NULL){ this.consume(); return{kind:'Literal',value:null}; }
    if(t.type===TokenType.STAR){ this.consume(); return{kind:'Star'}; }
    if(t.type===TokenType.LPAREN){
      this.consume();
      const expr=this.parseExpr();
      this.expect(TokenType.RPAREN);
      return expr;
    }
    if(t.type===TokenType.CASE){
      this.consume();
      let operand:ASTNode|undefined;
      if(!this.check(TokenType.WHEN)) operand=this.parseExpr();
      const branches:{when:ASTNode;then:ASTNode}[]=[];
      while(this.match(TokenType.WHEN)){ const when=this.parseExpr(); this.expect(TokenType.THEN); const then=this.parseExpr(); branches.push({when,then}); }
      let elseBranch:ASTNode|undefined;
      if(this.match(TokenType.ELSE)) elseBranch=this.parseExpr();
      this.expect(TokenType.END);
      return{kind:'Case',operand,branches,else:elseBranch};
    }
    if(t.type===TokenType.IDENT){
      this.consume();
      // Function call
      if(this.check(TokenType.LPAREN)){
        this.consume();
        const distinct=this.match(TokenType.DISTINCT);
        const args:ASTNode[]=[];
        if(!this.check(TokenType.RPAREN)){
          if(this.check(TokenType.STAR)){ this.consume(); args.push({kind:'Star'}); }
          else{ do{ args.push(this.parseExpr()); }while(this.match(TokenType.COMMA)); }
        }
        this.expect(TokenType.RPAREN);
        return{kind:'FunctionCall',name:t.value.toUpperCase(),args,distinct};
      }
      // Qualified identifier
      if(this.check(TokenType.DOT)){ this.consume(); const col=this.expect(TokenType.IDENT).value; return{kind:'Identifier',table:t.value,name:col}; }
      return{kind:'Identifier',name:t.value};
    }
    throw new Error(`Unexpected token '${t.value}' (${t.type}) at pos ${t.pos}`);
  }
}

export function parse(sql:string):ASTNode{ return new Parser(sql).parse(); }
