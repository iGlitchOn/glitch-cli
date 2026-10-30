import React from 'react';
import { Box, Text } from 'ink';
import type { ThinkingDisplayMode } from '../config/settings.js';
import type { SavedUiMessage } from '../core/sessionStore.js';
import type { LiveSubagentInfo } from '../core/subagents.js';
import { formatCollapsedThoughtLine } from '../core/thinkingBlocks.js';
import {
  RichMarkdownBlock,
  measureTextWidth,
  parseInlineMarkdownTokens,
  wrapInlineTokensByWords,
  type InlineToken,
} from './markdownRender.js';
import { SubagentsView } from './SubagentsView.js';
import { ToolCallView } from './ToolCallView.js';

export interface NumberedUiMessage extends SavedUiMessage {
  turnNumber: number;
}

export function shouldCollapseThought(
  thinkingDisplay: ThinkingDisplayMode = 'expandido',
  isCompletedResponse: boolean,
  manualOverride?: boolean | null,
  perMessageOverride?: boolean,
): boolean {
  if (typeof perMessageOverride === 'boolean') {
    return perMessageOverride;
  }
  if (typeof manualOverride === 'boolean') {
    return manualOverride;
  }
  if (thinkingDisplay === 'contraido') {
    return true;
  }
  if (thinkingDisplay === 'auto') {
    return isCompletedResponse;
  }
  return false;
}

export interface ChatHistoryViewProps {
  numberedMessages: readonly NumberedUiMessage[];
  uniformBoxWidth: number;
  uniformBoxInnerWidth: number;
  thoughtsEnabled: boolean;
  thinkingDisplay?: ThinkingDisplayMode;
  thoughtsCollapsed: boolean | null;
  perMessageCollapsed?: Readonly<Record<string, boolean>>;
  copiedMessageId?: string | null;
  isStreaming: boolean;
  liveThought: string;
  liveText: string;
  streamingElapsedMs?: number;
  nextStreamingReplyNumber: number;
  liveSubagents?: readonly LiveSubagentInfo[];
}

