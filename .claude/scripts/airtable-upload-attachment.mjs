#!/usr/bin/env node
// Upload a local file into an Airtable attachment field.
// Usage: node airtable-upload-attachment.mjs --base app... --record rec... --field fld... --file path/to.csv
// Prints the raw API response JSON to stdout; exits 1 on non-2xx. The caller
// decides pass/fail by inspecting the response (no self-graded verdicts here).

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024; // uploadAttachment endpoint limit

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return process.argv[i + 1];
}

const baseId = arg("base");
const recordId = arg("record");
const fieldIdOrName = arg("field");
const filePath = resolve(arg("file"));

let apiKey = process.env.AIRTABLE_API_KEY;
if (!apiKey) {
  // Fall back to the sibling MCP server's env file, which is the canonical key location.
  const envPath = new URL(
    "../../../effect-airtable-mcp/.env",
    import.meta.url,
  ).pathname;
  try {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("AIRTABLE_API_KEY="));
    if (line) apiKey = line.slice("AIRTABLE_API_KEY=".length).trim();
  } catch {
    /* handled below */
  }
}
if (!apiKey) {
  console.error("AIRTABLE_API_KEY not set and not found in effect-airtable-mcp/.env");
  process.exit(2);
}

const bytes = readFileSync(filePath);
if (bytes.length > MAX_BYTES) {
  console.error(`file is ${bytes.length} bytes; uploadAttachment caps at ${MAX_BYTES}`);
  process.exit(2);
}

const contentType = filePath.endsWith(".csv")
  ? "text/csv"
  : filePath.endsWith(".md")
    ? "text/markdown"
    : "application/octet-stream";

const res = await fetch(
  `https://content.airtable.com/v0/${baseId}/${recordId}/${encodeURIComponent(fieldIdOrName)}/uploadAttachment`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contentType,
      file: bytes.toString("base64"),
      filename: basename(filePath),
    }),
  },
);

const body = await res.text();
console.log(body);
if (!res.ok) {
  console.error(`HTTP ${res.status}`);
  process.exit(1);
}
