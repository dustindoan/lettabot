/**
 * Narrator Custom Tools — Python source code strings
 *
 * These are registered as Letta custom tools via the API.
 * They run inside Letta's tool execution sandbox and call
 * Letta's own REST API to read/write across agents.
 *
 * Each tool is a Python function with a docstring that Letta
 * uses to auto-generate the JSON schema.
 */

/**
 * The Letta base URL is injected at registration time via string interpolation.
 */
export function makeToolSources(lettaBaseUrl: string): Record<string, { source: string; description: string }> {
  const baseUrl = lettaBaseUrl.replace(/\/+$/, '');

  return {
    read_agent_conversations: {
      description: 'Read recent conversation messages from a coaching agent, with timestamps and temporal gaps.',
      source: `
import requests
from datetime import datetime, timezone

def read_agent_conversations(target_agent_id: str, limit: int = 50) -> str:
    """Read recent messages from a coaching agent's conversation history.

    Returns messages with timestamps and notes temporal gaps between interactions
    so you can see the rhythm of the coaching relationship.

    Args:
        target_agent_id: The Letta agent ID to read conversations from.
        limit: Maximum number of messages to return (default 50).

    Returns:
        A formatted string of recent messages with timestamps and gap annotations.
    """
    base_url = "${baseUrl}"
    resp = requests.get(
        f"{base_url}/v1/agents/{target_agent_id}/messages",
        params={"limit": limit},
        headers={"X-Letta-Source": "narrator-tool"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()

    messages = data if isinstance(data, list) else data.get("messages", [])
    if not messages:
        return "No messages found for this agent."

    lines = []
    prev_time = None
    for msg in messages:
        msg_type = msg.get("message_type", "unknown")
        content = msg.get("content", "")
        created = msg.get("created_at", "")

        if msg_type not in ("user_message", "assistant_message"):
            continue
        if not content:
            continue

        # Parse timestamp and note gaps
        current_time = None
        if created:
            try:
                current_time = datetime.fromisoformat(created.replace("Z", "+00:00"))
            except (ValueError, TypeError):
                pass

        if current_time and prev_time:
            gap = current_time - prev_time
            gap_hours = gap.total_seconds() / 3600
            if gap_hours > 24:
                days = int(gap_hours / 24)
                lines.append(f"  --- {days} day gap ---")
            elif gap_hours > 4:
                lines.append(f"  --- {int(gap_hours)} hour gap ---")

        role = "athlete" if msg_type == "user_message" else "coach"
        time_str = current_time.strftime("%Y-%m-%d %H:%M") if current_time else "unknown time"
        # Truncate long messages
        display = content[:500] + "..." if len(content) > 500 else content
        lines.append(f"[{time_str}] {role}: {display}")
        prev_time = current_time

    return "\\n".join(lines) if lines else "No user/assistant messages found."
`,
    },

    update_shared_block: {
      description: 'Update the value and optionally the description of an existing shared persona block. Changes propagate to all coaching agents.',
      source: `
import requests

def update_shared_block(block_id: str, new_value: str, description: str = "") -> str:
    """Update the value (and optionally the description) of an existing shared persona block.

    The block is shared by reference across all coaching agents, so this
    update propagates instantly to every agent. Updating the description
    changes how agents interpret and use the block — this is how you
    repurpose a block's meaning without changing its label.

    Args:
        block_id: The Letta block ID to update (e.g. "block-xxx").
        new_value: The new content for the block.
        description: Optional new description. If provided, changes how agents interpret this block.

    Returns:
        Confirmation message with the block label and new value length.
    """
    base_url = "${baseUrl}"
    body = {"value": new_value}
    if description:
        body["description"] = description
    resp = requests.patch(
        f"{base_url}/v1/blocks/{block_id}",
        json=body,
        headers={
            "Content-Type": "application/json",
            "X-Letta-Source": "narrator-tool",
        },
        timeout=30,
    )
    resp.raise_for_status()
    block = resp.json()
    label = block.get("label", "unknown")
    desc_note = f" Description updated." if description else ""
    return f"Updated block '{label}' ({block_id}). New value length: {len(new_value)} chars.{desc_note}"
`,
    },

    list_coaching_agents: {
      description: 'List all coaching agents (social selves), excluding the Narrator itself.',
      source: `
import requests

def list_coaching_agents() -> str:
    """List all coaching agents managed by lettabot, excluding the Narrator.

    Returns agent IDs, names, and last activity timestamps so you can
    decide which agents to read conversations from.

    Returns:
        A formatted list of coaching agents with their IDs and activity info.
    """
    base_url = "${baseUrl}"
    resp = requests.get(
        f"{base_url}/v1/agents/",
        params={"limit": 100},
        headers={"X-Letta-Source": "narrator-tool"},
        timeout=30,
    )
    resp.raise_for_status()
    agents = resp.json()
    if not isinstance(agents, list):
        agents = agents.get("agents", [])

    lines = []
    for agent in agents:
        name = agent.get("name", "unknown")
        agent_id = agent.get("id", "unknown")
        # Skip the Narrator
        if "narrator" in name.lower():
            continue
        created = agent.get("created_at", "unknown")
        lines.append(f"- {name} (id={agent_id}, created={created})")

    if not lines:
        return "No coaching agents found."
    return f"Found {len(lines)} coaching agent(s):\\n" + "\\n".join(lines)
`,
    },

    get_current_blocks: {
      description: 'Read current shared persona blocks from a coaching agent to see the current coaching identity.',
      source: `
import requests

def get_current_blocks(target_agent_id: str) -> str:
    """Read all persona/* blocks from a coaching agent's core memory.

    Returns the label, ID, description, and full content of each persona block
    so you can see the current state of the coaching identity.

    Args:
        target_agent_id: A coaching agent ID to read blocks from.

    Returns:
        Formatted listing of all persona blocks with their content.
    """
    base_url = "${baseUrl}"
    resp = requests.get(
        f"{base_url}/v1/agents/{target_agent_id}/core-memory/blocks",
        params={"limit": 50},
        headers={"X-Letta-Source": "narrator-tool"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    blocks = data if isinstance(data, list) else data.get("blocks", [])

    lines = []
    for block in blocks:
        label = block.get("label", "unknown")
        if not label.startswith("persona/"):
            continue
        block_id = block.get("id", "unknown")
        description = block.get("description", "no description")
        value = block.get("value", "")
        limit = block.get("limit", 0)
        lines.append(
            f"=== {label} ===\\n"
            f"ID: {block_id}\\n"
            f"Description: {description}\\n"
            f"Limit: {limit} chars | Used: {len(value)} chars\\n"
            f"Content:\\n{value}\\n"
        )

    if not lines:
        return "No persona/* blocks found on this agent."
    return "\\n".join(lines)
`,
    },
  };
}
