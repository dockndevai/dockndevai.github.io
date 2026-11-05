// Generates og-downloads.html — the downloads milestone card — from servers.json
// (already produced by build-servers.mjs). The workflow screenshots it to
// og-downloads.png with headless Chrome. No network calls; pure render.
import { readFileSync, writeFileSync } from 'node:fs';

const servers = JSON.parse(readFileSync(new URL('../servers.json', import.meta.url)));
const total = servers.reduce((a, s) => a + (s.downloads?.total || 0), 0);
const count = servers.length;
const top = servers
  .filter((s) => (s.downloads?.total || 0) > 0)
  .sort((a, b) => (b.downloads.total || 0) - (a.downloads.total || 0))
  .slice(0, 6);
const max = top.length ? top[0].downloads.total : 1;
const fmt = (n) => n.toLocaleString('en-US');

// Guard: if npm's download API was unavailable during the server-list build,
// totals come back 0 — don't overwrite the card with a "0". The workflow skips
// the render on this non-zero exit.
if (total === 0) {
  console.error('No download data in servers.json — skipping card refresh.');
  process.exit(1);
}

const bars = top
  .map((s) => {
    const w = Math.max(6, Math.round((s.downloads.total / max) * 100));
    return `    <div class="b"><div class="n"><span>${s.name}</span><span>${fmt(s.downloads.total)}</span></div><div class="track"><div class="fill" style="width:${w}%"></div></div></div>`;
  })
  .join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1200px;height:630px}
body{background:#0b1220;color:#e8edf7;font-family:-apple-system,"Liberation Sans","DejaVu Sans",Arial,sans-serif;padding:64px 72px;position:relative;overflow:hidden}
.top{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:600;color:#9fb4d8;letter-spacing:.2px}
.dot{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#22d3ee)}
.hero{font-size:150px;font-weight:800;line-height:1;letter-spacing:-4px;margin-top:40px;background:linear-gradient(90deg,#60a5fa,#34d399);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{font-size:31px;font-weight:600;margin-top:14px;color:#e8edf7;max-width:640px;line-height:1.25}
.sub b{color:#34d399}
.tags{margin-top:26px;display:flex;gap:10px;flex-wrap:wrap;max-width:640px}
.tag{font-size:19px;color:#9fb4d8;border:1px solid #24324d;background:#121b2e;border-radius:999px;padding:7px 16px}
.bars{position:absolute;right:72px;top:150px;width:360px}
.bl{display:flex;flex-direction:column;gap:12px}
.b{font-size:16px;color:#b9c6de}
.b .n{display:flex;justify-content:space-between;margin-bottom:5px}
.b .track{height:12px;background:#15203a;border-radius:6px;overflow:hidden}
.b .fill{height:100%;background:linear-gradient(90deg,#3b82f6,#22d3ee);border-radius:6px}
.foot{position:absolute;left:72px;right:72px;bottom:56px;display:flex;justify-content:space-between;align-items:center;font-size:22px;color:#9fb4d8}
.foot .url{color:#60a5fa;font-weight:600}
</style></head><body>
  <div class="top"><div class="dot"></div> dockndevai &middot; safe-by-default MCP servers</div>
  <div class="hero">${fmt(total)}</div>
  <div class="sub">downloads across <b>${count}</b> open-source MCP servers</div>
  <div class="tags"><span class="tag">Read-only by default</span><span class="tag">Allowlisted</span><span class="tag">Audited</span><span class="tag">Human-confirmed</span></div>
  <div class="bars"><div class="bl">
${bars}
  </div></div>
  <div class="foot"><span>npm + the official MCP registry &middot; MIT</span><span class="url">dockndevai.github.io</span></div>
</body></html>`;

writeFileSync(new URL('../og-downloads.html', import.meta.url), html);
console.log(`og-downloads card: ${fmt(total)} downloads across ${count} servers; top ${top.length} bars`);
