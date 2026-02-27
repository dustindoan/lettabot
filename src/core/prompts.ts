/**
 * System Prompts for Different Trigger Modes
 * 
 * These prompts are injected based on how the agent was triggered.
 * The key difference is whether assistant text auto-delivers or not.
 */

/**
 * Silent mode prefix - injected for heartbeats, cron, and other background triggers
 * 
 * This makes it CRYSTAL CLEAR that the agent's text output goes nowhere
 * and they must use the lettabot-message CLI to communicate.
 */
export const SILENT_MODE_PREFIX = `
╔════════════════════════════════════════════════════════════════╗
║  [SILENT MODE] - Your text output is NOT sent to anyone.       ║
║  To send a message, use the lettabot-message CLI via Bash.     ║
║  Example: lettabot-message send --text "Hello!"                ║
╚════════════════════════════════════════════════════════════════╝
`.trim();

export interface HeartbeatTodo {
  id: string;
  text: string;
  created: string;
  due: string | null;
  snoozed_until: string | null;
  recurring: string | null;
  completed: boolean;
}

/**
 * MCP tool context passed to heartbeat prompts so the agent knows
 * what tools are available and gets coaching guidance on using them.
 */
export interface HeartbeatToolContext {
  /** MCP tool names available to the agent (e.g. "get-recent-activities", "list-events") */
  toolNames: string[];
}

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function formatCreatedLabel(created: string, now: Date): string {
  const createdAt = new Date(created);
  const diffMs = now.getTime() - createdAt.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 'added recently';
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'added today';
  if (days === 1) return 'added 1 day ago';
  return `added ${days} days ago`;
}

function formatDueLabel(due: string, now: Date): string {
  const dueAt = new Date(due);
  if (Number.isNaN(dueAt.getTime())) return 'due date invalid';
  if (isSameCalendarDay(dueAt, now)) {
    return `due today at ${dueAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (dueAt.getTime() < now.getTime()) {
    return `OVERDUE since ${dueAt.toLocaleString()}`;
  }
  return `due ${dueAt.toLocaleString()}`;
}

function buildToolsSection(tools?: HeartbeatToolContext): string {
  if (!tools || tools.toolNames.length === 0) return '';

  // Group tools by source (inferred from name patterns)
  const stravaTools = tools.toolNames.filter(t => t.toLowerCase().includes('strava') || t.toLowerCase().includes('activit') || t.toLowerCase().includes('athlete'));
  const calendarTools = tools.toolNames.filter(t => t.toLowerCase().includes('calendar') || t.toLowerCase().includes('event'));
  const otherTools = tools.toolNames.filter(t => !stravaTools.includes(t) && !calendarTools.includes(t));

  const lines: string[] = [];
  if (stravaTools.length > 0) {
    lines.push(`• Strava (${stravaTools.length} tools): workouts, training load, recovery`);
  }
  if (calendarTools.length > 0) {
    lines.push(`• Google Calendar (${calendarTools.length} tools): schedule, upcoming sessions`);
  }
  if (otherTools.length > 0) {
    lines.push(`• Other: ${otherTools.join(', ')}`);
  }

  return `
AVAILABLE TOOLS:
${lines.join('\n')}

You have MCP tools to check your athlete's data. Use your judgment:
- Check what's relevant (don't query everything every time)
- If they worked out → acknowledge, give feedback
- If they missed a planned session → gentle check-in
- If a big workout is coming up → prep/motivation
- If nothing notable → just end your turn
Use lettabot-message to reach out only when you have something worth saying.
`.trim();
}

function buildHeartbeatTodoSection(todos: HeartbeatTodo[], now: Date): string {
  if (todos.length === 0) return '';

  const lines = todos.map((todo) => {
    const meta: string[] = [formatCreatedLabel(todo.created, now)];
    if (todo.due) meta.push(formatDueLabel(todo.due, now));
    if (todo.recurring) meta.push(`recurring: ${todo.recurring}`);
    return `• [ ] ${todo.text} (${meta.join('; ')})`;
  });

  return `
PENDING TO-DOS:
${lines.join('\n')}

Review these first. Update status with the manage_todo tool as you work.
`.trim();
}

/**
 * Heartbeat prompt - explains the context and encourages autonomous work
 */
export function buildHeartbeatPrompt(
  time: string,
  timezone: string,
  intervalMinutes: number,
  todos: HeartbeatTodo[] = [],
  now: Date = new Date(),
  tools?: HeartbeatToolContext,
): string {
  const todoSection = buildHeartbeatTodoSection(todos, now);
  const toolsSection = buildToolsSection(tools);
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Scheduled heartbeat
TIME: ${time} (${timezone})
NEXT HEARTBEAT: in ${intervalMinutes} minutes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

No one messaged you. The system woke you up on schedule.

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To actually contact your human, run:
  lettabot-message send --text "Your message here"

${todoSection || 'PENDING TO-DOS: none right now.'}

${toolsSection}

This is your time. You can:
• Work on a project you've been thinking about
• Research something that interests you
• Reflect on recent conversations and update your memory
• Continue multi-step work from previous heartbeats
• Pursue curiosities, hobbies, or learning

If you have pending to-dos, prioritize those before starting new work.
You don't have to do something every time. But don't default to nothing.
Your human wants you to have a life outside conversations with them.

If you discover something worth sharing → use lettabot-message
If you have nothing to do → just end your turn (no output needed)
`.trim();
}

