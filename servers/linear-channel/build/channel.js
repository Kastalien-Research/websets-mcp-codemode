/**
 * Two-way Linear channel for Claude Code.
 *
 * Receives Linear webhook events (issue state changes, assignments, comments)
 * and provides tools for commenting, transitioning, assigning, and creating issues.
 *
 * Start with: node build/channel.js
 */
import { createHmac } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
const CHANNEL_PORT = parseInt(process.env.CHANNEL_PORT ?? "3004", 10);
const CHANNEL_HOST = process.env.CHANNEL_HOST ?? "127.0.0.1";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY;
const LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
const LINEAR_API_URL = "https://api.linear.app/graphql";
if (!LINEAR_API_KEY) {
    console.error("LINEAR_API_KEY is required.");
    process.exit(1);
}
// --- Linear GraphQL client ---
async function linearQuery(query, variables) {
    const res = await fetch(LINEAR_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: LINEAR_API_KEY,
        },
        body: JSON.stringify({ query, variables }),
    });
    const json = (await res.json());
    if (json.errors) {
        throw new Error(`Linear API error: ${json.errors.map((e) => e.message).join(", ")}`);
    }
    return json.data;
}
// --- Webhook signature verification ---
function verifySignature(body, signature) {
    if (!LINEAR_WEBHOOK_SECRET)
        return true;
    if (!signature)
        return false;
    const expected = createHmac("sha256", LINEAR_WEBHOOK_SECRET).update(body).digest("hex");
    return signature === expected;
}
function formatEvent(payload) {
    const { action, type, data } = payload;
    const meta = {
        event_type: `${type}.${action}`,
        action,
        resource_type: type,
    };
    if (data.id)
        meta.issue_id = String(data.id);
    if (data.identifier)
        meta.identifier = String(data.identifier);
    if (data.teamKey)
        meta.team = String(data.teamKey);
    const content = JSON.stringify({
        action,
        type,
        identifier: data.identifier,
        title: data.title,
        state: data.state ? data.state.name : undefined,
        priority: data.priority,
        assignee: data.assignee ? data.assignee.name : undefined,
        labels: data.labels
            ? data.labels.map((l) => l.name)
            : undefined,
        description: data.description
            ? String(data.description).slice(0, 500)
            : undefined,
        url: payload.url ?? data.url,
    }, null, 2);
    return { content, meta };
}
// --- Channel ---
export function startChannel() {
    const mcp = new Server({ name: "linear-channel", version: "0.1.0" }, {
        capabilities: {
            experimental: { "claude/channel": {} },
            tools: {},
        },
        instructions: "Linear events arrive as <channel> notifications. Attributes include: " +
            "event_type (Issue.create, Issue.update, Comment.create, etc.), action (create, update, remove), " +
            "resource_type (Issue, Comment, Project, Cycle), identifier (e.g. ENG-123), team. " +
            "The body contains issue details: title, state, priority, assignee, labels, description. " +
            "Available tools: comment_on_issue, transition_issue, assign_issue, create_issue, list_issues. " +
            "Use the workflow config at /workspaces/schwartz13/data/workflow-configs.json for automated responses.",
    });
    // -- Tools --
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "comment_on_issue",
                description: "Add a comment to a Linear issue.",
                inputSchema: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Linear issue ID (UUID)" },
                        body: { type: "string", description: "Comment body (Markdown)" },
                    },
                    required: ["issue_id", "body"],
                },
            },
            {
                name: "transition_issue",
                description: "Move a Linear issue to a different state (e.g. In Progress, Done, Cancelled).",
                inputSchema: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Linear issue ID (UUID)" },
                        state_name: { type: "string", description: "Target state name (e.g. 'In Progress', 'Done', 'Todo')" },
                    },
                    required: ["issue_id", "state_name"],
                },
            },
            {
                name: "assign_issue",
                description: "Assign a Linear issue to a team member.",
                inputSchema: {
                    type: "object",
                    properties: {
                        issue_id: { type: "string", description: "Linear issue ID (UUID)" },
                        assignee_email: { type: "string", description: "Email of the team member to assign" },
                    },
                    required: ["issue_id", "assignee_email"],
                },
            },
            {
                name: "create_issue",
                description: "Create a new Linear issue.",
                inputSchema: {
                    type: "object",
                    properties: {
                        team_key: { type: "string", description: "Team key (e.g. 'ENG')" },
                        title: { type: "string", description: "Issue title" },
                        description: { type: "string", description: "Issue description (Markdown)" },
                        priority: { type: "number", description: "Priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low" },
                        state_name: { type: "string", description: "Initial state name (default: Backlog)" },
                        labels: { type: "array", items: { type: "string" }, description: "Label names to apply" },
                    },
                    required: ["team_key", "title"],
                },
            },
            {
                name: "list_issues",
                description: "List issues with optional filters.",
                inputSchema: {
                    type: "object",
                    properties: {
                        team_key: { type: "string", description: "Filter by team key" },
                        state: { type: "string", description: "Filter by state name" },
                        assignee_email: { type: "string", description: "Filter by assignee email" },
                        limit: { type: "number", description: "Max results (default 20)" },
                    },
                },
            },
        ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = req.params.arguments;
        switch (req.params.name) {
            case "comment_on_issue": {
                const data = (await linearQuery(`mutation($issueId: String!, $body: String!) {
            commentCreate(input: { issueId: $issueId, body: $body }) {
              success
              comment { id body }
            }
          }`, { issueId: args.issue_id, body: args.body }));
                return {
                    content: [{ type: "text", text: `Comment added (id: ${data.commentCreate.comment.id})` }],
                };
            }
            case "transition_issue": {
                // First find the state ID by name
                const states = (await linearQuery(`query { workflowStates { nodes { id name } } }`));
                const target = states.workflowStates.nodes.find((s) => s.name.toLowerCase() === args.state_name.toLowerCase());
                if (!target) {
                    return {
                        content: [{
                                type: "text",
                                text: `State "${args.state_name}" not found. Available: ${states.workflowStates.nodes.map((s) => s.name).join(", ")}`,
                            }],
                        isError: true,
                    };
                }
                await linearQuery(`mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }`, { id: args.issue_id, stateId: target.id });
                return {
                    content: [{ type: "text", text: `Issue transitioned to "${target.name}"` }],
                };
            }
            case "assign_issue": {
                // Find user by email
                const users = (await linearQuery(`query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id name } } }`, { email: args.assignee_email }));
                if (!users.users.nodes.length) {
                    return {
                        content: [{ type: "text", text: `No user found with email "${args.assignee_email}"` }],
                        isError: true,
                    };
                }
                const userId = users.users.nodes[0].id;
                await linearQuery(`mutation($id: String!, $assigneeId: String!) {
            issueUpdate(id: $id, input: { assigneeId: $assigneeId }) { success }
          }`, { id: args.issue_id, assigneeId: userId });
                return {
                    content: [{ type: "text", text: `Issue assigned to ${users.users.nodes[0].name}` }],
                };
            }
            case "create_issue": {
                // Find team ID by key
                const teams = (await linearQuery(`query { teams { nodes { id key } } }`));
                const team = teams.teams.nodes.find((t) => t.key.toLowerCase() === args.team_key.toLowerCase());
                if (!team) {
                    return {
                        content: [{
                                type: "text",
                                text: `Team "${args.team_key}" not found. Available: ${teams.teams.nodes.map((t) => t.key).join(", ")}`,
                            }],
                        isError: true,
                    };
                }
                const input = {
                    teamId: team.id,
                    title: args.title,
                    description: args.description,
                    priority: args.priority,
                };
                // Resolve state if provided
                if (args.state_name) {
                    const states = (await linearQuery(`query($teamId: String!) { team(id: $teamId) { states { nodes { id name } } } }`, { teamId: team.id }));
                    const state = states.team.states.nodes.find((s) => s.name.toLowerCase() === args.state_name.toLowerCase());
                    if (state)
                        input.stateId = state.id;
                }
                // Resolve labels if provided
                if (args.labels && args.labels.length > 0) {
                    const allLabels = (await linearQuery(`query { issueLabels { nodes { id name } } }`));
                    const labelIds = args.labels
                        .map((name) => allLabels.issueLabels.nodes.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id)
                        .filter(Boolean);
                    if (labelIds.length)
                        input.labelIds = labelIds;
                }
                const data = (await linearQuery(`mutation($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue { id identifier title url }
            }
          }`, { input }));
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({
                                identifier: data.issueCreate.issue.identifier,
                                title: data.issueCreate.issue.title,
                                url: data.issueCreate.issue.url,
                                id: data.issueCreate.issue.id,
                            }, null, 2),
                        }],
                };
            }
            case "list_issues": {
                const limit = args.limit ?? 20;
                const filters = [];
                if (args.team_key)
                    filters.push(`team: { key: { eq: "${args.team_key}" } }`);
                if (args.state)
                    filters.push(`state: { name: { eq: "${args.state}" } }`);
                if (args.assignee_email)
                    filters.push(`assignee: { email: { eq: "${args.assignee_email}" } }`);
                const filterStr = filters.length ? `filter: { ${filters.join(", ")} }` : "";
                const data = (await linearQuery(`query { issues(first: ${limit}, ${filterStr}, orderBy: updatedAt) {
            nodes { id identifier title state { name } priority assignee { name } labels { nodes { name } } url updatedAt }
          } }`));
                const issues = data.issues.nodes.map((i) => ({
                    identifier: i.identifier,
                    title: i.title,
                    state: i.state?.name,
                    priority: i.priority,
                    assignee: i.assignee?.name,
                    labels: (i.labels?.nodes ?? []).map((l) => l.name),
                    url: i.url,
                }));
                return {
                    content: [{
                            type: "text",
                            text: JSON.stringify({ count: issues.length, issues }, null, 2),
                        }],
                };
            }
            default:
                throw new Error(`Unknown tool: ${req.params.name}`);
        }
    });
    // -- Webhook listener --
    const app = express();
    app.use(express.json({
        verify: (req, _res, buf) => {
            req.rawBody = buf.toString("utf-8");
        },
    }));
    app.post("/webhook", async (req, res) => {
        const signature = req.headers["linear-signature"];
        if (LINEAR_WEBHOOK_SECRET && !verifySignature(req.rawBody ?? "", signature)) {
            console.error("Linear webhook signature verification failed");
            res.sendStatus(401);
            return;
        }
        const payload = req.body;
        if (!payload.type || !payload.action) {
            res.sendStatus(200);
            return;
        }
        try {
            const { content, meta } = formatEvent(payload);
            await mcp.notification({
                method: "notifications/claude/channel",
                params: { content, meta },
            });
        }
        catch (err) {
            console.error("Failed to push Linear notification:", err);
        }
        res.sendStatus(200);
    });
    app.get("/health", (_req, res) => {
        res.json({ status: "ok", secret_configured: !!LINEAR_WEBHOOK_SECRET });
    });
    app.listen(CHANNEL_PORT, CHANNEL_HOST, () => {
        console.error(`Linear channel webhook listener on http://${CHANNEL_HOST}:${CHANNEL_PORT}/webhook`);
    });
    // -- Stdio transport --
    const transport = new StdioServerTransport();
    mcp.connect(transport).then(() => {
        console.error("Linear channel connected via stdio");
    });
}
startChannel();
