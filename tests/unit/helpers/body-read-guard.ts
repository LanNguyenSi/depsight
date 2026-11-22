// Structural body-read guard for app/api route.ts sources, used only by
// tests/unit/read-json-capped.test.ts. It parses the source with the
// TypeScript compiler API and judges each mutating handler (POST, PUT, PATCH
// or DELETE, function declaration or `export const` arrow/function) on its
// own: a handler that uses its request needs an awaited readJsonCapped or
// readBodyCapped on the request inside its own body, or inside a same-file
// helper it calls with the request. Using the request only for non-body
// properties (headers, nextUrl, url, cookies, method, signal) needs nothing.
// Independently of the handlers, no request-typed value (parameter,
// annotated variable, alias or `clone()` result) may have a body property
// (`json`, `text`, `arrayBuffer`, `formData`, `blob`, `bytes`, `body`) read
// off it, with dot or element access, and a destructured request parameter
// may not pull a body property out.
// Limits: the scan is syntactic. It does not judge reachability (a capped
// call after a return, inside `if (false)` or in an uncalled inner function
// still counts) and it does not follow handlers or helpers into other files.
import ts from 'typescript';

const REQUEST_TYPES = new Set(['NextRequest', 'Request']);
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const BODY_ACCESSORS = new Set(['json', 'text', 'arrayBuffer', 'formData', 'blob', 'bytes', 'body']);
const NON_BODY_PROPERTIES = new Set(['headers', 'nextUrl', 'url', 'cookies', 'method', 'signal']);
const CAPPED_CALLS = new Set(['readJsonCapped', 'readBodyCapped']);

function forEachDescendant(node: ts.Node, visit: (n: ts.Node) => void): void {
  ts.forEachChild(node, (child) => {
    visit(child);
    forEachDescendant(child, visit);
  });
}

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
      e = e.expression;
      continue;
    }
    return e;
  }
}

function isRequestTypeAnnotation(type: ts.TypeNode | undefined): boolean {
  return (
    !!type &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    REQUEST_TYPES.has(type.typeName.text)
  );
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** The property name a `.p` or `['p']` access reads, for the literal forms only. */
function accessedKey(expr: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isElementAccessExpression(expr) && expr.argumentExpression && ts.isStringLiteral(expr.argumentExpression)) {
    return expr.argumentExpression.text;
  }
  return null;
}

/**
 * The request-typed root of an expression: a known request name, or the
 * result of `.clone()` on such an expression. Null when the expression does
 * not derive from a request.
 */
function requestRoot(expr: ts.Expression, requestNames: Set<string>): string | null {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return requestNames.has(e.text) ? e.text : null;
  if (ts.isCallExpression(e) && accessedKey(e.expression) === 'clone' && ts.isPropertyAccessExpression(e.expression)) {
    return requestRoot(e.expression.expression, requestNames);
  }
  return null;
}

interface Handler {
  method: string;
  /** Absent when the handler could not be resolved; `problem` then says why. */
  fn?: ts.FunctionLikeDeclaration;
  /** Identifier names this handler's signature binds the request to. */
  params: string[];
  /** A body property pulled out of a destructured request parameter. */
  destructured: string[];
  /** Set when a destructured or rest parameter binds something beyond the non-body list. */
  forcedNeeds: boolean;
  problem?: string;
}

type FnLike = ts.FunctionLikeDeclaration;

function isFunctionExpr(e: ts.Expression): e is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(e) || ts.isFunctionExpression(e);
}

/**
 * The function a handler initializer stands for: the function expression
 * itself, a same-file function it names, or (for a wrapper call such as
 * `withAuth(async (req) => ...)`) the first argument that is one of those.
 */
function resolveHandlerFn(expr: ts.Expression, localFns: Map<string, FnLike>): FnLike | undefined {
  const e = unwrap(expr);
  if (isFunctionExpr(e)) return e;
  if (ts.isIdentifier(e)) return localFns.get(e.text);
  if (ts.isCallExpression(e)) {
    for (const arg of e.arguments) {
      const fn = resolveHandlerFn(arg, localFns);
      if (fn) return fn;
    }
  }
  return undefined;
}

/** Same-file functions by name: declarations and consts holding a function or a wrapper call around one. */
function collectLocalFns(sf: ts.SourceFile): Map<string, FnLike> {
  const localFns = new Map<string, FnLike>();
  forEachDescendant(sf, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) localFns.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const fn = resolveHandlerFn(node.initializer, new Map());
      if (fn) localFns.set(node.name.text, fn);
    }
  });
  return localFns;
}

