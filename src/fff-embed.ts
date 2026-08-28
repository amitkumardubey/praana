/**
 * Ensures `bun build --compile` embeds the platform fff native library.
 *
 * The bundler only packs `type: "file"` imports on statically reachable paths.
 * A runtime `import("@ff-labs/fff-bun")` from fff.ts is not enough — this module
 * must stay on the import chain from src/main.ts.
 *
 * Linux libc is supplied at compile time via FFF_LIBC (`"gnu"` default, `"musl"` for Alpine).
 */

declare const FFF_LIBC: string | undefined;

async function importFile(
  promise: Promise<{ default: string }>,
): Promise<string | null> {
  try {
    return (await promise).default;
  } catch {
    return null;
  }
}

async function embedFffNative(): Promise<string | null> {
  if (process.platform === "darwin") {
    return importFile(
      import(`@ff-labs/fff-bin-darwin-${process.arch}/libfff_c.dylib`, {
        with: { type: "file" },
      }),
    );
  }

  if (process.platform === "win32") {
    return importFile(
      import(`@ff-labs/fff-bin-win32-${process.arch}/fff_c.dll`, {
        with: { type: "file" },
      }),
    );
  }

  if (process.platform === "linux") {
    const libc = typeof FFF_LIBC === "string" ? FFF_LIBC : "gnu";
    return importFile(
      import(`@ff-labs/fff-bin-linux-${process.arch}-${libc}/libfff_c.so`, {
        with: { type: "file" },
      }),
    );
  }

  return null;
}

/** Resolved once at module init so standalone binaries have a $bunfs native path. */
export const fffEmbeddedLibPath: string | null = await embedFffNative();