export const ChatHistoryView: React.FC<ChatHistoryViewProps> = React.memo(({
  numberedMessages,
  uniformBoxWidth,
  uniformBoxInnerWidth,
  thoughtsEnabled,
  thinkingDisplay = 'expandido',
  thoughtsCollapsed,
  perMessageCollapsed = {},
  copiedMessageId = null,
  isStreaming,
  liveThought,
  liveText,
  nextStreamingReplyNumber,
  liveSubagents = [],
}) => {
  const renderThoughtTokensLine = (tokens: readonly InlineToken[], keyIdx: number) => (
    <Text key={keyIdx}>
      {tokens.map((tok, i) => {
        if (tok.kind === 'bold') {
          return (
            <Text key={i} bold color="whiteBright">
              {tok.content}
            </Text>
          );
        }
        if (tok.kind === 'code') {
          return (
            <Text key={i} color="cyan">
              {tok.content}
            </Text>
          );
        }
        return (
          <Text key={i} color="gray" dimColor italic>
            {tok.content}
          </Text>
        );
      })}
    </Text>
  );

  const renderThoughtBlock = (
    thoughtContent: string | undefined,
    isCompletedResponse = true,
    hasFollowingText = false,
    msgId?: string,
  ) => {
    if (!thoughtContent || !thoughtContent.trim() || !thoughtsEnabled) {
      return null;
    }
    const trimmedThought = thoughtContent.trim();
    const isCollapsed = shouldCollapseThought(
      thinkingDisplay,
      isCompletedResponse,
      thoughtsCollapsed,
      msgId ? perMessageCollapsed[msgId] : undefined,
    );

    if (isCollapsed) {
      const firstRealLine = formatCollapsedThoughtLine(trimmedThought);
      if (!firstRealLine) {
        return null;
      }
      const firstTokens = parseInlineMarkdownTokens(firstRealLine);
      return (
        <Box
          width={uniformBoxWidth}
          marginLeft={0}
          paddingX={1}
          marginTop={0}
          marginBottom={hasFollowingText ? 1 : 0}
        >
          {renderThoughtTokensLine(firstTokens, 0)}
        </Box>
      );
    }

    const rawParas = trimmedThought
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const wrappedTokenLines: InlineToken[][] = [];
    for (const para of rawParas) {
      const tokens = parseInlineMarkdownTokens(para);
      const lines = wrapInlineTokensByWords(
        tokens,
        Math.max(10, uniformBoxInnerWidth),
      );
      for (const ln of lines) {
        if (ln.length > 0) wrappedTokenLines.push(ln);
      }
    }
    const visibleTokenLines = wrappedTokenLines.slice(0, 8);
    if (visibleTokenLines.length === 0) {
      return null;
    }
    return (
      <Box
        flexDirection="column"
        width={uniformBoxWidth}
        marginLeft={0}
        paddingX={1}
        marginTop={0}
        marginBottom={hasFollowingText ? 1 : 0}
      >
        {visibleTokenLines.map((toks, idx) => renderThoughtTokensLine(toks, idx))}
      </Box>
    );
  };

  const renderSubthinkingBlock = (subthinkingContent: string | undefined) => {
    if (!subthinkingContent || !subthinkingContent.trim()) {
      return null;
    }
    const rawParas = subthinkingContent
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const wrappedTokenLines: InlineToken[][] = [];
    for (const para of rawParas) {
      const tokens = parseInlineMarkdownTokens(para);
      const lines = wrapInlineTokensByWords(
        tokens,
        Math.max(10, uniformBoxInnerWidth),
      );
      for (const ln of lines) {
        if (ln.length > 0) wrappedTokenLines.push(ln);
      }
    }
    if (wrappedTokenLines.length === 0) {
      return null;
    }
    return (
      <Box
        flexDirection="column"
        width={uniformBoxWidth}
        marginLeft={0}
        paddingX={1}
        marginTop={0}
        marginBottom={0}
      >
        {wrappedTokenLines.map((toks, idx) => renderThoughtTokensLine(toks, idx))}
      </Box>
    );
  };

  const renderUserMessageBlock = (
    m: NumberedUiMessage,
  ) => {
    const userPrefixStr = '> ';
    const copyLabel = copiedMessageId === m.id ? 'copiado' : 'copiar';
    return (
      <RichMarkdownBlock
        text={m.text}
        availableWidth={uniformBoxWidth}
        firstLinePrefix={
          <Text color="cyan" bold>
            {userPrefixStr}
          </Text>
        }
        firstLinePrefixWidth={measureTextWidth(userPrefixStr)}
        firstLineSuffix={
          <Text color="gray" dimColor>
            {`${m.timestamp ? `  ${m.timestamp}` : ''}  [${copyLabel}]`}
          </Text>
        }
        baseTextColor="cyan"
      />
    );
  };

  const streamingPrefixStr = `  `;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {numberedMessages.map((m, msgIndex) => {
        const topMargin = m.role === 'user' && msgIndex === 0 ? 1 : 0;
        const hasModelText = m.text.trim().length > 0;
        const hasThoughtText = Boolean(
          thoughtsEnabled && m.thoughtText && m.thoughtText.trim().length > 0,
        );

        if (m.isBlockSummary) {
          return (
            <Box
              key={m.id}
              flexDirection="column"
              marginTop={0}
              marginBottom={1}
              paddingX={1}
            >
              <Text color="cyan" bold>
                {m.blockTitle ? `[${m.blockTitle}] ` : ''}
                <Text color="white">{m.text}</Text>
              </Text>
            </Box>
          );
        }

        if (m.role === 'model' && !hasModelText && !hasThoughtText) {
          return null;
        }

        const nextMsg = numberedMessages[msgIndex + 1];
        const isGroupedWithNextTool =
          m.role === 'system' &&
          Boolean(m.toolStatus) &&
          nextMsg?.role === 'system' &&
          Boolean(nextMsg.toolStatus) &&
          !nextMsg.subthinking;

        const prevMsg = msgIndex > 0 ? numberedMessages[msgIndex - 1] : undefined;
        const isDuplicateSubthinking =
          Boolean(m.subthinking) &&
          Boolean(
            prevMsg &&
              (prevMsg.subthinking?.trim() === m.subthinking?.trim() ||
                prevMsg.text.trim() === m.subthinking?.trim() ||
                (thoughtsEnabled &&
                  prevMsg.thoughtText?.trim() === m.subthinking?.trim())),
          );

        const isMsgThoughtCollapsed = shouldCollapseThought(
          thinkingDisplay,
          true,
          thoughtsCollapsed,
          perMessageCollapsed[m.id],
        );
        const thoughtBtnLabel = isMsgThoughtCollapsed
          ? 'expandir pensamiento'
          : 'plegar pensamiento';
        const copyLabel = copiedMessageId === m.id ? 'copiado' : 'copiar';
        const replyPrefixStr = `  `;

        return (
          <Box
            key={m.id}
            flexDirection="column"
            marginTop={topMargin}
            marginBottom={isGroupedWithNextTool ? 0 : 1}
          >
            {m.role === 'user' && renderUserMessageBlock(m)}
            {m.role === 'model' && (
              <Box flexDirection="column">
                {(hasThoughtText || hasModelText) && (
                  <Box flexDirection="row" justifyContent="flex-end" paddingX={1}>
                    {hasThoughtText && settingsThoughtBtn(thoughtBtnLabel)}
                    <Text color={copiedMessageId === m.id ? 'cyan' : 'gray'} dimColor={copiedMessageId !== m.id}>
                      {`[${copyLabel}]`}
                    </Text>
                  </Box>
                )}
                {renderThoughtBlock(m.thoughtText, true, hasModelText, m.id)}
                {hasModelText && (
                  <RichMarkdownBlock
                    text={m.text}
                    availableWidth={uniformBoxWidth}
                    firstLinePrefix={
                      <Text color="white">
                        {replyPrefixStr}
                      </Text>
                    }
                    firstLinePrefixWidth={measureTextWidth(replyPrefixStr)}
                  />
                )}
              </Box>
            )}
            {m.role === 'system' && (
              <Box flexDirection="column">
                {!isDuplicateSubthinking && renderSubthinkingBlock(m.subthinking)}
                <ToolCallView
                  rawText={m.text}
                  uniformBoxWidth={uniformBoxWidth}
                  uniformBoxInnerWidth={uniformBoxInnerWidth}
                  toolStatus={m.toolStatus}
                />
              </Box>
            )}
          </Box>
        );
      })}

      {liveSubagents.length > 0 && <SubagentsView subagents={liveSubagents} />}

      {isStreaming && (liveThought || liveText) && (
        <Box flexDirection="column" marginBottom={1}>
          {renderThoughtBlock(
            liveThought,
            false,
            Boolean(liveText && liveText.trim().length > 0),
          )}
          {liveText && liveText.trim().length > 0 && (
            <RichMarkdownBlock
              text={liveText}
              availableWidth={uniformBoxWidth}
              firstLinePrefix={
                <Text color="white">
                  {streamingPrefixStr}
                </Text>
              }
              firstLinePrefixWidth={measureTextWidth(streamingPrefixStr)}
            />
          )}
        </Box>
      )}
    </Box>
  );
});

function settingsThoughtBtn(label: string): React.ReactNode {
  return (
    <Text color="gray" dimColor>
      {`[${label}]  `}
    </Text>
  );
}
