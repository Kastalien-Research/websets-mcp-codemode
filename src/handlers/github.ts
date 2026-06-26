import { z } from 'zod';
import type { OperationHandler } from './types.js';
import { successResult, errorResult, requireParams } from './types.js';

const GITHUB_API = 'https://api.github.com';

async function ghFetch(path: string): Promise<unknown> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'websets-codemode-mcp',
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export const Schemas = {
  getUser: z.object({
    username: z.string(),
  }),
  getUserRepos: z.object({
    username: z.string(),
    sort: z.enum(['updated', 'created', 'pushed', 'full_name']).optional(),
    perPage: z.number().optional(),
  }),
  getRepo: z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  getUserLanguages: z.object({
    username: z.string(),
  }),
  verifyProfile: z.object({
    username: z.string(),
  }),
};

export const getUser: OperationHandler = async (args, _exa) => {
  const guard = requireParams('github.getUser', args, 'username');
  if (guard) return guard;
  try {
    const user = await ghFetch(`/users/${args.username}`) as Record<string, unknown>;
    return successResult({
      login: user.login,
      name: user.name,
      bio: user.bio,
      company: user.company,
      location: user.location,
      blog: user.blog,
      twitter_username: user.twitter_username,
      public_repos: user.public_repos,
      followers: user.followers,
      following: user.following,
      created_at: user.created_at,
      avatar_url: user.avatar_url,
      html_url: user.html_url,
    });
  } catch (error) {
    return errorResult('github.getUser', error, 'Verify the GitHub username is correct.');
  }
};

export const getUserRepos: OperationHandler = async (args, _exa) => {
  const guard = requireParams('github.getUserRepos', args, 'username');
  if (guard) return guard;
  try {
    const sort = (args.sort as string) ?? 'updated';
    const perPage = (args.perPage as number) ?? 10;
    const repos = await ghFetch(
      `/users/${args.username}/repos?sort=${sort}&per_page=${perPage}&type=owner`,
    ) as Array<Record<string, unknown>>;

    return successResult(repos.map(r => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
      html_url: r.html_url,
      language: r.language,
      stargazers_count: r.stargazers_count,
      forks_count: r.forks_count,
      topics: r.topics,
      updated_at: r.updated_at,
      pushed_at: r.pushed_at,
      fork: r.fork,
    })));
  } catch (error) {
    return errorResult('github.getUserRepos', error);
  }
};

export const getRepo: OperationHandler = async (args, _exa) => {
  const guard = requireParams('github.getRepo', args, 'owner', 'repo');
  if (guard) return guard;
  try {
    const repo = await ghFetch(`/repos/${args.owner}/${args.repo}`) as Record<string, unknown>;
    return successResult({
      full_name: repo.full_name,
      description: repo.description,
      html_url: repo.html_url,
      language: repo.language,
      stargazers_count: repo.stargazers_count,
      forks_count: repo.forks_count,
      open_issues_count: repo.open_issues_count,
      topics: repo.topics,
      license: (repo.license as Record<string, unknown> | null)?.spdx_id ?? null,
      created_at: repo.created_at,
      updated_at: repo.updated_at,
      pushed_at: repo.pushed_at,
    });
  } catch (error) {
    return errorResult('github.getRepo', error, 'Check owner and repo name. Format: owner="octocat", repo="hello-world".');
  }
};

export const getUserLanguages: OperationHandler = async (args, _exa) => {
  const guard = requireParams('github.getUserLanguages', args, 'username');
  if (guard) return guard;
  try {
    const repos = await ghFetch(
      `/users/${args.username}/repos?per_page=30&sort=pushed&type=owner`,
    ) as Array<Record<string, unknown>>;

    const langCount: Record<string, number> = {};
    for (const r of repos) {
      const lang = r.language as string | null;
      if (lang) langCount[lang] = (langCount[lang] ?? 0) + 1;
    }
    const sorted = Object.entries(langCount).sort((a, b) => b[1] - a[1]);
    return successResult({
      primary: sorted[0]?.[0] ?? null,
      languages: Object.fromEntries(sorted),
      reposSampled: repos.length,
    });
  } catch (error) {
    return errorResult('github.getUserLanguages', error);
  }
};

export const verifyProfile: OperationHandler = async (args, _exa) => {
  const guard = requireParams('github.verifyProfile', args, 'username');
  if (guard) return guard;
  try {
    const user = await ghFetch(`/users/${args.username}`) as Record<string, unknown>;
    const repos = await ghFetch(
      `/users/${args.username}/repos?per_page=5&sort=pushed&type=owner`,
    ) as Array<Record<string, unknown>>;

    const langCount: Record<string, number> = {};
    for (const r of repos) {
      const lang = r.language as string | null;
      if (lang) langCount[lang] = (langCount[lang] ?? 0) + 1;
    }
    const primaryLang = Object.entries(langCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return successResult({
      exists: true,
      login: user.login,
      name: user.name,
      bio: user.bio,
      twitter_username: user.twitter_username,
      public_repos: user.public_repos,
      followers: user.followers,
      primaryLanguage: primaryLang,
      recentRepos: repos.map(r => ({
        name: r.name,
        description: r.description,
        language: r.language,
        stargazers_count: r.stargazers_count,
        topics: r.topics,
        pushed_at: r.pushed_at,
      })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('404')) {
      return successResult({ exists: false, username: args.username });
    }
    return errorResult('github.verifyProfile', error);
  }
};
