import * as readline from "node:readline";

/** Return true only when both stdin and stdout are attached to a TTY. */
export function isInteractiveTerminal(): boolean {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask a readline prompt and return the trimmed answer as a promise. */
export function askQuestion(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  rl.question(prompt, (answer) => {
    resolve(answer.trim());
  });
  return promise;
}
