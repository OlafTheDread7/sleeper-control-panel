/**
 * Menu.gs — entry points. Everything the user can run lives here.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Sleeper Panel')
    .addItem('Refresh everything', 'refreshAll')
    .addSeparator()
    .addItem('My lineup only', 'refreshLineupOnly')
    .addItem('Matchup only', 'refreshMatchupOnly')
    .addItem('Waiver targets only', 'refreshWaiversOnly')
    .addItem('Trade finder only', 'refreshTradesOnly')
    .addItem('League stats only', 'refreshStatsOnly')
    .addSeparator()
    .addItem('First-time setup', 'setupPanel')
    .addItem('Schedule weekly auto-refresh', 'installWeeklyTrigger')
    .addItem('Clear projection cache', 'clearProjectionCache')
    .addItem('Test scoring engine', 'verifyScoringEngine')
    .addItem('Check usage score against results', 'verifyUsageScore')
    .addToUi();
}

/**
 * Every refresh starts here: bring the Settings sheet up to date with the
 * code, drop the cached copy of it, and take a fresh snapshot of the league.
 */
function freshModel_() {
  ensureSettingsSheet();
  clearSettingsCache_();
  return buildModel(true);
}

function setupPanel() {
  const m = freshModel_();

  let msg = 'League: ' + m.leagueName + '\n' +
    'Season ' + m.season + ', week ' + m.week + '\n' +
    'Teams: ' + m.teams.length + '\n' +
    'Starting slots: ' + m.slots.join(', ') + '\n' +
    'Scoring rules loaded: ' + Object.keys(m.scoring).filter(k => m.scoring[k]).length + '\n\n';

  if (m.me) {
    msg += 'Your team: ' + m.me.name + ' (roster ' + m.me.rosterId + ')';
  } else {
    msg += 'Could not tell which team is yours.\n\nOpen the Settings sheet and ' +
      'set MY_USERNAME to your Sleeper username, or MY_ROSTER_ID to one of:\n' +
      m.teams.map(t => '  ' + t.rosterId + ' = ' + t.name).join('\n');
  }

  SpreadsheetApp.getUi().alert('Sleeper Panel setup', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Builds the lineup view: optimal vs what is currently set.
 *
 * Players are ranked by the usage score (Usage.gs), not by Sleeper's
 * projections. A game that has already been played is settled: a starter who
 * has played stays where he is, and a bench player who has played cannot be
 * moved in, so the sheet only ever suggests swaps you can still make.
 */
function computeLineupView(m) {
  loadWeeks(m, [m.week]);
  const me = m.me;
  if (!me) throw new Error('Could not identify your roster. Run First-time setup.');

  const usage = loadUsage(m);
  const tbl = usage.score;
  const week = m.week;
  const today = todayEastern_();
  const done = id => gameIsFinal_(m, id, week, today);

  // Starters whose games are over keep their slots.
  const starters = me.starters || [];
  const locked = [];
  const openSlots = [], openIndex = [];
  m.slots.forEach((slot, i) => {
    const id = starters[i];
    if (id && id !== '0' && done(id)) {
      locked.push({ order: i, slot: slot, id: id, pts: tbl[id] || 0, final: true });
    } else {
      openSlots.push(slot);
      openIndex.push(i);
    }
  });
  const lockedIds = locked.map(p => p.id);
  const movable = me.players.filter(id => lockedIds.indexOf(id) === -1 && !done(id));
  const spent = me.players.filter(id => lockedIds.indexOf(id) === -1 && done(id));

  const detail = optimalWeekDetail(m, movable, week, tbl, openSlots);
  detail.rows.forEach(p => { p.order = openIndex[p.order]; p.final = false; });
  const rows = detail.rows.concat(locked).sort((a, b) => a.order - b.order);
  const optimal = rows.reduce((s, p) => s + p.pts, 0);
  const current = currentLineupScore(m, me, week, tbl);

  const bench = detail.bench.map(b => { b.final = false; return b; })
    .concat(spent.map(id => ({ id: id, pts: tbl[id] || 0, final: true })));

  const currentStarters = starters.filter(id => id && id !== '0');
  const optimalStarters = rows.filter(p => p.id).map(p => p.id);

  const ins = optimalStarters.filter(id => currentStarters.indexOf(id) === -1);
  const outs = currentStarters.filter(id => optimalStarters.indexOf(id) === -1);

  ins.sort((a, b) => (tbl[b] || 0) - (tbl[a] || 0));
  outs.sort((a, b) => (tbl[b] || 0) - (tbl[a] || 0));

  const changes = [];
  for (let i = 0; i < Math.min(ins.length, outs.length); i++) {
    changes.push({
      in: ins[i], out: outs[i],
      inLabel: pLabel(m, ins[i]), outLabel: pLabel(m, outs[i]),
      delta: (tbl[ins[i]] || 0) - (tbl[outs[i]] || 0)
    });
  }

  rows.forEach(p => { p.isChange = p.id && ins.indexOf(p.id) >= 0; });
  bench.forEach(b => { b.isChange = outs.indexOf(b.id) >= 0; });

  return {
    current: current,
    optimal: optimal,
    rows: rows,
    bench: bench,
    changes: changes,
    usage: usage
  };
}

function withProgress_(label, fn) {
  const ss = SpreadsheetApp.getActive();
  ss.toast(label + '…', 'Sleeper Panel', -1);
  try {
    const out = fn();
    ss.toast(label + ' done.', 'Sleeper Panel', 4);
    return out;
  } catch (e) {
    ss.toast('Failed: ' + e.message, 'Sleeper Panel', 10);
    throw e;
  }
}

function refreshAll() {
  const m = freshModel_();

  const lineup = withProgress_('Lineup', () => computeLineupView(m));
  const matchup = withProgress_('Matchup', () => computeMatchup(m));
  const stats = withProgress_('League stats', () => computeSeasonStats(m));
  const matrix = withProgress_('Positional matrix', () => computePositionalMatrix(m));
  const needs = withProgress_('Roster shape', () => computeNeeds(m, matrix));
  const waivers = withProgress_('Waiver targets', () => findWaiverTargets(m));
  const trades = withProgress_('Trade finder', () => findTrades(m));

  renderLineup(m, lineup);
  renderMatchup(m, matchup);
  renderPower(m, stats);
  renderMatrix(m, matrix);
  renderWaivers(m, waivers);
  renderTrades(m, trades);
  renderRosters(m);
  renderDashboard(m, stats, lineup, waivers, trades, needs, matchup);

  SpreadsheetApp.getActive().setActiveSheet(
    SpreadsheetApp.getActive().getSheetByName(SHEETS.DASH));
  SpreadsheetApp.getActive().toast('All sheets refreshed.', 'Sleeper Panel', 5);
}

function refreshLineupOnly() {
  const m = freshModel_();
  renderLineup(m, withProgress_('Lineup', () => computeLineupView(m)));
}

function refreshMatchupOnly() {
  const m = freshModel_();
  renderMatchup(m, withProgress_('Matchup', () => computeMatchup(m)));
}

function refreshWaiversOnly() {
  const m = freshModel_();
  renderWaivers(m, withProgress_('Waiver targets', () => findWaiverTargets(m)));
}

function refreshTradesOnly() {
  const m = freshModel_();
  renderTrades(m, withProgress_('Trade finder', () => findTrades(m)));
}

function refreshStatsOnly() {
  const m = freshModel_();
  const stats = withProgress_('League stats', () => computeSeasonStats(m));
  renderPower(m, stats);
  renderMatrix(m, withProgress_('Positional matrix', () => computePositionalMatrix(m)));
  renderRosters(m);
}

/**
 * Optional: install a weekly trigger so the panel refreshes itself.
 * Tuesday morning catches the waiver wire after Monday night.
 */
function installWeeklyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshAll')
    .timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(7).create();
  SpreadsheetApp.getActive().toast('Weekly refresh scheduled for Tuesday 7am.',
    'Sleeper Panel', 5);
}
