import { WorkflowError } from './helpers.js';

export function expandTemplates<T>(
  config: T,
  variables: Record<string, string>,
): T {
  const json = JSON.stringify(config);
  let expanded = json;
  for (const [key, value] of Object.entries(variables)) {
    expanded = expanded.replaceAll(`{{${key}}}`, value);
  }

  // Check for unresolved templates
  const unresolved = expanded.match(/\{\{[^}]+\}\}/g);
  if (unresolved) {
    throw new WorkflowError(
      `Unresolved template variables: ${[...new Set(unresolved)].join(', ')}`,
      'validate',
    );
  }

  return JSON.parse(expanded) as T;
}
