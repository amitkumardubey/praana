import { createInterface } from "node:readline";
import { writeUiStderr } from "../ui.js";

export async function promptYesNo(question: string): Promise<boolean> {
  writeUiStderr(question);
  const answer = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question("Apply? [y/N] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase());
    });
    rl.on("error", reject);
  });
  return answer === "y" || answer === "yes";
}
