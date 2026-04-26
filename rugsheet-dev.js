// rugsheet-dev.js — Dev profile page (per-dev token list + ATH peak MC).
// Reads ?addr=... and fetches GET /api/rugsheet/dev/:addr.

const BACKEND_API = 'https://dexscreener-telegram-bot-production.up.railway.app/api/rugsheet';
const MUG_API = 'https://api.dicebear.com/7.x/identicon/svg?seed=';

const $ = sel => document.querySelector(sel);

const fmtUSD = n => {
  if (!isFinite(n) || n < 0) return '$0';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString();
};
const shortAddr = a => a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : (a || '');
const fmtAge = ts => {
  if (!ts) return '?';
  const h = (Date.now() - ts) / 3600000;
  if (h < 1) return Math.max(0, Math.floor(h * 60)) + 'm';
  if (h < 24) return Math.floor(h) + 'h';
  return Math.floor(h / 24) + 'd';
};
const escapeHTML = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

function getQueryAddr() {
  const p = new URLSearchParams(location.search);
  return (p.get('addr') || '').trim();
}

function explorerForAddr(addr, chain) {
  const c = (chain || '').toLowerCase();
  if (c === 'solana' || c === 'pumpfun') return `https://solscan.io/account/${addr}`;
  if (c === 'base') return `https://basescan.org/address/${addr}`;
  return `https://etherscan.io/address/${addr}`;
}

function dexscreenerLink(addr, pairAddress, chain) {
  const c = (chain || '').toLowerCase();
  if (pairAddress) return `https://dexscreener.com/${c}/${pairAddress}`;
  return `https://dexscreener.com/${c}/${addr}`;
}

function outcomeLabel(code) {
  return ({ rugged: 'Rugged', dead: 'Dead', alive: 'Alive', success: 'Success', moon: 'Moon', pending: 'Pending' })[code] || code || '?';
}

function renderError(msg) {
  $('#rs-dev-section').innerHTML = `<div class="rs-error">${escapeHTML(msg)}</div>`;
}

function renderHeader(d) {
  const isHonored = d.score > 50;
  const isWanted = d.score < 0;
  const cls = isHonored ? 'honored' : (isWanted ? 'wanted' : 'neutral');
  const tag = isHonored ? '⭐ HONORED' : (isWanted ? '☠ WANTED' : 'NEUTRAL');
  const realTag = d.isReal
    ? '<span class="rs-dev-realtag">✓ Real Dev</span>'
    : '<span class="rs-dev-realtag pseudo">⚠ Pseudo (token = dev)</span>';
  const wins = (d.success || 0) + (d.moon || 0);

  return `
    <div class="rs-dev-header ${cls}">
      <div class="rs-dev-head-main">
        <img class="rs-dev-mug" src="${MUG_API}${encodeURIComponent(d.addr)}" alt="mugshot">
        <div class="rs-dev-head-info">
          <div class="rs-dev-head-tags">
            <span class="rs-dev-tag">${tag}</span>
            ${realTag}
            <span class="rs-dev-chain">${escapeHTML((d.chain || 'unknown').toUpperCase())}</span>
          </div>
          <div class="rs-dev-addr" title="${escapeHTML(d.addr)}">${escapeHTML(d.addr)}</div>
          <div class="rs-dev-score-wrap">
            <span class="rs-dev-score">${d.score > 0 ? '+' : ''}${d.score}</span>
            <span class="rs-dev-score-lbl">Reputation</span>
          </div>
          <div class="rs-dev-actions">
            <a class="rs-poster-btn" target="_blank" rel="noopener" href="${explorerForAddr(d.addr, d.chain)}">🔍 Explorer</a>
            <button class="rs-poster-btn" onclick="navigator.clipboard.writeText('${d.addr}');this.textContent='Copied'">Copy CA</button>
          </div>
        </div>
      </div>
      <div class="rs-dev-stats">
        <div class="rs-dev-stat-tile"><div class="rs-dev-stat-val">${d.deployed || 0}</div><div class="rs-dev-stat-lbl">Tokens</div></div>
        <div class="rs-dev-stat-tile"><div class="rs-dev-stat-val">${fmtUSD(d.bestPeakMc || 0)}</div><div class="rs-dev-stat-lbl">Best Peak MC</div></div>
        <div class="rs-dev-stat-tile"><div class="rs-dev-stat-val" style="color:var(--rs-cyan)">${fmtUSD(d.avgPeakMc || 0)}</div><div class="rs-dev-stat-lbl">Avg Peak MC</div></div>
        <div class="rs-dev-stat-tile"><div class="rs-dev-stat-val" style="color:var(--rs-red)">${d.rugged || 0}</div><div class="rs-dev-stat-lbl">Rugged</div></div>
        <div class="rs-dev-stat-tile"><div class="rs-dev-stat-val" style="color:var(--rs-yellow)">${wins}</div><div class="rs-dev-stat-lbl">Wins</div></div>
      </div>
    </div>
  `;
}

