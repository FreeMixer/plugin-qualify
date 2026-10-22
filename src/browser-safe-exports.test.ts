// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Pau Aliagas <linuxnow@gmail.com>
/**
 * Every public subpath a browser bundles imports no Node built-in, directly or through any module
 * it reaches (#134). openmixer's web-ui bundles `@freemixer/catalog` for the browser, and the
 * catalog re-exports `./rating`, `./declarations` and `./hosting-suitability`; one `node:` import
 * anywhere below them and the static build fails (`fileURLToPath is not exported by
 * __vite-browser-external`), while the dev server, which externalizes lazily, hides it.
 *
 * The walk reads the sources each subpath's `default` condition names, with the TypeScript parser:
 * every runtime import, re-export and dynamic `import()`, relative ones followed into this package
 * and bare ones into the dependency's own `exports`. Type-only imports are erased and not followed.
 * The subpaths that are Node by design are named below with the reason; any other subpath is held
 * to the rule.
 */
import { existsSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type ExportTarget = string | { readonly [condition: string]: ExportTarget } | null;
const PACKAGE = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as { exports: Record<string, ExportTarget> };

/** The subpaths that run on Node by design, with the reason; nothing a browser bundles. */
const NODE_SUBPATHS: Readonly<Record<string, string>> = {
  ".": "the whole tool: the CLI, the plugin loaders, the probe runner and the tool paths",
  "./measurement": "reads the measuring host's own provenance (node:os, /proc) and writes documents (cli.ts)",
  "./tools/hosting-sweep.mjs": "the hosting sweep, a Node script",
  "./tools/lv2-measure.mjs": "the LV2 measurer's driver, a Node script",
  "./package.json": "data, not a module",
  "./fixtures/*": "data files, not modules",
};

/** The target a condition map resolves to for a bundler: `import`, then `default`. */
function conditionTarget(target: ExportTarget, conditions: readonly string[]): string | undefined {
  if (target === null) return undefined;
  if (typeof target === "string") return target;
  for (const c of conditions) {
    if (c in target) {
      const t = conditionTarget(target[c]!, conditions);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

/** A bare specifier resolved through its package's own `exports` (the `import` condition), from this package's node_modules. */
function resolveBare(spec: string): string {
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  const sub = "." + spec.slice(name.length);
  const root = join(PKG, "node_modules", name);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports?: Record<string, ExportTarget>; main?: string };
  const target = pkg.exports === undefined ? (sub === "." ? (pkg.main ?? "index.js") : sub) : conditionTarget(pkg.exports[sub] ?? null, ["import", "default"]);
  if (target === undefined) throw new Error(`${spec}: no import target in its package's exports`);
  return join(root, target);
}

/** This package's source for a relative specifier: `./x.js` is `./x.ts` where the TypeScript source exists. */
function resolveRelative(from: string, spec: string): string {
  const path = resolve(dirname(from), spec);
  const asTs = path.replace(/\.js$/, ".ts");
  return asTs !== path && existsSync(asTs) ? asTs : path;
}

/** True when an import or export clause is erased by the compiler: type-only, or every named element is. */
function typeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined) return false; // a side-effect import
    if (clause.isTypeOnly) return true;
    if (clause.name !== undefined) return false;
    const bindings = clause.namedBindings;
    return bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
}

/** Every specifier a module loads at run time. */
function runtimeSpecifiers(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier) && !typeOnly(node)) out.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      if (!node.isTypeOnly && ts.isStringLiteral(e)) out.push(e.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      out.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : "<computed import()>");
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** One Node built-in a subpath reaches, with the chain of modules that reaches it. */
interface NodeImport {
  readonly builtin: string;
  readonly chain: readonly string[];
}

/** Walks the import graph from `entry`; `read` supplies a module's text (a test substitutes one). */
function nodeImportsReachedFrom(entry: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): NodeImport[] {
  const found: NodeImport[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: readonly string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(PKG, file)];
    for (const spec of runtimeSpecifiers(file, read(file))) {
      if (spec.startsWith("node:") || isBuiltin(spec) || spec === "<computed import()>") found.push({ builtin: spec, chain: here });
      else if (spec.startsWith(".") || spec.startsWith("/")) walk(resolveRelative(file, spec), here);
      else if (!spec.startsWith("data:")) walk(resolveBare(spec), here);
    }
  };
  walk(entry, []);
  return found;
}

/** Every public subpath a browser may bundle, with its source entry (the `default` condition). */
function browserSubpaths(): [string, string][] {
  return Object.entries(PACKAGE.exports)
    .filter(([sub]) => !(sub in NODE_SUBPATHS))
    .map(([sub, target]) => {
      const t = conditionTarget(target, ["default"]);
      if (t === undefined) throw new Error(`${sub}: no default (source) condition to walk`);
      return [sub, join(PKG, t)];
    });
}

const describeFound = (f: readonly NodeImport[]): string[] => f.map((x) => `${x.builtin} via ${x.chain.join(" -> ")}`);

describe("every browser-reachable public subpath imports no Node built-in (#134)", () => {
  const subpaths = browserSubpaths();

  it("the browser subpaths include the ones openmixer's catalog bundles", () => {
    const names = subpaths.map(([s]) => s);
    for (const s of ["./rating", "./declarations", "./hosting-suitability", "./host-profiles"]) expect(names).toContain(s);
  });

  it("every subpath held to be Node by design is still a public subpath: an exclusion nothing uses is a hole", () => {
    for (const sub of Object.keys(NODE_SUBPATHS)) expect(Object.keys(PACKAGE.exports)).toContain(sub);
  });

  it.each(subpaths)("%s reaches no node: module", (_sub, entry) => {
    expect(describeFound(nodeImportsReachedFrom(entry))).toEqual([]);
  });

  it("the walk sees a Node subpath's built-ins: positive control", () => {
    const entry = join(PKG, conditionTarget(PACKAGE.exports["."]!, ["default"])!);
    expect(nodeImportsReachedFrom(entry).map((x) => x.builtin)).toContain("node:child_process");
  });

  it("sabotage: `import \"node:fs\"` put back into hosting-codes.ts turns the browser subpaths that reach it red", () => {
    const hostingCodes = join(PKG, "src/hosting-codes.ts");
    const sabotaged = (p: string): string => (p === hostingCodes ? `import "node:fs";\n${readFileSync(p, "utf8")}` : readFileSync(p, "utf8"));
    const red = subpaths.filter(([, entry]) => nodeImportsReachedFrom(entry, sabotaged).length > 0).map(([s]) => s);
    expect(red).toContain("./hosting-suitability");
    const [, entry] = subpaths.find(([s]) => s === "./hosting-suitability")!;
    expect(describeFound(nodeImportsReachedFrom(entry, sabotaged))).toContain("node:fs via src/hosting-suitability.ts -> src/hosting-codes.ts");
  });

  it("a type-only import is erased and not followed; a named import that keeps a value is", () => {
    expect(runtimeSpecifiers("a.ts", 'import type { Stats } from "node:fs";\nimport { type Dirent } from "node:fs";')).toEqual([]);
    expect(runtimeSpecifiers("a.ts", 'import { type Dirent, readFileSync } from "node:fs";')).toEqual(["node:fs"]);
    expect(runtimeSpecifiers("a.ts", 'export * from "./x.js";\nconst m = await import("node:os");')).toEqual(["./x.js", "node:os"]);
  });
});