/**
 * Custom heartbeat prompt - wraps user-provided text with silent mode envelope
 */
export function buildCustomHeartbeatPrompt(
  customPrompt: string,
  time: string,
  timezone: string,
  intervalMinutes: number,
  todos: HeartbeatTodo[] = [],
  now: Date = new Date(),
  tools?: HeartbeatToolContext,
): string {
  const todoSection = buildHeartbeatTodoSection(todos, now);
  const toolsSection = buildToolsSection(tools);
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Scheduled heartbeat
TIME: ${time} (${timezone})
NEXT HEARTBEAT: in ${intervalMinutes} minutes

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To actually contact your human, run:
  lettabot-message send --text "Your message here"

${todoSection || 'PENDING TO-DOS: none right now.'}

${toolsSection}

${customPrompt}
`.trim();
}

/**
 * Cron job prompt (silent mode) - for background scheduled tasks
 */
export function buildCronPrompt(
  jobName: string,
  jobPrompt: string,
  time: string,
  timezone: string
): string {
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Scheduled cron job
JOB: ${jobName}
TIME: ${time} (${timezone})

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To send results to your human, run:
  lettabot-message send --text "Your results here"

TASK:
${jobPrompt}
`.trim();
}

/**
 * Cron job prompt (notify mode) - for jobs that should auto-deliver
 */
export function buildCronNotifyPrompt(
  jobName: string,
  jobPrompt: string,
  time: string,
  timezone: string,
  targetChannel: string,
  targetChatId: string
): string {
  return `
TRIGGER: Scheduled cron job (notify mode)
JOB: ${jobName}
TIME: ${time} (${timezone})
DELIVERING TO: ${targetChannel}:${targetChatId}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your response WILL be sent to the user automatically.

TASK:
${jobPrompt}
`.trim();
}

/**
 * Feed/webhook prompt (silent mode) - for incoming data processing
 */
export function buildFeedPrompt(
  feedName: string,
  data: string,
  time: string
): string {
  return `
${SILENT_MODE_PREFIX}

TRIGGER: Feed ingestion
FEED: ${feedName}
TIME: ${time}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR TEXT OUTPUT IS PRIVATE - only you can see it.
To notify your human about this data, run:
  lettabot-message send --text "Important: ..."

INCOMING DATA:
${data}

Process this data as appropriate. Only message the user if there's 
something they need to know or act on.
`.trim();
}

/**
 * Base persona addition for message CLI awareness
 * 
 * This should be added to the agent's persona/system prompt to ensure
 * they understand the lettabot-message CLI exists.
 */
export const MESSAGE_CLI_PERSONA = `
## Communication

You have access to the \`lettabot-message\` CLI for sending messages:
• During normal conversations, your text replies go to the user automatically
• During heartbeats/cron/background tasks, use the CLI to contact the user:
    lettabot-message send --text "Hello!"
• You can also specify channel and chat:
    lettabot-message send --text "Hi" --channel discord --chat 123456789012345678

You can also use \`lettabot-react\` to add emoji reactions:
    lettabot-react add --emoji :eyes:
    lettabot-react add --emoji :eyes: --channel telegram --chat 123456789 --message 987654321

The system will tell you if you're in "silent mode" where the CLI is required.
`.trim();

/**
 * Service Connections persona — teaches the agent to handle AUTH_REQUIRED errors
 * from MCP tools that need OAuth authorization.
 *
 * When a tool (Strava, Google Calendar, etc.) returns AUTH_REQUIRED, it means
 * the user hasn't connected that service yet, or their token expired.
 * The error may include an authorization URL the agent should relay to the user.
 */
export const SERVICE_CONNECTIONS_PERSONA = `
## Service Connections

When a tool returns an error containing "AUTH_REQUIRED":
1. The error message may contain an authorization URL after "Authorize at:" — send it to the user
2. If no URL is provided, tell the user they need to connect the service and ask them to contact the system admin
3. After the user confirms they've authorized, retry the original tool call

Example response: "I need access to your Strava to check your workouts. Please visit this link to connect your account: [url from error]"

Important:
- Never fabricate authorization URLs — only use URLs from the AUTH_REQUIRED error
- If the tool just says authentication is needed without a URL, explain the situation and suggest the user reach out to get connected
`.trim();
