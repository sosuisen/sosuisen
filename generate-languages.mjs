// Generate an SVG card that shows the share of languages across your GitHub repositories.
// Requires Node.js 20+ (uses the built-in fetch).
//
// Environment variables:
//   GH_TOKEN          GitHub token (required)
//   GH_USER           GitHub username (default: owner of the current repository)
//   INCLUDE_PRIVATE   "true" to include private repositories (needs a classic PAT with "repo" scope)
//   IGNORED_LANGUAGES Comma-separated list of languages to ignore (e.g. "HTML,CSS")
//   SKIPPED_REPOS     Comma-separated list of repository names to skip
//   LIMIT             Max number of languages to show (default: 8). The rest go into "Other".
//   OUTPUT            Output file path (default: languages.svg)

import { writeFile } from "node:fs/promises";

const token = process.env.GH_TOKEN;
const user = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER;
const includePrivate = process.env.INCLUDE_PRIVATE === "true";
const toList = (s) => (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
const ignored = new Set(toList(process.env.IGNORED_LANGUAGES));
const skipped = new Set(toList(process.env.SKIPPED_REPOS));
const limit = Number(process.env.LIMIT || 8);
const output = process.env.OUTPUT || "languages.svg";

if (!token || !user) {
  console.error("GH_TOKEN and GH_USER (or GITHUB_REPOSITORY_OWNER) are required.");
  process.exit(1);
}

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.json();
}

// Fetch all repositories owned by the user, page by page.
async function fetchRepos() {
  const repos = [];
  for (let page = 1; ; page++) {
    const path = includePrivate
      ? `/user/repos?affiliation=owner&per_page=100&page=${page}`
      : `/users/${user}/repos?type=owner&per_page=100&page=${page}`;
    const batch = await api(path);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos.filter((r) => !r.fork && !skipped.has(r.name.toLowerCase()));
}

// Sum language bytes across all repositories.
async function collectLanguages(repos) {
  const totals = new Map();
  for (const repo of repos) {
    const langs = await api(`/repos/${repo.owner.login}/${repo.name}/languages`);
    for (const [name, bytes] of Object.entries(langs)) {
      if (ignored.has(name.toLowerCase())) continue;
      totals.set(name, (totals.get(name) || 0) + bytes);
    }
  }
  return totals;
}

// Language colors from GitHub Linguist. Unknown languages get a gray color.
async function fetchColors() {
  try {
    const res = await fetch("https://raw.githubusercontent.com/ozh/github-colors/master/colors.json");
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

const escapeXml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function renderSvg(items) {
  const width = 480;
  const pad = 20;
  const barY = 48;
  const barWidth = width - pad * 2;
  const rowHeight = 22;
  const rows = Math.ceil(items.length / 2);
  const height = barY + 10 + 20 + rows * rowHeight + 10;

  // Stacked bar
  let x = pad;
  const bar = items
    .map((it) => {
      const w = (barWidth * it.percent) / 100;
      const rect = `<rect x="${x.toFixed(2)}" y="${barY}" width="${w.toFixed(2)}" height="10" fill="${it.color}"/>`;
      x += w;
      return rect;
    })
    .join("");

  // Legend in two columns
  const colWidth = barWidth / 2;
  const legend = items
    .map((it, i) => {
      const lx = pad + (i % 2) * colWidth;
      const ly = barY + 10 + 24 + Math.floor(i / 2) * rowHeight;
      return (
        `<circle cx="${lx + 5}" cy="${ly - 4}" r="5" fill="${it.color}"/>` +
        `<text x="${lx + 16}" y="${ly}" class="name">${escapeXml(it.name)}</text>` +
        `<text x="${lx + colWidth - 10}" y="${ly}" class="pct" text-anchor="end">${it.percent.toFixed(1)}%</text>`
      );
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>
  .title { font: 600 16px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #0969da; }
  .name { font: 13px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #57606a; }
  .pct { font: 13px -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; fill: #8c959f; }
  @media (prefers-color-scheme: dark) {
    .title { fill: #4493f8; } .name { fill: #c9d1d9; } .pct { fill: #8b949e; }
  }
</style>
<text x="${pad}" y="30" class="title">Most used languages</text>
<clipPath id="round"><rect x="${pad}" y="${barY}" width="${barWidth}" height="10" rx="5"/></clipPath>
<g clip-path="url(#round)">${bar}</g>
${legend}
</svg>
`;
}

async function main() {
  const repos = await fetchRepos();
  console.log(`Repositories: ${repos.length}`);

  const totals = await collectLanguages(repos);
  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  if (sum === 0) throw new Error("No language data found.");

  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, limit);
  const otherBytes = sorted.slice(limit).reduce((a, [, b]) => a + b, 0);

  const colors = await fetchColors();
  const items = top.map(([name, bytes]) => ({
    name,
    percent: (bytes / sum) * 100,
    color: colors[name]?.color || "#8c959f",
  }));
  if (otherBytes > 0) items.push({ name: "Other", percent: (otherBytes / sum) * 100, color: "#d0d7de" });

  for (const it of items) console.log(`${it.name.padEnd(20)} ${it.percent.toFixed(1)}%`);

  await writeFile(output, renderSvg(items));
  console.log(`Wrote ${output}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