function renderTokenRow(t, rank) {
  const outcome = t.outcome || 'pending';
  const symbol = t.symbol || '?';
  const name = t.name || '';
  const peak = t.peakMc || 0;
  const cur = t.currentMc || 0;
  const liq = t.currentLiq || 0;
  const age = fmtAge(t.deployedAt);
  const dexAddr = t.addrOriginal || t.addr;
  const chain = (t.chain || 'unknown').toLowerCase();
  return `
    <a class="rs-token-row" target="_blank" rel="noopener" href="${dexscreenerLink(dexAddr, t.pairAddress, chain)}">
      <div class="rs-token-rank">#${rank}</div>
      <div class="rs-token-cell rs-token-symbol">
        <div class="rs-token-symbol-val">$${escapeHTML(symbol)}</div>
        ${name ? `<div class="rs-token-symbol-sub">${escapeHTML(name)}</div>` : ''}
      </div>
      <div class="rs-token-cell">
        <div class="rs-token-mc">${fmtUSD(peak)}</div>
        <div class="rs-token-mc-lbl">Peak MC</div>
      </div>
      <div class="rs-token-cell rs-token-mc-current">
        <div class="rs-token-mc-val">${fmtUSD(cur)}</div>
        <div class="rs-token-mc-lbl">Current</div>
      </div>
      <div class="rs-token-cell rs-token-liq">
        <div class="rs-token-mc-val">${fmtUSD(liq)}</div>
        <div class="rs-token-mc-lbl">Liq</div>
      </div>
      <div class="rs-token-cell rs-token-age">
        <div class="rs-token-age-val">${age}</div>
        <div class="rs-token-mc-lbl">Age</div>
      </div>
      <div class="rs-token-cell rs-token-outcome-cell">
        <span class="rs-outcome ${outcome}">${outcomeLabel(outcome)}</span>
      </div>
    </a>
  `;
}

function renderTokens(tokens) {
  if (!tokens.length) return '<div class="rs-empty">No tokens recorded for this dev yet.</div>';
  return `<div class="rs-token-list">${tokens.map((t, i) => renderTokenRow(t, i + 1)).join('')}</div>`;
}

async function loadDev() {
  const addr = getQueryAddr();
  if (!addr) {
    renderError('Missing ?addr= parameter. Pick a dev from one of the rugsheet leaderboards.');
    return;
  }
  document.title = `RugSheet · ${shortAddr(addr)}`;
  try {
    const res = await fetch(`${BACKEND_API}/dev/${encodeURIComponent(addr)}`, { signal: AbortSignal.timeout(12000) });
    if (res.status === 404) {
      renderError('Dev not found in the global DB yet. The scanner may not have indexed this address — try again later or pick one from the leaderboards on the home page.');
      return;
    }
    if (!res.ok) {
      renderError(`Backend error (${res.status}). Try again in a few minutes.`);
      return;
    }
    const d = await res.json();
    if (!d || !d.addr) {
      renderError('Empty response from backend.');
      return;
    }
    const html = `
      ${renderHeader(d)}
      <div class="rs-section-head" style="margin-top:36px">
        <span class="rs-marker">//</span>
        <h2>Launched Tokens</h2>
        <span class="rs-sub">${d.deployed || 0} total · sorted by peak MC</span>
      </div>
      ${renderTokens(d.tokens || [])}
    `;
    $('#rs-dev-section').innerHTML = html;
  } catch (e) {
    renderError('Network error: ' + (e?.message || 'unknown'));
  }
}

document.addEventListener('DOMContentLoaded', loadDev);
