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
  for (const [name, flavor, root, separator] of [
    ["POSIX", path.posix, "/a/b", "/"],
    ["Windows", path.win32, "C:\\a\\b", "\\"],
    ["Windows forward slash", path.win32, "C:/a/b", "/"],
  ] as const) {
    for (const child of ["..hidden", "...x"]) {
      test(`${name} contains ${child}`, () => {
        expect(pathInRoot(`${root}${separator}${child}`, root, flavor)).toBe(true);
      });
    }
    for (const escape of ["..", `..${separator}x`]) {
      test(`${name} excludes ${escape}`, () => {
        expect(pathInRoot(`${root}${separator}${escape}`, root, flavor)).toBe(false);
      });
    }
  }

  for (const [name, flavor] of [["POSIX", path.posix], ["Windows", path.win32]] as const) {
    test(`${name} does not resolve relative arguments against cwd`, () => {
      const cwd = flavor.resolve(process.cwd());
      expect(pathInRoot("rel/x", cwd, flavor)).toBe(false);
      expect(pathInRoot(flavor.join(cwd, "rel/x"), "rel", flavor)).toBe(false);
    });
    test(`${name} compares normalized relative arguments for equality`, () => {
      expect(pathInRoot("rel/x", "rel/x", flavor)).toBe(true);
      expect(pathInRoot(`rel/x${flavor.sep}`, "rel/x", flavor)).toBe(true);
      expect(pathInRoot("rel/x", "rel/y", flavor)).toBe(false);
    });
  }

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
