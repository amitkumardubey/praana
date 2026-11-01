/**
 * Force the client build of solid-js for OpenTUI Solid tests.
 *
 * Under Bun's "bun"/"node" conditions, `solid-js` resolves to its SSR build
 * (`dist/server.js`). OpenTUI's Solid renderer expects the client runtime:
 * the SSR build materialises `<Show when={false}>` as an empty text node that
 * the reconciler rejects with "Orphan text", and it breaks the KeymapProvider
 * context wiring (useKeymap finds no provider). This plugin swaps every load
 * of `solid-js/dist/server.js` for the client `dist/solid.js` so the whole
 * module graph shares one client runtime.
 *
 * This module is listed in bunfig.toml `preload` so it registers before any
 * test module (and its solid-js imports) is loaded; registering from inside a
 * test file is too late because Bun resolves the module graph before
 * executing it. It only activates under `bun test` (NODE_ENV === "test"), so
 * normal app runs are unaffected.
 */
import { plugin } from "bun";

if (process.env.NODE_ENV === "test") {
  plugin({
    name: "solid-client-build",
    setup(build) {
      build.onLoad(
        { filter: /node_modules[\\/]solid-js[\\/]dist[\\/]server\.js$/ },
        async (args) => {
          const clientPath = args.path.replace("server.js", "solid.js");
          const file = Bun.file(clientPath);
          const code = await file.text();
          return { contents: code, loader: "js" };
        },
      );
    },
  });
}
