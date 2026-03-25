---
name: dedalus-sdk
description: >
  Work with the Dedalus TypeScript SDK for managing cloud workspaces, executing commands,
  streaming events, and deploying MCP servers. Use this skill when the user mentions
  Dedalus, cloud workspaces, workspace executions, workspace previews, deploying to
  Dedalus, the Dedalus API, or building on the Dedalus platform. Also use when the user
  needs to create/manage cloud VMs, run remote commands, expose ports, stream execution
  output, or connect terminals via WebSocket.
---

# Dedalus TypeScript SDK

Dedalus is an AI agent execution platform. The TypeScript SDK (`dedalus` on npm, v0.0.3)
is Stainless-generated and provides typed access to the full workspace lifecycle API.

> Source repo: `dedalus-labs/dedalus-typescript` (MIT license)

## SDK Installation

```bash
pnpm add dedalus
```

```ts
import Dedalus from 'dedalus';

const client = new Dedalus({
  apiKey: process.env.DEDALUS_API_KEY,       // Bearer auth
  xAPIKey: process.env.DEDALUS_X_API_KEY,    // x-api-key header auth
  dedalusOrgID: process.env.DEDALUS_ORG_ID,  // org scoping
  baseURL: process.env.DEDALUS_BASE_URL,     // override default
});
```

## API Surface

### Workspaces

Cloud VMs with configurable compute. The fundamental unit of infrastructure.

```ts
// Create
const ws = await client.workspaces.create({
  memory_mib: 2048,
  storage_gib: 10,
  vcpu: 1,
});

// Retrieve
const workspace = await client.workspaces.retrieve(ws.workspace_id);

// Update (requires ETag for optimistic concurrency)
await client.workspaces.update(ws.workspace_id, {
  'If-Match': workspace.status.revision,
  memory_mib: 4096,
});

// List (cursor-paginated)
for await (const item of client.workspaces.list()) {
  console.log(item.workspace_id, item.status.phase);
}

// Delete (requires ETag)
await client.workspaces.delete(ws.workspace_id, {
  'If-Match': workspace.status.revision,
});
```

#### Workspace lifecycle phases

```
accepted → placement_pending → starting → running → stopping → sleeping → destroying → destroyed
                                                                                    └→ failed
```

#### Watch lifecycle (SSE stream)

```ts
const stream = await client.workspaces.watch(ws.workspace_id);
for await (const status of stream) {
  console.log(status.status.phase, status.status.reason);
  if (status.status.phase === 'running') break;
}
```

Resume a previous stream with `Last-Event-ID`:

```ts
const stream = await client.workspaces.watch(ws.workspace_id, {
  'Last-Event-ID': lastEventId,
});
```

### Executions

Run commands inside a workspace. Each execution is an isolated process.

```ts
// Create execution
const exec = await client.workspaces.executions.create(workspaceId, {
  command: ['node', 'dist/index.js'],
  cwd: '/app',
  env: { PORT: '7860', API_KEY: 'sk-...' },
  stdin: 'optional stdin input',
  timeout_ms: 300_000,
});
// exec.execution_id, exec.status
```

#### Execution statuses

```
wake_in_progress → queued → running → succeeded | failed | cancelled | expired
```

#### Stream execution events

Events are cursor-paginated with three types: `lifecycle`, `stdout`, `stderr`.

```ts
for await (const event of client.workspaces.executions.events(
  exec.execution_id,
  { workspace_id: workspaceId },
)) {
  switch (event.type) {
    case 'stdout':
      process.stdout.write(event.chunk ?? '');
      break;
    case 'stderr':
      process.stderr.write(event.chunk ?? '');
      break;
    case 'lifecycle':
      console.log(`Status: ${event.status}`);
      break;
  }
}
```

#### Get execution output (after completion)

```ts
const output = await client.workspaces.executions.output(
  exec.execution_id,
  { workspace_id: workspaceId },
);
// output.stdout, output.stderr, output.stdout_truncated, output.stderr_truncated
```

#### Poll until done

```ts
async function waitForExecution(
  client: Dedalus,
  workspaceId: string,
  executionId: string,
): Promise<{ status: string; stdout?: string; stderr?: string }> {
  const terminal = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
  while (true) {
    const exec = await client.workspaces.executions.retrieve(
      executionId,
      { workspace_id: workspaceId },
    );
    if (terminal.has(exec.status)) {
      const output = await client.workspaces.executions.output(
        executionId,
        { workspace_id: workspaceId },
      );
      return { status: exec.status, ...output };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

### Previews

Expose a workspace port as a public HTTPS URL.

```ts
// Create preview
const preview = await client.workspaces.previews.create(workspaceId, {
  port: 7860,
  protocol: 'http',  // or 'https'
});
// preview.url → https://<id>.preview.dedalus.dev
// preview.status: 'wake_in_progress' | 'ready' | 'closed' | 'expired' | 'failed'

// List previews
for await (const p of client.workspaces.previews.list(workspaceId)) {
  console.log(p.preview_id, p.url, p.status);
}

