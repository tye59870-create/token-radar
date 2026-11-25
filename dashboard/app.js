// Token Radar dashboard client (radar-2).
// Renders the offline board, filters, sorting, methodology panel, and protocol detail drawer
// directly from window.RADAR (loaded via ../data.js).
(() => {
  'use strict';

  const DATA = window.RADAR;
  const root = document.getElementById('board');
  if (!DATA || !root) return;

  const WATCHLIST_SLUGS = new Set(DATA.watchlist || []);
  const LOW_GAS_CHAINS = new Set([
    'Base', 'Arbitrum', 'Optimism', 'Solana', 'Polygon', 'BSC', 'BNB Chain',
    'Avalanche', 'Blast', 'Linea', 'Scroll', 'zkSync Era', 'Mode', 'Sonic',
    'Plasma', 'Hyperliquid', 'Sui', 'Aptos',
  ]);

  const state = {
    q: '',
    category: 'all',
    chain: 'all',
    watchlistOnly: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
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

  function recomputeImplied(row, model) {
    const rawGrowth = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    const growth = clamp(rawGrowth, model.growth_floor, model.growth_cap);
    const growthMult = 1 + (growth / 100) * model.growth_weight;

    const rawAge = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturityMult =
      model.maturity_floor +
      (clamp(rawAge, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;

    const chainCount = Array.isArray(row.chains) ? row.chains.length : 0;
    const chainMult = 1 + model.chain_step * clamp(chainCount - 1, 0, model.chain_cap);

    return Math.max(1, Math.round(row.tvl_usd * row.ratio * growthMult * maturityMult * chainMult));
  }

  const CATEGORY_PLAYBOOKS = [
    {
      keywords: ['curator', 'allocator'],
      setup: (c) => `Deposit $${c.capital} into a ${c.name} vault on ${c.chain} and keep the vault shares in the same wallet.`,
      weekly: (c) => `Top up the vault or move between ${c.name} vaults once a week so the wallet shows fresh activity.`,
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
      if (pb.keywords.some((kw) => normalized.includes(kw))) return pb;
    }
    return DEFAULT_PLAYBOOK;
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
    if (chain === 'Ethereum') return 'about $8 of gas';
    if (LOW_GAS_CHAINS.has(chain)) return 'about $0.50 of gas';
    return 'about $2 of gas';
  }

  function formatStep(step) {
    let text = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
    if (text.length > 600) text = `${text.slice(0, 596)}...`;
    if (text.length < 20) text = `${text} Hold the position and check the protocol's own page.`;
    return text;
  }

  function buildFarmSteps(row) {
    const chain = row.chains && row.chains.length > 0 ? row.chains[0] : 'its main chain';
    const capital = capitalForTvl(row.tvl_usd);
    const hold = holdWindow(row.age_days);
    const gas = gasEstimate(chain);
    const pb = pickPlaybook(row.category);
    const ctx = { name: row.name, capital, chain };

    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: pb.setup(ctx),
        cost: `$${capital} of capital and ${gas}`,
        time: '15 minutes to set up',
      },
      {
        text: pb.weekly(ctx),
        cost: `${gas} a week`,
        time: '10 minutes a week',
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

  function getFilteredRows() {
    const query = state.q.trim().toLowerCase();
    return DATA.rows.filter((row) => {
      if (state.watchlistOnly && !WATCHLIST_SLUGS.has(row.slug)) return false;
      if (state.category !== 'all' && row.category !== state.category) return false;
      if (state.chain !== 'all' && !(row.chains || []).includes(state.chain)) return false;
      if (!query) return true;
      const searchable = [row.name, row.slug, row.category, (row.chains || []).join(' ')]
        .join(' ')
        .toLowerCase();
      return searchable.includes(query);
    });
  }

  function sortKeyFor(row, key) {
    switch (key) {
      case 'name':
        return row.name.toLowerCase();
      case 'tvl':
        return row.tvl_usd;
      case 'growth':
        return row.change_7d === null ? -Infinity : row.change_7d;
      case 'age':
        return row.age_days === null ? Infinity : row.age_days;
      default:
        return row.implied_value_usd;
    }
  }

  function getSortedRows(list) {
    const key = state.sort;
    const dir = state.dir;
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
    new Set(DATA.rows.map((r) => r.category || 'Other')),
  ).sort();

  const ALL_CHAINS = Array.from(
    new Set(DATA.rows.flatMap((r) => r.chains || [])),
  ).sort();

  const TOTAL_IMPLIED_USD = sumImplied(DATA.rows);
  const ROWS_BY_SLUG = new Map(DATA.rows.map((r) => [r.slug, r]));

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
          h('b', { text: String(DATA.live_size) }),
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
        : `${DATA.live.length} live-token protocols`;

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

  function renderSortHeader(key, label) {
    const active = state.sort === key;
    return h(
      'th',
      { scope: 'col' },
      h(
        'button',
        {
          type: 'button',
          onclick: () => {
            if (state.sort === key) state.dir = -state.dir;
            else {
              state.sort = key;
              state.dir = -1;
            }
            render();
          },
        },
        label,
        active ? h('span', { 'aria-hidden': 'true', text: state.dir < 0 ? ' v' : ' ^' }) : null,
      ),
    );
  }

  function renderBoardTable(filtered) {
    const list = getSortedRows(filtered);
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
        h('td', null, h('span', { class: 'rank-badge', text: String(row.rank) })),
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
              renderSortHeader('implied', 'Rank'),
              renderSortHeader('name', 'Protocol'),
              renderSortHeader('tvl', 'TVL'),
              renderSortHeader('growth', '7d'),
              renderSortHeader('age', 'Age'),
              renderSortHeader('implied', 'Implied value'),
              h('th', { scope: 'col', text: 'Token' }),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  function renderLiveTable() {
    const tbody = h('tbody');
    for (const row of DATA.live) {
      const growthClass = row.change_7d === null ? '' : row.change_7d >= 0 ? 'pos' : 'neg';
      tbody.appendChild(
        h(
          'tr',
          null,
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
          null,
          h('caption', {
            class: 'sub',
            text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.',
          }),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col', text: 'Status' }),
              h('th', { scope: 'col', text: 'Protocol' }),
              h('th', { scope: 'col', text: 'TVL' }),
              h('th', { scope: 'col', text: '7d' }),
              h('th', { scope: 'col', text: 'Market cap' }),
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
      `x (${m.maturity_floor} + min(age_days, ${m.maturity_days}) / ${m.maturity_days} x ${m.maturity_range}) ` +
      `x (1 + ${m.chain_step} x min(chains - 1, ${m.chain_cap})) )`;

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
          `The ratio is the comparables argument: the median market-cap-to-TVL of the token-bearing protocols in the same category, computed from this snapshot. ` +
          `A category whose token has never traded takes the market-wide median of ${formatFixed4(DATA.global_ratio)}. ` +
          `TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; ` +
          `an unlisted age uses ${m.unknown_age_days} days.`,
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
        text: 'The early radar is every pre-token protocol below the watchlist floor that the watchlist rule keeps, by TVL, and the live-token protocols are set aside with their market caps shown.',
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
        text: `Snapshot ${DATA.as_of} \u00b7 ${DATA.source} \u00b7 ${DATA.board_size} rows, ${DATA.watchlist_size} on the watchlist, ${DATA.early_size} early, ${DATA.live_size} live-token protocols set aside \u00b7 model ${DATA.model_version}`,
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

    const filtered = getFilteredRows();
    const shell = h(
      'div',
      { class: 'shell' },
      renderHeader(),
      renderLede(),
      renderControls(filtered.length),
      state.tab === 'pre-token' ? renderBoardTable(filtered) : renderLiveTable(),
      state.tab === 'pre-token' ? renderModelPanel() : null,
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
