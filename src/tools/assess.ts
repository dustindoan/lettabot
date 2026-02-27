/**
 * OODA Tool — Cognitive loop checkpoint for the coaching agent.
 *
 * Forces the model through Observe → Orient → Decide → Directive before
 * generating any text. Registered as a Letta server-side tool with an
 * InitToolRule so the model physically cannot skip it.
 *
 * The tool itself is trivial — a Python function that returns the decide
 * string. The value is in the structured arguments the model must provide,
 * which sit in conversation history and activate coaching cognition before
 * action selection.
 */

import { upsertToolFromSource } from './letta-api.js';
import type { InitToolRule, ContinueToolRule } from '@letta-ai/letta-client/resources/agents/agents';

// ---------------------------------------------------------------------------
// Python tool source
// ---------------------------------------------------------------------------

const OODA_TOOL_SOURCE = `
def ooda(
    observe: str,
    orient: str,
    decide: str,
    directive: str,
) -> str:
    """Cognitive loop called at the start of every turn.

    You MUST call this tool before doing anything else. Work through each
    field in order — each one builds on the last.

    Args:
        observe: What concrete data do you have right now? State facts, not
            interpretations. Recent sessions, current plan state, what the
            athlete said, what surfaces are connected (calendar, Strava,
            memory), and where you have gaps in data.
        orient: What's happening with this athlete's training? Think as a
            coach. What patterns, risks, or opportunities do you see? What
            would an experienced coach focus on right now? This is where
            your coaching judgment lives — not action selection.
        decide: One of: "prescribe" (deliver training through surfaces —
            schedule sessions, update the plan), "schedule" (put specific
            sessions on the calendar), "adjust" (modify existing plan or
            sessions based on new data), "ask" (need specific info to
            proceed — ask exactly one focused question), "acknowledge"
            (confirm, encourage, or respond to something that doesn't
            require coaching action).
        directive: The specific next step. If acting on a surface, name it.
            "Put Tuesday's 6x400m session on the calendar at 6am" not
            "create a training plan."

    Returns:
        The decide string, which is stored in conversation history for
        reference.
    """
    return decide
`.trim();

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the OODA tool on the Letta server (idempotent via upsert).
 * Returns the tool ID.
 */
export async function ensureAssessTool(): Promise<string> {
  const tool = await upsertToolFromSource({
    source_code: OODA_TOOL_SOURCE,
    description: 'OODA cognitive loop — called automatically at the start of every turn.',
    tags: ['ooda', 'coaching'],
  });
  return tool.id;
}

// ---------------------------------------------------------------------------
// Tool Rules
// ---------------------------------------------------------------------------

/** Tool rule union type matching the SDK's AgentCreateParams.tool_rules */
export type ToolRule = InitToolRule | ContinueToolRule;

/**
 * Build the tool rules array for the OODA-first architecture.
 *
 * Two rules:
 * 1. InitToolRule ("run_first") — forces ooda as the first tool call
 *    every turn. Hard enforced via tool_choice="required" at the LLM API level.
 * 2. ContinueToolRule ("continue_loop") — keeps the agent stepping after
 *    ooda so it can call memory/calendar tools before generating text.
 */
export function buildAssessToolRules(): ToolRule[] {
  return [
    { tool_name: 'ooda', type: 'run_first' },
    { tool_name: 'ooda', type: 'continue_loop' },
  ];
}
