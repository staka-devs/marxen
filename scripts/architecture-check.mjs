/** Verify the five product layers and documentation on handwritten named operations. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const LAYERS = ["domain", "application", "contracts", "infrastructure", "presentation"];
const ALLOWED = {
  contracts: new Set(["contracts"]),
  domain: new Set(["domain", "contracts"]),
  application: new Set(["application", "domain", "contracts"]),
  infrastructure: new Set(["infrastructure", "application", "domain", "contracts"]),
  presentation: new Set(["presentation", "application", "domain", "contracts"]),
};
const EFFECT_PACKAGES = /^(?:react(?:-dom)?|@tauri-apps\/|@codemirror\/|leaflet$|three$)/;
const RUST_EFFECTS = new Set(["tauri", "tauri_plugin_dialog", "reqwest", "keyring", "arboard", "clipboard_win", "windows_sys", "objc2_app_kit", "objc2_foundation"]);
const DOM_GLOBALS = new Set(["window", "document", "navigator", "localStorage", "sessionStorage", "FileReader", "MutationObserver", "ResizeObserver", "getComputedStyle", "Document", "HTMLElement", "Element", "Node", "Range", "Selection", "DOMParser", "XMLSerializer", "KeyboardEvent", "MouseEvent"]);

/** Normalize paths so layer checks behave identically on Windows and POSIX hosts. */
function portable(path) {
  return path.split(sep).join("/").replaceAll("\\", "/");
}

/** Identify production layer ownership while leaving explicit composition and test roots outside it. */
export function layerOf(path) {
  const normalized = portable(path);
  const match = normalized.match(/^(?:src|src-tauri\/src)\/([^/]+)\//);
  return match && LAYERS.includes(match[1]) ? match[1] : null;
}

/** Exclude tests from dependency restrictions; their helpers still require documentation. */
function isTest(path) {
  return /(?:^|\/)(?:tests|test)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(portable(path));
}

/** Collect handwritten source files without traversing downloaded resources or build outputs. */
function sourceFiles(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(root, path);
    return /\.(?:rs|[cm]?[jt]sx?)$/.test(path) ? [path] : [];
  });
}

/** Recognize generated IPC bindings by their explicit generator header, not their directory. */
function generated(source) {
  return /^\/\/ Generated from src-tauri\//.test(source);
}

/** Reject empty and placeholder documentation while allowing concise Japanese or English descriptions. */
function usefulDoc(text) {
  const content = text.replace(/\/\*\*?|\*\/|^\s*\*|^\s*\/\/\//gm, "").trim();
  return content.length > 3 && !/^(?:TODO|FIXME|TBD|undocumented)[.!\s]*$/i.test(content);
}

/** Return direct or declaration-level JSDoc for variable-bound functions and members. */
function jsdocFor(node, sourceFile) {
  const candidates = [node];
  if (ts.isVariableDeclaration(node)) candidates.push(node.parent, node.parent.parent);
  for (const candidate of candidates) {
    const docs = candidate.jsDoc ?? [];
    if (docs.some(doc => usefulDoc(doc.getText(sourceFile)))) return true;
    const comments = ts.getLeadingCommentRanges(sourceFile.text, candidate.getFullStart()) ?? [];
    if (comments.some(comment => {
      const text = sourceFile.text.slice(comment.pos, comment.end);
      return text.startsWith("/**") && usefulDoc(text);
    })) return true;
  }
  return false;
}

/** Detect functions held by a binding, including callbacks wrapped by React hooks or test factories. */
function functionInitializer(node) {
  if (!node) return false;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) return functionInitializer(node.expression);
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : "";
  return ["useCallback", "forwardRef", "memo", "fn"].includes(callee) && node.arguments.some(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
}

/** Find named implementations and callable declarations, excluding anonymous inline callbacks. */
function operationName(node, sourceFile) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "default function";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return node.name.getText(sourceFile);
  if (ts.isVariableDeclaration(node) && functionInitializer(node.initializer)) return node.name.getText(sourceFile);
  if ((ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) && functionInitializer(node.initializer)) return node.name.getText(sourceFile);
  if (ts.isPropertySignature(node) && node.type && ts.isFunctionTypeNode(node.type)) return node.name.getText(sourceFile);
  if (ts.isTypeAliasDeclaration(node) && ts.isFunctionTypeNode(node.type)) return node.name.text;
  return null;
}

