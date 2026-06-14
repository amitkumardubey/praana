import React from "react";
import { Box, Text } from "ink";
import stripAnsi from "strip-ansi";
import type { TranscriptEntry } from "./reducer.js";
import { PALETTE } from "./palette.js";
import { MarkdownRender } from "./markdown-render.js";
import { needsTopMargin } from "./tool-display.js";
import { UserBlock } from "./components/user-block.js";
import { ThinkingBlock } from "./components/thinking-block.js";
import { InlineToolRow } from "./components/inline-tool-row.js";
import { ToolResultLine } from "./components/tool-result-line.js";
import { TurnFooter } from "./components/turn-footer.js";
import { SystemLine } from "./components/system-line.js";

export interface TranscriptLineProps {
  entry: TranscriptEntry;
  prevRole?: TranscriptEntry["role"];
  live?: boolean;
  showThinking?: boolean;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

export const TranscriptLine = React.memo(function TranscriptLine({
  entry,
  prevRole,
  live = false,
  showThinking = false,
  markdownRendering = true,
  syntaxHighlighting = true,
  syntaxTheme = "nord",
}: TranscriptLineProps) {
  const plain = stripAnsi(entry.text);
  const marginTop = needsTopMargin(entry.role, prevRole);

  if (entry.role === "user") {
    return (
      <UserBlock
        text={plain}
        marginTop={marginTop}
        showTurnBreak={prevRole === "turn_footer"}
      />
    );
  }

  if (entry.role === "thinking") {
    return (
      <ThinkingBlock
        text={plain}
        live={live}
        showBody={showThinking}
        durationMs={entry.durationMs}
        markdownRendering={markdownRendering}
        syntaxHighlighting={syntaxHighlighting}
        syntaxTheme={syntaxTheme}
      />
    );
  }

  if (entry.role === "tool") {
    return (
      <Box flexDirection="column">
        <InlineToolRow
          icon={entry.toolIcon ?? "⚙"}
          label={entry.toolLabel ?? plain}
          pending={entry.toolPending}
          complete={entry.resultSummary !== undefined}
          isError={entry.isError}
          marginTop={marginTop}
        />
        {entry.resultSummary ? (
          <ToolResultLine
            summary={entry.resultSummary}
            body={entry.toolName === "shell" ? (entry.resultBody ?? null) : null}
            isError={entry.isError}
          />
        ) : null}
      </Box>
    );
  }

  if (entry.role === "tool_result") {
    const summary = entry.resultSummary ?? plain;
    return (
      <Box flexDirection="column" marginTop={marginTop ? 1 : 0} paddingLeft={1}>
        <ToolResultLine summary={summary} isError={entry.isError} />
      </Box>
    );
  }

  if (entry.role === "turn_footer") {
    return <TurnFooter text={plain} marginTop />;
  }

  if (entry.role === "system") {
    return <SystemLine text={plain} marginTop={marginTop} />;
  }

  if (entry.role === "assistant") {
    if (!plain.trim()) return null;
    const useMarkdown = markdownRendering;

    return (
      <Box flexDirection="column" marginTop={marginTop ? 1 : 0} paddingLeft={1}>
        {useMarkdown ? (
          <MarkdownRender
            text={plain}
            syntaxHighlighting={syntaxHighlighting}
            syntaxTheme={syntaxTheme}
          />
        ) : (
          <Text wrap="wrap" color={PALETTE.text}>{plain || " "}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box marginTop={marginTop ? 1 : 0} paddingLeft={1}>
      <Text wrap="wrap">{plain || " "}</Text>
    </Box>
  );
});
