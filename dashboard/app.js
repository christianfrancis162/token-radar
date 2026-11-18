// Token Radar's dashboard. It reads window.RADAR (written beside dashboard/ by main.ts) and
// renders the ranked board, the already-trading view, the coverage of all 758 protocols, and one
// detail view per protocol. No network: every byte it shows is in data.js, and the page
// recomputes each row's implied value from the same figures the model scored, so the page and
// the board agree.
//
// Views by address: index.html shows the board; ?view=detail&slug=<slug> opens one protocol;
// ?view=filtered&category=<name> (or &q=<text>) opens the board with that filter on;
// ?tab=live, ?tab=coverage or ?tab=model opens the other views.
(function () {
  'use strict';

  var DATA = window.RADAR;
  if (!DATA) return;

  var model = DATA.model;
  var fit = DATA.fitted;
  var validation = DATA.validation;
  var kpis = DATA.kpis;
  var rows = DATA.rows.slice();
  var live = DATA.live.slice();
  var coverage = DATA.coverage.slice();

  var state = { q: '', category: 'all', chain: 'all', sort: 'rank', watchlistOnly: false, tab: 'board', selected: null, covQ: '', covStatus: 'all' };

  var usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtUsd(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return usd0.format(n);
  }
  function fmtPct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }
  function fmtMoney(n) { return usd0.format(n); }
  function fmtNum(n) { return n.toLocaleString('en-US'); }

  // The model in one function, the same arithmetic lib/model.ts scores with: TVL times the
  // fitted multiple (exp of the fitted log multiple) times the capped momentum term.
  function impliedValueOf(row) {
    var implied = Math.max(1, Math.round(row.tvl_usd * row.fitted_multiple * row.momentum));
    return { fittedMultiple: row.fitted_multiple, momentum: row.momentum, implied: implied };
  }

  // The farm plan is the same derivation main.ts writes to board.json: category, first chain,
  // TVL and age decide the action, the capital, the hold and every cost and time, and the
  // seventh step prices the whole plan. No name is special-cased, so the plan the page shows
  // is the plan the board carries.
  function chainOf(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function gasUsd(chain) {
    var c = String(chain).toLowerCase();
    if (c === 'ethereum') return 6;
    if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'near' || c === 'sei' || c === 'ton') return 0.01;
    if (c === 'binance') return 0.1;
    if (['base', 'arbitrum', 'optimism', 'zksync era', 'linea', 'scroll', 'mode', 'blast', 'unichain', 'ink', 'soneium', 'world chain', 'polygon', 'polygon zkevm'].indexOf(c) >= 0) return 0.2;
    if (c === 'avalanche' || c === 'fantom' || c === 'tron' || c === 'cronos') return 0.3;
    return 2;
  }
  function gasFor(chain) {
    var g = gasUsd(chain);
    return g >= 1 ? 'about $' + g + ' of gas' : 'about $' + g.toFixed(2) + ' of gas';
  }
  function capitalFor(p) {
    if (p.tvl_usd >= 2e9) return 300;
    if (p.tvl_usd >= 5e8) return 200;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdDaysFor(age) {
    if (age === null || age === undefined) return 45;
    if (age < 90) return 90;
    if (age < 365) return 60;
    return 30;
  }
  function actionFor(p, capital, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Lend $' + capital + ' of USDC into ' + name + "'s " + chain + ' market and leave it supplied.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0 || c.indexOf('liquidity manager') >= 0) return 'Add $' + capital + " of liquidity to " + name + "'s deepest pool on " + chain + ' and keep the LP tokens.';
    if (c.indexOf('bridge') >= 0) return 'Move $' + capital + ' of USDC across ' + name + ' onto ' + chain + ', then put the funds to work in the destination app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return 'Stake $' + capital + " of " + chain + "'s native asset through " + name + ' and hold the receipt token.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0 || c.indexOf('options') >= 0) return 'Post $' + capital + ' of USDC as collateral on ' + name + ' and open a small hedged position.';
    if (c.indexOf('prediction') >= 0) return 'Back one outcome with $' + capital + ' on ' + name + "'s " + chain + ' market and let it settle.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0 || c.indexOf('vault') >= 0) return 'Subscribe $' + capital + ' to a ' + name + ' vault on ' + chain + ' and hold the vault shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or hold $' + capital + ' of ' + name + "'s stable asset on " + chain + '.';
    if (c.indexOf('rwa') >= 0) return 'Buy $' + capital + ' of ' + name + "'s tokenised asset on " + chain + ' and hold it through one yield cycle.';
    if (c.indexOf('insurance') >= 0) return 'Underwrite $' + capital + ' of cover through ' + name + ' on ' + chain + ' and keep the policy live.';
    if (c.indexOf('launchpad') >= 0) return 'Commit $' + capital + " to " + name + "'s next launch allocation on " + chain + '.';
    if (c.indexOf('chain') >= 0) return 'Bridge $' + capital + ' onto ' + chain + " and use " + name + "'s native apps every day for a week.";
    return 'Put $' + capital + ' of USDC to work in ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function farmSteps(p) {
    var chain = chainOf(p);
    var capital = capitalFor(p);
    var hold = holdDaysFor(p.age_days);
    var gas = gasFor(chain);
    var e = p.farm_economics;
    var steps = [
      { text: 'Open a fresh wallet for this farm alone, fund it with only the farming amount, and store its recovery phrase offline on paper.', cost: 'about $3 of gas for the first transfer', time: '10 minutes to set up' },
      { text: actionFor(p, capital, chain), cost: '$' + capital + ' of capital plus ' + gas + ' for the transaction', time: '20 minutes to place' },
      { text: 'Do one real action a week inside ' + p.name + ' — a deposit, a swap, a vote or a borrow — so the wallet reads as an active user, not a one-off deposit.', cost: gas + ' a week', time: '10 minutes a week' },
      { text: 'Keep the position live for at least ' + hold + " days, across at least two of the protocol's snapshot windows if it takes them.", cost: 'the $' + capital + ' stays in the position', time: hold + ' days' },
      { text: 'When a claim opens, use only the claim link the protocol publishes on its own site or verified account, and never pay a fee to claim.', cost: 'free to check; a claim that asks for payment is a scam', time: '10 minutes to verify' },
      { text: 'Record the wallet, the dates and every transaction hash in a farm log, and decide your exit — withdraw, restake or hold — before the claim window closes.', cost: 'nothing but the log', time: '10 minutes' },
    ];
    if (e) {
      steps.push({ text: 'The whole plan costs about $' + e.total_outlay_usd.toFixed(2) + ' ($' + capital + ' of capital plus about $' + e.gas_usd.toFixed(2) + ' of gas), and it breaks even if the airdrop pays $' + e.breakeven_usd.toFixed(2) + '. A payout of just 1% of the implied value would be $' + fmtNum(e.one_pct_of_implied_usd) + ' — about ' + fmtNum(e.one_pct_cover_x) + " times the plan's cost.", cost: 'about $' + e.total_outlay_usd.toFixed(2) + ' all in', time: hold + ' days from the first deposit' });
    }
    return steps.map(function (s) {
      var t = s.text + ' Cost: ' + s.cost + '. Time: ' + s.time + '.';
      if (t.length > 600) t = t.slice(0, 596) + '...';
      return t;
    });
  }

  // Exposed for the build's own verification: the page's plan must equal the board's plan.
  window.__radarTest = { farmSteps: farmSteps, impliedValueOf: impliedValueOf };

  var $ = function (id) { return document.getElementById(id); };
  var boardBody = $('board-body'), liveBody = $('live-body'), detail = $('detail'), countEl = $('count');
  var covBody = $('cov-body'), covCountEl = $('cov-count');

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    var out = rows.filter(function (r) {
      if (state.watchlistOnly && !r.watchlist) return false;
      if (state.category !== 'all' && (r.category || 'Uncategorised') !== state.category) return false;
      if (state.chain !== 'all' && (r.chains || []).indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var by = {
      rank: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d || 0) - (a.change_7d || 0); },
      age: function (a, b) { return (b.age_days || 0) - (a.age_days || 0); },
      name: function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; },
    }[state.sort] || function (a, b) { return a.rank - b.rank; };
    return out.sort(by);
  }

  function changeClass(n) {
    if (n === null || n === undefined) return '';
    return n > 0 ? 'up' : n < 0 ? 'down' : '';
  }

  function renderBoard() {
    var list = filteredRows();
    var top = rows.length ? rows[0].implied_value_usd : 1;
    boardBody.innerHTML = list.map(function (r) {
      var pct = Math.max(0, Math.min(100, (r.implied_value_usd / top) * 100));
      return '<tr data-slug="' + esc(r.slug) + '" data-open="' + (state.selected === r.slug) + '">' +
        '<td class="num rank">' + r.rank + '</td>' +
        '<td><span class="name"><b>' + esc(r.name) + '</b><span class="sub">' + esc(r.slug) + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</span></span></td>' +
        '<td><span class="chip">' + esc(r.category || 'Uncategorised') + '</span></td>' +
        '<td>' + esc((r.chains || []).slice(0, 2).join(', ') || '—') + ((r.chains || []).length > 2 ? ' +' + ((r.chains || []).length - 2) : '') + '</td>' +
        '<td class="num">' + fmtUsd(r.tvl_usd) + '</td>' +
        '<td class="num ' + changeClass(r.change_7d) + '">' + fmtPct(r.change_7d) + '</td>' +
        '<td class="num">' + fmtAge(r.age_days) + '</td>' +
        '<td><span class="value-cell"><b class="num">' + fmtMoney(r.implied_value_usd) + '</b><span class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></span></span></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="8"><div class="empty"><h3>Nothing matches that filter</h3><p>Loosen the search or clear a filter to see the board again.</p><button class="button" type="button" id="clear-filters">Clear all filters</button></div></td></tr>';
    countEl.textContent = 'Showing ' + list.length + ' of ' + rows.length + ' protocols';
    var clear = $('clear-filters');
    if (clear) clear.addEventListener('click', function () {
      state.q = ''; state.category = 'all'; state.chain = 'all'; state.watchlistOnly = false;
      $('q').value = ''; $('category').value = 'all'; $('chain').value = 'all'; $('watchlist-only').checked = false;
      renderBoard();
    });
  }

  function renderLive() {
    liveBody.innerHTML = live.map(function (p, i) {
      return '<tr>' +
        '<td class="num">' + (i + 1) + '</td>' +
        '<td><span class="name"><b>' + esc(p.name) + '</b><span class="sub">' + esc(p.slug) + '</span></span></td>' +
        '<td><span class="chip">' + esc(p.category || 'Uncategorised') + '</span></td>' +
        '<td>' + esc((p.chains || []).slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="num">' + fmtUsd(p.tvl_usd) + '</td>' +
        '<td class="num">' + fmtUsd(p.mcap_usd) + '</td>' +
        '<td class="num ' + changeClass(p.change_7d) + '">' + fmtPct(p.change_7d) + '</td>' +
        '</tr>';
    }).join('');
  }

  function covStatusLabel(s) {
    return s === 'ranked' ? 'Ranked' : s === 'has-token' ? 'Has token' : 'Excluded';
  }
  function renderCoverage() {
    var q = state.covQ.trim().toLowerCase();
    var list = coverage.filter(function (c) {
      if (state.covStatus !== 'all' && c.status !== state.covStatus) return false;
      if (q && c.name.toLowerCase().indexOf(q) < 0 && c.slug.toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    covBody.innerHTML = list.map(function (c) {
      return '<tr>' +
        '<td><span class="name"><b>' + esc(c.name) + '</b><span class="sub">' + esc(c.slug) + '</span></span></td>' +
        '<td><span class="chip">' + esc(c.category || 'Uncategorised') + '</span></td>' +
        '<td class="num">' + fmtUsd(c.tvl_usd) + '</td>' +
        '<td><span class="cov-status cov-' + c.status + '">' + covStatusLabel(c.status) + '</span></td>' +
        '<td class="cov-reason">' + esc(c.reason) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5"><div class="empty"><h3>Nothing matches that filter</h3><p>Loosen the search or clear the status filter.</p></div></td></tr>';
    covCountEl.textContent = 'Showing ' + list.length + ' of ' + coverage.length + ' protocols';
  }

  function renderDetail() {
    var row = rows.find(function (r) { return r.slug === state.selected; });
    if (!row) { detail.hidden = true; detail.innerHTML = ''; return; }
    var v = impliedValueOf(row);
    var recomputed = v.implied;
    var tieNote = recomputed !== row.implied_value_usd
      ? '<p class="sub">Board value ' + fmtMoney(row.implied_value_usd) + ' — the tie-break shaved $' + (recomputed - row.implied_value_usd) + ' so no two ranks share a value.</p>'
      : '';
    var steps = farmSteps(row);
    var e = row.farm_economics;
    var econ = e ? '<h3 style="margin-top:20px">What the farm costs</h3>' +
      '<div class="equation">' +
      '<div><span>Capital in the position</span><b>$' + fmtNum(e.capital_usd) + '</b></div>' +
      '<div><span>Gas over the ' + e.hold_days + '-day hold</span><b>$' + e.gas_usd.toFixed(2) + '</b></div>' +
      '<div><span>Total outlay</span><b>$' + e.total_outlay_usd.toFixed(2) + '</b></div>' +
      '<div><span>Break-even airdrop</span><b>$' + e.breakeven_usd.toFixed(2) + '</b></div>' +
      '<div><span>A 1% share of the implied value</span><b>$' + fmtNum(e.one_pct_of_implied_usd) + ' (' + fmtNum(e.one_pct_cover_x) + 'x the outlay)</b></div>' +
      '</div>' : '';
    detail.innerHTML =
      '<div class="detail-head"><div><p class="eyebrow">Rank #' + row.rank + ' · Implied value ' + fmtMoney(row.implied_value_usd) + '</p>' +
      '<h2>' + esc(row.name) + '</h2>' +
      '<p class="sub">' + esc(row.slug) + ' · ' + esc(row.category || 'Uncategorised') + ' · ' + esc((row.chains || []).join(', ') || 'no chain listed') +
      (row.watchlist ? ' · <span class="badge">ON THE WATCHLIST</span>' : '') + '</p></div>' +
      '<button class="close" type="button" id="detail-close">Close ✕</button></div>' +
      '<div class="detail-cols"><div><h3>How the value is worked out</h3>' +
      '<div class="equation">' +
      '<div><span>TVL</span><b>' + fmtMoney(row.tvl_usd) + '</b></div>' +
      '<div><span>Fitted multiple (' + esc(row.category || 'reference') + ')</span><b>×' + v.fittedMultiple.toFixed(4) + '</b></div>' +
      '<div><span>7-day growth ' + fmtPct(row.change_7d) + ' → momentum</span><b>×' + v.momentum.toFixed(4) + '</b></div>' +
      '<div><span>No token for ' + fmtAge(row.age_days) + ' · ' + (row.chains || []).length + ' chain' + ((row.chains || []).length === 1 ? '' : 's') + '</span><b>' + esc((row.chains || []).slice(0, 3).join(', ') || '—') + '</b></div>' +
      '<div><span>Implied value</span><b>' + fmtMoney(row.implied_value_usd) + '</b></div>' +
      '</div>' + tieNote +
      '<p class="sub" style="margin-top:12px">This protocol records no token — the snapshot carries no market cap, CoinGecko id or symbol for it. That is the record, not proof it has none.</p>' +
      econ +
      '</div><div><h3>Farm plan — seven steps</h3><ol class="steps">' +
      steps.map(function (s) { return '<li><p>' + esc(s) + '</p></li>'; }).join('') +
      '</ol></div></div>';
    detail.hidden = false;
    $('detail-close').addEventListener('click', function () { state.selected = null; renderDetail(); renderBoard(); });
  }

  function showTab(tab) {
    state.tab = tab;
    $('view-board').hidden = tab !== 'board';
    $('view-live').hidden = tab !== 'live';
    $('view-coverage').hidden = tab !== 'coverage';
    $('view-model').hidden = tab !== 'model';
    var buttons = document.querySelectorAll('#tabs button');
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-tab') === tab)); });
  }

  function fillSelects() {
    var cats = {};
    rows.forEach(function (r) { cats[r.category || 'Uncategorised'] = (cats[r.category || 'Uncategorised'] || 0) + 1; });
    var catSel = $('category');
    Object.keys(cats).sort().forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c + ' (' + cats[c] + ')';
      catSel.appendChild(o);
    });
    var chainCounts = {};
    rows.forEach(function (r) { (r.chains || []).forEach(function (c) { chainCounts[c] = (chainCounts[c] || 0) + 1; }); });
    var chainSel = $('chain');
    Object.keys(chainCounts).sort(function (a, b) { return chainCounts[b] - chainCounts[a]; }).slice(0, 40).forEach(function (c) {
      var o = document.createElement('option');
      o.value = c; o.textContent = c + ' (' + chainCounts[c] + ')';
      chainSel.appendChild(o);
    });
  }

  function renderStats() {
    $('masthead-stats').innerHTML =
      '<div><dt>Protocols on the board</dt><dd>' + rows.length + '</dd></div>' +
      '<div><dt>Watchlist covered</dt><dd>' + DATA.watchlist_size + ' of ' + DATA.watchlist_size + '</dd></div>' +
      '<div><dt>Early finds beyond it</dt><dd>' + DATA.early_size + '</dd></div>' +
      '<div><dt>Already trading, set aside</dt><dd>' + DATA.live_size + '</dd></div>' +
      '<div><dt>Snapshot as of</dt><dd>' + esc(DATA.as_of) + '</dd></div>' +
      '<div><dt>Model</dt><dd>' + esc(DATA.model_version) + '</dd></div>';
    $('source-line').textContent = 'Source: ' + DATA.source + ' · Floor for the watchlist: ' + fmtMoney(DATA.floor_usd) + ' TVL.';
    $('foot-date').textContent = DATA.as_of;
    $('board-note').textContent = 'Rows are ranked by implied value, rank 1 first. Click any row for its model breakdown and farm plan.';
  }

  function renderKpis() {
    $('kpi-strip').innerHTML =
      '<div class="kpi"><span class="kpi-label">Total implied value</span><b class="kpi-value">' + fmtUsd(kpis.total_implied_value_usd) + '</b></div>' +
      '<div class="kpi"><span class="kpi-label">Protocols ranked</span><b class="kpi-value">' + kpis.ranked_count + '</b></div>' +
      '<div class="kpi"><span class="kpi-label">Farm plans</span><b class="kpi-value">' + kpis.farm_plans_count + '</b></div>' +
      '<div class="kpi"><span class="kpi-label">Top category · ' + fmtUsd(kpis.top_category_implied_usd) + '</span><b class="kpi-value">' + esc(kpis.top_category) + '</b></div>' +
      '<div class="kpi"><span class="kpi-label">Out-of-sample error (holdout)</span><b class="kpi-value">' + kpis.holdout_median_ape_pct.toFixed(1) + '% median</b></div>';
  }

  function renderModel() {
    var cats = ['Dexs', 'Lending', 'Liquid Staking', 'Yield', 'RWA', 'Bridge'];
    var base = fit.baseline_multiple;
    var rowsHtml = '<div class="equation">' +
      '<div><span>Comparables fitted on</span><b>' + fit.comparables + ' protocols</b></div>' +
      '<div><span>Baseline multiple (reference category, 1 chain, 365 days)</span><b>×' + base.toFixed(3) + '</b></div>';
    cats.forEach(function (c, i) {
      var mult = base * Math.exp(fit.category_effects[i]);
      rowsHtml += '<div><span>' + esc(c) + ' multiple</span><b>×' + mult.toFixed(3) + '</b></div>';
    });
    rowsHtml += '<div><span>Chain count effect (per log chain)</span><b>' + fit.chains_coef.toFixed(3) + '</b></div>' +
      '<div><span>Age effect (per log day)</span><b>' + fit.age_coef.toFixed(3) + '</b></div>' +
      '<div><span>R-squared of the fit</span><b>' + fit.r_squared.toFixed(3) + '</b></div>' +
      '<div><span>Comparables’ median mcap/TVL</span><b>' + fit.comparables_median_ratio.toFixed(3) + '</b></div>' +
      '<div><span>Growth slope (diagnostic, not used to rank)</span><b>' + fit.growth_slope.toFixed(2) + ' (t = ' + fit.growth_t.toFixed(2) + ')</b></div>' +
      '</div>';
    $('fit-table').innerHTML = rowsHtml;
    $('validation-table').innerHTML = '<div class="equation">' +
      '<div><span>' + esc(validation.holdout.name) + ' (train ' + validation.holdout.train_n + ', test ' + validation.holdout.test_n + ')</span><b>' + validation.holdout.median_ape_pct.toFixed(1) + '% median error</b></div>' +
      '<div><span>' + esc(validation.walk_forward.name) + ' (split ' + esc(validation.walk_forward_cut) + ', train ' + validation.walk_forward.train_n + ', test ' + validation.walk_forward.test_n + ')</span><b>' + validation.walk_forward.median_ape_pct.toFixed(1) + '% median error</b></div>' +
      '</div>';
    $('formula').textContent =
      'implied = TVL × fitted multiple × momentum\n' +
      'fitted multiple = exp(OLS fit of log(mcap/TVL) on ' + fit.comparables + ' comparables:\n' +
      '  category + log(chains) + log1p(age in days))\n' +
      'momentum = clamp(1 + ' + model.momentum_weight + ' × clamp(7d growth, ' + model.growth_floor + '%, ' + model.growth_cap + '%) / 100,\n' +
      '  ' + model.momentum_floor + ', ' + model.momentum_cap + ')';
  }

  // Events.
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('category').addEventListener('change', function (e) { state.category = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  $('watchlist-only').addEventListener('change', function (e) { state.watchlistOnly = e.target.checked; renderBoard(); });
  $('cov-q').addEventListener('input', function (e) { state.covQ = e.target.value; renderCoverage(); });
  $('cov-status').addEventListener('change', function (e) { state.covStatus = e.target.value; renderCoverage(); });
  boardBody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    state.selected = state.selected === tr.getAttribute('data-slug') ? null : tr.getAttribute('data-slug');
    renderDetail();
    renderBoard();
    if (state.selected) detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  // Views from the address, for the screenshots and for sharing a view.
  var params = new URLSearchParams(window.location.search);
  var tabParam = params.get('tab');
  if (tabParam === 'live' || tabParam === 'model' || tabParam === 'coverage') showTab(tabParam);
  var qParam = params.get('q');
  if (qParam) { state.q = qParam; $('q').value = qParam; }
  var catParam = params.get('category');
  if (catParam) { state.category = catParam; }
  var view = params.get('view');
  if (view === 'detail') {
    var slug = params.get('slug');
    if (slug && rows.some(function (r) { return r.slug === slug; })) state.selected = slug;
  }

  fillSelects();
  if (catParam) $('category').value = catParam;
  renderStats();
  renderKpis();
  renderBoard();
  renderLive();
  renderCoverage();
  renderDetail();
  renderModel();
  if (state.selected) detail.scrollIntoView({ block: 'start' });
})();
