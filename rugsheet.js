// rugsheet.js — Search + localStorage + auto-scan + backend sync (Phase 1B).

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens/';
const DEX_SEARCH = 'https://api.dexscreener.com/latest/dex/search?q=';
const DEX_BOOSTS_LATEST = 'https://api.dexscreener.com/token-boosts/latest/v1';
const DEX_BOOSTS_TOP = 'https://api.dexscreener.com/token-boosts/top/v1';
const BACKEND_API = 'https://dexscreener-telegram-bot-production.up.railway.app/api/rugsheet';
const MUG_API = 'https://api.dicebear.com/7.x/identicon/svg?seed=';
const STORE_KEY = 'rugsheet-v1';
const REFRESH_TTL_MS = 60 * 60 * 1000;
const SCAN_INTERVAL_MS = 10 * 60 * 1000;
const BACKEND_REFRESH_MS = 5 * 60 * 1000;

let scanStats = { added: 0, lastScan: 0 };
let backendStats = null;
let backendDevs = [];
let backendOk = false;

// ─── Helpers ───────────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const fmtUSD = n => {
  if (!isFinite(n) || n < 0) return '$0';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString();
};
const fmtNum = n => {
  if (!isFinite(n) || n < 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return Math.round(n).toLocaleString();
};
const shortAddr = a => a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a;
const fmtAge = ts => {
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return Math.floor(h * 60) + 'm';
  if (h < 24) return Math.floor(h) + 'h';
  return Math.floor(h / 24) + 'd';
};

function detectChain(input) {
  const s = (input || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return 'evm';
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return 'solana';
  return null;
}

// ─── localStorage store ───────────────────────────────────────────────
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { tokens: {}, devs: {}, lastVisit: 0, alerts: [] };
    const s = JSON.parse(raw);
    s.tokens = s.tokens || {};
    s.devs = s.devs || {};
    s.alerts = s.alerts || [];
    return s;
  } catch (e) {
    return { tokens: {}, devs: {}, lastVisit: 0, alerts: [] };
  }
}
function saveStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(STORE)); } catch (e) {} }
let STORE = loadStore();

// ─── Outcome classification ───────────────────────────────────────────
function classifyOutcome(pair) {
  const ageH = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : 0;
  const liq = parseFloat(pair.liquidity?.usd) || 0;
  const vol24 = parseFloat(pair.volume?.h24) || 0;
  const chg24 = parseFloat(pair.priceChange?.h24) || 0;

  if (ageH < 24) return { code: 'pending', label: 'Pending', desc: 'Too young to classify' };
  if (liq < 100) return { code: 'rugged', label: 'Rugged', desc: 'Liquidity drained' };
  if (chg24 < -85 && ageH > 24) return { code: 'rugged', label: 'Rugged', desc: '24h price -85%+' };
  if (liq < 1000 && vol24 < 100 && ageH > 24 * 7) return { code: 'dead', label: 'Dead', desc: 'No volume, no liq' };
  if (chg24 > 1000) return { code: 'moon', label: 'Moon', desc: '24h +1000%' };
  if (chg24 > 200) return { code: 'success', label: 'Success', desc: 'Strong 24h run' };
  return { code: 'alive', label: 'Alive', desc: 'Still trading' };
}

function computeRep(s) {
  const total = s.deployed || 0;
  if (total === 0) return 0;
  const pos = (s.success || 0) * 100 + (s.moon || 0) * 200 + (s.alive || 0) * 10;
  const neg = (s.rugged || 0) * 80 + (s.honeypot || 0) * 150 + (s.dead || 0) * 5;
  return Math.max(-100, Math.min(100, Math.round((pos - neg) / total)));
}

