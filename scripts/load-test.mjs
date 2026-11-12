// Closed-loop load test: N workers each fire requests back-to-back for D seconds.
// usage: node scripts/load-test.mjs <name> <url> <file|-> <concurrency> <seconds>
// Needs RATE_LIMIT_MAX raised on the target, and a container named loadtest-conv (or edit below) for mem/CPU sampling.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { execFile } from 'node:child_process';

const [name, url, file, concStr, secStr] = process.argv.slice(2);
const conc = Number(concStr), secs = Number(secStr);
const body = file === '-' ? null : readFileSync(file);
const fname = file === '-' ? null : basename(file);

const lat = [], okLat = [], codes = {};
let stop = false;
const mem = []; const cpu = [];
const sampler = setInterval(() => {
  execFile('docker', ['stats', '--no-stream', '--format', '{{.MemUsage}}|{{.CPUPerc}}', 'loadtest-conv'], (e, out) => {
    if (e) return;
    const [m, c] = out.trim().split('|');
    const v = parseFloat(m); mem.push(/GiB/.test(m.split('/')[0]) ? v * 1024 : v); cpu.push(parseFloat(c));
  });
}, 1000);

async function worker() {
  while (!stop) {
    const t = performance.now();
    let code = 'ERR';
    try {
      let init = {};
      if (body) { const fd = new FormData(); fd.append('files', new Blob([body]), fname); init = { method: 'POST', body: fd }; }
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(240000) });
      await r.arrayBuffer(); code = r.status;
    } catch (e) { code = e.name === 'TimeoutError' ? 'TIMEOUT' : 'ERR'; }
    const d = performance.now() - t;
    lat.push(d); if (code === 200) okLat.push(d);
    codes[code] = (codes[code] ?? 0) + 1;
    if (code !== 200 && !body) continue;
  }
}
const start = performance.now();
setTimeout(() => { stop = true; }, secs * 1000);
await Promise.all(Array.from({ length: conc }, worker));
clearInterval(sampler);
const el = (performance.now() - start) / 1000;
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const ok = codes[200] ?? 0, total = lat.length;
console.log(JSON.stringify({
  name, conc, secs: +el.toFixed(1), total, ok, codes,
  ok_per_sec: +(ok / el).toFixed(2), ok_per_min: Math.round(ok / el * 60),
  okPct: +(100 * ok / total).toFixed(1),
  p50: Math.round(pct(okLat, 50)), p95: Math.round(pct(okLat, 95)), p99: Math.round(pct(okLat, 99)), max: Math.round(pct(okLat, 100)),
  peakMemMiB: Math.round(Math.max(0, ...mem)), avgCpu: Math.round(cpu.reduce((a, b) => a + b, 0) / (cpu.length || 1)),
}));
