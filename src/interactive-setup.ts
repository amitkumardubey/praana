import { isInteractiveTerminal } from "./terminal.js";
import { runSetupWizardTui } from "./ui/tui/setup-wizard.js";
import { runInteractiveSetupCli } from "./setup/setup-readline.js";
import type { SetupResult } from "./setup/types.js";

export type { SetupResult } from "./setup/types.js";
export { providerPageLines } from "./setup/provider-options.js";

/**
 * Run interactive provider setup when no API key is found.
 * Uses pi-tui when stdin/stdout are a TTY; falls back to readline otherwise.
 */
export async function runInteractiveSetup(cwd: string): Promise<SetupResult> {
  void cwd;
  if (isInteractiveTerminal()) {
    return runSetupWizardTui();
  }
  return runInteractiveSetupCli(cwd);
}
