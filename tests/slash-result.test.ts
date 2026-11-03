/**
 * Pure geometry helpers for the slash-result overlay.
 *
 * The overlay frame is 18 rows tall at most and shrinks with the terminal:
 * maxHeight = min(18, max(8, termHeight - 6)) (same maths as OverlayFrame).
 * Inside the frame, 4 rows are chrome (top/bottom borders + padding) and an
 * extra hint row appears only while the content overflows. The scrollbox
 * height is derived from that so a 14-row terminal never clips the hint.
 */
import { describe, expect, it } from "bun:test";
import {
  computeSlashFrameMaxHeight,
  computeSlashScrollBoxHeight,
  isSlashScrollKey,
  SLASH_FRAME_CHROME_ROWS,
  SLASH_HINT_ROWS,
  SLASH_FRAME_MAX_HEIGHT,
} from "../src/ui/tui/overlays/slash-result.js";

describe("computeSlashFrameMaxHeight", () => {
  it("caps at 18 rows on tall terminals", () => {
    expect(computeSlashFrameMaxHeight(40)).toBe(SLASH_FRAME_MAX_HEIGHT);
    expect(computeSlashFrameMaxHeight(24)).toBe(SLASH_FRAME_MAX_HEIGHT);
  });

  it("shrinks with the terminal below 24 rows", () => {
    expect(computeSlashFrameMaxHeight(20)).toBe(14);
    expect(computeSlashFrameMaxHeight(14)).toBe(8);
    expect(computeSlashFrameMaxHeight(6)).toBe(8);
  });
});

describe("computeSlashScrollBoxHeight", () => {
  it("fills the frame minus chrome when overflowing on a 24-row terminal", () => {
    expect(computeSlashScrollBoxHeight(24, true)).toBe(
      SLASH_FRAME_MAX_HEIGHT - SLASH_FRAME_CHROME_ROWS - SLASH_HINT_ROWS,
    );
  });

  it("keeps the hint visible on a 14-row terminal", () => {
    const frame = computeSlashFrameMaxHeight(14);
    const scroll = computeSlashScrollBoxHeight(14, true);
    expect(scroll).toBe(frame - SLASH_FRAME_CHROME_ROWS - SLASH_HINT_ROWS);
    expect(scroll).toBe(3);
  });

  it("reserves the hint row only when overflowing", () => {
    expect(computeSlashScrollBoxHeight(24, false)).toBe(
      SLASH_FRAME_MAX_HEIGHT - SLASH_FRAME_CHROME_ROWS,
    );
    expect(computeSlashScrollBoxHeight(14, false)).toBe(4);
  });

  it("never returns a negative or zero height", () => {
    for (const h of [6, 8, 14, 24, 40, 100]) {
      expect(computeSlashScrollBoxHeight(h, true)).toBeGreaterThanOrEqual(1);
      expect(computeSlashScrollBoxHeight(h, false)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("isSlashScrollKey", () => {
  it("recognises scroll keys", () => {
    for (const k of ["up", "down", "pageup", "pagedown"]) {
      expect(isSlashScrollKey(k)).toBe(true);
    }
  });

  it("rejects non-scroll keys", () => {
    for (const k of ["enter", "escape", "space", "left", "right", "tab"]) {
      expect(isSlashScrollKey(k)).toBe(false);
    }
  });
});
