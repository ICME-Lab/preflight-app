// Minimal SMT-LIB / s-expression pretty printer.
// Parses parenthesised expressions and reformats with consistent indentation.
// Strings (in double quotes) and pipe-quoted symbols are preserved verbatim.

type Node = string | Node[];

const INDENT = "  ";
const TARGET_WIDTH = 78;

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if (c === ";") {
      // line comment
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push(c);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; } // SMT-LIB escape ""
          j++;
          break;
        }
        j++;
      }
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "|") {
      let j = i + 1;
      while (j < n && src[j] !== "|") j++;
      if (j < n) j++; // include closing |
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    let j = i;
    while (
      j < n &&
      src[j] !== " " &&
      src[j] !== "\t" &&
      src[j] !== "\n" &&
      src[j] !== "\r" &&
      src[j] !== "(" &&
      src[j] !== ")"
    ) {
      j++;
    }
    if (j > i) {
      tokens.push(src.slice(i, j));
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

function parse(tokens: string[]): Node[] {
  let i = 0;
  function read(): Node {
    const tok = tokens[i++];
    if (tok === "(") {
      const list: Node[] = [];
      while (i < tokens.length && tokens[i] !== ")") list.push(read());
      i++; // consume ")"
      return list;
    }
    if (tok === ")") {
      // unbalanced; surface as a stray atom rather than throwing
      return tok;
    }
    return tok;
  }
  const out: Node[] = [];
  while (i < tokens.length) out.push(read());
  return out;
}

function flatLen(node: Node): number {
  if (typeof node === "string") return node.length;
  let sum = 2; // for parentheses
  for (let k = 0; k < node.length; k++) {
    sum += flatLen(node[k]);
    if (k > 0) sum += 1;
  }
  return sum;
}

function flatPrint(node: Node): string {
  if (typeof node === "string") return node;
  return "(" + node.map(flatPrint).join(" ") + ")";
}

function format(node: Node, indent: number): string {
  if (typeof node === "string") return node;
  const pad = INDENT.repeat(indent);
  if (flatLen(node) + indent * INDENT.length <= TARGET_WIDTH) {
    return flatPrint(node);
  }
  if (node.length === 0) return "()";
  // Keep the head on the opening paren line; nest the rest.
  const head = node[0];
  const headStr = typeof head === "string" ? head : flatPrint(head);
  const childPad = pad + INDENT;
  const children = node
    .slice(1)
    .map((c) => childPad + format(c, indent + 1));
  return "(" + headStr + "\n" + children.join("\n") + ")";
}

export function formatSmt(src: string): string {
  try {
    const trimmed = src.trim();
    if (!trimmed) return "";
    if (!trimmed.includes("(")) return trimmed;
    const ast = parse(tokenize(trimmed));
    return ast.map((n) => format(n, 0)).join("\n\n");
  } catch {
    return src;
  }
}

const SMT_KEYWORDS = new Set([
  "declare-fun", "define-fun", "declare-sort", "define-sort", "declare-const",
  "assert", "check-sat", "get-model", "push", "pop", "set-logic", "set-info",
  "and", "or", "not", "xor", "=>", "ite", "let", "forall", "exists",
  "=", "distinct", "true", "false",
  "+", "-", "*", "div", "mod", "<", "<=", ">", ">=",
  "select", "store", "as", "Int", "Bool", "Real", "String", "Array",
]);

export interface SmtToken {
  text: string;
  kind: "paren" | "keyword" | "string" | "number" | "symbol" | "comment" | "space";
}

export function highlightSmt(formatted: string): SmtToken[] {
  const tokens: SmtToken[] = [];
  const n = formatted.length;
  let i = 0;
  while (i < n) {
    const c = formatted[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i;
      while (j < n && (formatted[j] === " " || formatted[j] === "\t" || formatted[j] === "\n" || formatted[j] === "\r")) j++;
      tokens.push({ text: formatted.slice(i, j), kind: "space" });
      i = j;
      continue;
    }
    if (c === ";") {
      let j = i;
      while (j < n && formatted[j] !== "\n") j++;
      tokens.push({ text: formatted.slice(i, j), kind: "comment" });
      i = j;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ text: c, kind: "paren" });
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (formatted[j] === '"') {
          if (formatted[j + 1] === '"') { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      tokens.push({ text: formatted.slice(i, j), kind: "string" });
      i = j;
      continue;
    }
    let j = i;
    while (j < n && !" \t\n\r()".includes(formatted[j])) j++;
    const atom = formatted.slice(i, j);
    if (SMT_KEYWORDS.has(atom)) tokens.push({ text: atom, kind: "keyword" });
    else if (/^-?\d+(\.\d+)?$/.test(atom)) tokens.push({ text: atom, kind: "number" });
    else tokens.push({ text: atom, kind: "symbol" });
    i = j;
  }
  return tokens;
}
