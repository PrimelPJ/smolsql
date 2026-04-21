export enum TokenType {
  SELECT='SELECT',FROM='FROM',WHERE='WHERE',AND='AND',OR='OR',NOT='NOT',
  JOIN='JOIN',INNER='INNER',LEFT='LEFT',ON='ON',GROUP='GROUP',BY='BY',
  ORDER='ORDER',ASC='ASC',DESC='DESC',LIMIT='LIMIT',AS='AS',
  DISTINCT='DISTINCT',HAVING='HAVING',IS='IS',NULL='NULL',IN='IN',
  BETWEEN='BETWEEN',LIKE='LIKE',CASE='CASE',WHEN='WHEN',THEN='THEN',
  ELSE='ELSE',END='END',TRUE='TRUE',FALSE='FALSE',
  IDENT='IDENT',NUMBER='NUMBER',STRING='STRING',
  STAR='STAR',COMMA='COMMA',DOT='DOT',SEMICOLON='SEMICOLON',
  LPAREN='LPAREN',RPAREN='RPAREN',
  EQ='EQ',NEQ='NEQ',LT='LT',GT='GT',LTE='LTE',GTE='GTE',
  PLUS='PLUS',MINUS='MINUS',SLASH='SLASH',PERCENT='PERCENT',
  EOF='EOF',
}

const KEYWORDS: Record<string,TokenType> = {
  SELECT:TokenType.SELECT,FROM:TokenType.FROM,WHERE:TokenType.WHERE,
  AND:TokenType.AND,OR:TokenType.OR,NOT:TokenType.NOT,
  JOIN:TokenType.JOIN,INNER:TokenType.INNER,LEFT:TokenType.LEFT,
  ON:TokenType.ON,GROUP:TokenType.GROUP,BY:TokenType.BY,
  ORDER:TokenType.ORDER,ASC:TokenType.ASC,DESC:TokenType.DESC,
  LIMIT:TokenType.LIMIT,AS:TokenType.AS,DISTINCT:TokenType.DISTINCT,
  HAVING:TokenType.HAVING,IS:TokenType.IS,NULL:TokenType.NULL,IN:TokenType.IN,
  BETWEEN:TokenType.BETWEEN,LIKE:TokenType.LIKE,CASE:TokenType.CASE,
  WHEN:TokenType.WHEN,THEN:TokenType.THEN,ELSE:TokenType.ELSE,END:TokenType.END,
  TRUE:TokenType.TRUE,FALSE:TokenType.FALSE,
};

export interface Token { type:TokenType; value:string; pos:number; }

export function tokenize(input:string):Token[] {
  const tokens:Token[]=[];
  let pos=0;
  const peek=()=>input[pos]??'';
  const readWhile=(pred:(c:string)=>boolean):string=>{
    let s='';
    while(pos<input.length&&pred(input[pos]))s+=input[pos++];
    return s;
  };
  while(pos<input.length){
    const start=pos;
    const ch=peek();
    if(/\s/.test(ch)){pos++;continue;}
    if(ch==='-'&&input[pos+1]==='-'){while(pos<input.length&&input[pos]!=='\n')pos++;continue;}
    if(/[0-9]/.test(ch)){
      const num=readWhile(c=>/[0-9.]/.test(c));
      tokens.push({type:TokenType.NUMBER,value:num,pos:start});continue;
    }
    if(ch==="'"||ch==='"'){
      const quote=input[pos++];let s='';
      while(pos<input.length&&input[pos]!==quote){if(input[pos]==='\\')pos++;s+=input[pos++];}
      pos++;tokens.push({type:TokenType.STRING,value:s,pos:start});continue;
    }
    if(/[a-zA-Z_]/.test(ch)){
      const word=readWhile(c=>/[a-zA-Z0-9_]/.test(c));
      const upper=word.toUpperCase();
      const kw=KEYWORDS[upper];
      tokens.push({type:kw??TokenType.IDENT,value:kw?upper:word,pos:start});continue;
    }
    pos++;
    if(ch==='<'&&peek()==='='){pos++;tokens.push({type:TokenType.LTE,value:'<=',pos:start});continue;}
    if(ch==='>'&&peek()==='='){pos++;tokens.push({type:TokenType.GTE,value:'>=',pos:start});continue;}
    if(ch==='!'&&peek()==='='){pos++;tokens.push({type:TokenType.NEQ,value:'!=',pos:start});continue;}
    if(ch==='<'&&peek()==='>'){pos++;tokens.push({type:TokenType.NEQ,value:'<>',pos:start});continue;}
    const single:Record<string,TokenType>={
      '*':TokenType.STAR,',':TokenType.COMMA,'.':TokenType.DOT,
      ';':TokenType.SEMICOLON,'(':TokenType.LPAREN,')':TokenType.RPAREN,
      '=':TokenType.EQ,'<':TokenType.LT,'>':TokenType.GT,
      '+':TokenType.PLUS,'-':TokenType.MINUS,'/':TokenType.SLASH,'%':TokenType.PERCENT,
    };
    const t=single[ch];
    if(t){tokens.push({type:t,value:ch,pos:start});continue;}
    throw new Error(`Unexpected character '${ch}' at position ${start}`);
  }
  tokens.push({type:TokenType.EOF,value:'',pos});
  return tokens;
}
