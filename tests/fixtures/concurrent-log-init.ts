import { initAppLogFile } from "../../src/logger.js";

async function main(): Promise<void> {
  // Clear the test runner's env marker so initAppLogFile actually writes files.
  delete process.env.VITEST;
  await initAppLogFile();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