function saveTokenResult(pair, outcome) {
  const addr = (pair.baseToken?.address || '').toLowerCase();
  if (!addr) return;
  const chain = (pair.chainId || 'unknown').toLowerCase();
  const liq = parseFloat(pair.liquidity?.usd) || 0;
  const mc = parseFloat(pair.marketCap || pair.fdv) || 0;
  const prev = STORE.tokens[addr];

  STORE.tokens[addr] = {
    addr, chain,
    symbol: pair.baseToken?.symbol || '?',
    name: pair.baseToken?.name || '',
    pairAddress: pair.pairAddress,
    deployedAt: pair.pairCreatedAt || prev?.deployedAt || Date.now(),
    initialLiq: prev?.initialLiq && prev.initialLiq > 0 ? prev.initialLiq : liq,
    currentLiq: liq, currentMc: mc,
    peakMc: Math.max(prev?.peakMc || 0, mc),
    priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
    volume24h: parseFloat(pair.volume?.h24) || 0,
    outcome: outcome.code,
    outcomeAt: prev && prev.outcome === outcome.code ? prev.outcomeAt : Date.now(),
    lastChecked: Date.now(),
    firstSeen: prev?.firstSeen || Date.now(),
  };

  const devKey = addr;
  const dev = STORE.devs[devKey] || { addr: devKey, chain, ens: null, deployed: [], firstSeen: Date.now() };
  if (!dev.deployed.includes(addr)) dev.deployed.push(addr);
  STORE.devs[devKey] = dev;
  saveStore();
}

function devStats(devKey) {
  const dev = STORE.devs[devKey];
  if (!dev) return null;
  const tokens = (dev.deployed || []).map(a => STORE.tokens[a]).filter(Boolean);
  const stats = { deployed: tokens.length, rugged: 0, dead: 0, alive: 0, success: 0, moon: 0, damage: 0 };
  for (const t of tokens) {
    if (t.outcome === 'rugged')      { stats.rugged++; stats.damage += t.initialLiq || 0; }
    else if (t.outcome === 'dead')   { stats.dead++; }
    else if (t.outcome === 'alive')  { stats.alive++; }
    else if (t.outcome === 'success'){ stats.success++; }
    else if (t.outcome === 'moon')   { stats.moon++; }
  }
  stats.score = computeRep(stats);
  return { ...dev, ...stats };
}

// ─── Backend sync — pulls global DB from the bot API ──────────────────
async function fetchBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const [statsRes, devsRes] = await Promise.all([
      fetch(BACKEND_API + '/stats', { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(BACKEND_API + '/devs?limit=80', { signal: ctrl.signal }).then(r => r.ok ? r.json() : null).catch(() => null),
    ]);
    clearTimeout(t);

    if (!statsRes) {
      backendOk = false;
      backendStats = null;
      backendDevs = [];
      return false;
    }

    backendStats = statsRes;
    backendDevs = Array.isArray(devsRes?.devs) ? devsRes.devs : [];
    backendOk = true;
    return true;
  } catch (e) {
    backendOk = false;
    return false;
  }
}

function renderSyncIndicator() {
  const el = $('#rs-sync-indicator');
  if (!el) return;
  if (backendOk && backendStats) {
    const lastScanMin = backendStats.lastScan ? Math.floor((Date.now() - backendStats.lastScan) / 60000) : null;
    el.innerHTML = `<span style="color:var(--rs-green)">🌐 Global DB synced</span> · ${fmtNum(backendStats.devsTracked)} devs · ${fmtNum(backendStats.rugsDetected)} rugs · ${fmtUSD(backendStats.estimatedDamage)} damage${lastScanMin !== null ? ` · server scan ${lastScanMin}m ago` : ''}`;
  } else {
    el.innerHTML = `<span style="color:var(--rs-yellow)">💾 Local-only mode</span> · backend unreachable, your watchlist is still saved in this browser`;
  }
}

