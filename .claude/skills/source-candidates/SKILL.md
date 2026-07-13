---
name: source-candidates
description: Source and independently verify candidates for a role from a job description URL. Runs the source-candidates workflow (Webset creation → Exa verification of every claim → validated/rejected CSVs). Use whenever the user wants to find candidates, source people for a role, run a recruiting search from a job posting, or invokes /source-candidates.
argument-hint: [job-description-URL] [count=25] [additional info | --more-info]
user-invocable: true
allowed-tools: Read, Workflow, AskUserQuestion, WebFetch, ToolSearch, mcp__websets-codemode-local__execute, mcp__websets-codemode-local__search
---

Run the recruiter sourcing pipeline defined in `.claude/workflows/source-candidates.js` from a job description. This skill is the argument-parsing and intake front end; all sourcing, verification, and CSV export happens inside the named workflow — do not reimplement any of it inline.

## Argument parsing

The raw argument string arrives with this skill's invocation (the `ARGUMENTS:` line appended below this content). Parse it as follows (be forgiving — it is typed by hand):

1. **Job description source** — the first token. Usually a URL. If it is not a URL, treat the entire argument string (minus flags and a trailing count) as pasted job-description text and skip the fetch step.
2. **Count** — the first standalone positive integer after the URL, if any. Default **25**. This becomes the workflow's `count` (results requested per search AND the verification cap).
3. **Additional info** — everything else: free-form notes about the ideal candidate ("must be in NYC", "prefers ex-founders", etc.). Default: none.
4. **`--more-info` flag** — if present anywhere, run the interview step below before launching. Remove it from the additional-info text.

If no arguments were given at all, ask the user for a job description URL (or pasted text) and stop until they provide one.

## Step 1 — Fetch the job description

Fetch the URL via the websets `execute` tool (load `mcp__websets-codemode-local__execute` via ToolSearch if deferred):

```javascript
const r = await callOperation('exa.getContents', { urls: ['<the URL>'] });
```

Extract the plain-text job description from the result. If `exa.getContents` returns nothing usable (paywall, empty content), fall back to WebFetch. If both fail, tell the user what happened and ask them to paste the job description text — do not fabricate a role description from the URL slug.

Sanity-check what you fetched: it should read like a job posting (role title, responsibilities, requirements). If it's a listings index page or a 404 shell, say so and ask for a better link.

## Step 2 — Interview (only with `--more-info`)

If the flag was passed, ask the user about their ideal candidate with AskUserQuestion **before** launching anything. Generate the questions from what the job description leaves ambiguous — don't ask things the posting already answers. Good territory:

- Which requirements are hard must-haves vs. nice-to-haves (the workflow treats criteria as strict AND-gates, so this materially changes yield)
- Location policy: strict criterion, informational only, or irrelevant
- Seniority band / years-of-experience range actually acceptable
- Anything to explicitly screen out (competitors, contractors, visa constraints)

One AskUserQuestion call, 2–4 questions, multiSelect where it fits. Fold the answers into the candidate spec below. Without the flag, skip this step entirely — do not ask questions.

## Step 3 — Build the workflow inputs

- **`role`** — the fetched job description text (trim boilerplate like EEO statements and application instructions; keep title, responsibilities, requirements).
- **`candidate`** — the ideal-candidate spec, as prose. Compose it from, in priority order: interview answers (if any) > additional-info text (if any) > requirements distilled from the job description itself. Always state explicitly which requirements are must-haves and which are informational, since the workflow's Compose stage maps must-haves to criteria and everything else to enrichment columns.
- **`count`** — the parsed count.

## Step 4 — Launch the workflow

Invoke the Workflow tool with the **named** workflow — this resolves to `.claude/workflows/source-candidates.js`:

```
Workflow({
  name: 'source-candidates',
  args: { role: <role text>, candidate: <candidate spec>, count: <count> }
})
```

Pass `args` as a real JSON object, not a stringified one. Do not set `model`/`cheapModel`/`outputCsv` unless the user asked for them. To re-verify or re-export an existing webset instead of creating a new one, pass `{ websetId: '...' }` in place of role/candidate (the user will say something like "resume webset ws_...").

The workflow runs in the background and can take a long time — population of a webset alone can run 30 min to 2+ hours. After launching:

1. Tell the user it's running, roughly what the phases are (Compose → Populate → Verify → Export), and that population is the long pole.
2. Do not poll or block. You'll get a task notification when it completes.

## Step 5 — Report results

When the workflow completes, summarize from its return value: candidates found, unique, verified, validated vs. rejected, and the two CSV paths (`csvPath`, `rejectedPath`). Surface `unverified` names and any `ingestTruncated`/`csvWritten: false` warnings honestly — a failed export means the CSVs on disk are not trustworthy, and the return value's `partsDir` is where the verified parts live. Relay the workflow's `report` (the recruiter-facing synthesis) as the main body of your answer.
