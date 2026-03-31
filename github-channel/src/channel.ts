/**
 * One-way GitHub channel for Claude Code.
 *
 * Receives GitHub webhook events (PRs, issues, CI, reviews, pushes)
 * and pushes them as channel notifications into a Claude Code session.
 *
 * Start with: node build/channel.js
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";

const CHANNEL_PORT = parseInt(process.env.CHANNEL_PORT ?? "3003", 10);
const CHANNEL_HOST = process.env.CHANNEL_HOST ?? "127.0.0.1";
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const VERBOSE = process.env.CHANNEL_VERBOSE === "1";

// Events we always push (high-signal)
const HIGH_SIGNAL_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  "issues",
  "issue_comment",
  "check_run",
  "check_suite",
  "workflow_run",
  "push",
  "release",
  "deployment_status",
]);

// --- Signature verification ---

function verifySignature(payload: string, signature: string | undefined): boolean {
  if (!WEBHOOK_SECRET) return true; // No secret configured, skip verification
  if (!signature) return false;

  const expected = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// --- Event formatting ---

interface GitHubEvent {
  action?: string;
  sender?: { login: string };
  repository?: { full_name: string; html_url: string };
  pull_request?: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
    body?: string;
    merged?: boolean;
    draft?: boolean;
  };
  issue?: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    user: { login: string };
    body?: string;
    labels?: Array<{ name: string }>;
  };
  comment?: {
    body: string;
    user: { login: string };
    html_url: string;
  };
  check_run?: {
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    check_suite?: { head_branch: string };
  };
  check_suite?: {
    status: string;
    conclusion: string | null;
    head_branch: string;
  };
  workflow_run?: {
    name: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    head_branch: string;
    event: string;
  };
  ref?: string;
  commits?: Array<{ message: string; author: { name: string } }>;
  release?: {
    tag_name: string;
    name: string;
    html_url: string;
    prerelease: boolean;
    body?: string;
  };
  deployment_status?: {
    state: string;
    environment: string;
    description?: string;
  };
}

function formatEvent(
  eventType: string,
  body: GitHubEvent
): { content: string; meta: Record<string, string> } {
  const repo = body.repository?.full_name ?? "unknown";
  const sender = body.sender?.login ?? "unknown";
  const action = body.action ?? "";

  const meta: Record<string, string> = {
    event_type: eventType,
    action,
    repo,
    sender,
  };

  let content = "";

  switch (eventType) {
    case "pull_request": {
      const pr = body.pull_request!;
      meta.pr_number = String(pr.number);
      meta.pr_state = pr.merged ? "merged" : pr.state;
      meta.branch = pr.head.ref;
      meta.base = pr.base.ref;
      content = JSON.stringify({
        title: pr.title,
        number: pr.number,
        action,
        state: pr.merged ? "merged" : pr.state,
        draft: pr.draft,
        author: pr.user.login,
        branch: `${pr.head.ref} → ${pr.base.ref}`,
        url: pr.html_url,
        body: pr.body?.slice(0, 500),
      }, null, 2);
      break;
    }

    case "pull_request_review": {
      const pr = body.pull_request!;
      meta.pr_number = String(pr.number);
      content = JSON.stringify({
        pr_title: pr.title,
        pr_number: pr.number,
        reviewer: sender,
        action,
        url: pr.html_url,
      }, null, 2);
      break;
    }

    case "issues": {
      const issue = body.issue!;
      meta.issue_number = String(issue.number);
      meta.issue_state = issue.state;
      content = JSON.stringify({
        title: issue.title,
        number: issue.number,
        action,
        state: issue.state,
        author: issue.user.login,
        labels: issue.labels?.map((l) => l.name),
        url: issue.html_url,
        body: issue.body?.slice(0, 500),
      }, null, 2);
      break;
    }

    case "issue_comment": {
      const issue = body.issue!;
      const comment = body.comment!;
      meta.issue_number = String(issue.number);
      content = JSON.stringify({
        issue_title: issue.title,
        issue_number: issue.number,
        commenter: comment.user.login,
        action,
        comment: comment.body.slice(0, 1000),
        url: comment.html_url,
      }, null, 2);
      break;
    }

    case "check_run": {
      const cr = body.check_run!;
      meta.check_status = cr.status;
      meta.check_conclusion = cr.conclusion ?? "pending";
      meta.branch = cr.check_suite?.head_branch ?? "";
      content = JSON.stringify({
        name: cr.name,
        status: cr.status,
        conclusion: cr.conclusion,
        branch: cr.check_suite?.head_branch,
        url: cr.html_url,
      }, null, 2);
      break;
    }

    case "workflow_run": {
      const wr = body.workflow_run!;
      meta.workflow_status = wr.status;
      meta.workflow_conclusion = wr.conclusion ?? "pending";
      meta.branch = wr.head_branch;
      content = JSON.stringify({
        name: wr.name,
        status: wr.status,
        conclusion: wr.conclusion,
        branch: wr.head_branch,
        trigger: wr.event,
        url: wr.html_url,
      }, null, 2);
      break;
    }

    case "push": {
      const commits = body.commits ?? [];
      const branch = body.ref?.replace("refs/heads/", "") ?? "";
      meta.branch = branch;
      meta.commit_count = String(commits.length);
      content = JSON.stringify({
        branch,
        commit_count: commits.length,
        commits: commits.slice(0, 5).map((c) => ({
          message: c.message.split("\n")[0],
          author: c.author.name,
        })),
      }, null, 2);
      break;
    }

    case "release": {
      const rel = body.release!;
      meta.tag = rel.tag_name;
      content = JSON.stringify({
        tag: rel.tag_name,
        name: rel.name,
        prerelease: rel.prerelease,
        url: rel.html_url,
        body: rel.body?.slice(0, 500),
      }, null, 2);
      break;
    }

    case "deployment_status": {
      const ds = body.deployment_status!;
      meta.deploy_state = ds.state;
      meta.environment = ds.environment;
      content = JSON.stringify({
        state: ds.state,
        environment: ds.environment,
        description: ds.description,
      }, null, 2);
      break;
    }

    default:
      content = JSON.stringify(body, null, 2).slice(0, 2000);
  }

  return { content, meta };
}

// --- Channel ---

export function startChannel(): void {
  const mcp = new Server(
    { name: "github-channel", version: "0.1.0" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
      },
      instructions:
        "GitHub events arrive as <channel> notifications. Attributes include: " +
        "event_type (pull_request, issues, issue_comment, check_run, workflow_run, push, release, deployment_status), " +
        "action (opened, closed, completed, created, etc.), repo (owner/name), sender (GitHub username), " +
        "and event-specific fields (pr_number, issue_number, branch, check_status, etc.). " +
        "The body contains structured event details. " +
        "Use the workflow config at /workspaces/schwartz13/data/workflow-configs.json to determine if any automated steps should run for this event.",
    }
  );

  const app = express();

  // Capture raw body for signature verification
  app.use(express.json({
    verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString("utf-8");
    },
  }));

  app.post("/webhook", async (req: express.Request & { rawBody?: string }, res) => {
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const eventType = req.headers["x-github-event"] as string | undefined;

    if (!eventType) {
      res.sendStatus(400);
      return;
    }

    // Verify signature if secret is configured
    if (WEBHOOK_SECRET && !verifySignature(req.rawBody ?? "", signature)) {
      console.error("GitHub webhook signature verification failed");
      res.sendStatus(401);
      return;
    }

    // Filter to high-signal events unless verbose
    if (!HIGH_SIGNAL_EVENTS.has(eventType) && !VERBOSE) {
      res.sendStatus(200);
      return;
    }

    try {
      const { content, meta } = formatEvent(eventType, req.body);
      await mcp.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      });
    } catch (err) {
      console.error("Failed to push GitHub notification:", err);
    }

    res.sendStatus(200);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", secret_configured: !!WEBHOOK_SECRET });
  });

  app.listen(CHANNEL_PORT, CHANNEL_HOST, () => {
    console.error(`GitHub channel webhook listener on http://${CHANNEL_HOST}:${CHANNEL_PORT}/webhook`);
  });

  const transport = new StdioServerTransport();
  mcp.connect(transport).then(() => {
    console.error("GitHub channel connected via stdio");
  });
}

startChannel();
