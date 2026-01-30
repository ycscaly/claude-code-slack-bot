import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { PermissionMCPServer } from './permission-mcp-server';
import { config } from './config';
import { TmuxManager } from './tmux-manager';
import { MessageQueue, QueuedMessage } from './message-queue';
import { parseSessionCommand, formatSessionInfo, SESSION_COMMANDS } from './session-commands';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private botMessages: Map<string, string[]> = new Map(); // sessionKey -> array of bot message timestamps
  private botUserId: string | null = null;
  private tmuxManager: TmuxManager;
  private messageQueue: MessageQueue;
  private threadMessageCount: Map<string, number> = new Map(); // threadKey -> message count
  private threadMessageHistory: Map<string, Array<{role: string, content: string, ts: string}>> = new Map(); // threadKey -> full history
  private threadSummaries: Map<string, string[]> = new Map(); // threadKey -> array of summaries
  private threadWelcomeMessage: Map<string, string> = new Map(); // threadKey -> welcome message ts

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.tmuxManager = new TmuxManager();
    this.messageQueue = new MessageQueue();
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `📎 Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    // Parse session commands
    const command = parseSessionCommand(text || '');

    // Handle session commands first
    if (command.type === 'complete_delete' || command.type === 'complete_keep') {
      await this.handleCompleteCommand(channel, thread_ts || ts, command.type === 'complete_delete', say);
      return;
    }

    if (command.type === 'connect') {
      await this.handleConnectCommand(channel, thread_ts || ts, command.sessionName!, say);
      return;
    }

    if (command.type === 'show_history') {
      await this.handleShowHistoryCommand(channel, thread_ts || ts, say);
      return;
    }

    // Check if this is a scroll history command (📜 followed by number)
    if (text && this.isScrollHistoryCommand(text)) {
      const count = this.parseScrollHistoryCount(text);
      await this.handleScrollHistoryCommand(channel, thread_ts || ts, count, say);
      return;
    }

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // For messages in threads, use thread_ts as the thread identifier
    // For new messages in channel, use ts as the thread identifier (starts a new thread)
    const actualThreadTs = thread_ts || ts;

    // Check if this is a working directory command (only if there's text)
    const setDirPath = command.messageText ? this.workingDirManager.parseSetCommand(command.messageText.trim()) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `✅ Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ ${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
      
      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `✅ MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `❌ Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // NEW SESSION-BASED QUEUING SYSTEM
    // If this is a threaded message (or becomes a thread), handle via queue
    if (actualThreadTs) {
      // Check if this is a new thread (no tmux session exists yet)
      const existingSession = this.tmuxManager.getSession(channel, actualThreadTs);

      if (!existingSession) {
        // New thread - ask for project selection
        const isDM = channel.startsWith('D');
        await this.askForProjectSelection(channel, actualThreadTs, say, isDM ? user : undefined, text || '');
        return;
      }

      // Existing thread - get working directory and process message
      const isDM = channel.startsWith('D');
      const workingDirectory = this.workingDirManager.getWorkingDirectory(
        channel,
        actualThreadTs,
        isDM ? user : undefined
      );

      if (!workingDirectory) {
        await say({
          text: '⚠️ No working directory set for this thread.',
          thread_ts: actualThreadTs,
        });
        return;
      }

      await this.enqueueAndProcessMessage(
        user,
        channel,
        actualThreadTs,
        command,
        processedFiles,
        workingDirectory,
        say
      );
      return;
    }

    // For non-threaded messages, still check working directory
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    if (!workingDirectory) {
      await this.askForProjectSelection(channel, actualThreadTs, say, isDM ? user : undefined, text || '');
      return;
    }

    // OLD DIRECT PROCESSING (fallback for non-threaded messages)
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);

    // Store the original message info for status reactions
    const originalMessageTs = thread_ts || ts;
    this.originalMessages.set(sessionKey, { channel, ts: originalMessageTs });

    // Cancel any existing request for this conversation UNLESS it's waiting for permission
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      // Check if there are pending approval requests via IPC
      if (PermissionMCPServer.hasPendingApproval(sessionKey)) {
        this.logger.info('Session is waiting for permission approval, not aborting', { sessionKey });
        await say({
          text: '⚠️ A previous request is waiting for your permission approval. Please approve or deny it before sending new messages.',
          thread_ts: thread_ts || ts,
        });
        return;
      }

      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    // Delete all previous bot messages from the last task to keep the channel clean
    const previousMessages = this.botMessages.get(sessionKey);
    if (previousMessages && previousMessages.length > 0) {
      this.logger.info('Deleting previous bot messages', { sessionKey, count: previousMessages.length });
      for (const messageTs of previousMessages) {
        try {
          await this.app.client.chat.delete({
            channel,
            ts: messageTs,
          });
        } catch (error) {
          this.logger.debug('Failed to delete previous message', { messageTs, error: (error as any).message });
        }
      }
    }

    // Clear previous message tracking for this session
    this.botMessages.set(sessionKey, []);

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      const finalPrompt = processedFiles.length > 0 
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      this.logger.info('Sending query to Claude Code SDK', { 
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''), 
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: thread_ts || ts,
      });
      statusMessageTs = statusResult.ts;

      // Track this message for cleanup
      if (statusMessageTs) {
        const messages = this.botMessages.get(sessionKey) || [];
        messages.push(statusMessageTs);
        this.botMessages.set(sessionKey, messages);
      }

      // Add thinking reaction to original message (but don't spam if already set)
      await this.updateMessageReaction(sessionKey, '🤔');
      
      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: thread_ts,
        user
      };
      
      for await (const message of this.claudeHandler.streamQuery(finalPrompt, session, abortController, workingDirectory, slackContext)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          
          if (hasToolUse) {
            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Update reaction to show working
            await this.updateMessageReaction(sessionKey, '⚙️');

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) => 
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, thread_ts || ts, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              const result = await say({
                text: toolContent,
                thread_ts: thread_ts || ts,
              });

              // Track this message for cleanup
              if (result?.ts) {
                const messages = this.botMessages.get(sessionKey) || [];
                messages.push(result.ts);
                this.botMessages.set(sessionKey, messages);
              }
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              const result = await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });

              // Track this message for cleanup
              if (result?.ts) {
                const messages = this.botMessages.get(sessionKey) || [];
                messages.push(result.ts);
                this.botMessages.set(sessionKey, messages);
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });
          
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              const result = await say({
                text: formatted,
                thread_ts: thread_ts || ts,
              });

              // Track this message for cleanup
              if (result?.ts) {
                const messages = this.botMessages.get(sessionKey) || [];
                messages.push(result.ts);
                this.botMessages.set(sessionKey, messages);
              }
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: 'COMPLETED ✅ *Task completed*',
        });
      }

      // Update reaction to show completion
      await this.updateMessageReaction(sessionKey, '✅');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);
        
        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        // Update reaction to show error
        await this.updateMessageReaction(sessionKey, '❌');
        
        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });
        
        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }

        // Update reaction to show cancellation
        await this.updateMessageReaction(sessionKey, '⏹️');
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
      
      // Clean up todo tracking if session ended
      if (session?.sessionId) {
        // Don't immediately clean up - keep todos visible for a while
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];
    
    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;
        
        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }
    
    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];
    
    let result = `📝 *Editing \`${filePath}\`*\n`;
    
    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }
    
    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);
    
    return `📄 *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `👁️ *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `🖥️ *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `🔧 *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any, 
    sessionKey: string, 
    sessionId: string | undefined, 
    channel: string, 
    threadTs: string, 
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);
    
    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);
      
      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);
      
      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);
      
      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        const result = await say({
          text: `🔄 *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });

        // Track this message for cleanup
        if (result?.ts) {
          const messages = this.botMessages.get(sessionKey) || [];
          messages.push(result.ts);
          this.botMessages.set(sessionKey, messages);
        }
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });

      // Track this message for cleanup
      const messages = this.botMessages.get(sessionKey) || [];
      messages.push(result.ts);
      this.botMessages.set(sessionKey, messages);
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', { 
            sessionKey, 
            emoji: currentEmoji,
            error: (error as any).message 
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', { 
        sessionKey, 
        emoji, 
        previousEmoji: currentEmoji,
        channel: originalMessage.channel, 
        ts: originalMessage.ts 
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = '✅'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = '🔄'; // Tasks in progress
    } else {
      emoji = '📋'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';
      
      let welcomeMessage = `👋 Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;
      
      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `• \`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `• \`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `• \`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }
      
      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  private pendingThreadMessages: Map<string, string> = new Map(); // threadKey -> initial message

  private async askForProjectSelection(
    channel: string,
    threadTs: string,
    say: any,
    userId?: string,
    initialMessage?: string
  ): Promise<void> {
    try {
      const fs = require('fs');
      const path = require('path');

      // Store the initial message to process after project selection
      if (initialMessage) {
        const threadKey = `${channel}-${threadTs}`;
        this.pendingThreadMessages.set(threadKey, initialMessage);
      }

      // List directories in projects directory
      const projectsDir = config.projectsDirectory;
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      const projects = entries
        .filter((entry: any) => entry.isDirectory())
        .map((entry: any) => entry.name)
        .sort();

      if (projects.length === 0) {
        await say({
          text: `⚠️ No projects found in ${projectsDir}`,
          thread_ts: threadTs,
        });
        return;
      }

      // Create blocks with buttons (max 5 per action block)
      const blocks: any[] = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `📂 *Select a project to work on:*\n_Projects directory: \`${projectsDir}\`_`
          }
        }
      ];

      // Add buttons in groups of 5
      for (let i = 0; i < projects.length; i += 5) {
        const chunk = projects.slice(i, i + 5);
        blocks.push({
          type: 'actions',
          elements: chunk.map((project: string) => ({
            type: 'button',
            text: {
              type: 'plain_text',
              text: project.length > 75 ? project.substring(0, 72) + '...' : project,
            },
            value: JSON.stringify({
              project,
              channel,
              threadTs,
              userId,
            }),
            action_id: `select_project_${project}`,
          }))
        });
      }

      await say({
        blocks,
        text: `Select a project to work on`,
        thread_ts: threadTs,
      });
    } catch (error) {
      this.logger.error('Failed to list projects', error);
      await say({
        text: `❌ Failed to list projects: ${(error as Error).message}`,
        thread_ts: threadTs,
      });
    }
  }

  private async enqueueAndProcessMessage(
    user: string,
    channel: string,
    threadTs: string,
    command: any,
    processedFiles: ProcessedFile[],
    workingDirectory: string,
    say: any
  ): Promise<void> {
    // Get or create tmux session for this thread
    let sessionName = this.tmuxManager.getSession(channel, threadTs);
    const isNewSession = !sessionName;

    if (!sessionName) {
      sessionName = this.tmuxManager.createSession(channel, threadTs, workingDirectory);
      this.logger.info('Created new tmux session for thread', { sessionName, threadTs });

      // Announce the session
      await say({
        text: formatSessionInfo(sessionName),
        thread_ts: threadTs,
      });
    }

    // Handle interrupt
    if (command.type === 'interrupt') {
      this.logger.info('Interrupt received', { threadTs, sessionName });

      // Abort current execution
      const sessionKey = this.claudeHandler.getSessionKey(user, channel, threadTs);
      const existingController = this.activeControllers.get(sessionKey);
      if (existingController) {
        existingController.abort();
        this.logger.info('Aborted current execution', { sessionKey });
      }

      // Enqueue the interrupt message (which clears the queue)
      this.messageQueue.enqueue(channel, threadTs, {
        text: command.messageText,
        files: processedFiles,
        timestamp: Date.now(),
        isInterrupt: true,
      });

      await say({
        text: `🛑 *Interrupted*\nProcessing new message: ${command.messageText.substring(0, 100)}${command.messageText.length > 100 ? '...' : ''}`,
        thread_ts: threadTs,
      });
    } else {
      // Enqueue normal message
      this.messageQueue.enqueue(channel, threadTs, {
        text: command.messageText,
        files: processedFiles,
        timestamp: Date.now(),
        isInterrupt: false,
      });

      const queueSize = this.messageQueue.getQueueSize(channel, threadTs);
      if (queueSize > 1) {
        await say({
          text: `📬 Message queued (${queueSize} messages in queue)`,
          thread_ts: threadTs,
        });
      }
    }

    // Start processing if not already processing
    if (!this.messageQueue.isProcessing(channel, threadTs)) {
      await this.processMessageQueue(user, channel, threadTs, workingDirectory, say);
    }
  }

  private async processMessageQueue(
    user: string,
    channel: string,
    threadTs: string,
    workingDirectory: string,
    say: any
  ): Promise<void> {
    this.messageQueue.setProcessing(channel, threadTs, true);

    try {
      while (this.messageQueue.hasMessages(channel, threadTs)) {
        const queuedMessage = this.messageQueue.dequeue(channel, threadTs);
        if (!queuedMessage) break;

        this.logger.info('Processing queued message', { threadTs, remaining: this.messageQueue.getQueueSize(channel, threadTs) });

        // Process this message using existing Claude handler logic
        await this.processClaudeMessage(
          user,
          channel,
          threadTs,
          queuedMessage.text,
          queuedMessage.files || [],
          workingDirectory,
          say
        );
      }
    } finally {
      this.messageQueue.setProcessing(channel, threadTs, false);
    }
  }

  private async processClaudeMessage(
    user: string,
    channel: string,
    threadTs: string,
    text: string,
    processedFiles: ProcessedFile[],
    workingDirectory: string,
    say: any
  ): Promise<void> {
    // This is the core Claude processing logic extracted from the original handleMessage
    // For now, I'll just put a placeholder and we can fill it in
    const sessionKey = this.claudeHandler.getSessionKey(user, channel, threadTs);

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let session = this.claudeHandler.getSession(user, channel, threadTs);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, threadTs);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;

    try {
      // Prepare the prompt with file attachments
      const finalPrompt = processedFiles.length > 0
        ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
        : text || '';

      this.logger.info('Sending query to Claude Code SDK', {
        prompt: finalPrompt.substring(0, 200) + (finalPrompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        skipPermissions: session.skipPermissions,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Track user message
      this.trackMessage(channel, threadTs, 'user', text || '', threadTs);

      // Send initial status message
      const statusResult = await say({
        text: '🤔 *Thinking...*',
        thread_ts: threadTs,
      });
      statusMessageTs = statusResult.ts;

      // Create Slack context for permission prompts
      const slackContext = {
        channel,
        threadTs: threadTs,
        user
      };

      // Determine which thread to post messages to
      let currentThreadTs = threadTs;
      let executionThreadTs: string | undefined;
      let planModeExited = false;

      // If not using plan mode, create execution thread immediately
      if (!session.usePlanMode) {
        const sessionName = this.tmuxManager.getSession(channel, threadTs);
        const executionMessage = await this.app.client.chat.postMessage({
          token: config.slack.botToken,
          channel: channel,
          text: `🚀 *Execution: ${sessionName}*\n\nThis thread contains the execution output.`,
        });

        executionThreadTs = executionMessage.ts as string;
        currentThreadTs = executionThreadTs;

        // Store execution thread in session
        if (session) {
          session.executionThreadTs = executionThreadTs;
        }

        this.logger.info('Created execution thread for non-plan mode', { executionThreadTs });
      }

      // Create plan approval request handler
      // This is called when ExitPlanMode is intercepted by canUseTool
      // It shows the approval UI and waits for user response
      // If approved, creates execution thread and updates currentThreadTs
      const onPlanApprovalRequest = async (plan: string, approvalId: string) => {
        this.logger.info('Plan approval requested', { threadTs, approvalId, planLength: plan.length });

        // Show plan approval UI in main thread
        await this.app.client.chat.postMessage({
          token: config.slack.botToken,
          channel: channel,
          thread_ts: threadTs,
          text: `📋 *Plan Ready for Review*\n\n${plan}\n\n*Do you want to execute this plan?*`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `📋 *Plan Ready for Review*`
              }
            },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: '*Do you want to execute this plan?*'
              }
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '✅ Approve & Execute'
                  },
                  value: JSON.stringify({ approvalId, channel, threadTs }),
                  action_id: 'approve_plan',
                  style: 'primary'
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '❌ Deny'
                  },
                  value: JSON.stringify({ approvalId, channel, threadTs }),
                  action_id: 'deny_plan',
                  style: 'danger'
                }
              ]
            }
          ]
        });

        // Note: The actual approval wait happens in canUseTool via IPC
        // After canUseTool returns 'allow', we need to create execution thread
        // This is handled by detecting ExitPlanMode tool result below
      };

      for await (const message of this.claudeHandler.streamQuery(
        finalPrompt,
        session,
        abortController,
        workingDirectory,
        slackContext,
        session.inPlanMode,
        session.inPlanMode ? onPlanApprovalRequest : undefined
      )) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        // Check if this is a tool_result message for ExitPlanMode (indicates plan was approved)
        if (message.type === 'user' && (message as any).message?.content) {
          const toolResults = (message as any).message.content.filter((part: any) => part.type === 'tool_result');
          for (const toolResult of toolResults) {
            // Check if this is ExitPlanMode result by looking at the content
            if (toolResult.content && typeof toolResult.content === 'string' &&
                toolResult.content.includes('exited plan mode')) {
              if (!planModeExited && session?.inPlanMode) {
                this.logger.info('ExitPlanMode completed, creating execution thread', { threadTs });

                // Create a new thread for execution
                const sessionName = this.tmuxManager.getSession(channel, threadTs);
                const executionMessage = await this.app.client.chat.postMessage({
                  token: config.slack.botToken,
                  channel: channel,
                  text: `🚀 *Executing Plan: ${sessionName}*\n\nThis thread contains the execution output.`,
                });

                executionThreadTs = executionMessage.ts as string;
                currentThreadTs = executionThreadTs;
                planModeExited = true;

                // Store execution thread in session
                if (session) {
                  session.executionThreadTs = executionThreadTs;
                  session.inPlanMode = false;
                }

                this.logger.info('Created execution thread after plan approval', { executionThreadTs });
              }
            }
          }
        }

        if (message.type === 'assistant') {
          // Check if this is a tool use message
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Check for ExitPlanMode tool - if we see this, plan approval is in progress
            const exitPlanModeTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'ExitPlanMode'
            );

            if (exitPlanModeTool && session?.inPlanMode) {
              this.logger.info('ExitPlanMode tool detected, waiting for approval', { threadTs });
              // The plan will be shown via onPlanApprovalRequest callback
              // Don't show this tool use in the output
              continue;
            }

            // Update status to show working
            if (statusMessageTs) {
              await this.app.client.chat.update({
                channel,
                ts: statusMessageTs,
                text: '⚙️ *Working...*',
              });
            }

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, threadTs, say);
            }

            // For other tool use messages, always show in the current thread
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              const result = await this.app.client.chat.postMessage({
                token: config.slack.botToken,
                channel: channel,
                thread_ts: currentThreadTs,
                text: toolContent,
              });
              if (result.ts) {
                this.trackMessage(channel, currentThreadTs, 'assistant', toolContent, result.ts as string);
              }
            }
          } else {
            // Handle regular text content - always show in the current thread
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              const result = await this.app.client.chat.postMessage({
                token: config.slack.botToken,
                channel: channel,
                thread_ts: currentThreadTs,
                text: formatted,
              });
              if (result.ts) {
                this.trackMessage(channel, currentThreadTs, 'assistant', formatted, result.ts as string);
              }
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          // Show final result in the current thread
          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              const result = await this.app.client.chat.postMessage({
                token: config.slack.botToken,
                channel: channel,
                thread_ts: currentThreadTs,
                text: formatted,
              });
              if (result.ts) {
                this.trackMessage(channel, currentThreadTs, 'assistant', formatted, result.ts as string);
              }
            }
          }
        }
      }

      // Update status to completed
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: 'COMPLETED ✅ *Task completed*',
        });
      }

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
        executionThreadTs,
      });

      // NOTE: Summarization disabled - user wants full output in main thread
      // await this.checkAndSummarize(user, channel, executionThreadTs || threadTs);

      // Clean up temporary files
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        // Update status to error
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '❌ *Error occurred*',
          });
        }

        await say({
          text: `Error: ${error.message || 'Something went wrong'}`,
          thread_ts: threadTs,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        // Update status to cancelled
        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: '⏹️ *Cancelled*',
          });
        }
      }

      // Clean up temporary files in case of error too
      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      this.activeControllers.delete(sessionKey);
    }
  }

  private async handleCompleteCommand(channel: string, threadTs: string, deleteThread: boolean, say: any): Promise<void> {
    const sessionName = this.tmuxManager.getSession(channel, threadTs);

    if (!sessionName) {
      await say({
        text: '❌ No active session found for this thread.',
        thread_ts: threadTs,
      });
      return;
    }

    // Close the tmux session
    this.tmuxManager.closeSession(sessionName);

    // Clear the message queue
    this.messageQueue.clearQueue(channel, threadTs);

    // Remove from active controllers
    const sessionKey = this.claudeHandler.getSessionKey('', channel, threadTs);
    this.activeControllers.delete(sessionKey);

    if (deleteThread) {
      // Delete all messages in the thread
      await say({
        text: `🗑️ Session \`${sessionName}\` closed. Deleting thread...`,
        thread_ts: threadTs,
      });

      // Get all messages in thread and delete them
      try {
        const result = await this.app.client.conversations.replies({
          channel,
          ts: threadTs,
        });

        if (result.messages) {
          for (const msg of result.messages) {
            try {
              await this.app.client.chat.delete({
                channel,
                ts: msg.ts!,
              });
            } catch (err) {
              this.logger.debug('Failed to delete message', { ts: msg.ts, error: (err as Error).message });
            }
          }
        }
      } catch (error) {
        this.logger.error('Failed to delete thread', error);
      }
    } else {
      await say({
        text: `✅ Session \`${sessionName}\` closed. Thread preserved.`,
        thread_ts: threadTs,
      });
    }

    this.logger.info('Session completed', { sessionName, deleteThread });
  }

  private async handleConnectCommand(channel: string, threadTs: string, sessionName: string, say: any): Promise<void> {
    if (!sessionName) {
      await say({
        text: `❌ Please provide a session name: ${SESSION_COMMANDS.CONNECT} session_name`,
        thread_ts: threadTs,
      });
      return;
    }

    if (!this.tmuxManager.connectToSession(sessionName)) {
      await say({
        text: `❌ Session \`${sessionName}\` not found. Available sessions:\n${this.formatAvailableSessions()}`,
        thread_ts: threadTs,
      });
      return;
    }

    // Get working directory directly from the tmux session
    const workingDirectory = this.tmuxManager.getWorkingDirectory(sessionName);
    if (!workingDirectory) {
      await say({
        text: `❌ Failed to get working directory from session \`${sessionName}\``,
        thread_ts: threadTs,
      });
      return;
    }

    // Map this thread to the session
    if (!this.tmuxManager.mapThreadToSession(channel, threadTs, sessionName)) {
      await say({
        text: `❌ Failed to map thread to session \`${sessionName}\``,
        thread_ts: threadTs,
      });
      return;
    }

    // Set working directory for this thread
    const isDM = channel.startsWith('D');
    const result = this.workingDirManager.setWorkingDirectory(
      channel,
      workingDirectory,
      threadTs,
      isDM ? undefined : undefined
    );

    if (!result.success) {
      await say({
        text: `❌ Failed to set working directory: ${result.error}`,
        thread_ts: threadTs,
      });
      return;
    }

    this.logger.info('Set working directory for connected thread', {
      threadTs,
      workingDirectory: result.resolvedPath,
    });

    await say({
      text: formatSessionInfo(sessionName) + `\n\n📁 *Working Directory:* \`${result.resolvedPath}\``,
      thread_ts: threadTs,
    });

    this.logger.info('Connected to existing session', { sessionName, threadTs, workingDirectory: result.resolvedPath });
  }

  private async handleShowHistoryCommand(channel: string, threadTs: string, say: any): Promise<void> {
    const threadKey = `${channel}-${threadTs}`;
    const history = this.threadMessageHistory.get(threadKey) || [];
    const summaries = this.threadSummaries.get(threadKey) || [];

    if (history.length === 0 && summaries.length === 0) {
      await say({
        text: '📜 No conversation history available yet.',
        thread_ts: threadTs,
      });
      return;
    }

    let historyText = '📜 *Full Conversation History*\n\n';

    // Add summaries first
    if (summaries.length > 0) {
      historyText += '*Previous Summaries:*\n';
      summaries.forEach((summary, index) => {
        historyText += `\n*Summary ${index + 1}:*\n${summary}\n`;
      });
      historyText += '\n---\n\n';
    }

    // Add current messages
    if (history.length > 0) {
      historyText += '*Recent Messages:*\n\n';
      history.forEach(msg => {
        const roleIcon = msg.role === 'user' ? '👤' : '🤖';
        historyText += `${roleIcon} **${msg.role}**: ${msg.content}\n\n`;
      });
    }

    await say({
      text: historyText,
      thread_ts: threadTs,
    });
  }

  private trackMessage(channel: string, threadTs: string, role: 'user' | 'assistant', content: string, ts: string): void {
    const threadKey = `${channel}-${threadTs}`;

    if (!this.threadMessageHistory.has(threadKey)) {
      this.threadMessageHistory.set(threadKey, []);
      this.threadMessageCount.set(threadKey, 0);
    }

    this.threadMessageHistory.get(threadKey)!.push({ role, content, ts });
    const count = this.threadMessageCount.get(threadKey)! + 1;
    this.threadMessageCount.set(threadKey, count);

    this.logger.debug('Tracked message', { threadKey, role, count });
  }

  private async checkAndSummarize(user: string, channel: string, threadTs: string): Promise<void> {
    const threadKey = `${channel}-${threadTs}`;
    const count = this.threadMessageCount.get(threadKey) || 0;

    // Summarize every 10 messages
    if (count >= 10 && count % 10 === 0) {
      await this.summarizeAndCleanup(user, channel, threadTs);
    }
  }

  private async summarizeAndCleanup(user: string, channel: string, threadTs: string): Promise<void> {
    const threadKey = `${channel}-${threadTs}`;
    const history = this.threadMessageHistory.get(threadKey) || [];
    const welcomeTs = this.threadWelcomeMessage.get(threadKey);

    if (history.length === 0) {
      return;
    }

    this.logger.info('Creating summary for thread', { threadKey, messageCount: history.length });

    try {
      // Create a prompt for Claude to summarize
      const conversationText = history.map(msg => `${msg.role}: ${msg.content}`).join('\n\n');
      const summaryPrompt = `Please summarize the following conversation in a short paragraph (2-3 sentences). Focus on what work was accomplished and key decisions made:\n\n${conversationText}`;

      // Get Claude session
      const session = this.claudeHandler.getSession(user, channel, threadTs);
      const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, threadTs, channel.startsWith('D') ? user : undefined);

      // Ask Claude for summary
      let summaryText = '';
      for await (const message of this.claudeHandler.streamQuery(summaryPrompt, session, undefined, workingDirectory)) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const content of message.message.content) {
            if (content.type === 'text') {
              summaryText += content.text;
            }
          }
        }
      }

      if (summaryText) {
        // Store the summary
        if (!this.threadSummaries.has(threadKey)) {
          this.threadSummaries.set(threadKey, []);
        }
        this.threadSummaries.get(threadKey)!.push(summaryText.trim());

        // Post the summary
        await this.app.client.chat.postMessage({
          token: config.slack.botToken,
          channel: channel,
          thread_ts: threadTs,
          text: `📝 *Summary of last 10 messages:*\n\n${summaryText.trim()}\n\n_Use ${SESSION_COMMANDS.SHOW_HISTORY} to see full history_`,
        });

        // Delete old messages (keep welcome message)
        const messagesToDelete = history.map(msg => msg.ts);
        for (const ts of messagesToDelete) {
          if (ts !== welcomeTs) {
            try {
              await this.app.client.chat.delete({
                token: config.slack.botToken,
                channel: channel,
                ts: ts,
              });
            } catch (error) {
              this.logger.warn('Failed to delete message', { ts, error });
            }
          }
        }

        // Clear current history but keep summaries
        this.threadMessageHistory.set(threadKey, []);

        this.logger.info('Successfully summarized and cleaned up thread', { threadKey });
      }
    } catch (error) {
      this.logger.error('Failed to create summary', { threadKey, error });
    }
  }

  private formatAvailableSessions(): string {
    const sessions = this.tmuxManager.getAllSessions();
    if (sessions.length === 0) {
      return '_No active sessions_';
    }

    return sessions.map(s => `• \`${s.sessionName}\``).join('\n');
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });

      // Write approval response via IPC so the MCP server process can read it
      PermissionMCPServer.writeApprovalResponse(approvalId, true);

      await respond({
        response_type: 'ephemeral',
        text: '✅ Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      // Write denial response via IPC so the MCP server process can read it
      PermissionMCPServer.writeApprovalResponse(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: '❌ Tool execution denied'
      });
    });

    // Handle plan approval button clicks
    this.app.action('approve_plan', async ({ ack, body, respond }) => {
      await ack();
      try {
        const data = JSON.parse((body as any).actions[0].value);
        const { approvalId } = data;
        this.logger.info('Plan approved', { approvalId });

        // Write approval response via IPC so canUseTool can read it
        ClaudeHandler.writePlanApprovalResponse(approvalId, true);

        await respond({
          response_type: 'ephemeral',
          text: '✅ Plan approved - executing...'
        });
      } catch (error) {
        this.logger.error('Failed to parse plan approval data', error);
        await respond({
          response_type: 'ephemeral',
          text: '❌ Error processing approval'
        });
      }
    });

    // Handle plan denial button clicks
    this.app.action('deny_plan', async ({ ack, body, respond }) => {
      await ack();
      try {
        const data = JSON.parse((body as any).actions[0].value);
        const { approvalId } = data;
        this.logger.info('Plan denied', { approvalId });

        // Write denial response via IPC so canUseTool can read it
        ClaudeHandler.writePlanApprovalResponse(approvalId, false);

        await respond({
          response_type: 'ephemeral',
          text: '❌ Plan denied'
        });
      } catch (error) {
        this.logger.error('Failed to parse plan denial data', error);
        await respond({
          response_type: 'ephemeral',
          text: '❌ Error processing denial'
        });
      }
    });

    // Handle project selection button clicks
    this.app.action(/^select_project_/, async ({ ack, body, respond }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const data = JSON.parse(action.value);
        const { project, channel, threadTs, userId } = data;
        const user = (body as any).user.id;

        const path = require('path');
        const { execSync } = require('child_process');
        const projectPath = path.join(config.projectsDirectory, project);

        this.logger.info('Project selected', { project, projectPath, channel, threadTs, userId });

        // Set the working directory for this thread
        this.workingDirManager.setWorkingDirectory(channel, projectPath, threadTs, userId);

        // Create tmux session for this thread
        const sessionName = this.tmuxManager.createSession(channel, threadTs, projectPath);

        // Get git branch
        let gitBranch = 'unknown';
        try {
          gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: projectPath,
            encoding: 'utf8'
          }).trim();
        } catch (error) {
          this.logger.warn('Failed to get git branch', { projectPath, error });
        }

        // Delete the project selection message
        await this.app.client.chat.delete({
          token: config.slack.botToken,
          channel: channel,
          ts: (body as any).message.ts,
        });

        // Base welcome text with project info
        const baseWelcomeText = formatSessionInfo(sessionName) +
          `\n\n📁 *Project:* \`${project}\`` +
          `\n🌿 *Branch:* \`${gitBranch}\``;

        // Check if aliases are configured
        const aliases = config.claude.aliases;

        if (aliases.length > 0) {
          // Show alias selection first
          const aliasWelcomeText = baseWelcomeText + `\n\n🏷️ *Select which alias to use:*`;

          const welcomeMessageResult = await this.app.client.chat.postMessage({
            token: config.slack.botToken,
            channel: channel,
            thread_ts: threadTs,
            text: aliasWelcomeText,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: aliasWelcomeText,
                }
              },
              {
                type: 'actions',
                elements: aliases.map((alias: string) => ({
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: `claude-${alias}`,
                  },
                  value: JSON.stringify({
                    channel,
                    threadTs,
                    user,
                    alias,
                  }),
                  action_id: `select_alias_${alias}`,
                }))
              }
            ]
          });

          // Store the welcome message timestamp
          if (welcomeMessageResult.ts) {
            const threadKey = `${channel}-${threadTs}`;
            this.threadWelcomeMessage.set(threadKey, welcomeMessageResult.ts);
          }
        } else {
          // No aliases configured, go directly to permission selection
          const welcomeText = baseWelcomeText + `\n\n🔐 *Choose permission mode:*`;

          const welcomeMessageResult = await this.app.client.chat.postMessage({
            token: config.slack.botToken,
            channel: channel,
            thread_ts: threadTs,
            text: welcomeText,
            blocks: [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: welcomeText,
                }
              },
              {
                type: 'actions',
                elements: [
                  {
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: '🚀 Unlimited Permissions (Recommended)',
                    },
                    value: JSON.stringify({
                      channel,
                      threadTs,
                      user,
                      skipPermissions: true,
                    }),
                    action_id: 'set_unlimited_permissions',
                    style: 'primary',
                  },
                  {
                    type: 'button',
                    text: {
                      type: 'plain_text',
                      text: '🛡️ Ask for Each Permission',
                    },
                    value: JSON.stringify({
                      channel,
                      threadTs,
                      user,
                      skipPermissions: false,
                    }),
                    action_id: 'set_ask_permissions',
                  }
                ]
              }
            ]
          });

          // Store the welcome message timestamp
          if (welcomeMessageResult.ts) {
            const threadKey = `${channel}-${threadTs}`;
            this.threadWelcomeMessage.set(threadKey, welcomeMessageResult.ts);
          }
        }

        // Alias or permission selection will handle processing the pending message
      } catch (error) {
        this.logger.error('Failed to handle project selection', error);
        await respond({
          response_type: 'ephemeral',
          text: `❌ Failed to set working directory: ${(error as Error).message}`
        });
      }
    });

    // Handle alias selection
    this.app.action(/^select_alias_/, async ({ ack, body, respond }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const data = JSON.parse(action.value);
        const { channel, threadTs, user, alias } = data;

        this.logger.info('Alias selected', { channel, threadTs, user, alias });

        // Get or create session and set alias
        let session = this.claudeHandler.getSession(user, channel, threadTs);
        if (!session) {
          this.logger.info('Creating new session for alias selection', { user, channel, threadTs });
          session = this.claudeHandler.createSession(user, channel, threadTs);
        }
        session.alias = alias;

        this.logger.info('Session alias set', {
          sessionKey: this.claudeHandler.getSessionKey(user, channel, threadTs),
          alias: session.alias,
        });

        // Get the original welcome message text and update it to show permission selection
        const originalMessage = (body as any).message;
        const originalText = originalMessage.blocks?.[0]?.text?.text || originalMessage.text;

        // Remove the alias selection prompt and add alias confirmation + permission prompt
        const aliasNote = `\n\n🏷️ *Using alias:* \`claude-${alias}\``;
        const permissionPrompt = `\n\n🔐 *Choose permission mode:*`;

        // Extract base text (remove the alias selection prompt)
        const baseText = originalText.replace(/\n\n🏷️ \*Select which alias to use:\*$/, '');

        await this.app.client.chat.update({
          token: config.slack.botToken,
          channel: channel,
          ts: (body as any).message.ts,
          text: baseText + aliasNote + permissionPrompt,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: baseText + aliasNote + permissionPrompt,
              }
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '🚀 Unlimited Permissions (Recommended)',
                  },
                  value: JSON.stringify({
                    channel,
                    threadTs,
                    user,
                    skipPermissions: true,
                  }),
                  action_id: 'set_unlimited_permissions',
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '🛡️ Ask for Each Permission',
                  },
                  value: JSON.stringify({
                    channel,
                    threadTs,
                    user,
                    skipPermissions: false,
                  }),
                  action_id: 'set_ask_permissions',
                }
              ]
            }
          ]
        });
      } catch (error) {
        this.logger.error('Failed to handle alias selection', error);
        await respond({
          response_type: 'ephemeral',
          text: `❌ Failed to set alias: ${(error as Error).message}`
        });
      }
    });

    // Handle permission mode selection
    this.app.action(/^set_(unlimited|ask)_permissions$/, async ({ ack, body, respond }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const data = JSON.parse(action.value);
        const { channel, threadTs, user, skipPermissions } = data;

        this.logger.info('Permission mode selected', { channel, threadTs, user, skipPermissions });

        // Get or create session and set permission mode
        let session = this.claudeHandler.getSession(user, channel, threadTs);
        if (!session) {
          this.logger.info('Creating new session for permission selection', { user, channel, threadTs });
          session = this.claudeHandler.createSession(user, channel, threadTs);
        }
        session.skipPermissions = skipPermissions;

        this.logger.info('Session permission mode set', {
          sessionKey: this.claudeHandler.getSessionKey(user, channel, threadTs),
          skipPermissions: session.skipPermissions,
          sessionId: session.sessionId,
        });

        // Get the original welcome message text and update it (don't delete it)
        const originalMessage = (body as any).message;
        const originalText = originalMessage.blocks?.[0]?.text?.text || originalMessage.text;

        // Update the message to show permission confirmation and ask about plan mode
        const permissionNote = skipPermissions
          ? `\n\n🚀 *Unlimited permissions enabled*`
          : `\n\n🛡️ *Permission prompts enabled* - I'll ask before each action`;

        const planModePrompt = `\n\n🎯 *Would you like to use plan mode?*`;

        await this.app.client.chat.update({
          token: config.slack.botToken,
          channel: channel,
          ts: (body as any).message.ts,
          text: originalText + permissionNote + planModePrompt,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: originalText + permissionNote + planModePrompt,
              }
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '🎯 Use Plan Mode',
                  },
                  value: JSON.stringify({
                    channel,
                    threadTs,
                    user,
                    usePlanMode: true,
                  }),
                  action_id: 'set_plan_mode',
                  style: 'primary',
                },
                {
                  type: 'button',
                  text: {
                    type: 'plain_text',
                    text: '🚀 Skip Plan Mode',
                  },
                  value: JSON.stringify({
                    channel,
                    threadTs,
                    user,
                    usePlanMode: false,
                  }),
                  action_id: 'skip_plan_mode',
                }
              ]
            }
          ]
        });

        // Pending message will be processed after plan mode selection
      } catch (error) {
        this.logger.error('Failed to handle permission selection', error);
        await respond({
          response_type: 'ephemeral',
          text: `❌ Failed to set permission mode: ${(error as Error).message}`
        });
      }
    });

    // Handle plan mode selection
    this.app.action(/^(set_plan_mode|skip_plan_mode)$/, async ({ ack, body, respond }) => {
      await ack();

      try {
        const action = (body as any).actions[0];
        const data = JSON.parse(action.value);
        const { channel, threadTs, user, usePlanMode } = data;

        this.logger.info('Plan mode selection', { channel, threadTs, user, usePlanMode });

        // Get session and set plan mode preference
        let session = this.claudeHandler.getSession(user, channel, threadTs);
        if (!session) {
          this.logger.error('Session not found for plan mode selection', { user, channel, threadTs });
          await respond({
            response_type: 'ephemeral',
            text: `❌ Session not found. Please try again.`
          });
          return;
        }

        session.usePlanMode = usePlanMode;
        session.inPlanMode = usePlanMode; // Start in plan mode if enabled

        this.logger.info('Session plan mode set', {
          sessionKey: this.claudeHandler.getSessionKey(user, channel, threadTs),
          usePlanMode: session.usePlanMode,
          inPlanMode: session.inPlanMode,
        });

        // Update the message to remove buttons and show final configuration
        const originalMessage = (body as any).message;
        const originalText = originalMessage.blocks?.[0]?.text?.text || originalMessage.text;

        const planModeNote = usePlanMode
          ? `\n\n🎯 *Plan mode enabled* - I'll create a plan first, then execute in a separate thread\n\n💬 What would you like me to help you with?`
          : `\n\n🚀 *Plan mode skipped* - I'll start working immediately\n\n💬 What would you like me to help you with?`;

        await this.app.client.chat.update({
          token: config.slack.botToken,
          channel: channel,
          ts: (body as any).message.ts,
          text: originalText + planModeNote,
        });

        // Check if there's a pending message to process
        const threadKey = `${channel}-${threadTs}`;
        const pendingMessage = this.pendingThreadMessages.get(threadKey);
        if (pendingMessage) {
          this.pendingThreadMessages.delete(threadKey);

          // Get working directory
          const workingDirectory = this.workingDirManager.getWorkingDirectory(channel, threadTs, channel.startsWith('D') ? user : undefined);

          if (workingDirectory) {
            // Process the pending message
            const command = parseSessionCommand(pendingMessage);
            this.messageQueue.enqueue(channel, threadTs, {
              text: command.messageText,
              files: [],
              timestamp: Date.now(),
              isInterrupt: false,
            });

            // Create a say function for this thread
            const say = async (message: any) => {
              await this.app.client.chat.postMessage({
                token: config.slack.botToken,
                channel: channel,
                thread_ts: threadTs,
                ...message,
              });
            };

            // Start processing the queue
            this.processMessageQueue(user, channel, threadTs, workingDirectory, say);
          }
        }
      } catch (error) {
        this.logger.error('Failed to handle plan mode selection', error);
        await respond({
          response_type: 'ephemeral',
          text: `❌ Failed to set plan mode: ${(error as Error).message}`
        });
      }
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  private isScrollHistoryCommand(text: string): boolean {
    // Match scroll emoji (📜) followed by optional space and a number
    return /📜\s*\d+/.test(text.trim());
  }

  private parseScrollHistoryCount(text: string): number {
    const match = text.trim().match(/📜\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 10; // Default to 10 if no match
  }

  private async handleScrollHistoryCommand(
    channel: string,
    threadTs: string,
    count: number,
    say: any
  ): Promise<void> {
    const threadKey = `${channel}-${threadTs}`;
    const history = this.threadMessageHistory.get(threadKey) || [];

    if (history.length === 0) {
      await say({
        text: '📜 No message history found for this thread.',
        thread_ts: threadTs,
      });
      return;
    }

    // Get the last X messages
    const lastMessages = history.slice(-count);

    // Format the messages
    let formatted = `📜 *Last ${lastMessages.length} message(s):*\n\n`;

    for (const msg of lastMessages) {
      const roleIcon = msg.role === 'user' ? '👤' : '🤖';
      const preview = msg.content.length > 200
        ? msg.content.substring(0, 200) + '...'
        : msg.content;

      formatted += `${roleIcon} **${msg.role}**:\n${preview}\n\n`;
    }

    await say({
      text: formatted,
      thread_ts: threadTs,
    });

    this.logger.info('Displayed scroll history', {
      threadKey,
      requestedCount: count,
      actualCount: lastMessages.length,
      totalMessages: history.length
    });
  }
}