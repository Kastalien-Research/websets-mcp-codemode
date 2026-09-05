import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { workflowMetadata, type WorkflowMeta } from './types.js';

// Category display order for index resource
const CATEGORY_ORDER = ['retrieval', 'research', 'analysis', 'monitoring', 'verification', 'lifecycle'];

export function renderWorkflowResource(key: string, meta: WorkflowMeta): string {
  const lines: string[] = [];

  lines.push(`# ${meta.title} (${key})`);
  lines.push('');
  lines.push(meta.description);
  lines.push('');
  lines.push(`**Category:** ${meta.category}`);
  lines.push('');

  // Quick Start
  lines.push('## Quick Start');
  lines.push('');
  lines.push('```javascript');
  lines.push(meta.example);
  lines.push('```');
  lines.push('');

  // Parameters
  lines.push('## Parameters');
  lines.push('');
  lines.push('| Name | Type | Required | Description |');
  lines.push('|------|------|----------|-------------|');
  for (const p of meta.parameters) {
    const req = p.required
      ? 'yes'
      : p.default !== undefined
        ? `no (default: ${JSON.stringify(p.default)})`
        : 'no';
    const desc = p.constraints ? `${p.description} (${p.constraints})` : p.description;
    const escapeCell = (value: string) => value.replaceAll('|', '&#124;').replaceAll('\n', ' ');
    lines.push(`| ${escapeCell(p.name)} | ${escapeCell(p.type)} | ${escapeCell(req)} | ${escapeCell(desc)} |`);
  }
  lines.push('');

  // How It Works
  lines.push('## How It Works');
  lines.push('');
  meta.steps.forEach((step, i) => {
    lines.push(`${i + 1}. ${step}`);
  });
  lines.push('');

  // Output
  lines.push('## Output');
  lines.push('');
  lines.push(meta.output);
  lines.push('');

  // Related Workflows
  if (meta.relatedWorkflows && meta.relatedWorkflows.length > 0) {
    lines.push('## Related Workflows');
    lines.push('');
    for (const rel of meta.relatedWorkflows) {
      const relMeta = workflowMetadata.get(rel);
      const desc = relMeta ? relMeta.description.split('.')[0] : rel;
      lines.push(`- **${rel}** — ${desc}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export function renderIndexResource(): string {
  const lines: string[] = [];

  lines.push('# Websets Workflows');
  lines.push('');
  lines.push(
    `${workflowMetadata.size} background workflows that orchestrate Exa Websets operations into higher-level research and analysis patterns. Launch any workflow via \`callOperation('tasks.create', { type: '<type>', args: {...} })\`.`,
  );
  lines.push('');

  // Group by category
  const byCategory = new Map<string, Array<{ key: string; meta: WorkflowMeta }>>();
  for (const [key, meta] of workflowMetadata) {
    const list = byCategory.get(meta.category) ?? [];
    list.push({ key, meta });
    byCategory.set(meta.category, list);
  }

  // Render in defined order
  for (const cat of CATEGORY_ORDER) {
    const entries = byCategory.get(cat);
    if (!entries || entries.length === 0) continue;

    const heading = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`## ${heading}`);
    lines.push('');
    for (const { key, meta } of entries) {
      lines.push(`- **${key}** — ${meta.description.split('.')[0]}`);
    }
    lines.push('');
  }

  // Any categories not in the defined order
  for (const [cat, entries] of byCategory) {
    if (CATEGORY_ORDER.includes(cat)) continue;
    const heading = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`## ${heading}`);
    lines.push('');
    for (const { key, meta } of entries) {
      lines.push(`- **${key}** — ${meta.description.split('.')[0]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderChoosePrompt(goal: string): string {
  const lines: string[] = [];
  lines.push('Here are the available workflows:\n');
  lines.push(renderIndexResource());
  lines.push('## Workflow Selection Guide\n');
  lines.push('- **Quick answer to a question?** → retrieval.verifiedAnswer');
  lines.push('- **Read specific web pages?** → retrieval.searchAndRead');
  lines.push('- **Broad coverage of a topic?** → retrieval.expandAndCollect');
  lines.push('- **Collect structured entities?** → lifecycle.harvest');
  lines.push('- **Rank/classify entities by quality?** → qd.winnow');
  lines.push('- **Find entities from multiple angles?** → convergent.search');
  lines.push('- **Test a hypothesis with evidence?** → adversarial.verify');
  lines.push('- **Deep research on specific entities?** → research.verifiedCollection');
  lines.push('- **Open-ended research question?** → research.deep');
  lines.push('- **Monitor for signals over time?** → semantic.cron');
  lines.push('- **Verify data quality?** → verify.enrichments');
  lines.push('');
  lines.push(`Goal: ${goal}`);
  lines.push('');
  lines.push('Based on the goal above, recommend the most appropriate workflow and explain why. Then provide the callOperation() invocation template with parameters filled in for this goal.');
  return lines.join('\n');
}

export function registerWorkflowMcp(server: McpServer): void {
  // Register per-workflow resources and prompts
  for (const [key, meta] of workflowMetadata) {
    const uri = `workflow://${key}`;

    // Resource: documentation
    server.resource(
      meta.title,
      uri,
      { description: meta.description, mimeType: 'text/markdown' },
      async () => ({
        contents: [{ uri, text: renderWorkflowResource(key, meta), mimeType: 'text/markdown' }],
      }),
    );

    // Prompt: invocation guidance
    server.prompt(
      `workflow/${key}`,
      meta.description,
      { goal: z.string().describe('What you want to accomplish with this workflow') },
      async ({ goal }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: renderWorkflowResource(key, meta),
            },
          },
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Goal: ${goal}\n\nUsing the workflow documented above, construct the appropriate callOperation('tasks.create', { type: '${key}', args: {...} }) invocation for the execute tool. Fill in the parameters based on the goal.`,
            },
          },
        ],
      }),
    );
  }

  // Index resource
  server.resource(
    'Websets Workflows',
    'workflow://index',
    { description: 'Categorized listing of all available workflows', mimeType: 'text/markdown' },
    async () => ({
      contents: [{ uri: 'workflow://index', text: renderIndexResource(), mimeType: 'text/markdown' }],
    }),
  );

  // Choose prompt
  server.prompt(
    'workflow/choose',
    'Help choose the right workflow for your goal',
    { goal: z.string().describe('What you want to accomplish') },
    async ({ goal }) => ({
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: renderChoosePrompt(goal),
          },
        },
      ],
    }),
  );
}
