/**
 * OpenTUI Solid JSX runtime registration for the praana CLI entry.
 *
 * Stock `@opentui/solid/preload` refuses to transform any path containing
 * `node_modules`. Global installs (`bun add -g`) live under
 * `.../node_modules/praana/src/...`, so Bun falls back to react/jsx-dev-runtime.
 * This helper registers the same Babel Solid transform scoped to this package
 * root only — works for local checkouts and global installs.
 */
import { plugin } from "bun";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a Bun onLoad filter that matches .tsx under `packageRoot` only. */
export function createPackageTsxFilter(packageRoot) {
  const rootPattern = escapeRegExp(packageRoot).replaceAll("/", "[/\\\\]");
  return new RegExp(`^${rootPattern}[/\\\\].*\\.[cm]?tsx(?:[?#].*)?$`);
}

async function loadSolidTransform() {
  const bunPluginPath = fileURLToPath(
    await import.meta.resolve("@opentui/solid/bun-plugin"),
  );
  const transformUrl = pathToFileURL(
    join(dirname(bunPluginPath), "solid-transform.js"),
  ).href;
  return import(transformUrl);
}

/**
 * Register Bun plugins that transform this package's TSX with @opentui/solid.
 * Idempotent across repeated calls in the same process.
 */
export async function registerPraanaSolidTransform(packageRoot) {
  const stateKey = Symbol.for("praana.opentui.solid.transform");
  const state = globalThis;
  if (state[stateKey]?.installed) return false;

  const { stripQueryAndHash, transformSolidSource } = await loadSolidTransform();
  const packageTsxFilter = createPackageTsxFilter(packageRoot);

  plugin({
    name: "praana-opentui-solid",
    setup(build) {
      build.onLoad(
        {
          filter:
            /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/,
        },
        async (args) => {
          const path = stripQueryAndHash(args.path).replace(
            "server.js",
            "solid.js",
          );
          return { contents: await Bun.file(path).text(), loader: "js" };
        },
      );
      build.onLoad(
        {
          filter:
            /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/,
        },
        async (args) => {
          const path = stripQueryAndHash(args.path).replace(
            "server.js",
            "store.js",
          );
          return { contents: await Bun.file(path).text(), loader: "js" };
        },
      );
      build.onLoad({ filter: packageTsxFilter }, async (args) => {
        const path = stripQueryAndHash(args.path);
        const code = await Bun.file(path).text();
        const contents = await transformSolidSource(code, {
          filename: path,
          moduleName: "@opentui/solid",
        });
        return { contents, loader: "js" };
      });
    },
  });

  state[stateKey] = { installed: true };
  return true;
}
