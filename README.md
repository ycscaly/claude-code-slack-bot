# Claude Code Slack Bot

A Slack bot that integrates with Claude Code SDK to provide AI-powered coding assistance directly in your Slack workspace.

## Features

- 🤖 Direct message support - chat with the bot privately
- 💬 Thread support - maintains conversation context within threads
- 🔄 Streaming responses - see Claude's responses as they're generated
- 📝 Markdown formatting - code blocks and formatting are preserved
- 🔧 Session management - maintains conversation context across messages
- ⚡ Real-time updates - messages update as Claude thinks
- 🎯 **Persistent tmux sessions** - each thread gets its own session
- 📬 **Message queuing** - queue messages while Claude works
- 🔀 **Parallel task execution** - run multiple tasks across different threads
- 🛑 **Interrupt support** - stop and redirect Claude with emoji commands
- ✅ **Clean thread management** - close sessions and optionally delete threads

## Prerequisites

- Node.js 18+ installed
- A Slack workspace where you can install apps
- Claude Code
- **tmux** installed (for session management)

## Setup

### 1. Clone and Install

```bash
git clone <your-repo>
cd claude-code-slack
npm install
```

### 2. Create Slack App

#### Option A: Using App Manifest (Recommended)
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From an app manifest"
3. Select your workspace
4. Paste the contents of `slack-app-manifest.json` (or `slack-app-manifest.yaml`)
5. Review and create the app

#### Option B: Manual Configuration
1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Choose "From scratch" and give your app a name
3. Select the workspace where you want to install it

### 3. Configure Slack App

After creating the app (either method), you need to:

#### Generate Tokens
1. Go to "OAuth & Permissions" and install the app to your workspace
2. Copy the "Bot User OAuth Token" (starts with `xoxb-`)
3. Go to "Basic Information" → "App-Level Tokens"
4. Generate a token with `connections:write` scope
5. Copy the token (starts with `xapp-`)

#### Get Signing Secret
1. Go to "Basic Information"
2. Copy the "Signing Secret"

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:
```env
# Slack App Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# Claude Code Configuration
# This is only needed if you don't use a Claude subscription

# ANTHROPIC_API_KEY=your-anthropic-api-key
# CLAUDE_CODE_USE_BEDROCK=1
# CLAUDE_CODE_USE_VERTEX=1
```

### 5. Run the Bot

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm run build
npm run prod
```

## Usage

### Session Management & Threading

The bot uses a sophisticated session management system where **each thread gets its own persistent tmux session**. This allows you to:
- Run multiple tasks in parallel across different threads
- Queue messages without interrupting current work
- Maintain persistent sessions that survive bot restarts
- Interrupt and redirect Claude when needed

#### Starting a New Session

Simply send a message in a channel or start a thread. The bot will create a new tmux session and display:

```
📦 Session: claude_slack_001

This thread is now connected to tmux session claude_slack_001.

Commands:
• 🛑 - Interrupt current execution
• 🗑️ - Complete & delete thread
• ✅ - Complete & keep thread
• 🔌 session_name - Connect to existing session
```

#### Message Queuing

While Claude is working on a task, you can send additional messages - they'll be queued automatically:

```
You: Implement the authentication system
Bot: 🤔 Thinking...

You: Also add tests when you're done
Bot: 📬 Message queued (1 messages in queue)

You: And update the README
Bot: 📬 Message queued (2 messages in queue)
```

Messages process **sequentially** in the order received. No more "aborted by user" errors!

#### Emoji Commands

**🛑 Interrupt** - Stop current execution and process this message immediately
```
You: 🛑 Stop! Do the database migration first
Bot: 🛑 Interrupted
     Processing new message: Stop! Do the database migration first
```
This clears the queue and aborts current work.

**🗑️ Complete & Delete** - Close the session and delete the entire thread
```
You: 🗑️
Bot: 🗑️ Session claude_slack_001 closed. Deleting thread...
```
All messages in the thread are deleted. Use this for a clean slate.

**✅ Complete & Keep** - Close the session but preserve the thread
```
You: ✅
Bot: ✅ Session claude_slack_001 closed. Thread preserved.
```
Session is closed but conversation history remains.

**🔌 Connect** - Connect to an existing tmux session
```
You: 🔌 claude_slack_001
Bot: 📦 Session: claude_slack_001
     [Connection confirmed]
