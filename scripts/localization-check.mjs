import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind } from "typescript/unstable/ast";

process.env.GOMAXPROCS ??= "2";
process.env.GOMEMLIMIT ??= "512MiB";
const source = readFileSync("src/contracts/localization-messages.ts", "utf8");

/** Read the literal JSON object used for a base catalog, without evaluating source code. */
function readCatalog(name, tail) {
  const match = source.match(new RegExp(`export const ${name} = (\\{[\\s\\S]*?\\n\\}) ${tail};`));
  if (!match) throw new Error(`Catalog declaration missing: ${name}`);
  return JSON.parse(match[1]);
}

/** Identify the complete interpolation contract for one message. */
function slots(message) {
  return [...new Set([...message.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]))].sort();
}

/** Enumerate product presentation files while excluding authored sample documents and tests. */
function presentationFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return presentationFiles(file);
    return /\.tsx?$/.test(file) && !/\.test\./.test(file) && !file.includes("source-sample") ? [file] : [];
  });
}

const japanese = readCatalog("japaneseMessages", "as const");
const english = readCatalog("englishMessages", "satisfies Record<keyof typeof japaneseMessages, string>");
const issues = [];
for (const key of new Set([...Object.keys(japanese), ...Object.keys(english)])) {
  for (const [language, catalog] of [["ja-JP", japanese], ["en-US", english]]) if (typeof catalog[key] !== "string" || !catalog[key].trim()) issues.push(`${language}: missing or empty ${key}`);
  if (typeof japanese[key] === "string" && typeof english[key] === "string" && JSON.stringify(slots(japanese[key])) !== JSON.stringify(slots(english[key]))) issues.push(`Interpolation mismatch: ${key}`);
}

const files = presentationFiles("src/presentation");
const api = new API({});
try {
  const snapshot = api.updateSnapshot({ openProjects: [resolve("tsconfig.json")], openFiles: files.map(file => resolve(file)) });
  const project = snapshot.getProjects()[0];
  for (const file of files) {
    const sourceFile = project.program.getSourceFile(resolve(file));
    /** Detect untranslated JSX labels and invalid literal translation calls at their source. */
    function inspect(node) {
      if (node.kind === SyntaxKind.JsxText && /[\u3040-\u30ff\u4e00-\u9fff]/.test(node.text)) issues.push(`${file}: untranslated JSX text ${node.text.trim()}`);
      if (node.kind === SyntaxKind.StringLiteral && node.parent.kind === SyntaxKind.JsxAttribute && /[\u3040-\u30ff\u4e00-\u9fff]/.test(node.text) && !["メモ/新規.md", "メモ/新名.md"].includes(node.text)) issues.push(`${file}: untranslated JSX attribute ${node.text}`);
      if (node.kind === SyntaxKind.CallExpression && node.expression.getText(sourceFile) === "t" && node.arguments[0]?.kind === SyntaxKind.StringLiteral) {
        const key = node.arguments[0].text;
        if (!(key in japanese)) issues.push(`${file}: unknown key ${key}`);
        else if (slots(japanese[key]).length > 0 && node.arguments.length < 2) issues.push(`${file}: missing interpolation values ${key}`);
      }
      node.forEachChild(inspect);
    }
    inspect(sourceFile);
  }
} finally { api.close(); }
console.log(`Localization: ${Object.keys(japanese).length} complete base keys, ${files.length} presentation files, ${issues.length} violations`);
for (const issue of issues.slice(0, 40)) console.error(issue);
if (issues.length) process.exitCode = 1;