/** Resolve one relative or aliased TypeScript import to its source layer. */
function importTarget(specifier, path, root, compilerOptions) {
  const result = ts.resolveModuleName(specifier, resolve(root, path), compilerOptions, ts.sys).resolvedModule;
  return result ? portable(relative(root, result.resolvedFileName)) : null;
}

/** Report a forbidden import at its original location rather than at an adapter facade. */
function checkEdge(path, line, layer, target, issues) {
  if (target && !ALLOWED[layer].has(target)) issues.push({ path, line, rule: "dependency", detail: `${layer} must not depend on ${target}` });
}

/** Inspect TypeScript declarations, import/export edges, and references to actual browser globals. */
export function inspectTypeScript(path, source, options = {}) {
  const { root = process.cwd(), compilerOptions = {}, checker = null, sourceFile: existing = null } = options;
  const sourceFile = existing ?? ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const issues = [];
  let methods = 0;
  let documented = 0;
  const layer = !isTest(path) ? layerOf(path) : null;
  const inner = layer === "domain" || layer === "application" || layer === "contracts";
  /** Inspect one AST node while preserving declaration documentation and resolved global identity. */
  function visit(node) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const name = operationName(node, sourceFile);
    if (name) {
      methods += 1;
      if (jsdocFor(node, sourceFile)) documented += 1;
      else issues.push({ path, line, rule: "documentation", detail: `JSDoc required: ${name}` });
    }
    let imported = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imported = node.moduleSpecifier.text;
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imported = node.argument.literal.text;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) && ts.isStringLiteral(node.arguments[0])) imported = node.arguments[0].text;
    if (layer && imported) {
      if (inner && EFFECT_PACKAGES.test(imported)) issues.push({ path, line, rule: "effect", detail: `${layer} imports platform/UI package ${imported}` });
      const target = importTarget(imported, path, root, compilerOptions);
      checkEdge(path, line, layer, target && layerOf(target), issues);
      if (target?.startsWith("src/") && !layerOf(target) && !isTest(target) && !target.endsWith(".d.ts")) issues.push({ path, line, rule: "dependency", detail: `layer imports unclassified/composition module ${target}` });
    }
    if (inner && checker && ts.isIdentifier(node) && DOM_GLOBALS.has(node.text)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol?.declarations?.some(declaration => /(?:^|[\\/])lib\.dom\.d\.ts$/.test(declaration.getSourceFile().fileName))) issues.push({ path, line, rule: "effect", detail: `${layer} accesses browser global ${node.text}` });
    }
    ts.forEachChild(node, visit);
  }
  if (!generated(source)) visit(sourceFile);
  return { methods, documented, issues };
}

