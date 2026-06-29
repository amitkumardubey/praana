import { Buffer } from "../core/buffer.js";
import type { Terminal } from "../backend/types.js";
import { createFrame } from "../render/frame.js";
import { enterTerminal, leaveTerminal } from "./terminal-lifecycle.js";
import { runCmd, type Cmd } from "./cmd.js";
import type { ViewSpec } from "./view.js";

export interface Program<Model, Msg> {
  init(): [Model, Cmd<Msg>];
  update(model: Model, msg: Msg): [Model, Cmd<Msg>];
  view(model: Model): ViewSpec;
}

export interface ProgramOptions {
  /** Write ANSI output (default: process.stdout.write). */
  write?: (data: string) => void;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  onKey?: (send: (msg: any) => void) => () => void;
  alternateScreen?: boolean;
  fps?: number;
}

export interface RunResult {
  model: unknown;
}

/**
 * Run the program loop until a quit Cmd is returned.
 * For headless/test use, pass messages via `injectMessages`.
 */
export async function runProgram<Model, Msg>(
  program: Program<Model, Msg>,
  terminal: Terminal,
  options: ProgramOptions & {
    injectMessages?: Msg[];
    maxFrames?: number;
  } = {}
): Promise<RunResult> {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  const alt = options.alternateScreen ?? false;

  write(enterTerminal({ alternateScreen: alt }));

  let [model, cmd] = program.init();
  let running = true;
  const messageQueue: Msg[] = [...(options.injectMessages ?? [])];

  const send = (msg: Msg) => {
    messageQueue.push(msg);
  };

  const cleanup = options.onKey?.(send);

  // Resize handling: update backend dimensions on SIGWINCH so the next frame is
  // rebuilt and fully redrawn at the new size. backend.resize() resets its diff
  // baseline, and terminal.width/height delegate to the backend's live size.
  const onResize =
    options.onKey && process.stdout.isTTY
      ? () => {
          terminal.backend.resize?.(
            process.stdout.columns ?? terminal.width,
            process.stdout.rows ?? terminal.height
          );
        }
      : undefined;
  if (onResize) process.stdout.on("resize", onResize);

  try {
    let frames = 0;
    const maxFrames = options.maxFrames ?? Infinity;

    while (running && frames < maxFrames) {
      // Process queued messages
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!;
        [model, cmd] = program.update(model, msg);
        const cont = await runCmd(cmd, send);
        if (!cont) {
          running = false;
          break;
        }
      }
      if (!running) break;

      const viewSpec = program.view(model);
      const frame = createFrame(terminal.width, terminal.height);
      viewSpec.draw(frame);

      // Single render owner: the backend diffs against its own previous frame
      // and writes only the delta (empty when nothing changed). Diffing here as
      // well would emit every frame twice.
      terminal.backend.draw(frame.buffer);

      frames++;

      if (messageQueue.length === 0 && options.injectMessages) break;
      if (messageQueue.length === 0 && !options.onKey) break;

      await sleep(1000 / (options.fps ?? 30));
    }
  } finally {
    if (onResize) process.stdout.off("resize", onResize);
    cleanup?.();
    write(leaveTerminal({ alternateScreen: alt }));
  }

  return { model };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Single-frame render for tests. */
export function renderProgramFrame<Model, Msg>(
  program: Program<Model, Msg>,
  model: Model,
  terminal: Terminal
): Buffer {
  const viewSpec = program.view(model);
  const frame = createFrame(terminal.width, terminal.height);
  viewSpec.draw(frame);
  terminal.backend.draw(frame.buffer);
  return frame.buffer;
}
