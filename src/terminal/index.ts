// Core
export { cell, emptyCell, cellsEqual, type Cell } from "./core/cell.js";
export {
  createStyle,
  styleFg,
  styleBg,
  styleAddModifier,
  patchStyle,
  styleToAnsi,
  RESET_ANSI,
  Modifier,
  type Style,
} from "./core/style.js";
export { createRect, rectInner, rectContains, type Rect } from "./core/rect.js";
export { Buffer } from "./core/buffer.js";
export {
  span,
  line,
  plainLine,
  strWidth,
  lineWidth,
  lineToPlain,
  type Span,
  type Line,
} from "./core/text.js";

// Layout
export {
  lengthConstraint,
  percentageConstraint,
  ratioConstraint,
  minConstraint,
  maxConstraint,
  fillConstraint,
  createLayout,
  type Constraint,
  type Layout,
  type LayoutDirection,
} from "./layout/constraint.js";
export { splitLayout } from "./layout/split.js";

// Widgets
export {
  renderWidget,
  renderStatefulWidget,
  type Widget,
  type WidgetRenderer,
  type StatefulWidget,
} from "./widgets/widget.js";
export { block, blockInner, renderBlock, type BlockConfig } from "./widgets/block.js";
export {
  paragraph,
  renderParagraph,
  wrapText,
  linesFromStrings,
  type ParagraphConfig,
} from "./widgets/paragraph.js";
export { clear, renderClear } from "./widgets/clear.js";

// Backend
export { createTerminal, type Terminal, type TerminalBackend } from "./backend/types.js";
export {
  createTestBackendState,
  createTestBackend,
  testBackendToString,
  bufferDiffToAnsi,
} from "./backend/test.js";

// Render
export {
  diffBuffers,
  clearScreenAnsi,
  showCursorAnsi,
  enterAltScreenAnsi,
  leaveAltScreenAnsi,
} from "./render/diff.js";
export { createFrame, type Frame } from "./render/frame.js";

// Draw API
export { terminalDrawBuffer, terminalDrawWidget } from "./draw.js";

// Runtime
export { none, quit, batch, task, runCmd, type Cmd } from "./runtime/cmd.js";
export {
  isKeyMsg,
  type KeyMsg,
  type Key,
  type ResizeMsg,
  type TickMsg,
  type SystemMsg,
} from "./runtime/msg.js";
export { view, type ViewSpec } from "./runtime/view.js";
export {
  enterTerminal,
  leaveTerminal,
  type TerminalLifecycleOptions,
} from "./runtime/terminal-lifecycle.js";
export {
  runProgram,
  renderProgramFrame,
  type Program,
  type ProgramOptions,
  type RunResult,
} from "./runtime/program.js";

// Widgets (extended)
export {
  listWidget,
  createListState,
  listSelectNext,
  listSelectPrev,
  type ListState,
} from "./widgets/list.js";
export {
  scrollbarWidget,
  createScrollbarState,
  type ScrollbarState,
} from "./widgets/scrollbar.js";
export {
  textInputWidget,
  createTextInputState,
  textInputInsert,
  textInputBackspace,
  textInputMoveLeft,
  textInputMoveRight,
  textInputSetValue,
  type TextInputState,
} from "./widgets/text-input.js";

// Backends (extended)
export { createTtyBackend } from "./backend/tty.js";
export { createAlternateTerminal, type AlternateScreenTerminal } from "./backend/alternate.js";
export {
  createAppendBackendState,
  createAppendBackend,
  writePinnedFooter,
  type AppendBackendState,
  type AppendBackend,
} from "./backend/append.js";
export { attachKeyListener, type KeyHandler } from "./backend/stdin-keys.js";
