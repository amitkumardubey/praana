/**
 * Join a provider base URL with a path and optional query string.
 * Query params are always applied after the path so Azure-style
 * `?api-version=` cannot swallow `/chat/completions`.
 */
export function joinUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const root = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${root}${suffix}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  return url.toString();
}
