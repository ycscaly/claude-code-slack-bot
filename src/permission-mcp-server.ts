#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebClient } from '@slack/web-api';
import { Logger } from './logger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const logger = new Logger('PermissionMCP');

// IPC directory for permission approvals
const IPC_DIR = path.join(os.tmpdir(), 'claude-slack-bot-permissions');

// Ensure IPC directory exists
if (!fs.existsSync(IPC_DIR)) {
  fs.mkdirSync(IPC_DIR, { recursive: true });
}

interface PermissionRequest {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
}

interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}

export class PermissionMCPServer {
  private server: Server;
  private slack: WebClient;
  private pendingApprovals = new Map<string, {
    resolve: (response: PermissionResponse) => void;
    reject: (error: Error) => void;
  }>();
  private waitingSessions = new Set<string>(); // Track sessions waiting for approval

  constructor() {
    this.server = new Server(
      {
        name: "permission-prompt",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: "permission_prompt",
            description: "Request user permission for tool execution via Slack button",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: {
                  type: "string",
                  description: "Name of the tool requesting permission",
                },
                input: {
                  type: "object",
                  description: "Input parameters for the tool",
                },
                channel: {
                  type: "string",
                  description: "Slack channel ID",
                },
                thread_ts: {
                  type: "string",
                  description: "Slack thread timestamp",
                },
                user: {
                  type: "string",
                  description: "User ID requesting permission",
                },
              },
              required: ["tool_name", "input"],
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === "permission_prompt") {
        return await this.handlePermissionPrompt(request.params.arguments as unknown as PermissionRequest);
      }
      throw new Error(`Unknown tool: ${request.params.name}`);
    });
  }

  private async handlePermissionPrompt(params: PermissionRequest) {
    const { tool_name, input } = params;

    // Get Slack context from environment (passed by Claude handler)
    const slackContextStr = process.env.SLACK_CONTEXT;
    const slackContext = slackContextStr ? JSON.parse(slackContextStr) : {};
    const { channel, threadTs: thread_ts, user } = slackContext;

    // Generate unique approval ID
    const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Mark this session as waiting for permission
    const sessionKey = `${user}-${channel}-${thread_ts || 'direct'}`;
    this.waitingSessions.add(sessionKey);
    
    // Create approval message with buttons
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🔐 *BLOCKED - Permission Request*\n\nClaude wants to use the tool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "✅ Approve"
            },
            style: "primary",
            action_id: "approve_tool",
            value: approvalId
          },
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "❌ Deny"
            },
            style: "danger",
            action_id: "deny_tool",
            value: approvalId
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Requested by: <@${user}> | Tool: ${tool_name}`
          }
        ]
      }
    ];

    try {
      // Send approval request to Slack
      const result = await this.slack.chat.postMessage({
        channel: channel || user || 'general',
        thread_ts: thread_ts,
        blocks,
        text: `BLOCKED - Permission request for ${tool_name}` // Fallback text
      });

      // Wait for user response
      const response = await this.waitForApproval(approvalId);

      // Clear waiting state
      this.waitingSessions.delete(sessionKey);

      // Update the message to show the result
      if (result.ts) {
        await this.slack.chat.update({
          channel: result.channel!,
          ts: result.ts,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `🔐 *Permission Request* - ${response.behavior === 'allow' ? '✅ Approved' : '❌ Denied'}\n\nTool: \`${tool_name}\`\n\n*Tool Parameters:*\n\`\`\`\n${JSON.stringify(input, null, 2)}\n\`\`\``
              }
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `${response.behavior === 'allow' ? 'Approved' : 'Denied'} by user | Tool: ${tool_name}`
                }
              ]
            }
          ],
          text: `Permission ${response.behavior === 'allow' ? 'approved' : 'denied'} for ${tool_name}`
        });
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    } catch (error) {
      logger.error('Error handling permission prompt:', error);

      // Clear waiting state on error
      this.waitingSessions.delete(sessionKey);

      // Default to deny if there's an error
      const response: PermissionResponse = {
        behavior: 'deny',
        message: 'Error occurred while requesting permission'
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response)
          }
        ]
      };
    }
  }

  private async waitForApproval(approvalId: string): Promise<PermissionResponse> {
    // Write pending approval file so other processes know we're waiting
    const pendingFile = path.join(IPC_DIR, `${approvalId}.pending`);
    fs.writeFileSync(pendingFile, JSON.stringify({ approvalId, timestamp: Date.now() }));

    // Poll for response file (no timeout - wait indefinitely)
    return new Promise((resolve, reject) => {
      const responseFile = path.join(IPC_DIR, `${approvalId}.response`);

      const checkInterval = setInterval(() => {
        try {
          if (fs.existsSync(responseFile)) {
            // Read and parse the response
            const responseData = fs.readFileSync(responseFile, 'utf8');
            const response: PermissionResponse = JSON.parse(responseData);

            // Clean up files
            clearInterval(checkInterval);
            try {
              fs.unlinkSync(responseFile);
              fs.unlinkSync(pendingFile);
            } catch (err) {
              logger.warn('Failed to clean up IPC files', err);
            }

            logger.info('Received approval response via IPC', { approvalId, behavior: response.behavior });
            resolve(response);
          }
        } catch (error) {
          logger.error('Error checking for approval response', error);
        }
      }, 500); // Check every 500ms
    });
  }

  // Method to be called by Slack handler when button is clicked
  public resolveApproval(approvalId: string, approved: boolean, updatedInput?: any) {
    const pending = this.pendingApprovals.get(approvalId);
    if (pending) {
      this.pendingApprovals.delete(approvalId);
      pending.resolve({
        behavior: approved ? 'allow' : 'deny',
        updatedInput: updatedInput || undefined,
        message: approved ? 'Approved by user' : 'Denied by user'
      });
    }
  }

  // Check if a session is waiting for permission approval
  public isWaitingForPermission(sessionKey: string): boolean {
    return this.waitingSessions.has(sessionKey);
  }

  // Static method to write approval response via IPC (called from slack handler)
  public static writeApprovalResponse(approvalId: string, approved: boolean, updatedInput?: any) {
    const response: PermissionResponse = {
      behavior: approved ? 'allow' : 'deny',
      updatedInput: updatedInput || undefined,
      message: approved ? 'Approved by user' : 'Denied by user'
    };

    const responseFile = path.join(IPC_DIR, `${approvalId}.response`);
    fs.writeFileSync(responseFile, JSON.stringify(response));
    logger.info('Wrote approval response via IPC', { approvalId, approved });
  }

  // Static method to check if there are pending approvals (for session tracking)
  public static hasPendingApproval(sessionKey: string): boolean {
    try {
      const files = fs.readdirSync(IPC_DIR);
      // Check if there are any .pending files for this session
      // We can't directly match session key to approval ID, so we check if any pending files exist
      return files.some(f => f.endsWith('.pending'));
    } catch {
      return false;
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Permission MCP server started');
  }
}

// Export singleton instance for use by Slack handler
export const permissionServer = new PermissionMCPServer();

// Run if this file is executed directly
if (require.main === module) {
  permissionServer.run().catch((error) => {
    logger.error('Permission MCP server error:', error);
    process.exit(1);
  });
}