import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import * as path from 'path';
import * as fs from 'fs';

// IPC directory for plan approval
const PLAN_APPROVAL_DIR = '/tmp/claude-slack-bot-plan-approval';

// Ensure IPC directory exists
if (!fs.existsSync(PLAN_APPROVAL_DIR)) {
  fs.mkdirSync(PLAN_APPROVAL_DIR, { recursive: true });
}

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;
  private pendingPlanApprovals: Map<string, { resolve: (approved: boolean) => void }> = new Map();

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
  }

  // Static methods for IPC-based plan approval (used by slack-handler)
  static writePlanApprovalResponse(approvalId: string, approved: boolean): void {
    const responsePath = path.join(PLAN_APPROVAL_DIR, `${approvalId}.response`);
    fs.writeFileSync(responsePath, approved ? 'approved' : 'denied');
  }

  static hasPendingPlanApproval(sessionKey: string): boolean {
    const pendingPath = path.join(PLAN_APPROVAL_DIR, `${sessionKey}.pending`);
    return fs.existsSync(pendingPath);
  }

  // Create a pending plan approval request
  createPlanApprovalRequest(sessionKey: string): string {
    const approvalId = `plan-${sessionKey}-${Date.now()}`;
    const pendingPath = path.join(PLAN_APPROVAL_DIR, `${approvalId}.pending`);
    fs.writeFileSync(pendingPath, sessionKey);
    return approvalId;
  }

  // Wait for plan approval response via IPC
  async waitForPlanApproval(approvalId: string, timeoutMs: number = 300000): Promise<boolean> {
    const responsePath = path.join(PLAN_APPROVAL_DIR, `${approvalId}.response`);
    const pendingPath = path.join(PLAN_APPROVAL_DIR, `${approvalId}.pending`);
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (fs.existsSync(responsePath)) {
        const response = fs.readFileSync(responsePath, 'utf-8').trim();
        // Cleanup
        try {
          fs.unlinkSync(responsePath);
          fs.unlinkSync(pendingPath);
        } catch (e) {
          // Ignore cleanup errors
        }
        return response === 'approved';
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Timeout - cleanup and deny
    try {
      fs.unlinkSync(pendingPath);
    } catch (e) {
      // Ignore cleanup errors
    }
    return false;
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string },
    usePlanMode?: boolean,
    onPlanApprovalRequest?: (plan: string, approvalId: string) => Promise<void>
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // Determine if we should skip permissions
    const shouldSkipPermissions = session?.skipPermissions ?? true;

    const options: any = {
      outputFormat: 'stream-json',
    };

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add profile/alias if specified
    if (session?.alias) {
      options.profile = `claude-${session.alias}`;
      this.logger.debug('Using profile', { profile: options.profile });
    }

    // Handle plan mode - requires canUseTool to intercept ExitPlanMode
    // IMPORTANT: Cannot use bypassPermissions with plan mode because it bypasses canUseTool
    if (usePlanMode && slackContext && onPlanApprovalRequest) {
      options.planMode = true;
      this.logger.debug('Plan mode enabled with ExitPlanMode approval');

      const sessionKey = session ? this.getSessionKey(session.userId, session.channelId, session.threadTs) : 'unknown';
      const self = this;

      // Use canUseTool to intercept ExitPlanMode for user approval
      // All other tools are auto-allowed (like bypassPermissions but selective)
      options.canUseTool = async (
        toolName: string,
        input: any,
        toolOptions: { signal: AbortSignal; suggestions?: any[] }
      ) => {
        // Allow all tools except ExitPlanMode
        if (toolName !== 'ExitPlanMode') {
          return {
            behavior: 'allow',
            updatedInput: input
          };
        }

        self.logger.info('ExitPlanMode tool intercepted via canUseTool, requesting user approval', {
          sessionKey,
          plan: input.plan?.substring(0, 200)
        });

        // Create approval request
        const approvalId = self.createPlanApprovalRequest(sessionKey);

        // Notify slack-handler to show approval UI
        await onPlanApprovalRequest(input.plan || 'No plan provided', approvalId);

        // Wait for user approval via IPC
        const approved = await self.waitForPlanApproval(approvalId);

        self.logger.info('Plan approval result', { sessionKey, approved });

        if (approved) {
          return {
            behavior: 'allow',
            updatedInput: input
          };
        } else {
          return {
            behavior: 'deny',
            message: 'User denied plan approval'
          };
        }
      };

      this.logger.debug('Permission configuration for plan mode', {
        skipPermissions: session?.skipPermissions,
        usingCanUseTool: true,
        planMode: true,
      });
    } else if (usePlanMode) {
      // Plan mode without approval callback - just enable plan mode with bypass
      options.planMode = true;
      if (shouldSkipPermissions) {
        options.permissionMode = 'bypassPermissions';
      }
      this.logger.debug('Plan mode enabled without approval callback');
    } else {
      // Non-plan mode - use normal permission handling
      if (shouldSkipPermissions) {
        options.permissionMode = 'bypassPermissions';
      }
      this.logger.debug('Permission configuration', {
        skipPermissions: session?.skipPermissions,
        shouldSkipPermissions,
        permissionMode: options.permissionMode || 'default',
      });
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();

    // Add permission prompt server if NOT skipping permissions
    if (!shouldSkipPermissions && slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', path.join(__dirname, 'permission-mcp-server.ts')],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };

      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }

      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';

      this.logger.debug('Added permission prompt server', { slackContext });
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (!shouldSkipPermissions && slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }

      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    // Add abort controller to options
    options.abortController = abortController || new AbortController();

    this.logger.debug('Claude query options', options);

    try {
      for await (const message of query({
        prompt,
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            this.logger.info('Session initialized', { 
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error) {
      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}