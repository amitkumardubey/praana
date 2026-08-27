/**
 * In-session setup overlay — reuses the standalone SetupWizard body.
 */
import { SetupWizard } from "../setup-wizard.js";
import type { SetupResult } from "../../../setup/types.js";
import { OverlayFrame } from "./frame.js";

export interface SetupOverlayProps {
  onComplete: (result: SetupResult) => void;
  onCancel: () => void;
}

export function SetupOverlay(props: SetupOverlayProps) {
  return (
    <OverlayFrame width={64} maxHeight={Math.max(16, (process.stdout.rows ?? 24) - 4)}>
      <SetupWizard
        onDone={(result) => {
          if (!result.success) props.onCancel();
          else props.onComplete(result);
        }}
      />
    </OverlayFrame>
  );
}
