import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import ts from "typescript";

test("dangling .praana error is outside the lstat try block", async () => {
  const source = await fs.readFile(new URL("../src/file-memory/store.ts", import.meta.url), "utf8");
  const file = ts.createSourceFile("store.ts", source, ts.ScriptTarget.Latest, true);
  const danglingThrows: ts.ThrowStatement[] = [];
  function visit(node: ts.Node) {
    if (ts.isThrowStatement(node) && node.getText(file).includes("Dangling .praana symlink")) danglingThrows.push(node);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(danglingThrows).toHaveLength(1);
  const statement = danglingThrows[0]!;
  for (let ancestor: ts.Node | undefined = statement.parent; ancestor; ancestor = ancestor.parent) {
    if (!ts.isTryStatement(ancestor) || !ancestor.catchClause) continue;
    const guarded = ancestor.tryBlock;
    // A deliberate diagnostic must not be caught as though lstat itself failed.
    expect(statement.pos >= guarded.pos && statement.end <= guarded.end).toBe(false);
  }
});
