import path from "node:path";

export function normalizeRoot(p: string, flavor: typeof path = path): string {
  const root = flavor.parse(p).root;
  const trimmed = p.replace(flavor.sep === "\\" ? /[\\/]+$/ : /\/+$/, "");
  return trimmed.length < root.length ? root : trimmed || p;
}

export function pathInRoot(absPath: string, root: string, flavor: typeof path = path): boolean {
  const relative = flavor.relative(root, absPath);
  return relative === "" || (!relative.startsWith("..") && !flavor.isAbsolute(relative));
}
