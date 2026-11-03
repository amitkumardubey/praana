import path from "node:path";

export function normalizeRoot(p: string, flavor: typeof path = path): string {
  const root = flavor.parse(p).root;
  const trimmed = p.replace(flavor.sep === "\\" ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.length < root.length ? root : trimmed || p;
}

export function pathInRoot(absPath: string, root: string, flavor: typeof path = path): boolean {
  if (!flavor.isAbsolute(absPath) || !flavor.isAbsolute(root)) {
    return normalizeRoot(absPath, flavor) === normalizeRoot(root, flavor);
  }
  const relative = flavor.relative(root, absPath);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative));
}
