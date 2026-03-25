# Agent Instructions

This example is a Docker-first MCP server. Treat it as an application inside the parent
workspace, not as a standalone repo or published npm package.

## Current Ground Truth

- Prefer Docker workflows first.
- Do not assume `npx`, Claude Desktop package installs, or npm publishing flows are valid.
- Do not assume local `.claude/skills/` content is the source of truth for agent behavior.
- For the load-bearing server skill in this refactor, use
  `/workspaces/openchatwidget/.agents/skills/code-mode-servers/SKILL.md`.

## Practical Commands

```bash
docker compose up --build
npm run build
npm test
```

## Cleanup Direction

- Keep docs aligned with Docker-first HTTP operation.
- Remove stale agent scaffolding instead of trying to preserve historical prompts.
- Avoid introducing new packaging or publish assumptions until a non-Docker path is
  intentionally designed.