// ─── Refresh stale tokens ─────────────────────────────────────────────
async function refreshStaleTokens() {
  const now = Date.now();
  const stale = Object.values(STORE.tokens).filter(t => now - (t.lastChecked || 0) > REFRESH_TTL_MS);
  if (!stale.length) return [];

  const newAlerts = [];
  for (let i = 0; i < stale.length; i += 30) {
    const batch = stale.slice(i, i + 30);
    const addrs = batch.map(t => t.addr).join(',');
    try {
      const res = await fetch(DEX_API + addrs, { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      const pairs = data?.pairs || [];
      for (const tok of batch) {
        const matches = pairs.filter(p => (p.baseToken?.address || '').toLowerCase() === tok.addr);
        if (!matches.length) {
          const oldOutcome = tok.outcome;
          if (oldOutcome !== 'rugged' && oldOutcome !== 'pending') {
            STORE.tokens[tok.addr].outcome = 'rugged';
            STORE.tokens[tok.addr].lastChecked = Date.now();
            STORE.tokens[tok.addr].outcomeAt = Date.now();
            newAlerts.push({ ts: Date.now(), addr: tok.addr, symbol: tok.symbol, from: oldOutcome, to: 'rugged', msg: `$${tok.symbol}: ${oldOutcome.toUpperCase()} → RUGGED` });
          }
          continue;
        }
        matches.sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0));
        const top = matches[0];
        const outcome = classifyOutcome(top);
        const oldOutcome = tok.outcome;
        saveTokenResult(top, outcome);
        if (oldOutcome && oldOutcome !== outcome.code && oldOutcome !== 'pending') {
          newAlerts.push({ ts: Date.now(), addr: tok.addr, symbol: tok.symbol, from: oldOutcome, to: outcome.code, msg: `$${tok.symbol}: ${oldOutcome.toUpperCase()} → ${outcome.code.toUpperCase()}` });
        }
      }
    } catch (e) { console.warn('Refresh batch failed', e); }
  }
  if (newAlerts.length) {
    STORE.alerts = (STORE.alerts || []).concat(newAlerts);
    saveStore();
  }
  return newAlerts;
}

// ─── Auto-scan: pull boosted tokens from DexScreener ───────────────────
async function autoScan() {
  // Skip client-side scan if backend is alive — server already does this.
  if (backendOk) {
    scanStats.lastScan = Date.now();
    renderScanIndicator();
    return 0;
  }
  let added = 0;
  try {
    const [latestRes, topRes] = await Promise.all([
      fetch(DEX_BOOSTS_LATEST, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => []),
      fetch(DEX_BOOSTS_TOP, { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => []),
    ]);
    const all = [...(Array.isArray(latestRes) ? latestRes : []), ...(Array.isArray(topRes) ? topRes : [])];
    const seen = new Set();
    const newAddresses = [];
    for (const b of all) {
      if (!b.tokenAddress) continue;
      const key = b.tokenAddress.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (STORE.tokens[key]) continue;
      newAddresses.push(b.tokenAddress);
    }
    if (!newAddresses.length) {
      scanStats.lastScan = Date.now();
      renderScanIndicator();
      return 0;
    }
    for (let i = 0; i < newAddresses.length && i < 60; i += 30) {
      const batch = newAddresses.slice(i, i + 30);
      try {
        const res = await fetch(DEX_API + batch.join(','), { signal: AbortSignal.timeout(15000) });
        const data = await res.json();
        const pairs = data?.pairs || [];
        for (const addr of batch) {
          const matches = pairs.filter(p => (p.baseToken?.address || '').toLowerCase() === addr.toLowerCase());
          if (!matches.length) continue;
          matches.sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0));
          const top = matches[0];
          const outcome = classifyOutcome(top);
          saveTokenResult(top, outcome);
          added++;
        }
      } catch (e) { console.warn('autoScan batch failed', e); }
    }
    scanStats.added += added;
    scanStats.lastScan = Date.now();
    renderScanIndicator();
    return added;
  } catch (e) { console.warn('Auto-scan failed', e); return 0; }
}

function renderScanIndicator() {
  const el = $('#rs-scan-indicator');
  if (!el) return;
  if (backendOk) {
    el.textContent = '🛰️ Server-side scanning active — local fallback off';
    return;
  }
  if (!scanStats.lastScan) { el.textContent = '🟡 Scanning market…'; return; }
  const minutes = Math.floor((Date.now() - scanStats.lastScan) / 60000);
  const ago = minutes < 1 ? 'just now' : `${minutes}m ago`;
  el.textContent = scanStats.added
    ? `🟢 ${scanStats.added} new dev${scanStats.added > 1 ? 's' : ''} added this session · last scan ${ago}`
    : `🟢 No new boosted tokens · last scan ${ago}`;
}

