// Evaluador de fórmulas SEGURO para columnas de nómina. NO usa eval/Function:
// es un parser propio (descenso recursivo) que sólo entiende números, los
// operadores + - * / , paréntesis, referencias a otras columnas por su "key" y
// unas pocas funciones (round, abs, min, max, floor, ceil). Cualquier otra cosa
// es un error de sintaxis. Así una fórmula escrita por el usuario nunca puede
// ejecutar código: en el peor caso no compila.
//
// Uso:
//   const f = compile('sueldo + horas_extra * 1.35');  // throws si es inválida
//   f.refs                                              // ['sueldo','horas_extra']
//   f.evaluate({ sueldo: 20000, horas_extra: 10 })      // número

const FUNCS = {
  round: (x, n = 0) => { const p = 10 ** Math.trunc(n); return Math.round((Number(x) + Number.EPSILON) * p) / p; },
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
};

function tokenize(src) {
  const tokens = [];
  const s = String(src);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if ('+-*/(),'.includes(c)) { tokens.push({ t: c }); i++; continue; }
    if (c >= '0' && c <= '9' || (c === '.' && s[i + 1] >= '0' && s[i + 1] <= '9')) {
      let j = i + 1;
      while (j < s.length && (s[j] >= '0' && s[j] <= '9' || s[j] === '.')) j++;
      const num = s.slice(i, j);
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Número inválido: "${num}"`);
      tokens.push({ t: 'num', v: Number(num) }); i = j; continue;
    }
    if (c >= 'a' && c <= 'z' || c === '_') {
      let j = i + 1;
      while (j < s.length && (s[j] >= 'a' && s[j] <= 'z' || s[j] >= '0' && s[j] <= '9' || s[j] === '_')) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    throw new Error(`Carácter no permitido en la fórmula: "${c}"`);
  }
  return tokens;
}

// AST: number | {ref} | {op,a,b} | {neg} | {call,args}
function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = t => { const tok = tokens[pos]; if (!tok || (t && tok.t !== t)) throw new Error('Fórmula incompleta o mal formada.'); pos++; return tok; };

  function expr() {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) { const op = eat().t; node = { op, a: node, b: term() }; }
    return node;
  }
  function term() {
    let node = factor();
    while (peek() && (peek().t === '*' || peek().t === '/')) { const op = eat().t; node = { op, a: node, b: factor() }; }
    return node;
  }
  function factor() {
    const tok = peek();
    if (!tok) throw new Error('Fórmula incompleta.');
    if (tok.t === '-') { eat(); return { neg: factor() }; }
    if (tok.t === '+') { eat(); return factor(); }
    if (tok.t === 'num') { eat(); return { num: tok.v }; }
    if (tok.t === '(') { eat('('); const n = expr(); eat(')'); return n; }
    if (tok.t === 'id') {
      eat('id');
      if (peek() && peek().t === '(') {
        if (!FUNCS[tok.v]) throw new Error(`Función desconocida: "${tok.v}".`);
        eat('(');
        const args = [];
        if (peek() && peek().t !== ')') { args.push(expr()); while (peek() && peek().t === ',') { eat(','); args.push(expr()); } }
        eat(')');
        return { call: tok.v, args };
      }
      return { ref: tok.v };
    }
    throw new Error('Fórmula mal formada.');
  }

  const node = expr();
  if (pos !== tokens.length) throw new Error('Sobran símbolos en la fórmula.');
  return node;
}

function collectRefs(node, set) {
  if (!node || typeof node !== 'object') return;
  if (node.ref) set.add(node.ref);
  if (node.num !== undefined) return;
  if (node.neg) collectRefs(node.neg, set);
  if (node.a) { collectRefs(node.a, set); collectRefs(node.b, set); }
  if (node.args) node.args.forEach(a => collectRefs(a, set));
}

function evalNode(node, scope) {
  if (node.num !== undefined) return node.num;
  if (node.ref) { const v = Number(scope[node.ref]); return Number.isFinite(v) ? v : 0; }
  if (node.neg) return -evalNode(node.neg, scope);
  if (node.call) return FUNCS[node.call](...node.args.map(a => evalNode(a, scope)));
  const a = evalNode(node.a, scope); const b = evalNode(node.b, scope);
  if (node.op === '+') return a + b;
  if (node.op === '-') return a - b;
  if (node.op === '*') return a * b;
  if (node.op === '/') return b === 0 ? 0 : a / b; // división por cero → 0 (sin NaN/Infinity)
  throw new Error('Operador desconocido.');
}

function compile(src) {
  if (src === null || src === undefined || String(src).trim() === '') throw new Error('La fórmula está vacía.');
  const ast = parse(tokenize(src));
  const refs = new Set();
  collectRefs(ast, refs);
  return {
    refs: [...refs],
    evaluate(scope = {}) {
      const v = evalNode(ast, scope || {});
      return Number.isFinite(v) ? v : 0;
    },
  };
}

// ¿La fórmula es válida? (no lanza). Útil para validar al guardar una columna.
function validate(src, knownKeys = null) {
  try {
    const f = compile(src);
    if (knownKeys) { const miss = f.refs.filter(r => !knownKeys.includes(r)); if (miss.length) return { ok: false, error: `La fórmula usa columnas que no existen: ${miss.join(', ')}.` }; }
    return { ok: true, refs: f.refs };
  } catch (e) { return { ok: false, error: e.message }; }
}

const round2 = x => { const n = Number(x); return Number.isFinite(n) ? Math.round((n + Number.EPSILON) * 100) / 100 : 0; };

module.exports = { compile, validate, round2, FUNCS };
