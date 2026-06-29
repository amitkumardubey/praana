export type Cmd<Msg> =
  | { tag: "none" }
  | { tag: "batch"; cmds: Cmd<Msg>[] }
  | { tag: "task"; run: (send: (msg: Msg) => void) => void | Promise<void> }
  | { tag: "quit" };

export function none<Msg>(): Cmd<Msg> {
  return { tag: "none" };
}

export function quit<Msg>(): Cmd<Msg> {
  return { tag: "quit" };
}

export function batch<Msg>(cmds: Cmd<Msg>[]): Cmd<Msg> {
  const flat = cmds.filter((c) => c.tag !== "none");
  if (flat.length === 0) return none();
  if (flat.length === 1) return flat[0]!;
  return { tag: "batch", cmds: flat };
}

export function task<Msg>(
  run: (send: (msg: Msg) => void) => void | Promise<void>
): Cmd<Msg> {
  return { tag: "task", run };
}

export async function runCmd<Msg>(
  cmd: Cmd<Msg>,
  send: (msg: Msg) => void
): Promise<boolean> {
  switch (cmd.tag) {
    case "none":
      return true;
    case "quit":
      return false;
    case "batch":
      for (const c of cmd.cmds) {
        const cont = await runCmd(c, send);
        if (!cont) return false;
      }
      return true;
    case "task":
      await cmd.run(send);
      return true;
  }
}