// ─── Render a poster card ─────────────────────────────────────────────
function renderPoster(d) {
  const isHonored = d.score > 50;
  const isWanted = d.score < 0;
  const cls = isHonored ? 'honored' : (isWanted ? 'wanted' : 'neutral');
  const tag = isHonored ? '⭐ Honored' : (isWanted ? '☠ Wanted' : 'Neutral');
  const tweetText = encodeURIComponent(
    `${tag.toUpperCase()} on @ByeBoss RugSheet:\n\n${d.ens || shortAddr(d.addr)} — Score ${d.score}\n${d.deployed} tokens deployed${d.rugged ? `, ${d.rugged} rugged` : ''}\n\nbyeboss.live/rugsheet.html`
  );
  return `
    <div class="rs-poster ${cls}" style="cursor:pointer" onclick="openDevDetail('${d.addr}')">
      <div class="rs-poster-tag">${tag}</div>
      <img class="rs-poster-mug" src="${MUG_API}${encodeURIComponent(d.addr)}" alt="mugshot">
      ${d.ens ? `<div class="rs-poster-ens">${d.ens}</div>` : ''}
      <div class="rs-poster-addr">${shortAddr(d.addr)} · ${d.chain || 'unknown'}</div>
      <div class="rs-poster-score">${d.score > 0 ? '+' : ''}${d.score}</div>
      ${d.damage > 0 ? `<div class="rs-poster-bounty">Estimated damage: <strong>${fmtUSD(d.damage)}</strong></div>` : '<div class="rs-poster-bounty">No reported damage</div>'}
      <div class="rs-poster-stats">
        <div><div class="rs-poster-stat-val">${d.deployed || 0}</div><div class="rs-poster-stat-lbl">Deployed</div></div>
        <div><div class="rs-poster-stat-val">${d.rugged || 0}</div><div class="rs-poster-stat-lbl">Rugged</div></div>
        <div><div class="rs-poster-stat-val">${(d.success || 0) + (d.moon || 0)}</div><div class="rs-poster-stat-lbl">Wins</div></div>
      </div>
      <div class="rs-poster-actions">
        <a class="rs-poster-btn" target="_blank" rel="noopener" href="https://twitter.com/intent/tweet?text=${tweetText}">Share</a>
        <button class="rs-poster-btn" onclick="navigator.clipboard.writeText('${d.addr}');this.textContent='Copied'">Copy CA</button>
      </div>
    </div>
  `;
}

function renderLeaderboards() {
  const wanted = $('#rs-wanted-grid');
  const honored = $('#rs-honored-grid');

  // Prefer backend data when available
  const source = (backendOk && backendDevs.length) ? backendDevs : Object.keys(STORE.devs).map(devStats).filter(Boolean);

  if (!source.length) {
    if (wanted) wanted.innerHTML = '<div class="rs-empty">Board is empty. Server scanner is collecting data — refresh in a few minutes.</div>';
    if (honored) honored.innerHTML = '<div class="rs-empty">No honored devs yet.</div>';
    return;
  }
  const sorted = [...source].sort((a, b) => a.score - b.score);
  const worst = sorted.filter(d => d.score < 0).slice(0, 12);
  const best = [...sorted].reverse().filter(d => d.score > 0).slice(0, 12);

  if (wanted) wanted.innerHTML = worst.length ? worst.map(d => renderPoster(d)).join('') : '<div class="rs-empty">No flagged devs yet.</div>';
  if (honored) honored.innerHTML = best.length ? best.map(d => renderPoster(d)).join('') : '<div class="rs-empty">No honored devs yet.</div>';
}

function renderCounters() {
  if (backendOk && backendStats) {
    $('#rs-c-devs').textContent = backendStats.devsTracked ? fmtNum(backendStats.devsTracked) : '—';
    $('#rs-c-rugs').textContent = backendStats.rugsDetected ? fmtNum(backendStats.rugsDetected) : '—';
    $('#rs-c-damage').textContent = backendStats.estimatedDamage ? fmtUSD(backendStats.estimatedDamage) : '—';
    return;
  }
  const tokens = Object.values(STORE.tokens);
  const devs = Object.values(STORE.devs);
  const ruggedCount = tokens.filter(t => t.outcome === 'rugged').length;
  const damage = tokens.filter(t => t.outcome === 'rugged').reduce((s, t) => s + (t.initialLiq || 0), 0);
  $('#rs-c-devs').textContent = devs.length ? devs.length.toString() : '—';
  $('#rs-c-rugs').textContent = ruggedCount ? fmtNum(ruggedCount) : '—';
  $('#rs-c-damage').textContent = damage ? fmtUSD(damage) : '—';
}

