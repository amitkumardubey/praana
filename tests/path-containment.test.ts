import { describe, expect, test } from "bun:test";
import path from "node:path";
import { pathInRoot, normalizeRoot } from "../src/path-containment.js";

const cases: Array<[string, typeof path, string, string, boolean]> = [
  ["Windows equal", path.win32, "C:\\work\\repo", "C:\\work\\repo", true],
  ["Windows child", path.win32, "C:\\work\\repo\\a.ts", "C:\\work\\repo", true],
  ["Windows nested child", path.win32, "C:\\work\\repo\\src\\a.ts", "C:\\work\\repo", true],
  ["Windows sibling prefix", path.win32, "C:\\work\\repo2", "C:\\work\\repo", false],
  ["Windows trailing separators", path.win32, "C:\\work\\repo\\src\\", "C:\\work\\repo\\", true],
  ["Windows mixed separators", path.win32, "C:/work\\repo/src/a.ts", "C:\\work/repo", true],
  ["Windows different case", path.win32, "c:\\WORK\\Repo\\a.ts", "C:\\work\\repo", true],
  ["Windows different drive", path.win32, "D:\\work\\repo\\a.ts", "C:\\work\\repo", false],
  ["Windows drive root", path.win32, "C:\\work\\a.ts", "C:\\", true],
  ["Windows drive root equality", path.win32, "C:\\", "c:/", true],
  ["Windows escape", path.win32, "C:\\work\\repo\\..\\outside", "C:\\work\\repo", false],
  ["UNC child", path.win32, "\\\\server\\share\\x\\a", "\\\\server\\share\\x", true],
  ["UNC share root", path.win32, "\\\\SERVER\\share\\x", "\\\\server\\share\\", true],
  ["UNC different share", path.win32, "\\\\server\\other\\x", "\\\\server\\share\\", false],
  ["POSIX equal", path.posix, "/a/b", "/a/b", true],
  ["POSIX child", path.posix, "/a/b/c", "/a/b", true],
  ["POSIX nested child", path.posix, "/a/b/c/d", "/a/b/", true],
  ["POSIX sibling prefix", path.posix, "/a/bc", "/a/b", false],
  ["POSIX escape", path.posix, "/a/b/../c", "/a/b", false],
  ["POSIX root", path.posix, "/a/b", "/", true],
];

describe("path containment", () => {
  for (const [name, flavor, candidate, root, expected] of cases) {
    test(name, () => {
      expect(pathInRoot(candidate, root, flavor)).toBe(expected);
    });
  }
  test("normalizes trailing separators without removing filesystem roots", () => {
    expect(normalizeRoot("C:\\work\\repo\\", path.win32)).toBe("C:\\work\\repo");
    expect(normalizeRoot("C:\\", path.win32)).toBe("C:\\");
    expect(normalizeRoot("/", path.posix)).toBe("/");
    expect(normalizeRoot("/a/b///", path.posix)).toBe("/a/b");
  });
});