function bindingKey(el: ts.BindingElement): string | null {
  if (el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName))) return el.propertyName.text;
  return ts.isIdentifier(el.name) ? el.name.text : null;
}

function destructureFirstParameter(method: string, fn: FnLike, handler: Handler): void {
  const first = fn.parameters[0];
  if (!first) return;
  // A rest parameter hides the request in an array, so it cannot be judged.
  if (first.dotDotDotToken) {
    handler.forcedNeeds = true;
    return;
  }
  // The first parameter of a route handler is the request (Next passes it),
  // annotated or not, so a destructured first parameter destructures it.
  if (!ts.isObjectBindingPattern(first.name)) return;
  for (const el of first.name.elements) {
    if (ts.isOmittedExpression(el) || el.dotDotDotToken) {
      handler.forcedNeeds = true;
      continue;
    }
    const key = bindingKey(el);
    if (key && BODY_ACCESSORS.has(key)) {
      handler.destructured.push(`${method}: body read directly`);
    } else if (!key || !NON_BODY_PROPERTIES.has(key)) {
      handler.forcedNeeds = true;
    }
  }
}

function makeHandler(method: string, fn: FnLike): Handler {
  const handler: Handler = { method, fn, params: [], destructured: [], forcedNeeds: false };
  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name) && (i === 0 || isRequestTypeAnnotation(p.type))) handler.params.push(p.name.text);
  });
  destructureFirstParameter(method, fn, handler);
  return handler;
}

function unresolved(method: string, problem: string): Handler {
  return { method, params: [], destructured: [], forcedNeeds: false, problem: `${method}: ${problem}` };
}

function containsFunction(sf: ts.SourceFile): boolean {
  let found = false;
  forEachDescendant(sf, (n) => {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) found = true;
  });
  return found;
}

function findHandlers(sf: ts.SourceFile, localFns: Map<string, FnLike>): Handler[] {
  const handlers: Handler[] = [];
  for (const node of sf.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body && MUTATING_METHODS.has(node.name.text) && isExported(node)) {
      handlers.push(makeHandler(node.name.text, node));
    }
    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isObjectBindingPattern(decl.name)) {
          // Documented exception: `export const { GET, POST } = handlers;`
          // re-exports an imported value, so a file that defines no function
          // at all has no body to judge here. Any function in the file turns
          // the shape into a problem.
          for (const el of decl.name.elements) {
            const exported = ts.isIdentifier(el.name) ? el.name.text : null;
            if (exported && MUTATING_METHODS.has(exported) && containsFunction(sf)) {
              handlers.push(unresolved(exported, 'destructured export in a file that defines functions, handler not found'));
            }
          }
          continue;
        }
        if (!ts.isIdentifier(decl.name) || !MUTATING_METHODS.has(decl.name.text) || !decl.initializer) continue;
        const fn = resolveHandlerFn(decl.initializer, localFns);
        handlers.push(fn ? makeHandler(decl.name.text, fn) : unresolved(decl.name.text, 'handler function not found in this file'));
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const spec of node.exportClause.elements) {
        const exported = spec.name.text;
        if (!MUTATING_METHODS.has(exported)) continue;
        if (node.moduleSpecifier) {
          handlers.push(unresolved(exported, 're-exported from another file, which the guard does not follow'));
          continue;
        }
        const fn = localFns.get((spec.propertyName ?? spec.name).text);
        handlers.push(fn ? makeHandler(exported, fn) : unresolved(exported, 'handler function not found in this file'));
      }
    }
  }
  return handlers;
}

