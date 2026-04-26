// rugsheet.js — Search + render logic for the dev reputation tracker

const DEX_API = 'https://api.dexscreener.com/latest/dex/tokens/';
const MUG_API = 'https://api.dicebear.com/7.x/identicon/svg?seed=';

// ─── Demo data — replaces the real backend until the worker ships ─────
const MOST_WANTED = [
  { addr: '0x4a3b8c2d1e9f7a6b5c4d3e2f1a9b8c7d6e5f4a3b', chain: 'ethereum', ens: 'rugmaster.eth', deployed: 47, rugged: 41, damage: 2400000, score: -89 },
  { addr: 'HnT9k2pQ7vYzL4mN8RxBcDfWjXgVtKuEsAYpzJi3rM5n', chain: 'solana', ens: null, deployed: 23, rugged: 19, damage: 880000, score: -82 },
  { addr: '0x9e8d7c6b5a4f3e2d1c0b9a8e7d6c5b4a3e2f1d0c', chain: 'base', ens: 'serialscam.eth', deployed: 38, rugged: 34, damage: 1200000, score: -90 },
  { addr: '0x1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c', chain: 'ethereum', ens: null, deployed: 18, rugged: 12, damage: 540000, score: -65 },
  { addr: '7Fxp2v5Yzm9kLwBnHcRtJqDsAGvUnWxKpEsZbMi4Tro', chain: 'solana', ens: null, deployed: 31, rugged: 25, damage: 1050000, score: -75 },
  { addr: '0xcafe1234567890abcdef1234567890abcdef1234', chain: 'ethereum', ens: 'punisher.eth', deployed: 56, rugged: 49, damage: 3200000, score: -91 },
];

const HALL_OF_FAME = [
  { addr: '0xa1b2c3d4e5f60708091a2b3c4d5e6f708192a3b4', chain: 'ethereum', ens: 'cleanbuild.eth', deployed: 8, success: 6, moon: 1, damage: 0, score: 87 },
  { addr: 'C1eAnD3v9BuiLd2zP6rT4mNk8YxJqFwSaVtZcEbR5oH', chain: 'solana', ens: null, deployed: 4, success: 3, moon: 0, damage: 0, score: 78 },
  { addr: '0xfeed1234567890abcdeffedcba0987654321abcd', chain: 'base', ens: 'longterm.eth', deployed: 11, success: 7, moon: 2, damage: 0, score: 92 },
];

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

// ─── Outcome classification (client-side, simplified) ────────────────────
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

// ─── Reputation score (client-side fake from limited data) ────────────────
function computeRep(stats) {
  const total = stats.deployed || 0;
  if (total === 0) return 0;
  const pos = (stats.success || 0) * 100 + (stats.moon || 0) * 200 + (stats.alive || 0) * 10;
  const neg = (stats.rugged || 0) * 80 + (stats.honeypot || 0) * 150 + (stats.dead || 0) * 5;
  return Math.max(-100, Math.min(100, Math.round((pos - neg) / total)));
}

