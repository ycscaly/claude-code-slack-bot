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

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `⚠️ No working directory set. `;
      
      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }
      
      await say({
        text: errorMessage,
        thread_ts: actualThreadTs,
      });
      return;
    }

    // NEW SESSION-BASED QUEUING SYSTEM
    // If this is a threaded message (or becomes a thread), handle via queue
    if (actualThreadTs) {
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
        workingDirectory,
        fileCount: processedFiles.length,
      });

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

            // Check for TodoWrite tool and handle it specially
            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, threadTs, say);
            }

            // For other tool use messages, format them immediately as new messages
            const toolContent = this.formatToolUse(message.message.content);
            if (toolContent) { // Only send if there's content (TodoWrite returns empty string)
              await say({
                text: toolContent,
                thread_ts: threadTs,
              });
            }
          } else {
            // Handle regular text content
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              // Send each new piece of content as a separate message
              const formatted = this.formatMessage(content, false);
              await say({
                text: formatted,
                thread_ts: threadTs,
              });
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
              await say({
                text: formatted,
                thread_ts: threadTs,
              });
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

    // Get the session mapping to retrieve working directory
    const sessionMapping = this.tmuxManager.getSessionByName(sessionName);
    if (!sessionMapping) {
      await say({
        text: `❌ Failed to retrieve session information for \`${sessionName}\``,
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
    if (sessionMapping.workingDirectory) {
      const isDM = channel.startsWith('D');
      this.workingDirManager.setWorkingDirectory(
        channel,
        sessionMapping.workingDirectory,
        threadTs,
        isDM ? undefined : undefined
      );
      this.logger.info('Set working directory for connected thread', {
        threadTs,
        workingDirectory: sessionMapping.workingDirectory,
      });
    }

    await say({
      text: formatSessionInfo(sessionName) + `\n\n📁 *Working Directory:* \`${sessionMapping.workingDirectory || 'Not set'}\``,
      thread_ts: threadTs,
    });

    this.logger.info('Connected to existing session', { sessionName, threadTs, workingDirectory: sessionMapping.workingDirectory });
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

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}