/** Names of the exported mutating handlers a source defines, in file order. */
export function mutatingHandlerNames(source: string): string[] {
  const sf = ts.createSourceFile('route.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  return findHandlers(sf, collectLocalFns(sf)).map((h) => h.method);
}

/**
 * What is wrong with one route.ts source; empty when every request body is
 * read through an awaited readJsonCapped or readBodyCapped. Message shapes:
 * `<name>: body read directly` for a body property read off request-typed
 * `<name>` (or destructured out of a handler's request), and
 * `<METHOD>: uses <param> without readJsonCapped or readBodyCapped` for a
 * handler that needs a capped read for its request and has none.
 */
export function findUncappedBodyReads(source: string): string[] {
  const sf = ts.createSourceFile('route.ts', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const localFns = collectLocalFns(sf);
  const handlers = findHandlers(sf, localFns);

  // Request-typed names: annotated bindings, the identifiers a mutating
  // handler binds the request to, then transitive aliases (`const r = req`).
  const requestNames = new Set<string>();
  forEachDescendant(sf, (node) => {
    if ((ts.isParameter(node) || ts.isVariableDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
      if (isRequestTypeAnnotation(node.type)) requestNames.add(node.name.text);
    }
  });
  for (const h of handlers) for (const p of h.params) requestNames.add(p);
  for (let changed = true; changed; ) {
    changed = false;
    forEachDescendant(sf, (node) => {
      if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer) return;
      const init = unwrap(node.initializer);
      if (ts.isIdentifier(init) && requestNames.has(init.text) && !requestNames.has(node.name.text)) {
        requestNames.add(node.name.text);
        changed = true;
      }
    });
  }

  const problems: string[] = [];
  const seen = new Set<string>();
  const push = (msg: string) => {
    if (!seen.has(msg)) {
      seen.add(msg);
      problems.push(msg);
    }
  };

  // Rule 1: no body property read off anything deriving from a request name.
  forEachDescendant(sf, (node) => {
    if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return;
    const root = requestRoot(node.expression, requestNames);
    if (!root) return;
    const key = accessedKey(node);
    if (key && BODY_ACCESSORS.has(key)) push(`${root}: body read directly`);
  });

  // A body property destructured out of a request alias: `const { body } = req`.
  forEachDescendant(sf, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isObjectBindingPattern(node.name) || !node.initializer) return;
    const root = requestRoot(node.initializer, requestNames);
    if (!root) return;
    for (const el of node.name.elements) {
      if (!ts.isOmittedExpression(el) && !el.dotDotDotToken && BODY_ACCESSORS.has(bindingKey(el) ?? '')) push(`${root}: body read directly`);
    }
  });

  // Same-file functions (collected above) honour a capped read a helper does on the request.
  const subtreeHasAwaitedCapped = (scope: ts.Node): boolean => {
    let found = false;
    forEachDescendant(scope, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      if (!CAPPED_CALLS.has(node.expression.text) || !node.parent || !ts.isAwaitExpression(node.parent)) return;
      // The call must read a request (or an alias or clone of one), not a foreign value.
      const target = node.arguments[0];
      if (target && requestRoot(target, requestNames)) found = true;
    });
    return found;
  };
  const localHasCapped = (name: string, visited: Set<string>): boolean => {
    const fn = localFns.get(name);
    if (!fn || visited.has(name)) return false;
    visited.add(name);
    if (subtreeHasAwaitedCapped(fn)) return true;
    return (() => {
      let hit = false;
      forEachDescendant(fn, (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && localHasCapped(node.expression.text, visited)) {
          hit = true;
        }
      });
      return hit;
    })();
  };

  // Rule 2: per mutating handler, on its own, with no excuse from siblings.
  for (const h of handlers) {
    for (const p of h.destructured) push(p);
    if (h.problem) push(h.problem);
    if (!h.fn?.body) continue;
    let needs = h.forcedNeeds;
    let satisfied = subtreeHasAwaitedCapped(h.fn.body);
    forEachDescendant(h.fn.body, (node) => {
      if (!ts.isIdentifier(node) || !requestNames.has(node.text)) return;
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        if (!NON_BODY_PROPERTIES.has(parent.name.text)) needs = true;
        return;
      }
      if (ts.isElementAccessExpression(parent) && parent.expression === node) {
        const key = parent.argumentExpression && ts.isStringLiteral(parent.argumentExpression) ? parent.argumentExpression.text : null;
        if (!key || !NON_BODY_PROPERTIES.has(key)) needs = true;
        return;
      }
      if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) {
        // `const { headers } = req` is fine; any other key, a rest element or an omitted one is not.
        for (const el of parent.name.elements) {
          if (ts.isOmittedExpression(el) || el.dotDotDotToken) needs = true;
          else if (!NON_BODY_PROPERTIES.has(bindingKey(el) ?? '')) needs = true;
        }
        return;
      }
      if ((ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) && parent.initializer === node) return;
      needs = true;
    });
    if (needs && !satisfied) {
      forEachDescendant(h.fn.body, (node) => {
        if (satisfied || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
        if (!localFns.has(node.expression.text)) return;
        if (node.arguments.some((a) => ts.isIdentifier(a) && requestNames.has(a.text)) && localHasCapped(node.expression.text, new Set())) {
          satisfied = true;
        }
      });
    }
    if (needs && !satisfied) {
      push(`${h.method}: uses ${h.params[0] ?? 'the request'} without readJsonCapped or readBodyCapped`);
    }
  }

  return problems;
}
