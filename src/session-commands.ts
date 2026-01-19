// Session control commands using emojis
export const SESSION_COMMANDS = {
  INTERRUPT: '🛑',
  COMPLETE_DELETE: '🗑️',
  COMPLETE_KEEP: '✅',
  CONNECT: '🔌',
  SHOW_HISTORY: '📜',
} as const;

// Slack text representations of emojis
const SLACK_EMOJI_TEXT = {
  INTERRUPT: ':octagonal_sign:',
  COMPLETE_DELETE: ':wastebasket:',
  COMPLETE_KEEP: ':white_check_mark:',
  CONNECT: ':electric_plug:',
  SHOW_HISTORY: ':scroll:',
} as const;

export interface ParsedCommand {
  type: 'interrupt' | 'complete_delete' | 'complete_keep' | 'connect' | 'show_history' | 'normal';
  sessionName?: string; // For connect command
  messageText: string; // Text without the command prefix
}

export function parseSessionCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  // Check for interrupt (both emoji and Slack text)
  if (trimmed.startsWith(SESSION_COMMANDS.INTERRUPT) || trimmed.startsWith(SLACK_EMOJI_TEXT.INTERRUPT)) {
    const prefix = trimmed.startsWith(SESSION_COMMANDS.INTERRUPT)
      ? SESSION_COMMANDS.INTERRUPT
      : SLACK_EMOJI_TEXT.INTERRUPT;
    return {
      type: 'interrupt',
      messageText: trimmed.substring(prefix.length).trim(),
    };
  }

  // Check for complete with delete (both emoji and Slack text)
  if (trimmed.startsWith(SESSION_COMMANDS.COMPLETE_DELETE) || trimmed.startsWith(SLACK_EMOJI_TEXT.COMPLETE_DELETE)) {
    const prefix = trimmed.startsWith(SESSION_COMMANDS.COMPLETE_DELETE)
      ? SESSION_COMMANDS.COMPLETE_DELETE
      : SLACK_EMOJI_TEXT.COMPLETE_DELETE;
    return {
      type: 'complete_delete',
      messageText: trimmed.substring(prefix.length).trim(),
    };
  }

  // Check for complete keep (both emoji and Slack text)
  if (trimmed.startsWith(SESSION_COMMANDS.COMPLETE_KEEP) || trimmed.startsWith(SLACK_EMOJI_TEXT.COMPLETE_KEEP)) {
    const prefix = trimmed.startsWith(SESSION_COMMANDS.COMPLETE_KEEP)
      ? SESSION_COMMANDS.COMPLETE_KEEP
      : SLACK_EMOJI_TEXT.COMPLETE_KEEP;
    return {
      type: 'complete_keep',
      messageText: trimmed.substring(prefix.length).trim(),
    };
  }

  // Check for connect (both emoji and Slack text)
  if (trimmed.startsWith(SESSION_COMMANDS.CONNECT) || trimmed.startsWith(SLACK_EMOJI_TEXT.CONNECT)) {
    const prefix = trimmed.startsWith(SESSION_COMMANDS.CONNECT)
      ? SESSION_COMMANDS.CONNECT
      : SLACK_EMOJI_TEXT.CONNECT;
    const rest = trimmed.substring(prefix.length).trim();
    const parts = rest.split(/\s+/);
    const sessionName = parts[0];
    const messageText = parts.slice(1).join(' ');

    return {
      type: 'connect',
      sessionName,
      messageText: messageText || '',
    };
  }

  // Check for show history (both emoji and Slack text)
  if (trimmed.startsWith(SESSION_COMMANDS.SHOW_HISTORY) || trimmed.startsWith(SLACK_EMOJI_TEXT.SHOW_HISTORY)) {
    const prefix = trimmed.startsWith(SESSION_COMMANDS.SHOW_HISTORY)
      ? SESSION_COMMANDS.SHOW_HISTORY
      : SLACK_EMOJI_TEXT.SHOW_HISTORY;
    return {
      type: 'show_history',
      messageText: trimmed.substring(prefix.length).trim(),
    };
  }

  // Normal message
  return {
    type: 'normal',
    messageText: trimmed,
  };
}

export function formatSessionInfo(sessionName: string): string {
  return `📦 *Session:* \`${sessionName}\`\n\n` +
    `This thread is now connected to tmux session \`${sessionName}\`.\n\n` +
    `**Commands:**\n` +
    `• ${SESSION_COMMANDS.INTERRUPT} or \`${SLACK_EMOJI_TEXT.INTERRUPT}\` - Interrupt current execution\n` +
    `• ${SESSION_COMMANDS.COMPLETE_DELETE} or \`${SLACK_EMOJI_TEXT.COMPLETE_DELETE}\` - Complete & delete thread\n` +
    `• ${SESSION_COMMANDS.COMPLETE_KEEP} or \`${SLACK_EMOJI_TEXT.COMPLETE_KEEP}\` - Complete & keep thread\n` +
    `• ${SESSION_COMMANDS.CONNECT} or \`${SLACK_EMOJI_TEXT.CONNECT}\` session_name - Connect to existing session\n` +
    `• ${SESSION_COMMANDS.SHOW_HISTORY} or \`${SLACK_EMOJI_TEXT.SHOW_HISTORY}\` - Show full conversation history`;
}
