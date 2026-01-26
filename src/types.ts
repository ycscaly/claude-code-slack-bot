export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
  alias?: string; // Claude alias to use (e.g., 'yehonatan' -> 'claude-yehonatan')
  skipPermissions?: boolean;
  usePlanMode?: boolean;
  executionThreadTs?: string; // Thread for normal mode execution (separate from plan thread)
  inPlanMode?: boolean; // Currently in plan mode
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}