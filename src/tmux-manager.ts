import { execSync, spawn } from 'child_process';
import { Logger } from './logger';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const logger = new Logger('TmuxManager');

// Storage for session mappings
const SESSION_STORAGE_FILE = path.join(os.tmpdir(), 'claude-slack-bot-sessions.json');

export interface SessionMapping {
  threadKey: string; // channel-threadTs
  sessionName: string;
  createdAt: number;
  workingDirectory?: string;
}

export class TmuxManager {
  private sessions: Map<string, SessionMapping> = new Map();
  private sessionCounter: number = 0;

  constructor() {
    this.loadSessions();
  }

  private loadSessions() {
    try {
      if (fs.existsSync(SESSION_STORAGE_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_STORAGE_FILE, 'utf8'));
        this.sessions = new Map(data.sessions);
        this.sessionCounter = data.counter || 0;
        logger.info('Loaded session mappings', { count: this.sessions.size, counter: this.sessionCounter });
      }
    } catch (error) {
      logger.warn('Failed to load session mappings', error);
    }
  }

  private saveSessions() {
    try {
      const data = {
        sessions: Array.from(this.sessions.entries()),
        counter: this.sessionCounter,
      };
      fs.writeFileSync(SESSION_STORAGE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to save session mappings', error);
    }
  }

  private getThreadKey(channel: string, threadTs: string): string {
    return `${channel}-${threadTs}`;
  }

  createSession(channel: string, threadTs: string, workingDirectory?: string): string {
    const threadKey = this.getThreadKey(channel, threadTs);

    // Check if session already exists for this thread
    const existing = this.sessions.get(threadKey);
    if (existing && this.sessionExists(existing.sessionName)) {
      logger.info('Thread already has a session', { threadKey, sessionName: existing.sessionName });
      return existing.sessionName;
    }

    // Create new session
    this.sessionCounter++;
    const sessionName = `claude_slack_${String(this.sessionCounter).padStart(3, '0')}`;

    try {
      // Create tmux session
      const cmd = workingDirectory
        ? `tmux new-session -d -s "${sessionName}" -c "${workingDirectory}"`
        : `tmux new-session -d -s "${sessionName}"`;

      execSync(cmd);

      // Store mapping
      const mapping: SessionMapping = {
        threadKey,
        sessionName,
        createdAt: Date.now(),
        workingDirectory,
      };

      this.sessions.set(threadKey, mapping);
      this.saveSessions();

      logger.info('Created tmux session', { sessionName, threadKey, workingDirectory });
      return sessionName;
    } catch (error) {
      logger.error('Failed to create tmux session', error);
      throw new Error(`Failed to create tmux session: ${(error as Error).message}`);
    }
  }

  getSession(channel: string, threadTs: string): string | null {
    const threadKey = this.getThreadKey(channel, threadTs);
    const mapping = this.sessions.get(threadKey);

    if (mapping && this.sessionExists(mapping.sessionName)) {
      return mapping.sessionName;
    }

    return null;
  }

  sessionExists(sessionName: string): boolean {
    try {
      execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`);
      return true;
    } catch {
      return false;
    }
  }

  closeSession(sessionName: string): boolean {
    try {
      execSync(`tmux kill-session -t "${sessionName}"`);

      // Remove from mappings
      for (const [threadKey, mapping] of this.sessions.entries()) {
        if (mapping.sessionName === sessionName) {
          this.sessions.delete(threadKey);
          this.saveSessions();
          break;
        }
      }

      logger.info('Closed tmux session', { sessionName });
      return true;
    } catch (error) {
      logger.error('Failed to close tmux session', { sessionName, error });
      return false;
    }
  }

  getAllSessions(): SessionMapping[] {
    return Array.from(this.sessions.values()).filter(mapping =>
      this.sessionExists(mapping.sessionName)
    );
  }

  connectToSession(sessionName: string): boolean {
    return this.sessionExists(sessionName);
  }

  // Get session mapping by session name
  getSessionByName(sessionName: string): SessionMapping | null {
    for (const mapping of this.sessions.values()) {
      if (mapping.sessionName === sessionName) {
        return mapping;
      }
    }
    return null;
  }

  // Map a thread to an existing session
  mapThreadToSession(channel: string, threadTs: string, sessionName: string): boolean {
    const sessionMapping = this.getSessionByName(sessionName);
    if (!sessionMapping) {
      logger.warn('Cannot map thread to non-existent session', { sessionName });
      return false;
    }

    const threadKey = this.getThreadKey(channel, threadTs);
    const newMapping: SessionMapping = {
      threadKey,
      sessionName,
      createdAt: Date.now(),
      workingDirectory: sessionMapping.workingDirectory,
    };

    this.sessions.set(threadKey, newMapping);
    this.saveSessions();

    logger.info('Mapped thread to existing session', { threadKey, sessionName, workingDirectory: sessionMapping.workingDirectory });
    return true;
  }

  // Execute command in tmux session
  executeInSession(sessionName: string, command: string): void {
    try {
      // Send keys to tmux session
      execSync(`tmux send-keys -t "${sessionName}" "${command.replace(/"/g, '\\"')}" C-m`);
      logger.debug('Executed command in tmux session', { sessionName, command: command.substring(0, 100) });
    } catch (error) {
      logger.error('Failed to execute command in tmux session', { sessionName, error });
      throw error;
    }
  }

  // Capture output from tmux session
  captureOutput(sessionName: string, lines: number = 100): string {
    try {
      const output = execSync(`tmux capture-pane -t "${sessionName}" -p -S -${lines}`).toString();
      return output;
    } catch (error) {
      logger.error('Failed to capture tmux output', { sessionName, error });
      return '';
    }
  }

  // Get current working directory from tmux session
  getWorkingDirectory(sessionName: string): string | null {
    try {
      const cwd = execSync(`tmux display-message -t "${sessionName}" -p "#{pane_current_path}"`).toString().trim();
      logger.debug('Got working directory from tmux session', { sessionName, cwd });
      return cwd;
    } catch (error) {
      logger.error('Failed to get working directory from tmux session', { sessionName, error });
      return null;
    }
  }
}
