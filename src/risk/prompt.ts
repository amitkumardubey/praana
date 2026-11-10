import { createInterface } from "node:readline";
import { writeUiStderr } from "../ui.js";

/** Confirmation line for the first fetch of a host. The detail already redacts the query and fragment. */
export function formatWebFetchPrompt(detail: string): string {
  return `Fetch ${detail}? [y/N]`;
}

export async function promptYesNo(question: string): Promise<boolean> {
  const inline = question.includes("[y/N]");
  if (!inline) writeUiStderr(question);
  const answer = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(inline ? `${question} ` : "Apply? [y/N] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
    rl.on("error", reject);
  });
  return answer === "y" || answer === "yes";
}