// Delete
await client.workspaces.previews.delete(preview.preview_id, {
  workspace_id: workspaceId,
});
```

### Artifacts

Binary objects attached to a workspace (e.g. build outputs, logs, data files).

```ts
// List
for await (const artifact of client.workspaces.artifacts.list(workspaceId)) {
  console.log(artifact);
}

// Retrieve
const artifact = await client.workspaces.artifacts.retrieve(artifactId, {
  workspace_id: workspaceId,
});

// Delete
await client.workspaces.artifacts.delete(artifactId, {
  workspace_id: workspaceId,
});
```

Executions can reference artifacts via `ArtifactRef`:

```ts
interface ArtifactRef {
  artifact_id: string;
  name: string;
}
```

### SSH Sessions

Create SSH connections to a workspace.

```ts
const session = await client.workspaces.ssh.create(workspaceId, {
  /* SSHSessionCreateParams */
});

for await (const s of client.workspaces.ssh.list(workspaceId)) {
  console.log(s);
}
```

### Terminals (WebSocket)

Interactive terminal sessions over WebSocket. Provides real-time I/O streaming.

```ts
import { TerminalsWS } from 'dedalus/resources/workspaces/terminals/ws';

const terminal = await client.workspaces.terminals.create(workspaceId, {
  height: 24, width: 80,
});

// WebSocket connection — async iterator for real-time streaming
const ws = new TerminalsWS(client, workspaceId, terminal.terminal_id);

for await (const event of ws.stream()) {
  switch (event.type) {
    case 'open':
      ws.send({ type: 'input', data: 'ls -la\n' });
      break;
    case 'message':
      if (event.message.type === 'output') {
        process.stdout.write(event.message.data);
      }
      break;
    case 'error':
      console.error(event.error);
      break;
    case 'close':
      break;
  }
}

// Cleanup
ws.close();
await client.workspaces.terminals.delete(terminal.terminal_id, {
  workspace_id: workspaceId,
});
```

Terminal statuses: `wake_in_progress` | `ready` | `closed` | `expired` | `failed`

## Common Deployment Pattern

Deploy a server to a Dedalus workspace and expose it:

```ts
import Dedalus from 'dedalus';

const client = new Dedalus();

// 1. Create workspace
const ws = await client.workspaces.create({
  memory_mib: 2048, storage_gib: 10, vcpu: 1,
});

// 2. Wait until running
const stream = await client.workspaces.watch(ws.workspace_id);
for await (const s of stream) {
  if (s.status.phase === 'running') break;
  if (s.status.phase === 'failed') throw new Error(s.status.last_error);
}

// 3. Deploy code
const deploy = await client.workspaces.executions.create(ws.workspace_id, {
  command: ['bash', '-c',
    'git clone https://github.com/org/repo /app && cd /app && npm ci && npm run build'
  ],
  timeout_ms: 120_000,
});
await waitForExecution(client, ws.workspace_id, deploy.execution_id);

// 4. Start server
const server = await client.workspaces.executions.create(ws.workspace_id, {
  command: ['node', '/app/dist/index.js'],
  env: { PORT: '7860', API_KEY: process.env.API_KEY! },
});

// 5. Expose port
const preview = await client.workspaces.previews.create(ws.workspace_id, {
  port: 7860,
});
console.log(`Server available at: ${preview.url}`);
```

## MCP Server SDK Patterns

The Dedalus SDK includes an MCP server package (`dedalus-mcp`) that implements the
Code Mode pattern. Key patterns worth reusing:

### Deno sandbox for code execution

Execute LLM-generated code in a restricted Deno subprocess with `--allow-read`,
`--allow-net` (API host only), and `--allow-env`. Provides stronger isolation than
Node.js `vm` module. See the channel-bridge skill for how this connects to Claude Code.

### SDK proxy with fuzzy method suggestions

Wrap the SDK client in a `Proxy` that catches invalid method paths and suggests
corrections via Fuse.js fuzzy search:

```ts
// When LLM calls client.workspace.creat() (typo):
// → Error: client.workspace.creat is not a function.
//   Did you mean: client.workspaces.create, client.workspaces.retrieve, ...
```

### TypeScript diagnostics pre-flight

Parse submitted code with the TS compiler before execution. Extract the `run` function
body, type-check it against the real SDK types, and reject with diagnostics if there
are errors. Catches type mismatches before burning execution time.

### Method allow/block lists

Regex-based filtering of which SDK methods the LLM can call. Support for
`--code-allow-http-gets` (read-only), `--code-allowed-methods`, and
`--code-blocked-methods` CLI flags.

## DedalusRunner (Python SDK)

The Python SDK (`dedalus-labs`) exposes a `DedalusRunner` that natively consumes MCP
servers as a parameter:

```python
runner = DedalusRunner(AsyncDedalus())
result = await runner.run(
    input="Query the websets API for ...",
    model="openai/gpt-4.1",
    mcp_servers=["your-org/your-mcp-server"],
    tools=[local_function],
    stream=True,
)
```

This means MCP servers deployed to Dedalus can be discovered and used by agents on
the platform without additional integration work.