```

#### Running Parallel Tasks

Start a new thread for each task - they all run independently:

```
Thread 1: Building frontend components
Thread 2: Writing API endpoints
Thread 3: Creating database migrations
```

Each thread has its own:
- Tmux session
- Message queue
- Independent execution

#### Session Persistence

Sessions are stored in `/tmp/claude-slack-bot-sessions.json` and survive bot restarts. Your work continues where you left off!

### Setting Working Directory

Before using Claude Code, you must set a working directory. This tells Claude where your project files are located.

#### Set working directory:

**Relative paths** (if BASE_DIRECTORY is configured):
```
cwd project-name
```

**Absolute paths**:
```
cwd /path/to/your/project
```
or
```
set directory /path/to/your/project
```

#### Check current working directory:
```
cwd
```
or
```
get directory
```

### Working Directory Scope

- **Direct Messages**: Working directory is set for the entire conversation
- **Channels**: Working directory is set for the entire channel (prompted when bot joins)
- **Threads**: Can override the channel/DM directory for a specific thread by mentioning the bot

### Base Directory Configuration

You can configure a base directory in your `.env` file to use relative paths:

```env
BASE_DIRECTORY=/Users/username/Code/
```

With this set, you can use:
- `cwd herd-website` → resolves to `/Users/username/Code/herd-website`
- `cwd /absolute/path` → uses absolute path directly

### Direct Messages
Simply send a direct message to the bot with your request:
```
@ClaudeBot Can you help me write a Python function to calculate fibonacci numbers?
```

### In Channels
When you first add the bot to a channel, it will ask for a default working directory for that channel.

Mention the bot in any channel where it's been added:
```
@ClaudeBot Please review this code and suggest improvements
```

### Thread-Specific Working Directories
You can override the channel's default working directory for a specific thread:
```
@ClaudeBot cwd different-project
@ClaudeBot Now help me with this specific project
```

### Threads
Reply in a thread to maintain conversation context. The bot will remember previous messages in the thread.

### File Uploads
You can upload files and images directly to any conversation:

#### Supported File Types:
- **Images**: JPG, PNG, GIF, WebP, SVG
- **Text Files**: TXT, MD, JSON, JS, TS, PY, Java, etc.
- **Documents**: PDF, DOCX (limited support)
- **Code Files**: Most programming languages

#### Usage:
1. Upload a file by dragging and dropping or using the attachment button
2. Add optional text to describe what you want Claude to do with the file
3. Claude will analyze the file content and provide assistance

**Note**: Files are temporarily downloaded for processing and automatically cleaned up after analysis.

### MCP (Model Context Protocol) Servers

The bot supports MCP servers to extend Claude's capabilities with additional tools and resources.

#### Setup MCP Servers

1. **Create MCP configuration file:**
   ```bash
   cp mcp-servers.example.json mcp-servers.json
   ```

2. **Configure your servers** in `mcp-servers.json`:
   ```json
   {
     "mcpServers": {
       "filesystem": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
       },
       "github": {
         "command": "npx", 
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": {
           "GITHUB_TOKEN": "your-token"
         }
       }
     }
   }
   ```

#### MCP Commands

- **View configured servers**: `mcp` or `servers`
- **Reload configuration**: `mcp reload`

#### Available MCP Servers

- **Filesystem**: File system access (`@modelcontextprotocol/server-filesystem`)
- **GitHub**: GitHub API integration (`@modelcontextprotocol/server-github`)
- **PostgreSQL**: Database access (`@modelcontextprotocol/server-postgres`)
- **Web Search**: Search capabilities (custom servers)

All MCP tools are automatically allowed and follow the pattern: `mcp__serverName__toolName`

## Advanced Configuration

### Using AWS Bedrock
Set these environment variables:
```env
CLAUDE_CODE_USE_BEDROCK=1
# AWS credentials should be configured via AWS CLI or IAM roles
```

### Using Google Vertex AI
Set these environment variables:
```env
CLAUDE_CODE_USE_VERTEX=1
# Google Cloud credentials should be configured
```

## Development

### Debug Mode

Enable debug logging by setting `DEBUG=true` in your `.env` file:
```env
DEBUG=true
```

This will show detailed logs including:
- Incoming Slack messages
- Claude SDK request/response details
- Session management operations
- Message streaming updates

### Project Structure
```
src/
├── index.ts                      # Application entry point
├── config.ts                     # Configuration management
├── types.ts                      # TypeScript type definitions
├── claude-handler.ts             # Claude Code SDK integration
├── slack-handler.ts              # Slack event handling & session orchestration
├── working-directory-manager.ts  # Working directory management
├── tmux-manager.ts               # Tmux session management
├── message-queue.ts              # Per-thread message queuing
├── session-commands.ts           # Emoji command parsing
├── permission-mcp-server.ts      # Permission approval via IPC
├── file-handler.ts               # File upload processing
├── todo-manager.ts               # Task list tracking
├── mcp-manager.ts                # MCP server configuration
└── logger.ts                     # Logging utility
```

### Available Scripts
- `npm run dev` - Start in development mode with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm start` - Run the compiled JavaScript
- `npm run prod` - Run production build

## Troubleshooting

### Bot not responding
1. Check that the bot is running (`npm run dev`)
2. Verify all environment variables are set correctly
3. Ensure the bot has been invited to the channel
4. Check Slack app permissions are configured correctly

### Authentication errors
1. Verify your Anthropic API key is valid
2. Check Slack tokens haven't expired
3. Ensure Socket Mode is enabled

### Message formatting issues
The bot converts Claude's markdown to Slack's formatting. Some complex formatting may not translate perfectly.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT