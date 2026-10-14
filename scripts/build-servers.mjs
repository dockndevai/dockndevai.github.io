#!/usr/bin/env node
// build-servers.mjs — the single source of business/transform logic for the
// MCP-server list on dockndevai.github.io.
//
// It fetches the owner's public repos, filters them down to MCP servers,
// enriches each with package.json + npm download metadata, writes servers.json
// (the source of truth), and regenerates two marked regions of index.html:
//   * the card grid           — between <!-- SERVERS:START --> / <!-- SERVERS:END -->
//   * the ItemList JSON-LD     — between <!-- SERVERS-JSONLD:START --> / <!-- SERVERS-JSONLD:END -->
//
// The page itself contains NO business logic: it is a pure render of this data.
// Running this script twice with no upstream change produces no diff (idempotent).
//
// Requires Node 20+ (global fetch). No dependencies.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const INDEX_HTML = join(ROOT, 'index.html');
const SERVERS_JSON = join(ROOT, 'servers.json');

const OWNER = 'dockndevai';
const TOKEN = process.env.GITHUB_TOKEN || '';

// Repos that pass the keep-filter but are NOT installable MCP servers.
// (laya-guard carries the `mcp` topic but is a guardrail library wired *into*
// the servers, not a server itself.)
const HARD_EXCLUDE = new Set(['dockndevai.github.io', 'laya-guard']);

// Name patterns for non-server repos (labs, sites, taps, gateways).
const EXCLUDE_PATTERNS = [/-lab$/, /-site$/, /^homebrew-/, /gateway/];

const NAME_MATCH = /(^mcp-|-mcp$)/;
const MCP_TOPICS = new Set(['model-context-protocol', 'mcp']);

// -------------------------------------------------------------------------
// HTTP helpers — every request is time-bounded and retried on 429/5xx so a
// flaky npm/GitHub endpoint degrades to `null` data instead of hanging CI.
// -------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function httpGet(url, { headers = {}, timeoutMs = 15000, retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
        return { ok: false, status: res.status, body: null };
      }
      return { ok: res.ok, status: res.status, res };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
      return { ok: false, status: 0, body: null, error: String(err) };
    }
  }
  return { ok: false, status: 0, body: null };
}

async function getJson(url, opts = {}) {
  const ghHeaders = { 'User-Agent': 'dockndevai-build-servers', Accept: 'application/vnd.github+json' };
  const r = await httpGet(url, { headers: { ...ghHeaders, ...(opts.headers || {}) }, ...opts });
  if (!r.ok || !r.res) return null;
  try { return await r.res.json(); } catch { return null; }
}

async function getText(url, opts = {}) {
  const r = await httpGet(url, { headers: { 'User-Agent': 'dockndevai-build-servers' }, ...opts });
  if (!r.ok || !r.res) return null;
  try { return await r.res.text(); } catch { return null; }
}

// -------------------------------------------------------------------------
// Data collection
// -------------------------------------------------------------------------
async function fetchAllRepos() {
  const headers = { Accept: 'application/vnd.github+json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const repos = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://api.github.com/users/${OWNER}/repos?per_page=100&page=${page}&sort=full_name`;
    const batch = await getJson(url, { headers });
    if (!Array.isArray(batch) || batch.length === 0) break;
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

function isMcpServer(repo) {
  if (repo.fork) return false;
  if (HARD_EXCLUDE.has(repo.name)) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(repo.name))) return false;
  const topics = repo.topics || [];
  const topicMatch = topics.some((t) => MCP_TOPICS.has(t));
  const nameMatch = NAME_MATCH.test(repo.name);
  return topicMatch || nameMatch;
}

async function fetchPackageJson(fullName, branch) {
  const txt = await getText(`https://raw.githubusercontent.com/${fullName}/${branch}/package.json`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

// npm downloads. Scoped packages are frequently unsupported by the downloads
// API (and the API is sometimes down) — any failure yields null, never a throw.
async function fetchNpmDownloads(pkg) {
  if (!pkg) return null;
  const enc = encodeURIComponent(pkg).replace(/^%40/, '@'); // keep leading @ for scopes
  const today = new Date().toISOString().slice(0, 10);
  const [last30, allTime] = await Promise.all([
    getJson(`https://api.npmjs.org/downloads/point/last-month/${enc}`, { timeoutMs: 8000, retries: 1 }),
    getJson(`https://api.npmjs.org/downloads/point/2015-01-01:${today}/${enc}`, { timeoutMs: 8000, retries: 1 }),
  ]);
  const d30 = last30 && typeof last30.downloads === 'number' ? last30.downloads : null;
  const dAll = allTime && typeof allTime.downloads === 'number' ? allTime.downloads : null;
  if (d30 === null && dAll === null) return null;
  return { total: dAll, last30: d30 };
}

async function buildServer(repo) {
  const pkg = await fetchPackageJson(repo.full_name, repo.default_branch);
  const npmName = pkg && typeof pkg.name === 'string' ? pkg.name : null;
  const mcpName = pkg && typeof pkg.mcpName === 'string' ? pkg.mcpName : null;
  const downloads = await fetchNpmDownloads(npmName);
  return {
    name: repo.name,
    description: (repo.description || '').trim() || null,
    html_url: repo.html_url,
    homepage: repo.homepage && repo.homepage.trim() ? repo.homepage.trim() : null,
    stars: repo.stargazers_count || 0,
    language: repo.language || null,
    topics: (repo.topics || []).slice().sort(),
    npm: npmName,
    mcpName,
    install: npmName ? `npx -y ${npmName}` : null,
    downloads, // { total, last30 } | null
  };
}

function sortServers(list) {
  return list.slice().sort((a, b) => {
    const da = a.downloads && typeof a.downloads.total === 'number' ? a.downloads.total : -1;
    const db = b.downloads && typeof b.downloads.total === 'number' ? b.downloads.total : -1;
    if (db !== da) return db - da;
    if (b.stars !== a.stars) return b.stars - a.stars;
    return a.name.localeCompare(b.name);
  });
}

// -------------------------------------------------------------------------
// Rendering — pure string builders from the enriched data.
// -------------------------------------------------------------------------
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtCount(n) {
  if (n == null) return null;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

function renderCard(s) {
  const id = `p-${s.name}`;
  const tag = s.language ? `<span class="tag k">${esc(s.language)}</span>` : '';
  const desc = s.description ? esc(s.description) : '';

  const stats = [];
  stats.push(`<span class="stat" title="GitHub stars">&#9733; ${s.stars}</span>`);
  if (s.downloads && s.downloads.last30 != null) {
    stats.push(`<span class="stat" title="npm downloads, last 30 days">&#8595; ${fmtCount(s.downloads.last30)}/mo</span>`);
  } else if (s.downloads && s.downloads.total != null) {
    stats.push(`<span class="stat" title="npm downloads, all time">&#8595; ${fmtCount(s.downloads.total)}</span>`);
  }
  const meta = `<div class="meta">${stats.join('')}</div>`;

  const install = s.install
    ? `<div class="install"><code>${esc(s.install)}</code><button class="copy" data-cmd="${esc(s.install)}">Copy</button></div>`
    : '';

  const links = [`<a href="${esc(s.html_url)}">GitHub</a>`];
  if (s.npm) links.push(`<a href="https://www.npmjs.com/package/${esc(s.npm)}">npm</a>`);
  // A "Website" link only when the homepage is a genuine external site — not the
  // repo itself, not github.com, and not this site's own origin (a circular link).
  if (s.homepage && s.homepage !== s.html_url &&
      !/github\.com/.test(s.homepage) && !/dockndevai\.github\.io/.test(s.homepage)) {
    links.push(`<a href="${esc(s.homepage)}">Website</a>`);
  }
  const linksHtml = `<div class="links">${links.join('')}</div>`;

  return [
    `          <article class="srv" id="${esc(id)}">`,
    `            <div class="top"><h3><a href="${esc(s.html_url)}">${esc(s.name)}</a></h3>${tag}</div>`,
    `            <p>${desc}</p>`,
    `            ${meta}`,
    install ? `            ${install}` : null,
    `            ${linksHtml}`,
    `          </article>`,
  ].filter((l) => l !== null).join('\n');
}

function renderGrid(servers) {
  return servers.map(renderCard).join('\n');
}

function renderJsonLd(servers) {
  // One SoftwareApplication per line, mirroring the shape of the original
  // hand-written block (compact items inside a pretty outer object).
  const items = servers.map((s, i) => {
    const item = {
      '@type': 'SoftwareApplication',
      position: i + 1,
      name: s.name,
      applicationCategory: 'DeveloperApplication',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      url: s.html_url,
    };
    if (s.description) item.description = s.description;
    return '      ' + JSON.stringify(item);
  });
  return [
    '  <!-- Structured data: the suite as an ItemList of SoftwareApplications (generated by scripts/build-servers.mjs) -->',
    '  <script type="application/ld+json">',
    '  {',
    '    "@context": "https://schema.org",',
    '    "@type": "ItemList",',
    '    "name": "dockndevai MCP server suite",',
    '    "description": "Safe-by-default Model Context Protocol servers for AI agents operating real infrastructure and knowledge.",',
    '    "url": "https://dockndevai.github.io/",',
    '    "itemListElement": [',
    items.join(',\n'),
    '    ]',
    '  }',
    '  </script>',
  ].join('\n');
}

// Replace the text strictly between a START/END marker pair, keeping the
// marker lines themselves intact.
function replaceRegion(html, startMarker, endMarker, body) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`Markers not found or out of order: ${startMarker} / ${endMarker}`);
  }
  const before = html.slice(0, start + startMarker.length);
  const after = html.slice(end);
  return `${before}\n${body}\n${after}`;
}

// -------------------------------------------------------------------------
async function main() {
  const repos = await fetchAllRepos();
  if (repos.length === 0) {
    console.error('No repos returned from GitHub API — aborting without writing.');
    process.exit(1);
  }
  const kept = repos.filter(isMcpServer);
  console.error(`Fetched ${repos.length} repos; ${kept.length} match the MCP-server filter.`);

  // Enrich all kept repos concurrently so a slow/down npm endpoint bounds total
  // time to the slowest request rather than the sum of all of them.
  const enriched = await Promise.all(kept.map((repo) => buildServer(repo)));
  const servers = sortServers(enriched);

  // 1) servers.json — the source of truth.
  await writeFile(SERVERS_JSON, JSON.stringify(servers, null, 2) + '\n', 'utf8');

  // 2) regenerate the two regions of index.html in place.
  let html = await readFile(INDEX_HTML, 'utf8');
  html = replaceRegion(html, '<!-- SERVERS:START -->', '<!-- SERVERS:END -->', renderGrid(servers));
  html = replaceRegion(html, '<!-- SERVERS-JSONLD:START -->', '<!-- SERVERS-JSONLD:END -->', renderJsonLd(servers));
  await writeFile(INDEX_HTML, html, 'utf8');

  console.error(`Wrote servers.json and index.html for ${servers.length} servers:`);
  console.error(servers.map((s) => `  - ${s.name} (★${s.stars}${s.npm ? ', ' + s.npm : ', no-npm'})`).join('\n'));
}

main().catch((err) => { console.error(err); process.exit(1); });
