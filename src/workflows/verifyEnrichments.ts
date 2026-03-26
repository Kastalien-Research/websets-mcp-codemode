import type { Exa } from 'exa-js';
import type { TaskStore } from '../lib/taskStore.js';
import { Semaphore } from '../lib/semaphore.js';
import { registerWorkflow } from './types.js';
import {
  createStepTracker,
  isCancelled,
  collectItems,
  withSummary,
} from './helpers.js';
import { projectItem } from '../lib/projections.js';
import { checkEmail } from '../lib/emailCheck.js';
import { upsertItem, upsertAnnotation } from '../store/db.js';

// --- Types ---

type Verdict = 'verified' | 'unverified' | 'contradicted' | 'not_checkable';

interface FieldVerification {
  field: string;
  originalValue: unknown;
  verdict: Verdict;
  evidence?: string;
}

interface ItemVerification {
  item: Record<string, unknown>;
  fields: FieldVerification[];
  score: number; // 0-1 ratio of verified fields
}

// --- GitHub URL parsing ---

function parseGitHubUsername(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes('github.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] ?? null;
  } catch {
    return null;
  }
}

function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  // Try full URL first
  try {
    const u = new URL(url);
    if (u.hostname.includes('github.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return { owner: parts[0], repo: parts[1] };
    }
  } catch {
    // Not a URL — try owner/repo format
  }
  // Match bare "owner/repo" format (e.g. "QuantGeekDev/mcp-framework")
  const match = url.match(/^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/);
  if (match) return { owner: match[1], repo: match[2] };
  return null;
}

// --- Verification strategies per enrichment type ---

async function verifyGitHubUrl(
  url: string,
  ghFetch: (path: string) => Promise<unknown>,
): Promise<FieldVerification> {
  const username = parseGitHubUsername(url);
  if (!username) {
    return { field: 'github_url', originalValue: url, verdict: 'unverified', evidence: 'Not a valid GitHub URL' };
  }
  try {
    const user = await ghFetch(`/users/${username}`) as Record<string, unknown>;
    return {
      field: 'github_url',
      originalValue: url,
      verdict: 'verified',
      evidence: `Profile exists: ${user.login} (${user.public_repos} repos, ${user.followers} followers)`,
    };
  } catch {
    return { field: 'github_url', originalValue: url, verdict: 'contradicted', evidence: 'GitHub profile not found' };
  }
}

