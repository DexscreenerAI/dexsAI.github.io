// rugsheet.js — Search + localStorage persistence + leaderboard + outcome alerts.

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens/';
const DEX_SEARCH = 'https://api.dexscreener.com/latest/dex/search?q=';
const MUG_API = 'https://api.dicebear.com/7.x/identicon/svg?seed=';
const STORE_KEY = 'rugsheet-v1';
const REFRESH_TTL_MS = 60 * 60 * 1000; // re-check each tracked token at most every hour

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

// ─── Chain detection from address shape ───────────────────────────────
function detectChain(input) {
  const s = (input || '').trim();
  if (/^0x[a-fA-F0-9]{40}$/.test(s)) return 'evm';        // ethereum or base
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return 'solana';
  return null; // probably a symbol
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
function saveStore() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(STORE)); } catch (e) {}
}
let STORE = loadStore();

// ─── Outcome classification (client-side, simplified) ─────────────────
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

// ─── Reputation formula ────────────────────────────────────────────────
function computeRep(s) {
  const total = s.deployed || 0;
  if (total === 0) return 0;
  const pos = (s.success || 0) * 100 + (s.moon || 0) * 200 + (s.alive || 0) * 10;
  const neg = (s.rugged || 0) * 80 + (s.honeypot || 0) * 150 + (s.dead || 0) * 5;
  return Math.max(-100, Math.min(100, Math.round((pos - neg) / total)));
}

// ─── Save a token result (links to a pseudo-dev keyed by token addr) ──
// Real deployer lookup needs a backend with Etherscan/Helius keys; until
// then each token becomes its own "dev" in the local store.
function saveTokenResult(pair, outcome) {
  const addr = (pair.baseToken?.address || '').toLowerCase();
  if (!addr) return;
  const chain = (pair.chainId || 'unknown').toLowerCase();
  const liq = parseFloat(pair.liquidity?.usd) || 0;
  const mc = parseFloat(pair.marketCap || pair.fdv) || 0;
  const prev = STORE.tokens[addr];

  STORE.tokens[addr] = {
    addr,
    chain,
    symbol: pair.baseToken?.symbol || '?',
    name: pair.baseToken?.name || '',
    pairAddress: pair.pairAddress,
    deployedAt: pair.pairCreatedAt || prev?.deployedAt || Date.now(),
    initialLiq: prev?.initialLiq && prev.initialLiq > 0 ? prev.initialLiq : liq,
    currentLiq: liq,
    currentMc: mc,
    peakMc: Math.max(prev?.peakMc || 0, mc),
    priceChange24h: parseFloat(pair.priceChange?.h24) || 0,
    volume24h: parseFloat(pair.volume?.h24) || 0,
    outcome: outcome.code,
    outcomeAt: prev && prev.outcome === outcome.code ? prev.outcomeAt : Date.now(),
    lastChecked: Date.now(),
    firstSeen: prev?.firstSeen || Date.now(),
  };

  // Pseudo-dev linkage (until backend gives us real deployer)
  const devKey = addr;
  const dev = STORE.devs[devKey] || { addr: devKey, chain, ens: null, deployed: [], firstSeen: Date.now() };
  if (!dev.deployed.includes(addr)) dev.deployed.push(addr);
  STORE.devs[devKey] = dev;

  saveStore();
}

// ─── Aggregate dev stats from tokens in store ─────────────────────────
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

// ─── Refresh stale tokens via batched DexScreener calls (up to 30/req) ─
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
          // If liquidity vanished entirely, mark as rugged
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
    <div class="rs-poster ${cls}">
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

// ─── Render local leaderboards from store ─────────────────────────────
function renderLocalLeaderboards() {
  const allDevs = Object.keys(STORE.devs).map(devStats).filter(Boolean);
  const wanted = $('#rs-wanted-grid');
  const honored = $('#rs-honored-grid');

  if (!allDevs.length) {
    if (wanted) wanted.innerHTML = '<div class="rs-empty">Local board is empty. Search any token to start tracking devs.</div>';
    if (honored) honored.innerHTML = '<div class="rs-empty">No honored devs yet.</div>';
    return;
  }
  const sorted = [...allDevs].sort((a, b) => a.score - b.score);
  const worst = sorted.filter(d => d.score < 0).slice(0, 12);
  const best = [...sorted].reverse().filter(d => d.score > 0).slice(0, 12);

  if (wanted) wanted.innerHTML = worst.length
    ? worst.map(d => renderPoster(d)).join('')
    : '<div class="rs-empty">No flagged devs yet — keep investigating.</div>';
  if (honored) honored.innerHTML = best.length
    ? best.map(d => renderPoster(d)).join('')
    : '<div class="rs-empty">No honored devs yet.</div>';
}

// ─── Counters from store ──────────────────────────────────────────────
function renderCounters() {
  const tokens = Object.values(STORE.tokens);
  const devs = Object.values(STORE.devs);
  const ruggedCount = tokens.filter(t => t.outcome === 'rugged').length;
  const damage = tokens.filter(t => t.outcome === 'rugged').reduce((s, t) => s + (t.initialLiq || 0), 0);
  $('#rs-c-devs').textContent = devs.length ? devs.length.toString() : '—';
  $('#rs-c-rugs').textContent = ruggedCount ? fmtNum(ruggedCount) : '—';
  $('#rs-c-damage').textContent = damage ? fmtUSD(damage) : '—';
}

// ─── Alert banner ─────────────────────────────────────────────────────
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
    </div>
  `;
}
function dismissAlerts() {
  STORE.alerts = [];
  saveStore();
  showAlertBanner();
}
window.dismissAlerts = dismissAlerts;

// ─── Search / investigate ─────────────────────────────────────────────
async function investigate() {
  const input = $('#rs-input');
  const raw = (input.value || '').trim();
  if (!raw) return;

  const result = $('#rs-result');
  result.hidden = false;
  const detected = detectChain(raw);
  const detLabel = detected === 'evm' ? 'ETH/Base detected'
                 : detected === 'solana' ? 'Solana detected'
                 : 'Treating as symbol search';
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
    const explorerUrl = chain === 'solana' ? `https://solscan.io/token/${tokAddr}`
                      : chain === 'base'   ? `https://basescan.org/token/${tokAddr}`
                      :                       `https://etherscan.io/token/${tokAddr}`;

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
            ✅ Saved locally. This token is now tracked — its outcome auto-refreshes on every visit (max 1 fetch / hour / token).
          </div>
        </div>
      </div>
    `;

    // Refresh leaderboards + counters with the new entry
    renderLocalLeaderboards();
    renderCounters();
  } catch (e) {
    result.innerHTML = '<div class="rs-error">Investigation failed: ' + (e?.message || 'network error') + '</div>';
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  renderCounters();
  renderLocalLeaderboards();
  showAlertBanner();

  // Background refresh — only stale tokens (last_checked > 1h ago) are refetched
  const newAlerts = await refreshStaleTokens();
  if (newAlerts.length) {
    renderLocalLeaderboards();
    renderCounters();
    showAlertBanner();
  }

  STORE.lastVisit = Date.now();
  saveStore();

  $('#rs-go')?.addEventListener('click', investigate);
  $('#rs-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') investigate(); });
});
