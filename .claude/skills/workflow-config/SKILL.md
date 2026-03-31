---
name: workflow-config
description: View, add, modify, or remove per-source workflow configurations. These configs control how channel events are routed to workflow chains. Manages data/workflow-configs.json.
argument-hint: [list | show <route_id> | add | remove <route_id> | add-step <step_name> | steps]
user-invocable: true
allowed-tools: Read, Write
---

Manage workflow configurations at `/workspaces/schwartz13/data/workflow-configs.json`.

## Commands

### `list` — Show all configured routes
Read the config file and display a table of all routes: ID, name, channel, event triggers.

### `show <route_id>` — Show details of one route
Display the full config for a specific route including its step chain, gate conditions, and parameters.

### `add` — Add a new route interactively
Ask the user for:
1. Route ID (typically matching a webset ID, inbox ID, or base ID)
2. Human-readable name
3. Channel source (websets-channel, google-workspace-channel, airtable-channel)
4. Event type(s) to trigger on
5. Gate conditions (optional)
6. Steps to execute (reference names from the `steps` library)
7. Step-specific parameter overrides

Write the new route to the config file.

### `remove <route_id>` — Remove a route
Delete the specified route from the config. Confirm with the user first.

### `steps` — List all available step definitions
Display the reusable step library with descriptions.

### `add-step <step_name>` — Add a new reusable step definition
Ask the user for:
1. Step name (kebab-case)
2. Description
3. Type (server-workflow, mcp-execute, channel-tool, notify)
4. Workflow name or tool reference
5. Parameter template (with `{{variable}}` placeholders)
6. Output gate condition (optional)

Write the new step to the config's `steps` section.

## Validation

When writing changes, verify:
- Route IDs are unique
- Referenced step names exist in the `steps` library
- Gate conditions have valid `field`, `op` (>=, <=, ==, !=, contains), and `value`
- `{{variable}}` placeholders in params_template use valid variable names