function showAlertBanner() {
  const banner = $('#rs-alert-banner');
  const alerts = STORE.alerts || [];
  if (!banner || !alerts.length) { if (banner) banner.hidden = true; return; }
  banner.hidden = false;
  banner.innerHTML = `
    <div class="rs-alert-bar">
      <div>
        <strong>🚨 ${alerts.length} change${alerts.length > 1 ? 's' : ''}</strong> since last visit
        <div class="rs-alert-list">
          ${alerts.slice(-5).reverse().map(a => `<div>· ${a.msg}</div>`).join('')}
          ${alerts.length > 5 ? `<div class="rs-alert-more">+${alerts.length - 5} more</div>` : ''}
        </div>
      </div>
      <button class="rs-poster-btn" onclick="dismissAlerts()">Dismiss</button>
    </div>`;
}
function dismissAlerts() { STORE.alerts = []; saveStore(); showAlertBanner(); }
window.dismissAlerts = dismissAlerts;

// ─── Search / investigate ─────────────────────────────────────────────
async function investigate() {
  const input = $('#rs-input');
  const raw = (input.value || '').trim();
  if (!raw) return;

  const result = $('#rs-result');
  result.hidden = false;
  const detected = detectChain(raw);
  const detLabel = detected === 'evm' ? 'ETH/Base detected' : detected === 'solana' ? 'Solana detected' : 'Treating as symbol search';
  result.innerHTML = `<div class="rs-loading"><span class="rs-spinner"></span> Investigating ${shortAddr(raw)} · ${detLabel}…</div>`;

  try {
    const url = detected ? (DEX_API + encodeURIComponent(raw)) : (DEX_SEARCH + encodeURIComponent(raw));
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (!pairs.length) {
      result.innerHTML = '<div class="rs-error">No pair found for this query. Try a token contract on ETH / Base / Solana, or a symbol like PEPE.</div>';
      return;
    }
    pairs.sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0));
    const top = pairs[0];
    const outcome = classifyOutcome(top);
    saveTokenResult(top, outcome);

    const symbol = top.baseToken?.symbol || '?';
    const name = top.baseToken?.name || '';
    const chain = (top.chainId || 'unknown').toLowerCase();
    const liq = parseFloat(top.liquidity?.usd) || 0;
    const mc = parseFloat(top.marketCap || top.fdv) || 0;
    const vol24 = parseFloat(top.volume?.h24) || 0;
    const chg24 = parseFloat(top.priceChange?.h24) || 0;
    const tokAddr = (top.baseToken?.address || '').toLowerCase();
    const logo = top.info?.imageUrl || `https://dd.dexscreener.com/ds-data/tokens/${chain}/${tokAddr}.png`;
    const dexUrl = top.url || `https://dexscreener.com/${chain}/${top.pairAddress}`;
    const explorerUrl = chain === 'solana' ? `https://solscan.io/token/${tokAddr}` : chain === 'base' ? `https://basescan.org/token/${tokAddr}` : `https://etherscan.io/token/${tokAddr}`;
    const dev = devStats(tokAddr) || { addr: tokAddr, chain, deployed: 1, score: 0 };

    result.innerHTML = `
      <div class="rs-result">
        <div>${renderPoster(dev)}</div>
        <div class="rs-token-card">
          <div class="rs-token-head">
            <div class="rs-token-logo"><img src="${logo}" onerror="this.parentElement.textContent='🪙'" alt=""></div>
            <div>
              <div class="rs-token-name">$${symbol}</div>
              <div class="rs-token-meta">${name} · ${chain.toUpperCase()} · age ${top.pairCreatedAt ? fmtAge(top.pairCreatedAt) : '?'}</div>
            </div>
          </div>
          <div class="rs-outcome ${outcome.code}">${outcome.label}</div>
          <div style="font-size:12px;color:var(--rs-text-dim);margin-bottom:14px">${outcome.desc}</div>
          <div class="rs-stats-grid">
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(mc)}</div><div class="rs-stat-tile-lbl">Market Cap</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(liq)}</div><div class="rs-stat-tile-lbl">Liquidity</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(vol24)}</div><div class="rs-stat-tile-lbl">Vol 24h</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val" style="color:${chg24>=0?'var(--rs-green)':'var(--rs-red)'}">${chg24>=0?'+':''}${chg24.toFixed(1)}%</div><div class="rs-stat-tile-lbl">Change 24h</div></div>
          </div>
          <div class="rs-token-links">
            <a class="rs-token-link" target="_blank" rel="noopener" href="${dexUrl}">📈 DexScreener</a>
            <a class="rs-token-link" target="_blank" rel="noopener" href="${explorerUrl}">🔍 Explorer</a>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--rs-border-bright);font-size:10px;color:var(--rs-text-dim);line-height:1.6">
            ✅ Saved locally${backendOk ? ' (server-side DB also tracks all boosted launches in real time)' : ''}.
          </div>
        </div>
      </div>
    `;

    renderLeaderboards();
    renderCounters();
  } catch (e) {
    result.innerHTML = '<div class="rs-error">Investigation failed: ' + (e?.message || 'network error') + '</div>';
  }
}

