// Session control commands using emojis
export const SESSION_COMMANDS = {
  INTERRUPT: '🛑',
  COMPLETE_DELETE: '🗑️',
  COMPLETE_KEEP: '✅',
  CONNECT: '🔌',
} as const;

export interface ParsedCommand {
  type: 'interrupt' | 'complete_delete' | 'complete_keep' | 'connect' | 'normal';
  sessionName?: string; // For connect command
  messageText: string; // Text without the command prefix
}

export function parseSessionCommand(text: string): ParsedCommand {
  const trimmed = text.trim();

  // Check for interrupt
  if (trimmed.startsWith(SESSION_COMMANDS.INTERRUPT)) {
    return {
      type: 'interrupt',
      messageText: trimmed.substring(SESSION_COMMANDS.INTERRUPT.length).trim(),
    };
  }

  // Check for complete with delete
  if (trimmed.startsWith(SESSION_COMMANDS.COMPLETE_DELETE)) {
    return {
      type: 'complete_delete',
      messageText: trimmed.substring(SESSION_COMMANDS.COMPLETE_DELETE.length).trim(),
    };
  }

  // Check for complete keep
  if (trimmed.startsWith(SESSION_COMMANDS.COMPLETE_KEEP)) {
    return {
      type: 'complete_keep',
      messageText: trimmed.substring(SESSION_COMMANDS.COMPLETE_KEEP.length).trim(),
    };
  }

  // Check for connect
  if (trimmed.startsWith(SESSION_COMMANDS.CONNECT)) {
    const rest = trimmed.substring(SESSION_COMMANDS.CONNECT.length).trim();
    const parts = rest.split(/\s+/);
    const sessionName = parts[0];
    const messageText = parts.slice(1).join(' ');

    return {
      type: 'connect',
      sessionName,
      messageText: messageText || '',
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
    `• ${SESSION_COMMANDS.INTERRUPT} - Interrupt current execution\n` +
    `• ${SESSION_COMMANDS.COMPLETE_DELETE} - Complete & delete thread\n` +
    `• ${SESSION_COMMANDS.COMPLETE_KEEP} - Complete & keep thread\n` +
    `• ${SESSION_COMMANDS.CONNECT} session_name - Connect to existing session`;
}