async function verifyGitHubRepo(
  repoUrl: string,
  ghFetch: (path: string) => Promise<unknown>,
  keywords: string[] = ['mcp'],
): Promise<FieldVerification> {
  const parsed = parseGitHubRepo(repoUrl);
  if (!parsed) {
    // Maybe it's just a repo name — try searching
    return { field: 'github_repo', originalValue: repoUrl, verdict: 'not_checkable', evidence: 'Not a parseable GitHub URL' };
  }
  try {
    const repo = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}`) as Record<string, unknown>;
    const name = (repo.full_name as string ?? '').toLowerCase();
    const desc = (repo.description as string ?? '').toLowerCase();
    const topics = (repo.topics as string[] ?? []).map(t => t.toLowerCase());
    const blob = `${name} ${desc} ${topics.join(' ')}`;

    const keywordMatch = keywords.some(kw => blob.includes(kw.toLowerCase()));
    return {
      field: 'github_repo',
      originalValue: repoUrl,
      verdict: keywordMatch ? 'verified' : 'unverified',
      evidence: keywordMatch
        ? `Repo exists and matches keywords: ${repo.full_name} — "${repo.description}"`
        : `Repo exists (${repo.full_name}) but no keyword match in name/description/topics`,
    };
  } catch {
    return { field: 'github_repo', originalValue: repoUrl, verdict: 'contradicted', evidence: 'Repository not found on GitHub' };
  }
}

async function verifyLanguage(
  claimed: string,
  username: string,
  ghFetch: (path: string) => Promise<unknown>,
): Promise<FieldVerification> {
  try {
    const repos = await ghFetch(
      `/users/${username}/repos?per_page=30&sort=pushed&type=owner`,
    ) as Array<Record<string, unknown>>;

    const langCount: Record<string, number> = {};
    for (const r of repos) {
      const lang = r.language as string | null;
      if (lang) langCount[lang] = (langCount[lang] ?? 0) + 1;
    }
    const sorted = Object.entries(langCount).sort((a, b) => b[1] - a[1]);
    const topLangs = sorted.slice(0, 3).map(([l]) => l);

    const match = topLangs.some(l => l.toLowerCase() === claimed.toLowerCase());
    return {
      field: 'primary_language',
      originalValue: claimed,
      verdict: match ? 'verified' : 'unverified',
      evidence: match
        ? `"${claimed}" is in top 3 languages: ${topLangs.join(', ')}`
        : `Top languages are ${topLangs.join(', ')} — "${claimed}" not found`,
    };
  } catch {
    return { field: 'primary_language', originalValue: claimed, verdict: 'not_checkable', evidence: 'Could not fetch repos' };
  }
}

async function verifyEmail(email: string): Promise<FieldVerification> {
  const result = await checkEmail(email);
  if (!result.formatValid) {
    return { field: 'email', originalValue: email, verdict: 'contradicted', evidence: 'Invalid email format' };
  }
  if (result.domainHasMx) {
    return { field: 'email', originalValue: email, verdict: 'verified', evidence: `Domain has MX records: ${result.mxRecords[0]}` };
  }
  return { field: 'email', originalValue: email, verdict: 'unverified', evidence: 'Domain has no MX records' };
}

async function verifyViaExa(
  field: string,
  value: string,
  context: string,
  exa: Exa,
): Promise<FieldVerification> {
  try {
    const query = `${context} ${value}`;
    const results = await exa.search(query, {
      numResults: 3,
      type: 'auto',
      contents: { highlights: true },
    });
    const hits = (results as any).results ?? [];
    if (hits.length === 0) {
      return { field, originalValue: value, verdict: 'unverified', evidence: 'No corroborating results found via web search' };
    }

    // Check if any highlights mention the value
    const allHighlights = hits.flatMap((h: any) => h.highlights ?? []).join(' ').toLowerCase();
    const valueLower = value.toLowerCase();
    const found = allHighlights.includes(valueLower) || hits.some((h: any) =>
      (h.title ?? '').toLowerCase().includes(valueLower) ||
      (h.url ?? '').toLowerCase().includes(valueLower)
    );

    return {
      field,
      originalValue: value,
      verdict: found ? 'verified' : 'unverified',
      evidence: found
        ? `Found corroborating mention in ${hits.length} search results`
        : `${hits.length} results returned but none mention "${value}"`,
    };
  } catch {
    return { field, originalValue: value, verdict: 'not_checkable', evidence: 'Exa search failed' };
  }
}

// --- Entity-specific verification strategies ---

interface EnrichmentSpec {
  description: string;
  result: string[] | null;
  format?: string;
}

function classifyEnrichment(desc: string): string {
  const d = desc.toLowerCase();
  if (d.includes('github') && (d.includes('profile') || d.includes('url'))) return 'github_url';
  if (d.includes('github') && d.includes('repo')) return 'github_repo';
  if (d.includes('language') || d.includes('programming')) return 'primary_language';
  if (d.includes('email')) return 'email';
  if (d.includes('follower')) return 'follower_count';
  if (d.includes('oss') || d.includes('open source') || d.includes('contributor')) return 'oss_status';
  if (d.includes('posted') && (d.includes('code') || d.includes('repo'))) return 'posted_code';
  return 'general';
}

async function verifyPersonItem(
  item: Record<string, unknown>,
  enrichments: EnrichmentSpec[],
  exa: Exa,
  ghFetch: (path: string) => Promise<unknown>,
): Promise<FieldVerification[]> {
  const results: FieldVerification[] = [];
  const props = item.properties as Record<string, unknown> | undefined;
  const person = props?.person as Record<string, unknown> | undefined;
  const itemName = (person?.name ?? props?.description ?? 'unknown') as string;
  const itemUrl = (props?.url ?? '') as string;

  // Verify the source URL is live
  if (itemUrl) {
    try {
      const contents = await exa.getContents(itemUrl, { text: true } as any);
      const pageResults = (contents as any).results ?? [];
      const hasContent = pageResults.length > 0 && pageResults[0].text?.length > 50;
      results.push({
        field: 'source_url',
        originalValue: itemUrl,
        verdict: hasContent ? 'verified' : 'unverified',
        evidence: hasContent ? 'Source URL is live and has content' : 'Source URL returned no meaningful content',
      });
    } catch {
      results.push({ field: 'source_url', originalValue: itemUrl, verdict: 'unverified', evidence: 'Could not fetch source URL' });
    }
  }

  // Find GitHub username from enrichments for cross-referencing
  let ghUsername: string | null = null;
  for (const e of enrichments) {
    if (classifyEnrichment(e.description) === 'github_url' && e.result?.[0]) {
      ghUsername = parseGitHubUsername(e.result[0]);
      break;
    }
  }

  // Verify each enrichment
  for (const e of enrichments) {
    const value = e.result?.[0];
    if (!value || value.trim() === '') {
      results.push({ field: e.description, originalValue: null, verdict: 'not_checkable', evidence: 'No value to verify' });
      continue;
    }

    const type = classifyEnrichment(e.description);
    let fv: FieldVerification;
    switch (type) {
      case 'github_url':
        fv = await verifyGitHubUrl(value, ghFetch);
        break;
      case 'github_repo':
        fv = await verifyGitHubRepo(value, ghFetch);
        break;
      case 'primary_language':
        fv = ghUsername
          ? await verifyLanguage(value, ghUsername, ghFetch)
          : await verifyViaExa(e.description, value, `${itemName} programming language`, exa);
        break;
      case 'email':
        fv = await verifyEmail(value);
        break;
      case 'follower_count':
        fv = await verifyViaExa(e.description, value, `${itemName} twitter followers`, exa);
        break;
      case 'oss_status':
        if (ghUsername) {
          try {
            const user = await ghFetch(`/users/${ghUsername}`) as Record<string, unknown>;
            const repoCount = user.public_repos as number ?? 0;
            fv = {
              field: e.description,
              originalValue: value,
              verdict: repoCount > 0 ? 'verified' : 'unverified',
              evidence: `${ghUsername} has ${repoCount} public repos`,
            };
          } catch {
            fv = { field: e.description, originalValue: value, verdict: 'not_checkable', evidence: 'Could not check GitHub' };
          }
        } else {
          fv = await verifyViaExa(e.description, value, `${itemName} open source contributions`, exa);
        }
        break;
      case 'posted_code':
        fv = await verifyViaExa(e.description, value, `${itemName} MCP code tweet`, exa);
        break;
      default:
        fv = await verifyViaExa(e.description, value, itemName, exa);
    }
    // Always use the enrichment description as the field name for consistent grouping
    fv.field = e.description;
    results.push(fv);
  }

  return results;
}

async function verifyCompanyItem(
  item: Record<string, unknown>,
  enrichments: EnrichmentSpec[],
  exa: Exa,
  ghFetch: (path: string) => Promise<unknown>,
): Promise<FieldVerification[]> {
  const results: FieldVerification[] = [];
  const props = item.properties as Record<string, unknown> | undefined;
  const company = props?.company as Record<string, unknown> | undefined;
  const itemName = (company?.name ?? props?.description ?? 'unknown') as string;
  const itemUrl = (props?.url ?? '') as string;

  // Verify source URL
  if (itemUrl) {
    try {
      const contents = await exa.getContents(itemUrl, { text: true } as any);
      const pageResults = (contents as any).results ?? [];
      const hasContent = pageResults.length > 0 && pageResults[0].text?.length > 50;
      results.push({
        field: 'source_url',
        originalValue: itemUrl,
        verdict: hasContent ? 'verified' : 'unverified',
        evidence: hasContent ? 'Company URL is live' : 'Company URL returned no meaningful content',
      });
    } catch {
      results.push({ field: 'source_url', originalValue: itemUrl, verdict: 'unverified', evidence: 'Could not fetch company URL' });
    }
  }

  for (const e of enrichments) {
    const value = e.result?.[0];
    if (!value || value.trim() === '') {
      results.push({ field: e.description, originalValue: null, verdict: 'not_checkable', evidence: 'No value to verify' });
      continue;
    }

    const type = classifyEnrichment(e.description);
    let fv: FieldVerification;
    switch (type) {
      case 'github_url':
        fv = await verifyGitHubUrl(value, ghFetch);
        break;
      case 'github_repo':
        fv = await verifyGitHubRepo(value, ghFetch);
        break;
      case 'email':
        fv = await verifyEmail(value);
        break;
      default:
        fv = await verifyViaExa(e.description, value, `${itemName} company`, exa);
    }
    fv.field = e.description;
    results.push(fv);
  }

  return results;
}

// --- Main Workflow ---

const GITHUB_API_BASE = 'https://api.github.com';

async function verifyEnrichmentsWorkflow(
  taskId: string,
  args: Record<string, unknown>,
  exa: Exa,
  store: TaskStore,
): Promise<unknown> {
  const startTime = Date.now();
  const tracker = createStepTracker();

  const websetId = args.websetId as string;
  if (!websetId) throw new Error('websetId is required');

  const maxItems = (args.maxItems as number) ?? 50;
  const concurrency = (args.concurrency as number) ?? 10;
  const keywords = (args.keywords as string[]) ?? ['mcp'];

  // Build ghFetch with optional token
  const ghHeaders: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'schwartz13-mcp',
  };
  const ghToken = process.env.GITHUB_TOKEN;
  if (ghToken) ghHeaders['Authorization'] = `Bearer ${ghToken}`;

  async function ghFetch(path: string): Promise<unknown> {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, { headers: ghHeaders });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
  }

  // Step 1: Get webset metadata to determine entity type
  const step1 = Date.now();
  store.updateProgress(taskId, { step: 'loading webset', completed: 1, total: 4 });

  const webset = await exa.websets.get(websetId) as any;
  const searches = webset.searches as any[] ?? [];
  const entityType = searches[0]?.entity?.type ?? 'unknown';

  // Build enrichment ID → description map (item enrichments carry enrichmentId, not description)
  const websetEnrichments = (webset.enrichments as Array<Record<string, unknown>> ?? []);
  const enrichmentDescById = new Map<string, string>();
  for (const e of websetEnrichments) {
    const id = e.id as string;
    const desc = ((e.description as string) ?? '').replace(/^Custom enrichment:\s*/i, '');
    if (id && desc) enrichmentDescById.set(id, desc);
  }
  tracker.track('load_webset', step1);

  if (isCancelled(taskId, store)) return null;

  // Step 2: Collect items
  const step2 = Date.now();
  store.updateProgress(taskId, { step: 'collecting items', completed: 2, total: 4 });

  const allItems = await collectItems(exa, websetId, maxItems);
  tracker.track('collect', step2);

  if (allItems.length === 0) {
    return withSummary({ websetId, entityType, items: [], totalVerified: 0 },
      'No items found in webset');
  }

  if (isCancelled(taskId, store)) return null;

  // Step 3: Verify each item
  const step3 = Date.now();
  store.updateProgress(taskId, {
    step: 'verifying',
    completed: 3,
    total: 4,
    message: `Verifying ${allItems.length} items (${entityType})`,
  });

  const semaphore = new Semaphore(concurrency);
  const verifications: ItemVerification[] = await Promise.all(
    allItems.map((item, idx) =>
      semaphore.run(async () => {
        if (isCancelled(taskId, store)) {
          return { item: projectItem(item), fields: [], score: 0 };
        }

        const enrichments = (item.enrichments as Array<Record<string, unknown>> ?? []).map((e, i) => {
          const eid = e.enrichmentId as string | undefined;
          const desc = (eid ? enrichmentDescById.get(eid) : null)
            ?? (e.description as string)
            ?? `enrichment_${i}`;
          return { description: desc, result: (e.result as string[] | null), format: e.format as string | undefined };
        });

        let fields: FieldVerification[];
        if (entityType === 'person') {
          fields = await verifyPersonItem(item, enrichments, exa, ghFetch);
        } else if (entityType === 'company') {
          fields = await verifyCompanyItem(item, enrichments, exa, ghFetch);
        } else {
          // Generic: use Exa for everything
          fields = [];
          const props = item.properties as Record<string, unknown> | undefined;
          const itemName = (props?.description ?? 'unknown') as string;
          for (const e of enrichments) {
            const value = e.result?.[0];
            if (!value) {
              fields.push({ field: e.description, originalValue: null, verdict: 'not_checkable', evidence: 'No value' });
            } else if (classifyEnrichment(e.description) === 'email') {
              const fv = await verifyEmail(value);
              fv.field = e.description;
              fields.push(fv);
            } else {
              fields.push(await verifyViaExa(e.description, value, itemName, exa));
            }
          }
        }

        const checkable = fields.filter(f => f.verdict !== 'not_checkable');
        const verified = checkable.filter(f => f.verdict === 'verified').length;
        const score = checkable.length > 0 ? verified / checkable.length : 0;

        // Persist to SQLite
        const itemId = item.id as string;
        const itemProps = item.properties as Record<string, unknown> | undefined;
        const person = itemProps?.person as Record<string, unknown> | undefined;
        const company = itemProps?.company as Record<string, unknown> | undefined;
        const article = itemProps?.article as Record<string, unknown> | undefined;
        const persistName = (person?.name ?? company?.name ?? article?.title ?? itemProps?.description ?? 'unknown') as string;
        const persistUrl = (itemProps?.url ?? '') as string;

        try {
          upsertItem({
            id: itemId,
            websetId,
            name: persistName,
            url: persistUrl,
            entityType,
            enrichments: item.enrichments as Record<string, unknown> | undefined,
            evaluations: item.evaluations as unknown[] | undefined,
          });

          // Store per-field verification results
          upsertAnnotation(itemId, 'verification', JSON.stringify({
            score,
            fields: fields.map(f => ({
              field: f.field,
              verdict: f.verdict,
              evidence: f.evidence,
            })),
          }), 'verify.enrichments');

          // Mark as investigated with overall verdict
          const contradicted = fields.filter(f => f.verdict === 'contradicted').length;
          let judgment: string;
          if (score >= 0.7 && contradicted === 0) {
            judgment = 'verified';
          } else if (contradicted > 0) {
            judgment = `needs_review (${contradicted} contradicted)`;
          } else {
            judgment = `partial (${(score * 100).toFixed(0)}% verified)`;
          }
          upsertAnnotation(itemId, 'judgment', judgment, 'verify.enrichments');
        } catch {
          // SQLite persistence is best-effort — don't fail the workflow
        }

        store.updateProgress(taskId, {
          step: 'verifying',
          completed: 3,
          total: 4,
          message: `Verified ${idx + 1}/${allItems.length}`,
        });

        return { item: projectItem(item), fields, score };
      }),
    ),
  );
  tracker.track('verify', step3);

  // Step 4: Summarize
  store.updateProgress(taskId, { step: 'summarizing', completed: 4, total: 4 });

  const avgScore = verifications.reduce((sum, v) => sum + v.score, 0) / verifications.length;

  // Per-field summary
  const fieldStats: Record<string, Record<Verdict, number>> = {};
  for (const v of verifications) {
    for (const f of v.fields) {
      if (!fieldStats[f.field]) fieldStats[f.field] = { verified: 0, unverified: 0, contradicted: 0, not_checkable: 0 };
      fieldStats[f.field][f.verdict]++;
    }
  }

  const duration = Date.now() - startTime;

  return withSummary({
    websetId,
    entityType,
    totalItems: verifications.length,
    averageVerificationScore: Math.round(avgScore * 100) / 100,
    fieldStats,
    items: verifications,
    duration,
    steps: tracker.steps,
  }, `${verifications.length} items verified (avg score: ${(avgScore * 100).toFixed(0)}%) in ${(duration / 1000).toFixed(0)}s`);
}

registerWorkflow('verify.enrichments', verifyEnrichmentsWorkflow);