/** Tokenize Rust code while retaining outer documentation and skipping nested comments and strings. */
export function rustTokens(source) {
  const tokens = [];
  let offset = 0;
  let line = 1;
  /** Consume a source span and maintain accurate diagnostic line numbers. */
  function advance(end) {
    line += source.slice(offset, end).split("\n").length - 1;
    offset = end;
  }
  while (offset < source.length) {
    const rest = source.slice(offset);
    if (/^\s/.test(rest)) { advance(offset + 1); continue; }
    if (rest.startsWith("//")) {
      const end = source.indexOf("\n", offset);
      const text = source.slice(offset, end < 0 ? source.length : end);
      if (text.startsWith("///") && !text.startsWith("////")) tokens.push({ value: text, kind: "doc", line, offset });
      advance(end < 0 ? source.length : end);
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      let end = offset + 2;
      while (end < source.length && depth) {
        if (source.startsWith("/*", end)) { depth += 1; end += 2; }
        else if (source.startsWith("*/", end)) { depth -= 1; end += 2; }
        else end += 1;
      }
      if (rest.startsWith("/**") && !rest.startsWith("/***")) tokens.push({ value: source.slice(offset, end), kind: "doc", line, offset });
      advance(end);
      continue;
    }
    const raw = rest.match(/^(?:b|c)?r(#{0,255})"/);
    if (raw) {
      const close = source.indexOf(`"${raw[1]}`, offset + raw[0].length);
      advance(close < 0 ? source.length : close + raw[1].length + 1);
      continue;
    }
    if (rest[0] === '"') {
      let end = offset + 1;
      while (end < source.length) {
        if (source[end] === "\\") end += 2;
        else if (source[end++] === '"') break;
      }
      advance(end);
      continue;
    }
    const character = rest.match(/^'(?:\\(?:x[\da-fA-F]{2}|u\{[\da-fA-F_]+\}|.)|[^'\\\r\n])'/u);
    if (character) { advance(offset + character[0].length); continue; }
    const identifier = rest.match(/^(?:r#)?(?:_|\p{XID_Start})(?:_|\p{XID_Continue})*/u);
    const value = identifier?.[0] ?? (rest.startsWith("::") ? "::" : rest[0]);
    tokens.push({ value, kind: identifier ? "identifier" : "symbol", line, offset });
    advance(offset + value.length);
  }
  return tokens;
}

/** Expand grouped Rust use trees so braces and aliases cannot conceal forbidden edges. */
function rustUsePaths(tokens, start) {
  const paths = [];
  let index = start;
  /** Expand one use tree with its inherited namespace prefix. */
  function tree(prefix) {
    const path = [...prefix];
    while (index < tokens.length) {
      const token = tokens[index++].value;
      if (token === "{") {
        while (index < tokens.length && tokens[index].value !== "}") {
          tree(path);
          if (tokens[index]?.value === ",") index += 1;
          else if (tokens[index]?.value !== "}") break;
        }
        if (tokens[index]?.value === "}") index += 1;
        return;
      }
      if (token === "::") continue;
      path.push(token);
      if (tokens[index]?.value === "::") { index += 1; continue; }
      paths.push(path);
      if (tokens[index]?.value === "as") index += 2;
      return;
    }
  }
  tree([]);
  return paths;
}

/** Resolve crate/self/super-qualified Rust namespaces against the current source module. */
function rustNamespace(path, parts) {
  const module = portable(path).replace(/^src-tauri\/src\//, "").replace(/\.rs$/, "").split("/");
  if (module.at(-1) === "mod") module.pop();
  if (parts[0] === "crate") return parts.slice(1);
  if (parts[0] === "self") return [...module, ...parts.slice(1)];
  if (parts[0] === "super") {
    let index = 0;
    while (parts[index] === "super") { module.pop(); index += 1; }
    return [...module, ...parts.slice(index)];
  }
  return null;
}

/** Locate outer Rustdoc adjacent to a function, including intervening attributes and visibility. */
function rustDocumentation(tokens, index) {
  const docs = [];
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const token = tokens[cursor];
    if ([";", "{", "}"].includes(token.value)) break;
    if (token.kind === "doc") docs.unshift(token.value);
  }
  return usefulDoc(docs.join("\n"));
}

/** Mark explicit Rust test-only item bodies; documentation still applies inside these fixtures. */
function rustTestMask(tokens) {
  const mask = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "#" || tokens[index + 1]?.value !== "[") continue;
    let end = index + 2;
    let brackets = 1;
    while (end < tokens.length && brackets) {
      if (tokens[end].value === "[") brackets += 1;
      if (tokens[end].value === "]") brackets -= 1;
      end += 1;
    }
    const attribute = tokens.slice(index + 2, end - 1).map(token => token.value).join("");
    const testOnly = attribute === "test" || attribute.endsWith("::test") || attribute === "cfg(test)" || (/^cfg\(all\(/.test(attribute) && /(?:[(,])test(?:[),])/.test(attribute) && !attribute.includes("not("));
    if (!testOnly) continue;
    let body = end;
    while (body < tokens.length && !["{", ";"].includes(tokens[body].value)) body += 1;
    let finish = body + 1;
    if (tokens[body]?.value === "{") {
      let braces = 1;
      while (finish < tokens.length && braces) {
        if (tokens[finish].value === "{") braces += 1;
        if (tokens[finish].value === "}") braces -= 1;
        finish += 1;
      }
    }
    for (let cursor = end; cursor < finish; cursor += 1) mask.add(cursor);
  }
  return mask;
}

/** Check Rust named functions, qualified dependencies, and effectful standard/external modules. */
export function inspectRust(path, source) {
  const tokens = rustTokens(source);
  const testTokens = rustTestMask(tokens);
  const issues = [];
  const layer = !isTest(path) ? layerOf(path) : null;
  let methods = 0;
  let documented = 0;
  const seen = new Set();
  /** Classify one Rust namespace and avoid duplicate diagnostics from an expanded use tree. */
  function dependency(parts, token) {
    if (!layer) return;
    const key = `${token.line}:${parts.join("::")}`;
    if (seen.has(key)) return;
    seen.add(key);
    const target = rustNamespace(path, parts);
    if (target) {
      checkEdge(path, token.line, layer, LAYERS.includes(target[0]) ? target[0] : null, issues);
      if (!LAYERS.includes(target[0])) issues.push({ path, line: token.line, rule: "dependency", detail: `layer references unclassified/composition namespace ${parts.join("::")}` });
    }
    if (["domain", "application", "contracts"].includes(layer) && (RUST_EFFECTS.has(parts[0]) || (parts[0] === "std" && ["fs", "io", "net", "process", "env"].includes(parts[1])) || (parts[0] === "tokio" && ["fs", "net", "process"].includes(parts[1])))) issues.push({ path, line: token.line, rule: "effect", detail: `${layer} accesses platform module ${parts.join("::")}` });
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "doc") continue;
    if (token.value === "fn" && tokens[index + 1]?.kind === "identifier") {
      methods += 1;
      if (rustDocumentation(tokens, index)) documented += 1;
      else issues.push({ path, line: token.line, rule: "documentation", detail: `Rustdoc required: ${tokens[index + 1].value}` });
    }
    if (token.value === "use" && !testTokens.has(index)) {
      for (const parts of rustUsePaths(tokens, index + 1)) dependency(parts, token);
    }
    if (!testTokens.has(index) && tokens[index + 1]?.value === "::" && tokens[index - 1]?.value !== "::") {
      const parts = [token.value];
      let cursor = index + 1;
      while (tokens[cursor]?.value === "::" && tokens[cursor + 1]?.kind === "identifier") {
        parts.push(tokens[cursor + 1].value);
        cursor += 2;
      }
      if (parts.length > 1 && !["{", "*"].includes(tokens[cursor]?.value)) dependency(parts, token);
    }
  }
  return { methods, documented, issues };
}

/** Require every production implementation to live in a layer or the small explicit composition root. */
function placement(path) {
  if (isTest(path) || layerOf(path)) return null;
  if (path.startsWith("src/") && !["src/App.tsx", "src/main.tsx", "src/composition.ts", "src/composition.tsx"].includes(path) && !path.startsWith("src/composition/") && !path.endsWith(".d.ts")) return "production TypeScript must belong to one of the five layers";
  if (path.startsWith("src-tauri/src/") && !["src-tauri/src/lib.rs", "src-tauri/src/main.rs"].includes(path) && !path.startsWith("src-tauri/src/bin/")) return "production Rust must belong to one of the five layers";
  return null;
}

/** Audit real repository source using TypeScript symbol resolution and Rust lexical inspection. */
export function auditRepository(root) {
  const files = ["src", "src-tauri/src", "src-tauri/tests", "scripts", "tests"].flatMap(directory => sourceFiles(root, directory));
  files.push("src-tauri/build.rs");
  files.push(...readdirSync(root).filter(name => /^(?:vite(?:\.live)?|vitest|playwright(?:\.live)?)\.config\.ts$/.test(name)));
  const config = ts.readConfigFile(resolve(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(files.filter(path => /\.[jt]sx?$/.test(path)).map(path => resolve(root, path)), { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const issues = [];
  let methods = 0;
  let documented = 0;
  for (const path of files.sort()) {
    const source = readFileSync(resolve(root, path), "utf8");
    const location = placement(path);
    if (location) issues.push({ path, line: 1, rule: "placement", detail: location });
    const result = extname(path) === ".rs" ? inspectRust(path, source) : inspectTypeScript(path, source, { root, compilerOptions: parsed.options, checker, sourceFile: program.getSourceFile(resolve(root, path)) });
    methods += result.methods;
    documented += result.documented;
    issues.push(...result.issues);
  }
  for (const base of ["src", "src-tauri/src"]) {
    const directories = new Set(readdirSync(resolve(root, base), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
    for (const layer of LAYERS) if (!directories.has(layer)) issues.push({ path: base, line: 1, rule: "placement", detail: `missing layer directory ${layer}` });
  }
  return { files: files.length, methods, documented, issues };
}

/** Print bounded diagnostics and return a failing exit code when any architecture rule is broken. */
function main() {
  const rootIndex = process.argv.indexOf("--root");
  if (rootIndex >= 0 && (!process.argv[rootIndex + 1] || process.argv[rootIndex + 1].startsWith("--"))) throw new Error("--root requires a checkout path");
  const root = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = auditRepository(root);
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Architecture: ${result.files} files, ${result.documented}/${result.methods} named operations documented, ${result.issues.length} violations`);
    for (const issue of result.issues.slice(0, 60)) console.error(`${issue.path}:${issue.line} [${issue.rule}] ${issue.detail}`);
    if (result.issues.length > 60) console.error(`${result.issues.length - 60} further diagnostics; use --json for the full result.`);
  }
  if (result.issues.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