// ─── Render a wanted poster card ──────────────────────────────────────────
function renderPoster(d, opts = {}) {
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
      ${d.damage ? `<div class="rs-poster-bounty">Estimated damage: <strong>${fmtUSD(d.damage)}</strong></div>` : '<div class="rs-poster-bounty">No reported damage</div>'}
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

// ─── Render the Most Wanted + Hall of Fame grids ──────────────────────────
function renderGrids() {
  const wanted = $('#rs-wanted-grid');
  if (wanted) wanted.innerHTML = MOST_WANTED.map(d => renderPoster(d)).join('');
  const honored = $('#rs-honored-grid');
  if (honored) honored.innerHTML = HALL_OF_FAME.map(d => renderPoster(d)).join('');
}

// ─── Counters animation ──────────────────────────────────────────────────
function animateCounters() {
  const totalDevs = MOST_WANTED.length + HALL_OF_FAME.length;
  const totalRugs = MOST_WANTED.reduce((s, d) => s + (d.rugged || 0), 0);
  const totalDamage = MOST_WANTED.reduce((s, d) => s + (d.damage || 0), 0);
  $('#rs-c-devs').textContent = `${totalDevs}+`;
  $('#rs-c-rugs').textContent = fmtNum(totalRugs);
  $('#rs-c-damage').textContent = fmtUSD(totalDamage);
}

// ─── Token search ────────────────────────────────────────────────────────
async function investigate() {
  const input = $('#rs-input');
  const raw = (input.value || '').trim();
  if (!raw) return;

  const result = $('#rs-result');
  result.hidden = false;
  result.innerHTML = '<div class="rs-loading"><span class="rs-spinner"></span> Investigating ' + shortAddr(raw) + '…</div>';

  try {
    const res = await fetch(DEX_API + encodeURIComponent(raw), { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const pairs = data?.pairs || [];
    if (!pairs.length) {
      result.innerHTML = '<div class="rs-error">No pair found for this address. Make sure it is a valid token contract on ETH / Base / Solana.</div>';
      return;
    }

    // Pick the pair with highest liquidity
    pairs.sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0));
    const top = pairs[0];
    const outcome = classifyOutcome(top);

    const symbol = top.baseToken?.symbol || '?';
    const name = top.baseToken?.name || '';
    const chain = (top.chainId || 'unknown').toLowerCase();
    const liq = parseFloat(top.liquidity?.usd) || 0;
    const mc = parseFloat(top.marketCap || top.fdv) || 0;
    const vol24 = parseFloat(top.volume?.h24) || 0;
    const chg24 = parseFloat(top.priceChange?.h24) || 0;
    const logo = top.info?.imageUrl || `https://dd.dexscreener.com/ds-data/tokens/${chain}/${raw.toLowerCase()}.png`;
    const dexUrl = top.url || `https://dexscreener.com/${chain}/${top.pairAddress}`;

    // Pseudo-dev (we don't know the real deployer client-side without an API key)
    // Use the token addr as a placeholder seed — the live backend will replace this.
    const pseudoDev = {
      addr: raw,
      chain,
      ens: null,
      deployed: 1,
      rugged: outcome.code === 'rugged' ? 1 : 0,
      success: outcome.code === 'success' ? 1 : 0,
      moon: outcome.code === 'moon' ? 1 : 0,
      alive: outcome.code === 'alive' ? 1 : 0,
      damage: outcome.code === 'rugged' ? liq : 0,
      score: 0,
    };
    pseudoDev.score = computeRep(pseudoDev);

    result.innerHTML = `
      <div class="rs-result">
        <div>${renderPoster(pseudoDev)}</div>
        <div class="rs-token-card">
          <div class="rs-token-head">
            <div class="rs-token-logo"><img src="${logo}" onerror="this.parentElement.textContent='🪙'" alt=""></div>
            <div>
              <div class="rs-token-name">$${symbol}</div>
              <div class="rs-token-meta">${name} · ${chain.toUpperCase()} · age ${top.pairCreatedAt ? fmtAge(top.pairCreatedAt) : '?'}</div>
            </div>
          </div>
          <div class="rs-outcome ${outcome.code}">${outcome.label}</div>
          <div style="font-size:12px;color:var(--rs-bone-dim);margin-bottom:14px">${outcome.desc}</div>
          <div class="rs-stats-grid">
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(mc)}</div><div class="rs-stat-tile-lbl">Market Cap</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(liq)}</div><div class="rs-stat-tile-lbl">Liquidity</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val">${fmtUSD(vol24)}</div><div class="rs-stat-tile-lbl">Vol 24h</div></div>
            <div class="rs-stat-tile"><div class="rs-stat-tile-val" style="color:${chg24>=0?'#22c55e':'var(--rs-blood)'}">${chg24>=0?'+':''}${chg24.toFixed(1)}%</div><div class="rs-stat-tile-lbl">Change 24h</div></div>
          </div>
          <div class="rs-token-links">
            <a class="rs-token-link" target="_blank" rel="noopener" href="${dexUrl}">📈 DexScreener</a>
            <a class="rs-token-link" target="_blank" rel="noopener" href="https://${chain==='solana'?'solscan.io/token/':chain==='base'?'basescan.org/token/':'etherscan.io/token/'}${raw}">🔍 Explorer</a>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--rs-border);font-size:10px;color:var(--rs-bone-dim);line-height:1.6">
            ⚠️ Single-token reputation is a teaser preview. Full deployer lookup, historical token list, and 60-min cross-chain alerts ship with the backend rollout.
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    result.innerHTML = '<div class="rs-error">Investigation failed: ' + (e?.message || 'network error') + '</div>';
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderGrids();
  animateCounters();
  $('#rs-go')?.addEventListener('click', investigate);
  $('#rs-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') investigate(); });
});
