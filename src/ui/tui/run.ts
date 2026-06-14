import React from "react";
import { render } from "ink";
import type { UiScreenMode } from "../../types.js";
import type { AppController, StartupInfo } from "../../app-controller.js";
import {
  formatSessionEndSummary,
  formatSessionEpilogue,
} from "../../app-banner.js";
import { formatTuiBootSummary } from "./tool-display.js";
import { TuiApp } from "./app.js";

export async function runTui(
  controller: AppController,
  info: StartupInfo,
  screen: UiScreenMode
): Promise<void> {
  const config = controller.config;
  const session = controller.session;
  const bootSummary = formatTuiBootSummary({
    sessionId: session.id,
    contextTokens: session.agentsContext
      ? Math.ceil(session.agentsContext.length / 4)
      : undefined,
    engineEnabled: session.isContextEngineEnabled(),
    skillCount: session.skills.length,
    memoryEnabled: session.memoryEnabled,
    incognito: session.isIncognito(),
  });

  const { waitUntilExit, unmount } = render(
    React.createElement(TuiApp, {
      controller,
      initialStatus: controller.getStatusBarInput(),
      recentLines: info.isResume ? [] : info.recentConversationLines,
      transcriptBootstrap: info.transcriptBootstrap,
      bootSummary,
      markdownRendering: config.ui.markdown_rendering,
      syntaxHighlighting: config.ui.syntax_highlighting,
      syntaxTheme: config.ui.syntax_theme,
    }),
    {
      alternateScreen: screen === "alternate",
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );

  await waitUntilExit();
  unmount();
  // Immediate feedback so the terminal isn't blank while shutdown runs.
  // stderr is used so piped/captured stdout stays clean.
  process.stderr.write("Saving session…\n");
  const { memory } = await controller.shutdown();
  if (memory === "background") {
    process.stderr.write("Memory save continuing in background…\n");
  }
  for (const line of formatSessionEpilogue(controller.session.id)) {
    console.log(line);
  }
  console.log(formatSessionEndSummary(controller.session));
  process.exit(0);
}
