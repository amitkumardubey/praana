import React from "react";
import { Box, Text } from "ink";
import { PALETTE } from "../palette.js";
import { MarkdownRender } from "../markdown-render.js";
import {
  formatThinkingDuration,
  reasoningSummary,
} from "../reasoning-summary.js";

export interface ThinkingBlockProps {
  text: string;
  live?: boolean;
  showBody: boolean;
  expanded?: boolean;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}

function thinkingPreview(text: string, maxLen = 72): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length <= maxLen) return line;
  return `${line.slice(0, maxLen - 1)}…`;
}

function ThinkingBody({
  bodyText,
  markdownRendering,
  syntaxHighlighting,
  syntaxTheme,
}: {
  bodyText: string;
  markdownRendering: boolean;
  syntaxHighlighting: boolean;
  syntaxTheme: string;
}) {
  if (markdownRendering) {
    return (
      <MarkdownRender
        text={bodyText}
        syntaxHighlighting={syntaxHighlighting}
        syntaxTheme={syntaxTheme}
      />
    );
  }
  return (
    <Text wrap="wrap" color={PALETTE.thinking} dimColor italic>
      {bodyText}
    </Text>
  );
}

export function ThinkingBlock({
  text,
  live = false,
  showBody,
  expanded = false,
  markdownRendering = true,
  syntaxHighlighting = true,
  syntaxTheme = "solarized-dark",
}: ThinkingBlockProps) {
  const plain = text.trim();
  if (!plain) return null;

  const { title, body } = reasoningSummary(plain);
  const headerTitle = title ?? thinkingPreview(body || plain);
  const bodyText = body || plain;
  const hasBody = Boolean(bodyText.trim());

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
      <Text color={PALETTE.thinking} wrap="wrap">
        {live ? (
          <>
            {headerTitle ? `Thinking: ${headerTitle}` : "Thinking"}
            <Text dimColor> …</Text>
          </>
        ) : (
          <>
            {hasBody && !expanded ? "+ " : hasBody && expanded ? "- " : ""}
            Thought{headerTitle ? `: ${headerTitle}` : ""}
          </>
        )}
      </Text>
      {showBody && hasBody && (live || expanded) ? (
        <Box paddingLeft={2} marginTop={1}>
          <ThinkingBody
            bodyText={bodyText}
            markdownRendering={markdownRendering}
            syntaxHighlighting={syntaxHighlighting}
            syntaxTheme={syntaxTheme}
          />
        </Box>
      ) : hasBody && showBody && !live && !expanded ? (
        <Box paddingLeft={2}>
          <Text color={PALETTE.muted} dimColor>
            Ctrl+T to expand
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function CompletedThinkingBlock({
  text,
  durationMs,
  expanded = false,
  markdownRendering = true,
  syntaxHighlighting = true,
  syntaxTheme = "solarized-dark",
}: {
  text: string;
  durationMs?: number;
  expanded?: boolean;
  markdownRendering?: boolean;
  syntaxHighlighting?: boolean;
  syntaxTheme?: string;
}) {
  const plain = text.trim();
  if (!plain) return null;

  const { title, body } = reasoningSummary(plain);
  const duration =
    durationMs !== undefined ? formatThinkingDuration(durationMs) : undefined;
  const headerTitle = title ?? thinkingPreview(body || plain);
  const bodyText = body || plain;
  const hasBody = Boolean(bodyText.trim());

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={1}>
      <Text color={PALETTE.thinking} wrap="wrap">
        {hasBody && !expanded ? "+ " : hasBody && expanded ? "- " : ""}
        Thought{headerTitle ? `: ${headerTitle}` : ""}
        {duration ? ` · ${duration}` : ""}
      </Text>
      {expanded && hasBody ? (
        <Box paddingLeft={2} marginTop={1}>
          <ThinkingBody
            bodyText={bodyText}
            markdownRendering={markdownRendering}
            syntaxHighlighting={syntaxHighlighting}
            syntaxTheme={syntaxTheme}
          />
        </Box>
      ) : hasBody && !expanded ? (
        <Box paddingLeft={2}>
          <Text color={PALETTE.muted} dimColor>
            Ctrl+T to expand
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