let topDevs = [];

async function fetchTopPerformers() {
  try {
    const r = await fetch(BACKEND_API + '/leaderboard?type=peakmc&limit=12', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { topDevs = []; return; }
    const d = await r.json();
    topDevs = Array.isArray(d?.devs) ? d.devs : [];
  } catch (e) { topDevs = []; }
}

function renderTopGrid() {
  const el = document.getElementById('rs-top-grid');
  if (!el) return;
  if (!topDevs.length) {
    el.innerHTML = '<div class="rs-empty">No real devs with peak MC data yet — backend still indexing.</div>';
    return;
  }
  el.innerHTML = topDevs.map(d => renderPoster(d)).join('');
}

// ─── Live feed — Just Deployed ──────────────────────────────────────
const OUTCOME_LABELS = { rugged: 'Rugged', dead: 'Dead', alive: 'Alive', success: 'Win', moon: 'Moon', pending: 'Pending' };
let recentTokens = [];
const FEED_REFRESH_MS = 30 * 1000;

async function fetchRecentTokens() {
  try {
    const r = await fetch(BACKEND_API + '/recent-tokens?limit=18', { signal: AbortSignal.timeout(8000) });
    if (!r.ok) { recentTokens = []; return; }
    const d = await r.json();
    recentTokens = Array.isArray(d?.tokens) ? d.tokens : [];
  } catch (e) { recentTokens = []; }
}

function knownDevSet() {
  const set = new Set();
  for (const d of (backendDevs || [])) if (d?.addr) set.add(String(d.addr).toLowerCase());
  return set;
}

function renderLiveFeed() {
  const el = document.getElementById('rs-feed-grid');
  if (!el) return;
  if (!recentTokens.length) {
    el.innerHTML = '<div class="rs-empty">Scanning fresh launches… new tokens appear here in real time.</div>';
    return;
  }
  const known = knownDevSet();
  const escAttr = (s) => String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  el.innerHTML = recentTokens.map(t => {
    const dev = (t.deployer || '').toLowerCase();
    const isKnown = dev && known.has(dev);
    const chain = (t.chain || 'solana').toLowerCase();
    const ca = t.addrOriginal || t.addr;
    const dexUrl = t.pairAddress ? `https://dexscreener.com/${chain}/${t.pairAddress}` : `https://dexscreener.com/${chain}/${ca}`;
    const pumpUrl = chain === 'solana' ? `https://pump.fun/coin/${ca}` : '';
    const symbol = (t.symbol || '?').toString();
    const initial = symbol.slice(0, 1).toUpperCase();
    const logo = `https://dd.dexscreener.com/ds-data/tokens/${chain}/${(ca || '').toLowerCase()}.png`;
    const ageStr = t.firstSeen ? fmtAge(t.firstSeen) : '—';
    const isFresh = t.firstSeen && (Date.now() - t.firstSeen) < 60 * 60 * 1000;
    const outcome = (t.outcome || 'pending').toLowerCase();
    const outcomeLbl = OUTCOME_LABELS[outcome] || outcome;
    const peakMc = fmtUSD(t.peakMc || 0);
    const currentMc = fmtUSD(t.currentMc || 0);
    const cardOnclick = isKnown
      ? `if(!event.target.closest('a,button')){event.preventDefault();openDevDetail('${dev}');}`
      : '';
    return `
      <a class="rs-feed-card ${isKnown ? 'known-dev' : ''}" href="${dexUrl}" target="_blank" rel="noopener" ${cardOnclick ? `onclick="${cardOnclick}"` : ''}>
        <div class="rs-feed-avatar">
          <span class="rs-feed-avatar-letter">${initial}</span>
          <img src="${escAttr(logo)}" alt="${escAttr(symbol)}" onload="this.classList.add('loaded')" onerror="this.remove()">
        </div>
        <div class="rs-feed-body">
          <div class="rs-feed-line1">
            <span class="rs-feed-ticker">$${symbol}</span>
            <span class="rs-feed-name" title="${escAttr(t.name || '')}">${(t.name || '').toString()}</span>
          </div>
          <div class="rs-feed-line2">
            <span class="rs-feed-chip ${isFresh ? 'new' : outcome}">${isFresh ? 'NEW' : outcomeLbl}</span>
            <span>${ageStr}</span>
            <span class="sep">·</span>
            <span class="mc">${currentMc}</span>
            <span class="ath">/ ATH ${peakMc}</span>
            ${isKnown ? '<span class="sep">·</span><span class="known">📁 on file</span>' : ''}
          </div>
        </div>
        <div class="rs-feed-actions">
          ${pumpUrl ? `<a class="rs-feed-action pf" href="${pumpUrl}" target="_blank" rel="noopener" title="Pump.fun" onclick="event.stopPropagation()">🎰</a>` : ''}
          <a class="rs-feed-action dex" href="${dexUrl}" target="_blank" rel="noopener" title="DexScreener" onclick="event.stopPropagation()">📈</a>
          ${isKnown ? `<button class="rs-feed-action" title="Dev profile" onclick="event.preventDefault();event.stopPropagation();openDevDetail('${dev}')">👤</button>` : ''}
        </div>
      </a>
    `;
  }).join('');
}

// ─── Dev detail modal ────────────────────────────────────────────────
async function openDevDetail(addr) {
  if (!addr) return;
  const modal = document.getElementById('rs-dev-modal');
  const body = document.getElementById('rs-dev-modal-body');
  if (!modal || !body) return;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  body.innerHTML = `<button class="rs-modal-close" onclick="closeDevDetail()">×</button><div class="rs-loading"><span class="rs-spinner"></span> Loading dev profile…</div>`;

  try {
    const r = await fetch(BACKEND_API + '/dev/' + encodeURIComponent(addr), { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('not found');
    const d = await r.json();
    const tokens = (d.tokens || []).slice().sort((a, b) => (b.peakMc || 0) - (a.peakMc || 0));

    body.innerHTML = `
      <button class="rs-modal-close" onclick="closeDevDetail()">×</button>
      <div class="rs-modal-head">
        <img class="rs-modal-mug" src="${MUG_API}${encodeURIComponent(d.addr)}" alt="">
        <div>
          <div class="rs-modal-title">${shortAddr(d.addr)} · ${(d.chain || 'unknown').toUpperCase()}</div>
          <div class="rs-modal-sub">Score ${d.score > 0 ? '+' : ''}${d.score} · first seen ${d.firstSeen ? fmtAge(d.firstSeen) + ' ago' : '?'}</div>
        </div>
      </div>
      <div class="rs-modal-stats">
        <div class="rs-modal-stat"><div class="rs-modal-stat-val">${d.deployed || 0}</div><div class="rs-modal-stat-lbl">Deployed</div></div>
        <div class="rs-modal-stat"><div class="rs-modal-stat-val" style="color:var(--rs-red)">${d.rugged || 0}</div><div class="rs-modal-stat-lbl">Rugged</div></div>
        <div class="rs-modal-stat"><div class="rs-modal-stat-val" style="color:var(--rs-green)">${(d.success || 0) + (d.moon || 0)}</div><div class="rs-modal-stat-lbl">Wins</div></div>
        <div class="rs-modal-stat"><div class="rs-modal-stat-val" style="color:var(--rs-yellow)">${fmtUSD(d.bestPeakMc || 0)}</div><div class="rs-modal-stat-lbl">Best ATH</div></div>
        <div class="rs-modal-stat"><div class="rs-modal-stat-val">${fmtUSD(d.avgPeakMc || 0)}</div><div class="rs-modal-stat-lbl">Avg ATH</div></div>
        <div class="rs-modal-stat"><div class="rs-modal-stat-val" style="color:var(--rs-red)">${fmtUSD(d.damage || 0)}</div><div class="rs-modal-stat-lbl">Damage</div></div>
      </div>
      <div class="rs-modal-section">Tokens deployed (${tokens.length})</div>
      <div class="rs-tokens-list">
        ${tokens.length ? tokens.map(t => {
          const chain = (t.chain || 'solana').toLowerCase();
          const ca = t.addrOriginal || t.addr;
          const dexUrl = t.pairAddress ? `https://dexscreener.com/${chain}/${t.pairAddress}` : `https://dexscreener.com/${chain}/${ca}`;
          const out = t.outcome || 'pending';
          return `
            <a class="rs-token-row" href="${dexUrl}" target="_blank" rel="noopener">
              <div class="rs-token-row-main">
                <div class="rs-token-row-sym">$${(t.symbol || '?').toString()}</div>
                <div class="rs-token-row-name">${(t.name || '').toString()}</div>
              </div>
              <div class="rs-token-row-ath">
                <div class="rs-token-row-ath-val">${fmtUSD(t.peakMc || 0)}</div>
                <div class="rs-token-row-ath-lbl">ATH MC</div>
              </div>
              <span class="rs-token-row-out ${out}">${OUTCOME_LABELS[out] || out}</span>
            </a>
          `;
        }).join('') : '<div class="rs-empty">No tokens indexed yet for this dev.</div>'}
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<button class="rs-modal-close" onclick="closeDevDetail()">×</button><div class="rs-error">Could not load dev profile (${e?.message || 'network error'}).</div>`;
  }
}

function closeDevDetail() {
  const modal = document.getElementById('rs-dev-modal');
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = '';
}

window.openDevDetail = openDevDetail;
window.closeDevDetail = closeDevDetail;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDevDetail(); });

// ─── Boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // First paint with whatever we have locally
  renderCounters();
  renderLeaderboards();
  renderScanIndicator();
  showAlertBanner();

  // Try the backend in parallel — if it answers, stats/leaderboard switch to global
  await fetchBackend();
  await fetchRecentTokens();
  renderSyncIndicator();
  renderCounters();
  renderLeaderboards();
  renderLiveFeed();
  renderScanIndicator();

  // Refresh stale local tokens (anything tracked > 1h ago)
  const newAlerts = await refreshStaleTokens();
  if (newAlerts.length) { renderLeaderboards(); renderCounters(); showAlertBanner(); }

  // Auto-scan boosted tokens — only if backend is unreachable
  const added = await autoScan();
  if (added > 0) { renderLeaderboards(); renderCounters(); }

  STORE.lastVisit = Date.now();
  saveStore();

  // Periodic re-scan + backend re-sync while page is open
  setInterval(async () => {
    const a = await autoScan();
    if (a > 0) { renderLeaderboards(); renderCounters(); }
  }, SCAN_INTERVAL_MS);

  setInterval(async () => {
    await fetchBackend();
    renderSyncIndicator();
    renderCounters();
    renderLeaderboards();
    renderScanIndicator();
  }, BACKEND_REFRESH_MS);

  setInterval(async () => {
    await fetchRecentTokens();
    renderLiveFeed();
  }, FEED_REFRESH_MS);

  $('#rs-go')?.addEventListener('click', investigate);
  $('#rs-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') investigate(); });
});
