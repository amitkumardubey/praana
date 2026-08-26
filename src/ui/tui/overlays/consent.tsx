/**
 * In-session HuggingFace embedder download consent.
 */
import { DownloadConsentApp } from "../download-consent.js";
import { TRANSFORMERS_MODEL_PRESETS } from "../../../memory/transformers-models.js";
import { OverlayFrame } from "./frame.js";

export interface ConsentOverlayProps {
  onComplete: (proceed: boolean) => void;
}

export function ConsentOverlay(props: ConsentOverlayProps) {
  return (
    <OverlayFrame width={64}>
      <DownloadConsentApp
        modelId={TRANSFORMERS_MODEL_PRESETS.default.id}
        embedded
        onDone={props.onComplete}
      />
    </OverlayFrame>
  );
}
