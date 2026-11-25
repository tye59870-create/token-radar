// Token Radar dashboard client (radar-3).
// Renders the offline board, filters, sorting, charts, methodology panel, and protocol
// detail drawer directly from window.RADAR (loaded via ../data.js).
(() => {
  'use strict';

  const DATA = window.RADAR;
  const root = document.getElementById('board');
  if (!DATA || !root) return;

  const WATCHLIST_SLUGS = new Set(DATA.watchlist || []);
  const LOW_GAS_CHAINS = new Set([
    'Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'BSC', 'BNB Chain', 'Binance',
    'Avalanche', 'Blast', 'Linea', 'Scroll', 'zkSync Era', 'Mode', 'Sonic', 'Plasma',
    'Hyperliquid', 'Hyperliquid L1', 'Sui', 'Aptos', 'Monad', 'Stellar', 'Ink', 'Tron',
    'Mantle', 'Starknet', 'Stable', 'Robinhood Chain', 'Katana', 'Arc', 'Tempo', 'BOB',
    'Plume Mainnet', 'Fluent', 'Citrea', 'Mezo', 'Corn', 'Morph', 'Proton', 'Ripple',
    'Kava', 'Flare', 'Berachain', 'Unichain', 'Sei', 'Soneium', 'World Chain', 'Zora',
  ]);

  const state = {
    q: '',
    category: 'all',
    chain: 'all',
    watchlistOnly: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    liveSort: 'mcap',
    liveDir: -1,
    selected: null,
  };

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  const currencyFormatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

  function formatUsd(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    const abs = Math.abs(value);
    if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `$${Math.round(value / 1e3)}K`;
    return currencyFormatter.format(value);
  }

  function formatPercent(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
  }

  function formatAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${Math.max(0, Math.round(days))}d`;
  }

  function formatFixed4(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
    return Number(value).toFixed(4);
  }

  function summarizeChains(chains, maxCount) {
    if (!chains || chains.length === 0) return 'an unnamed chain';
    return maxCount ? chains.slice(0, maxCount).join(', ') : chains.join(', ');
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // -------------------------------------------------------------------------
  // DOM builder
  // -------------------------------------------------------------------------

  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === null || val === undefined) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'html') node.innerHTML = val;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
        else node.setAttribute(key, String(val));
      }
    }
    for (const child of children) {
      if (child === null || child === undefined) continue;
      if (Array.isArray(child)) {
        for (const nested of child) {
          if (nested !== null && nested !== undefined) {
            node.appendChild(typeof nested === 'string' ? document.createTextNode(nested) : nested);
          }
        }
      } else if (typeof child === 'string') {
        node.appendChild(document.createTextNode(child));
      } else {
        node.appendChild(child);
      }
    }
    return node;
  }

  // -------------------------------------------------------------------------
  // Client-side model verification & farm-step derivation (mirrors lib/model.ts)
  // -------------------------------------------------------------------------

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function hasKeyword(text, keyword) {
    return new RegExp(`\\b${escapeRegExp(keyword)}`, 'i').test(text);
  }

  function maturityMultiplier(age, model) {
    if (age === null || age === undefined) return model.unknown_maturity;
    if (age < model.maturity_sweet_start) {
      return (
        model.maturity_young_floor +
        (model.maturity_peak - model.maturity_young_floor) * (age / model.maturity_sweet_start)
      );
    }
    if (age <= model.maturity_sweet_end) return model.maturity_peak;
    if (age <= model.maturity_decline_end) {
      const span = model.maturity_decline_end - model.maturity_sweet_end;
      return (
        model.maturity_peak -
        (model.maturity_peak - model.maturity_young_floor) * ((age - model.maturity_sweet_end) / span)
      );
    }
    const over = Math.min(1, (age - model.maturity_decline_end) / model.maturity_decline_end);
    return model.maturity_young_floor - (model.maturity_young_floor - model.maturity_old_floor) * over;
  }

  function recomputeImplied(row, model) {
    const rawGrowth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = clamp(rawGrowth, model.growth_floor, model.growth_cap);
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const rawAge = row.age_days === null || row.age_days === undefined ? null : row.age_days;
    const maturityMult = maturityMultiplier(rawAge, model);
    const chainCount = Array.isArray(row.chains) ? row.chains.length : 0;
    const chainMult = 1 + model.chain_step * clamp(chainCount - 1, 0, model.chain_cap);
    return Math.max(1, Math.round(row.tvl_usd * row.ratio * growthMult * maturityMult * chainMult));
  }

  function signalScore(row) {
    const age = row.age_days;
    let ageScore;
    if (age === null || age === undefined) ageScore = 50;
    else if (age >= 180 && age <= 540) ageScore = 100;
    else if ((age >= 90 && age < 180) || (age > 540 && age <= 1095)) ageScore = 70;
    else if (age < 90) ageScore = 40;
    else ageScore = 30;
    const growthScore = clamp(50 + (row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d), 0, 100);
    const chainScore = Math.min(100, (Array.isArray(row.chains) ? row.chains.length : 0) * 10);
    const categoryScore = row.ratio_n >= 3 ? 80 : row.ratio_n >= 1 ? 50 : 30;
    return Math.round(0.35 * ageScore + 0.25 * growthScore + 0.15 * chainScore + 0.25 * categoryScore);
  }

  const CATEGORY_PLAYBOOKS = [
    {
      keywords: ['collateral markets'],
      setup: (c) => `Supply $${c.capital} of collateral assets through ${c.name} on ${c.chain} and keep the position open.`,
      weekly: (c) => `Top up the collateral or move it between ${c.name} markets once a week so the wallet shows fresh activity.`,
    },
    {
      keywords: ['curator', 'allocator'],
      setup: (c) => `Deposit $${c.capital} into a ${c.name} vault on ${c.chain} and keep the vault shares in the same wallet.`,
      weekly: (c) => `Top up the vault or move between ${c.name} vaults once a week so the wallet shows fresh activity.`,
    },
    {
      keywords: ['indexes'],
      setup: (c) => `Buy $${c.capital} of the index token through ${c.name} on ${c.chain} and hold it in the same wallet.`,
      weekly: (c) => `Rebalance or top up the ${c.name} index position once a week.`,
    },
    {
      keywords: ['liquidity manager'],
      setup: (c) => `Deposit $${c.capital} into a ${c.name} managed liquidity position on ${c.chain} and keep it open.`,
      weekly: (c) => `Rebalance the ${c.name} position once a week.`,
    },
    {
      keywords: ['cedefi'],
      setup: (c) => `Deposit $${c.capital} into the ${c.name} CeDeFi vault on ${c.chain} and keep the position open.`,
      weekly: (c) => `Top up or rebalance the ${c.name} vault once a week.`,
    },
    {
      keywords: ['anchor btc'],
      setup: (c) => `Deposit $${c.capital} of BTC-backed collateral through ${c.name} on ${c.chain} and keep the position open.`,
      weekly: (c) => `Top up the ${c.name} position once a week.`,
    },
    {
      keywords: ['crypto card', 'card issuer'],
      setup: (c) => `Order the card from ${c.name}, load $${c.capital} onto it and spend from it.`,
      weekly: (c) => `Make one card payment through ${c.name} each week.`,
    },
    {
      keywords: ['rwa'],
      setup: (c) => `Mint $${c.capital} of the yield-bearing asset on ${c.chain} through ${c.name} and hold it in the same wallet.`,
      weekly: (c) => `Claim or compound the yield on your ${c.name} position once a week so it stays active.`,
    },
    {
      keywords: ['lend', 'cdp', 'collateral'],
      setup: (c) => `Supply $${c.capital} of USDC to ${c.name} on ${c.chain}, then borrow a small amount against it and keep the position open.`,
      weekly: (c) => `Repay and re-borrow a small amount on ${c.name} each week to keep the position active.`,
    },
    {
      keywords: ['dex', 'leveraged farm'],
      setup: (c) => `Provide $${c.capital} of liquidity to ${c.name}'s main pool on ${c.chain} and keep the position open.`,
      weekly: (c) => `Swap a small amount through ${c.name}'s pool on ${c.chain} once a week.`,
    },
    {
      keywords: ['yield'],
      setup: (c) => `Deposit $${c.capital} into ${c.name}'s yield vault on ${c.chain} and keep the receipt token.`,
      weekly: (c) => `Harvest or compound the yield on ${c.name} once a week.`,
    },
    {
      keywords: ['basis trad'],
      setup: (c) => `Deposit $${c.capital} of USDC as margin on ${c.name} and open one small delta-neutral position.`,
      weekly: (c) => `Roll or rebalance the ${c.name} position once a week.`,
    },
    {
      keywords: ['perpetual', 'derivative'],
      setup: (c) => `Deposit $${c.capital} of USDC as margin on ${c.name} and open one small hedge.`,
      weekly: (c) => `Roll or rebalance the ${c.name} position once a week.`,
    },
    {
      keywords: ['insurance'],
      setup: (c) => `Buy $${c.capital} of cover from ${c.name} on ${c.chain} and keep the policy active.`,
      weekly: (c) => `Check the ${c.name} policy each week and renew it before it lapses.`,
    },
    {
      keywords: ['staking', 'restak', 'staking pool'],
      setup: (c) => `Stake $${c.capital} of the chain's staking asset through ${c.name} and keep the receipt token.`,
      weekly: (c) => `Top up the stake on ${c.name} by a small amount once a week.`,
    },
    {
      keywords: ['governance'],
      setup: (c) => `Deposit $${c.capital} into ${c.name} on ${c.chain} and vote in its governance with the same wallet.`,
      weekly: (c) => `Vote on one ${c.name} proposal a week with the farming wallet.`,
    },
    {
      keywords: ['stable'],
      setup: (c) => `Mint $${c.capital} of the stable asset through ${c.name} on ${c.chain} and hold it in the same wallet.`,
      weekly: (c) => `Use the minted asset in ${c.name}'s app once a week.`,
    },
    {
      keywords: ['bridge'],
      setup: (c) => `Bridge $${c.capital} of USDC to ${c.chain} through ${c.name} and use the bridged funds in its app.`,
      weekly: (c) => `Bridge a small amount through ${c.name} once a week.`,
    },
    {
      keywords: ['payment'],
      setup: (c) => `Open a channel and route $${c.capital} of payments through ${c.name} on ${c.chain}.`,
      weekly: (c) => `Route one payment through ${c.name} each week.`,
    },
    {
      keywords: ['chain'],
      setup: (c) => `Bridge $${c.capital} to ${c.name} and use its apps in small amounts: one swap, one lend and one stake.`,
      weekly: (c) => `Do one on-chain action a week on ${c.name}: a swap, a lend or a stake.`,
    },
    {
      keywords: ['prediction'],
      setup: (c) => `Fund $${c.capital} and place one market position on ${c.name}.`,
      weekly: (c) => `Place one small market position a week on ${c.name}.`,
    },
  ];

  const DEFAULT_PLAYBOOK = {
    setup: (c) => `Deposit $${c.capital} of USDC into ${c.name} on ${c.chain} and keep the position open.`,
    weekly: () => 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
  };

  function pickPlaybook(category) {
    const normalized = (category || '').toLowerCase();
    for (const pb of CATEGORY_PLAYBOOKS) {
      if (pb.keywords.some((kw) => hasKeyword(normalized, kw))) return pb;
    }
    return DEFAULT_PLAYBOOK;
  }

  function gasCostUsd(chain) {
    if (chain === 'Ethereum') return 8;
    if (LOW_GAS_CHAINS.has(chain)) return 0.5;
    return 2;
  }

  function cheapestChain(chains) {
    if (!chains || chains.length === 0) return 'its main chain';
    let best = chains[0];
    let bestCost = gasCostUsd(best);
    for (const chain of chains) {
      const cost = gasCostUsd(chain);
      if (cost < bestCost) {
        best = chain;
        bestCost = cost;
      }
    }
    return best;
  }

  function capitalForTvl(tvlUsd) {
    if (tvlUsd >= 5e9) return 250;
    if (tvlUsd >= 1e9) return 150;
    if (tvlUsd >= 1e8) return 100;
    return 50;
  }

  function holdWindow(ageDays) {
    if (ageDays === null || ageDays === undefined) return 30;
    if (ageDays < 180) return 60;
    if (ageDays < 365) return 45;
    return 30;
  }

  function gasEstimate(chain) {
    const cost = gasCostUsd(chain);
    if (cost >= 8) return 'about $8 of gas';
    if (cost <= 0.5) return 'about $0.50 of gas';
    return 'about $2 of gas';
  }

  function firstTxCost(chain) {
    const cost = gasCostUsd(chain);
    if (cost >= 8) return 'about $8 of gas for the first transaction';
    if (cost <= 0.5) return 'under $1 of gas for the first transaction';
    return 'under $3 of gas for the first transaction';
  }

  function formatStep(step) {
    let text = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (text.length > 600) text = `${text.slice(0, 596)}...`;
    if (text.length < 20) text = `${text} Hold the position and check the protocol's own page.`;
    return text;
  }

  function buildFarmSteps(row) {
    const chain = cheapestChain(row.chains);
    const capital = capitalForTvl(row.tvl_usd);
    const hold = holdWindow(row.age_days);
    const gas = gasEstimate(chain);
    const pb = pickPlaybook(row.category);
    const ctx = { name: row.name, capital, chain };
    const monthly = gasCostUsd(chain) >= 8;
    const cadence = monthly ? 'month' : 'week';
    const weeklyText = pb.weekly(ctx);
    const recurringText = monthly
      ? weeklyText
          .replace(/once a week/g, 'once a month')
          .replace(/each week/g, 'each month')
          .replace(/a week/g, 'a month')
      : weeklyText;

    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: firstTxCost(chain),
        time: '5 minutes',
      },
      {
        text: pb.setup(ctx),
        cost: `$${capital} of capital and ${gas}`,
        time: '15 minutes to set up',
      },
      {
        text: recurringText,
        cost: `${gas} a ${cadence}`,
        time: `10 minutes a ${cadence}`,
      },
      {
        text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
        cost: `the $${capital} stays in the position`,
        time: `${hold} days`,
      },
      {
        text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
    ].map(formatStep);
  }

  // -------------------------------------------------------------------------
  // URL hash state synchronization
  // -------------------------------------------------------------------------

  function loadStateFromHash() {
    const raw = window.location.hash.replace(/^#/, '');
    if (!raw) return;
    const params = new URLSearchParams(raw);
    if (params.get('q')) state.q = params.get('q');
    if (params.get('category')) state.category = params.get('category');
    if (params.get('chain')) state.chain = params.get('chain');
    if (params.get('watch') === '1') state.watchlistOnly = true;
    const tab = params.get('tab');
    if (tab === 'pre-token' || tab === 'live') state.tab = tab;
    if (params.get('p')) state.selected = params.get('p');
  }

  function syncHashFromState() {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.category !== 'all') params.set('category', state.category);
    if (state.chain !== 'all') params.set('chain', state.chain);
    if (state.watchlistOnly) params.set('watch', '1');
    if (state.tab !== 'pre-token') params.set('tab', state.tab);
    if (state.selected) params.set('p', state.selected);

    const encoded = params.toString();
    const targetUrl = encoded
      ? `#${encoded}`
      : `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, '', targetUrl);
  }

  // -------------------------------------------------------------------------
  // Filtering & sorting
  // -------------------------------------------------------------------------

  function rowCategory(row) {
    return row.category || 'Other';
  }

  function matchesFilters(row, forLive) {
    if (!forLive && state.watchlistOnly && !WATCHLIST_SLUGS.has(row.slug)) return false;
    if (state.category !== 'all' && rowCategory(row) !== state.category) return false;
    if (state.chain !== 'all' && !(row.chains || []).includes(state.chain)) return false;
    const query = state.q.trim().toLowerCase();
    if (!query) return true;
    const searchable = [row.name, row.slug, row.category, (row.chains || []).join(' ')]
      .join(' ')
      .toLowerCase();
    return searchable.includes(query);
  }

  function getFilteredRows() {
    return DATA.rows.filter((row) => matchesFilters(row, false));
  }

  function getFilteredLive() {
    return DATA.live.filter((row) => matchesFilters(row, true));
  }

  function sortKeyFor(row, key) {
    switch (key) {
      case 'rank':
        return row.rank === undefined ? Infinity : row.rank;
      case 'name':
        return row.name.toLowerCase();
      case 'tvl':
        return row.tvl_usd;
      case 'growth':
        return row.change_7d === null ? -Infinity : row.change_7d;
      case 'age':
        return row.age_days === null ? Infinity : row.age_days;
      case 'signal':
        return row.signal_score === undefined ? -Infinity : row.signal_score;
      case 'mcap':
        return row.mcap_usd === null ? -Infinity : row.mcap_usd;
      default:
        return row.implied_value_usd;
    }
  }

  function sortList(list, key, dir) {
    return list.slice().sort((a, b) => {
      const av = sortKeyFor(a, key);
      const bv = sortKeyFor(b, key);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function sumImplied(list) {
    return list.reduce((acc, row) => acc + row.implied_value_usd, 0);
  }

  // Pre-compute static dropdown option lists and total implied value once.
  const ALL_CATEGORIES = Array.from(
    new Set([...DATA.rows, ...DATA.live].map((r) => rowCategory(r))),
  ).sort();

  const ALL_CHAINS = Array.from(
    new Set([...DATA.rows, ...DATA.live].flatMap((r) => r.chains || [])),
  ).sort();

  const TOTAL_IMPLIED_USD = sumImplied(DATA.rows);
  const ROWS_BY_SLUG = new Map(DATA.rows.map((r) => [r.slug, r]));

  // -------------------------------------------------------------------------
  // Charts (SVG, built as strings: compact and dependency-free)
  // -------------------------------------------------------------------------

  function categoryBreakdown() {
    const totals = new Map();
    for (const row of DATA.rows) {
      const cat = rowCategory(row);
      totals.set(cat, (totals.get(cat) ?? 0) + row.implied_value_usd);
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const other = [...totals.entries()]
      .slice(8)
      .reduce((acc, [, v]) => acc + v, 0);
    if (other > 0) top.push(['Other', other]);
    const max = Math.max(...top.map(([, v]) => v), 1);
    const rowH = 26;
    const height = top.length * rowH + 8;
    const bars = top
      .map(([cat, value], i) => {
        const y = 8 + i * rowH;
        const w = Math.max(4, Math.round((value / max) * 380));
        return `<text x="0" y="${y + 13}" fill="#8b98a9" font-size="12">${escapeHtml(cat)}</text>` +
          `<rect x="150" y="${y + 3}" width="${w}" height="14" rx="3" fill="#2dd4a8" opacity="${i < 3 ? '1' : '0.55'}"/>` +
          `<text x="${156 + w}" y="${y + 13}" fill="#e6edf3" font-size="12" font-family="ui-monospace,Menlo,Consolas,monospace">${escapeHtml(formatUsd(value))}</text>`;
      })
      .join('');
    return `<svg viewBox="0 0 600 ${height}" width="100%" role="img" aria-label="Implied value by category">${bars}</svg>`;
  }

  function tvlScatter() {
    const pts = DATA.rows.map((r) => ({ x: Math.log10(Math.max(1, r.tvl_usd)), y: Math.log10(Math.max(1, r.implied_value_usd)), w: WATCHLIST_SLUGS.has(r.slug) }));
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const x0 = Math.min(...xs) - 0.15;
    const x1 = Math.max(...xs) + 0.15;
    const y0 = Math.min(...ys) - 0.15;
    const y1 = Math.max(...ys) + 0.15;
    const W = 600;
    const H = 260;
    const padL = 44;
    const padB = 28;
    const padT = 10;
    const padR = 10;
    const px = (x) => padL + ((x - x0) / (x1 - x0)) * (W - padL - padR);
    const py = (y) => padT + (1 - (y - y0) / (y1 - y0)) * (H - padT - padB);
    const refY = (x) => x + Math.log10(Math.max(0.0001, DATA.global_ratio));
    const line = `<line x1="${px(x0).toFixed(1)}" y1="${py(refY(x0)).toFixed(1)}" x2="${px(x1).toFixed(1)}" y2="${py(refY(x1)).toFixed(1)}" stroke="#f5b544" stroke-width="1.5" stroke-dasharray="5 4"/>`;
    const dots = pts
      .map((p) => `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="${p.w ? 4 : 2.6}" fill="${p.w ? '#2dd4a8' : '#8b98a9'}" opacity="${p.w ? '0.95' : '0.6'}"/>`)
      .join('');
    const xTicks = [6, 7, 8, 9].filter((v) => v >= x0 && v <= x1);
    const yTicks = [6, 7, 8].filter((v) => v >= y0 && v <= y1);
    const axes =
      xTicks.map((v) => `<text x="${px(v).toFixed(1)}" y="${H - 8}" fill="#8b98a9" font-size="11" text-anchor="middle">$${'1e' + v}</text>`).join('') +
      yTicks.map((v) => `<text x="${padL - 6}" y="${(py(v) + 4).toFixed(1)}" fill="#8b98a9" font-size="11" text-anchor="end">$${'1e' + v}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="TVL against implied value, log scale">${line}${dots}${axes}</svg>`;
  }

  function renderCharts() {
    return h(
      'section',
      { class: 'panel charts' },
      h('h2', { text: 'Where the implied value sits' }),
      h(
        'div',
        { class: 'chart-grid' },
        h(
          'div',
          { class: 'chart' },
          h('h3', { text: 'Implied value by category' }),
          h('div', { html: categoryBreakdown() }),
        ),
        h(
          'div',
          { class: 'chart' },
          h('h3', { text: 'TVL against implied value' }),
          h('div', { html: tvlScatter() }),
          h('p', { class: 'sub', text: 'Log scale. Teal dots are watchlist protocols; the dashed line is the market-wide ratio.' }),
        ),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Page sections
  // -------------------------------------------------------------------------

  function renderHeader() {
    return h(
      'header',
      { class: 'top' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'mark' }),
        h('span', { class: 'brand-name', text: 'TOKEN RADAR' }),
      ),
      h(
        'div',
        { class: 'top-meta' },
        h('span', null, 'Snapshot ', h('b', { text: DATA.as_of })),
        h('span', null, 'Model ', h('b', { text: DATA.model_version })),
        h('span', null, 'Source ', h('b', { text: 'DefiLlama protocol index' })),
      ),
    );
  }

  function renderLede() {
    const floorMillions = Math.round(DATA.floor_usd / 1e6);
    return h(
      'section',
      { class: 'lede' },
      h(
        'div',
        null,
        h('h1', { text: 'Which pre-token protocol is worth farming next?' }),
        h(
          'p',
          null,
          'The watchlist is the floor: every protocol with at least ',
          h('b', { text: `$${floorMillions}M` }),
          ' of TVL and no token on record. The early radar adds ',
          h('b', { text: String(DATA.early_size) }),
          ' pre-token protocols below that floor. Implied value is a model, not a promise: what a token would be worth if the protocol launched one at the market rate its category already pays.',
        ),
      ),
      h(
        'div',
        { class: 'facts' },
        h(
          'div',
          { class: 'fact' },
          h('span', { text: 'Watchlist covered' }),
          h('b', { html: `${DATA.watchlist_size} <em>/ ${DATA.watchlist_size}</em>` }),
        ),
        h(
          'div',
          { class: 'fact' },
          h('span', { text: 'Pre-token rows scored' }),
          h('b', { text: String(DATA.board_size) }),
        ),
        h(
          'div',
          { class: 'fact' },
          h('span', { text: 'Total implied value' }),
          h('b', { text: formatUsd(TOTAL_IMPLIED_USD) }),
        ),
        h(
          'div',
          { class: 'fact' },
          h('span', { text: 'Live-token protocols set aside' }),
          h('b', { text: String(DATA.live_total) }),
        ),
      ),
    );
  }

  function renderControls(filteredCount) {
    const searchInput = h('input', {
      type: 'search',
      id: 'q',
      placeholder: 'Search name, category or chain',
      value: state.q,
      'aria-label': 'Search the board',
    });
    searchInput.addEventListener('input', () => {
      state.q = searchInput.value;
      syncHashFromState();
      render({ preserveSearchFocus: true });
    });

    const categorySelect = h(
      'select',
      { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      ALL_CATEGORIES.map((cat) =>
        h('option', {
          value: cat,
          text: cat,
          selected: cat === state.category ? 'selected' : null,
        }),
      ),
    );
    categorySelect.addEventListener('change', () => {
      state.category = categorySelect.value;
      syncHashFromState();
      render();
    });

    const chainSelect = h(
      'select',
      { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      ALL_CHAINS.map((ch) =>
        h('option', {
          value: ch,
          text: ch,
          selected: ch === state.chain ? 'selected' : null,
        }),
      ),
    );
    chainSelect.addEventListener('change', () => {
      state.chain = chainSelect.value;
      syncHashFromState();
      render();
    });

    const watchCheckbox = h('input', {
      type: 'checkbox',
      checked: state.watchlistOnly ? 'checked' : null,
      'aria-label': 'Watchlist only',
    });
    watchCheckbox.addEventListener('change', () => {
      state.watchlistOnly = watchCheckbox.checked;
      syncHashFromState();
      render();
    });
    const watchControl = h('label', { class: 'check' }, watchCheckbox, 'Watchlist only');

    const preTokenTab = h('button', {
      type: 'button',
      'aria-pressed': state.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token',
      onclick: () => {
        state.tab = 'pre-token';
        syncHashFromState();
        render();
      },
    });

    const liveTokenTab = h('button', {
      type: 'button',
      'aria-pressed': state.tab === 'live' ? 'true' : 'false',
      text: 'Live token',
      onclick: () => {
        state.tab = 'live';
        syncHashFromState();
        render();
      },
    });

    const countLabel =
      state.tab === 'pre-token'
        ? `${filteredCount} rows shown`
        : `${filteredCount} live-token protocols`;

    return h(
      'div',
      { class: 'controls' },
      h('div', { class: 'field' }, h('label', { for: 'q', text: 'Search' }), searchInput),
      h('div', { class: 'field' }, h('label', { for: 'category', text: 'Category' }), categorySelect),
      h('div', { class: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      watchControl,
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'sub', text: 'Token status' }),
        h('div', { class: 'tabs' }, preTokenTab, liveTokenTab),
      ),
      h('span', { class: 'count', text: countLabel }),
    );
  }

  function renderSortHeader(key, label, forLive) {
    const active = forLive ? state.liveSort === key : state.sort === key;
    const dir = forLive ? state.liveDir : state.dir;
    return h(
      'th',
      { scope: 'col' },
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            if (forLive) {
              if (state.liveSort === key) state.liveDir = -state.liveDir;
              else {
                state.liveSort = key;
                state.liveDir = -1;
              }
            } else if (state.sort === key) {
              state.dir = -state.dir;
            } else {
              state.sort = key;
              state.dir = key === 'rank' ? 1 : -1;
            }
            render();
          },
        },
        label,
        active ? h('span', { 'aria-hidden': 'true', text: dir < 0 ? ' v' : ' ^' }) : null,
      ),
    );
  }

  function renderBoardTable(filtered) {
    const list = sortList(filtered, state.sort, state.dir);
    if (list.length === 0) {
      return h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'No protocol matches that filter' }),
          h('p', { text: 'Clear the search or pick another category to see the board again.' }),
          h('button', {
            class: 'button primary',
            type: 'button',
            text: 'Clear filters',
            onclick: () => {
              state.q = '';
              state.category = 'all';
              state.chain = 'all';
              state.watchlistOnly = false;
              syncHashFromState();
              render();
            },
          }),
        ),
      );
    }

    const maxImplied = list.reduce((m, row) => Math.max(m, row.implied_value_usd), 1);
    const tbody = h('tbody');

    for (const row of list) {
      const growthText = row.change_7d === null ? 'n/a' : formatPercent(row.change_7d);
      const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
      const watchTag = WATCHLIST_SLUGS.has(row.slug) ? ' - watchlist' : '';
      const barPct = Math.max(3, Math.round((row.implied_value_usd / maxImplied) * 100));
      const badgeClass = row.rank <= 3 ? 'rank-badge top3' : 'rank-badge';

      const tr = h(
        'tr',
        {
          'data-slug': row.slug,
          'data-selected': state.selected === row.slug ? 'true' : 'false',
          tabindex: '0',
          onclick: () => openDetail(row.slug),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openDetail(row.slug);
            }
          },
        },
        h('td', null, h('span', { class: badgeClass, text: String(row.rank) })),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'name' },
            h('b', { text: row.name }),
            h('span', {
              class: 'sub',
              text: `${row.category || 'Other'} on ${summarizeChains(row.chains, 2)}${watchTag}`,
            }),
          ),
        ),
        h('td', { class: 'num', text: formatUsd(row.tvl_usd) }),
        h('td', { class: `num ${growthClass}`.trim(), text: growthText }),
        h('td', { class: 'num', text: formatAge(row.age_days) }),
        h('td', { class: 'num', text: String(row.signal_score) }),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'implied' },
            h('div', { class: 'bar', 'aria-hidden': 'true' }, h('i', { style: `width:${barPct}%` })),
            h('span', { class: 'num', text: formatUsd(row.implied_value_usd) }),
          ),
        ),
        h('td', null, h('span', { class: 'status', text: 'no token' })),
      );
      tbody.appendChild(tr);
    }

    return h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          null,
          h('caption', {
            class: 'sub',
            text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.',
          }),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              renderSortHeader('rank', 'Rank', false),
              renderSortHeader('name', 'Protocol', false),
              renderSortHeader('tvl', 'TVL', false),
              renderSortHeader('growth', '7d', false),
              renderSortHeader('age', 'Age', false),
              renderSortHeader('signal', 'Signal', false),
              renderSortHeader('implied', 'Implied value', false),
              h('th', { scope: 'col', text: 'Token' }),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  function renderLiveTable(filtered) {
    const list = sortList(filtered, state.liveSort, state.liveDir);
    if (list.length === 0) {
      return h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'empty' },
          h('h2', { text: 'No live-token protocol matches that filter' }),
          h('p', { text: 'Clear the search or pick another category to see them again.' }),
          h('button', {
            class: 'button primary',
            type: 'button',
            text: 'Clear filters',
            onclick: () => {
              state.q = '';
              state.category = 'all';
              state.chain = 'all';
              state.watchlistOnly = false;
              syncHashFromState();
              render();
            },
          }),
        ),
      );
    }

    const tbody = h('tbody');
    for (const row of list) {
      const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(
        h(
          'tr',
          { class: 'live-row' },
          h('td', null, h('span', { class: 'rank-badge', text: 'live' })),
          h(
            'td',
            null,
            h(
              'div',
              { class: 'name' },
              h('b', { text: row.name }),
              h('span', {
                class: 'sub',
                text: `${row.category || 'Other'} on ${summarizeChains(row.chains, 2)}`,
              }),
            ),
          ),
          h('td', { class: 'num', text: formatUsd(row.tvl_usd) }),
          h('td', { class: `num ${growthClass}`.trim(), text: formatPercent(row.change_7d) }),
          h('td', { class: 'num', text: formatUsd(row.mcap_usd) }),
          h('td', null, h('span', { class: 'status live', text: 'already trades' })),
        ),
      );
    }

    return h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'live-table' },
          h('caption', {
            class: 'sub',
            text: `Token live: these ${DATA.live_total} protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.`,
          }),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col', text: 'Status' }),
              renderSortHeader('name', 'Protocol', true),
              renderSortHeader('tvl', 'TVL', true),
              renderSortHeader('growth', '7d', true),
              renderSortHeader('mcap', 'Market cap', true),
              h('th', { scope: 'col', text: 'Token' }),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  function renderModelPanel() {
    const m = DATA.model;
    const topRatios = (DATA.ratios || []).slice(0, 8);
    const formulaText =
      `implied = round( tvl_usd x ratio x (1 + clamp(change_7d, ${m.growth_floor}, ${m.growth_cap}) / 100 x ${m.growth_weight}) ` +
      `x maturity(age) x (1 + ${m.chain_step} x min(chains - 1, ${m.chain_cap})) )`;

    return h(
      'section',
      { class: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', {
        class: 'sub',
        text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked.',
      }),
      h('div', { class: 'formula', text: formulaText }),
      h('p', {
        class: 'sub',
        text:
          `The ratio is the comparables argument: the median market-cap-to-TVL of the token-bearing protocols in the same category, computed from this snapshot, with each token's market cap divided by the combined TVL of every protocol carrying its symbol. ` +
          `A category with fewer than ${m.min_comparables} comparables takes the smaller of its own median and its family median (Vaults & Curators, Lending & CDP, RWA & Yield); a category with none takes the family median, or the market-wide median of ${formatFixed4(DATA.global_ratio)} when it has no family. ` +
          `Maturity peaks in the 6-18 month window (${m.maturity_sweet_start}-${m.maturity_sweet_end} days, ${m.maturity_peak}x) and falls to ${m.maturity_young_floor}x for very young protocols and ${m.maturity_old_floor}x for very old ones; an unknown age uses ${m.unknown_maturity}x. ` +
          `Age is the time since the protocol was first listed, the best record of how long it has run with no token.`,
      }),
      h(
        'div',
        { class: 'ratios' },
        topRatios.map((item) =>
          h(
            'div',
            { class: 'ratio' },
            h('span', { text: `${item.category} (${item.n} live)` }),
            h('b', { text: formatFixed4(item.ratio) }),
          ),
        ),
      ),
      h('p', {
        class: 'sub',
        text: 'The early radar is every pre-token protocol below the watchlist floor that the watchlist rule keeps, by TVL, topped up to 178 rows from the largest pre-token protocols above the floor. Six sub-protocols whose parent token already trades are removed. Centralised-exchange, bridge, liquid-staking and liquid-restaking protocols never enter the comparables pool, and the categories actually in use on this board include CDP, Yield Aggregator and Indexes. The live-token protocols are set aside with their market caps shown.',
      }),
    );
  }

  function renderFooter() {
    return h(
      'footer',
      { class: 'foot' },
      h(
        'p',
        null,
        h('b', { text: 'Read it as a record, not a promise. ' }),
        'A protocol on this board records no token in the snapshot; that is DefiLlama\u2019s record, not proof it has none. Implied value is this entry\u2019s own claim about what a launch would be worth if the protocol\u2019s record stayed as it is. It does not predict whether or when a token is issued.',
      ),
      h('p', {
        text: `Snapshot ${DATA.as_of} \u00b7 ${DATA.source} \u00b7 ${DATA.board_size} rows, ${DATA.watchlist_size} on the watchlist, ${DATA.early_size} early, ${DATA.live_total} live-token protocols set aside \u00b7 model ${DATA.model_version}`,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Detail drawer (<dialog id="detail">)
  // -------------------------------------------------------------------------

  const dialog = h('dialog', {
    class: 'detail',
    id: 'detail',
    'aria-labelledby': 'detail-title',
  });

  function updateRowSelectionHighlight() {
    const rows = root.querySelectorAll('tbody tr[data-slug]');
    for (const tr of rows) {
      tr.setAttribute('data-selected', tr.getAttribute('data-slug') === state.selected ? 'true' : 'false');
    }
  }

  dialog.addEventListener('close', () => {
    state.selected = null;
    syncHashFromState();
    updateRowSelectionHighlight();
  });

  function equationRow(label, value, isTotal) {
    return h(
      'div',
      isTotal ? { class: 'total' } : null,
      h('span', { text: label }),
      h('b', { class: 'num', text: value }),
    );
  }

  function waterfallSvg(row) {
    const steps = [
      { label: 'TVL', value: row.tvl_usd, mult: null },
      { label: `x ratio ${formatFixed4(row.ratio)}`, value: row.tvl_usd * row.ratio, mult: row.ratio },
      { label: `x growth ${formatFixed4(row.growth_multiplier)}`, value: row.tvl_usd * row.ratio * row.growth_multiplier, mult: row.growth_multiplier },
      { label: `x maturity ${formatFixed4(row.maturity_multiplier)}`, value: row.tvl_usd * row.ratio * row.growth_multiplier * row.maturity_multiplier, mult: row.maturity_multiplier },
      { label: `x chains ${formatFixed4(row.chain_multiplier)}`, value: row.implied_value_usd, mult: row.chain_multiplier },
    ];
    const logs = steps.map((s) => Math.log10(Math.max(1, s.value)));
    const lo = Math.min(...logs) - 0.2;
    const hi = Math.max(...logs) + 0.2;
    const W = 480;
    const rowH = 24;
    const height = steps.length * rowH + 6;
    const bars = steps
      .map((s, i) => {
        const y = 4 + i * rowH;
        const w = Math.max(6, Math.round(((logs[i] - lo) / (hi - lo)) * 260));
        const last = i === steps.length - 1;
        return `<text x="0" y="${y + 13}" fill="#8b98a9" font-size="11">${escapeHtml(s.label)}</text>` +
          `<rect x="150" y="${y + 3}" width="${w}" height="13" rx="3" fill="${last ? '#f5b544' : '#2dd4a8'}" opacity="${last ? '1' : '0.7'}"/>` +
          `<text x="${156 + w}" y="${y + 13}" fill="#e6edf3" font-size="11" font-family="ui-monospace,Menlo,Consolas,monospace">${escapeHtml(formatUsd(s.value))}</text>`;
      })
      .join('');
    return `<svg viewBox="0 0 ${W} ${height}" width="100%" role="img" aria-label="Implied value waterfall">${bars}</svg>`;
  }

  function openDetail(slug) {
    const row = ROWS_BY_SLUG.get(slug);
    if (!row) return;

    state.selected = slug;
    syncHashFromState();
    updateRowSelectionHighlight();

    const steps = buildFarmSteps(row);
    const recomputed = recomputeImplied(row, DATA.model);
    const matchNote =
      recomputed === row.implied_value_usd
        ? ', the same number board.json carries.'
        : ', which differs from the board: the data would be stale.';
    const ratioNote =
      row.ratio_n > 0
        ? `${row.ratio_source} across ${row.ratio_n} token-bearing protocols`
        : `${row.ratio_source} (no token-bearing protocol in ${row.category || 'this category'} yet)`;
    const tierBadge = WATCHLIST_SLUGS.has(row.slug) ? ' \u00b7 watchlist' : ' \u00b7 early';

    dialog.textContent = '';

    dialog.appendChild(
      h(
        'div',
        { class: 'detail-head' },
        h(
          'div',
          null,
          h('span', { class: 'brand-name', text: `Rank ${row.rank} of ${DATA.board_size}${tierBadge}` }),
          h('h2', { id: 'detail-title', text: row.name }),
          h('p', { class: 'sub', text: `${row.category || 'Other'} on ${summarizeChains(row.chains)}` }),
        ),
        h('button', {
          class: 'close',
          type: 'button',
          'aria-label': 'Close details',
          text: 'Close',
          onclick: () => dialog.close(),
        }),
      ),
    );

    dialog.appendChild(
      h(
        'section',
        { class: 'detail-section' },
        h('h3', { text: 'Implied value' }),
        h('div', { class: 'waterfall', html: waterfallSvg(row) }),
        h(
          'div',
          { class: 'equation' },
          equationRow('TVL', formatUsd(row.tvl_usd), false),
          equationRow('Category ratio', formatFixed4(row.ratio), false),
          equationRow('Seven-day growth', formatPercent(row.change_7d), false),
          equationRow('Age with no token', formatAge(row.age_days), false),
          equationRow('Growth multiplier', formatFixed4(row.growth_multiplier), false),
          equationRow('Maturity multiplier', formatFixed4(row.maturity_multiplier), false),
          equationRow('Chain multiplier', formatFixed4(row.chain_multiplier), false),
          equationRow('Launch signal', `${row.signal_score} / 100`, false),
          equationRow('Implied value', formatUsd(row.implied_value_usd), true),
        ),
        h('p', {
          class: 'sub',
          text: `Ratio: ${ratioNote}. Model ${DATA.model_version} recomputes this row as ${formatUsd(recomputed)}${matchNote} This is an estimate, not a price.`,
        }),
      ),
    );

    dialog.appendChild(
      h(
        'section',
        { class: 'detail-section' },
        h('h3', { text: 'Farm plan' }),
        h(
          'ol',
          { class: 'steps' },
          steps.map((stepStr) => {
            const splitAt = stepStr.indexOf(' Cost: ');
            const action = splitAt >= 0 ? stepStr.slice(0, splitAt) : stepStr;
            const meta = splitAt >= 0 ? stepStr.slice(splitAt + 1) : '';
            return h('li', null, h('b', { text: action }), h('span', { class: 'cost', text: meta }));
          }),
        ),
      ),
    );

    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  // -------------------------------------------------------------------------
  // Render lifecycle
  // -------------------------------------------------------------------------

  function render(options) {
    const preserveFocus = options && options.preserveSearchFocus;
    let caretStart = null;
    let caretEnd = null;
    if (preserveFocus) {
      const prevInput = document.getElementById('q');
      if (prevInput && document.activeElement === prevInput) {
        caretStart = prevInput.selectionStart;
        caretEnd = prevInput.selectionEnd;
      }
    }

    const isLive = state.tab === 'live';
    const filtered = isLive ? getFilteredLive() : getFilteredRows();
    const shell = h(
      'div',
      { class: 'shell' },
      renderHeader(),
      renderLede(),
      renderCharts(),
      renderControls(filtered.length),
      isLive ? renderLiveTable(filtered) : renderBoardTable(filtered),
      isLive ? null : renderModelPanel(),
      renderFooter(),
    );

    root.textContent = '';
    root.appendChild(shell);
    root.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) root.appendChild(dialog);

    if (preserveFocus && caretStart !== null) {
      const nextInput = document.getElementById('q');
      if (nextInput) {
        nextInput.focus();
        nextInput.setSelectionRange(caretStart, caretEnd);
      }
    }

    if (state.selected) {
      openDetail(state.selected);
    }
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  loadStateFromHash();
  render();

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) {
      dialog.close();
    }
  });
})();
