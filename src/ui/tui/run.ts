import React from "react";
import { render } from "ink";
import type { UiScreenMode } from "../../types.js";
import type { AppController, StartupInfo } from "../../app-controller.js";
import { formatSessionEndSummary } from "../../app-banner.js";
import { TuiApp } from "./app.js";

export async function runTui(
  controller: AppController,
  info: StartupInfo,
  screen: UiScreenMode
): Promise<void> {
  const { waitUntilExit, unmount } = render(
    React.createElement(TuiApp, {
      controller,
      initialStatus: controller.getStatusBarInput(),
      recentLines: info.recentConversationLines,
    }),
    {
      alternateScreen: screen === "alternate",
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );

  await waitUntilExit();
  unmount();
  await controller.shutdown();
  console.log(formatSessionEndSummary(controller.session));
}
