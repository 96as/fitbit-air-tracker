/**
 * MCP server stub (Phase 4) — the AI-agent surface of this app.
 *
 * The tool contracts are defined now so the data model and services stay
 * agent-compatible as they evolve. Phase 4 wires these definitions into a real
 * MCP server (@modelcontextprotocol/sdk) whose handlers call the SAME services
 * the REST API uses — agents get full parity with the frontend, nothing more.
 *
 * Until then, GET /api/v1/mcp/tools serves these definitions for discovery.
 */

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const mcpTools: McpToolDefinition[] = [
  {
    name: 'get_sleep_sessions',
    description:
      'Normalized sleep sessions (stages, efficiency, timestamps in ISO-8601 UTC) for a date range.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date' },
        to: { type: 'string', format: 'date' },
        limit: { type: 'number', default: 30 },
      },
    },
  },
  {
    name: 'get_prayer_times',
    description: 'Prayer timetable for a local date (includes lastthird/midnight for Qiyam).',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', format: 'date' } },
    },
  },
  {
    name: 'get_tonight_plan',
    description: 'Tonight’s wake plan: prayer time, hard deadline, wake window, policy in force.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_wake_outcomes',
    description:
      'Alarm event history (scheduled/fired/snoozed/dismissed with fire reasons) — the feedback signal for optimizing wake timing.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 100 } },
    },
  },
  {
    name: 'set_alarm_policy',
    description:
      'Adjust a per-prayer alarm policy (window length, deadline offset, preferred stages, snooze). This is the agent’s actuator.',
    inputSchema: {
      type: 'object',
      required: ['prayer'],
      properties: {
        prayer: { type: 'string', enum: ['fajr', 'qiyam', 'suhoor', 'dhuhr', 'asr', 'maghrib', 'isha'] },
        enabled: { type: 'boolean' },
        windowMinutes: { type: 'number', minimum: 5, maximum: 120 },
        deadlineOffsetMinutes: { type: 'number', minimum: 0, maximum: 120 },
        preferredStages: { type: 'array', items: { type: 'string', enum: ['awake', 'light', 'deep', 'rem'] } },
        snoozeMinutes: { type: 'number' },
        maxSnoozes: { type: 'number' },
      },
    },
  },
];
