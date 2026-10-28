/**
 * Sheets.gs — rendering. All spreadsheet writing happens here so the analysis
 * modules stay free of formatting concerns.
 */

const STYLE = {
  header: { bg: '#111827', fg: '#ffffff' },
  sub: { bg: '#e5e7eb', fg: '#111827' },
  good: '#065f46',
  goodBg: '#d1fae5',
  bad: '#991b1b',
  badBg: '#fee2e2',
  warnBg: '#fef3c7',
  muted: '#6b7280'
};

function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  return sh;
}

function resetSheet_(name) {
  const sh = getOrCreateSheet_(name);
  sh.clear();
  sh.clearConditionalFormatRules();
  const maxR = sh.getMaxRows(), maxC = sh.getMaxColumns();
  if (maxR > 1) sh.setRowHeights(1, maxR, 21);
  sh.getRange(1, 1, maxR, maxC).setFontFamily('Inter').setFontSize(10)
    .setVerticalAlignment('middle').setWrap(false);
  return sh;
}

function writeTable_(sh, startRow, headers, rows, opts) {
  opts = opts || {};
  sh.getRange(startRow, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground(STYLE.header.bg).setFontColor(STYLE.header.fg);
  if (rows.length) {
    sh.getRange(startRow + 1, 1, rows.length, headers.length).setValues(rows);
  }
  sh.setFrozenRows(opts.freeze === undefined ? startRow : opts.freeze);
  return startRow + 1 + rows.length;
}

function titleBlock_(sh, title, subtitle) {
  sh.getRange('A1').setValue(title)
    .setFontSize(16).setFontWeight('bold').setFontColor('#111827');
  sh.getRange('A2').setValue(subtitle).setFontColor(STYLE.muted).setFontSize(9);
  return 4;
}

function stamp_(m) {
  return m.leagueName + ' · Week ' + m.week + ' · updated ' +
    Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, h:mm a');
}

function colorScaleOnColumn_(sh, row, col, numRows, reverse) {
  if (numRows <= 0) return;
  const range = sh.getRange(row, col, numRows, 1);
  const rule = SpreadsheetApp.newConditionalFormatRule()
    .setGradientMinpointWithValue(reverse ? STYLE.goodBg : STYLE.badBg,
      SpreadsheetApp.InterpolationType.PERCENTILE, '5')
    .setGradientMaxpointWithValue(reverse ? STYLE.badBg : STYLE.goodBg,
      SpreadsheetApp.InterpolationType.PERCENTILE, '95')
    .setRanges([range]).build();
  const rules = sh.getConditionalFormatRules();
  rules.push(rule);
  sh.setConditionalFormatRules(rules);
}

// ------------------------------------------------------------------ Dashboard

function renderDashboard(m, stats, lineup, waivers, trades, needs, matchup) {
  const sh = resetSheet_(SHEETS.DASH);
  let r = titleBlock_(sh, m.leagueName, stamp_(m));

  const me = m.me;
  const myStat = stats.find(s => s.team.rosterId === (me && me.rosterId));
  const rank = stats.findIndex(s => s.team.rosterId === (me && me.rosterId)) + 1;

  sh.getRange(r, 1).setValue('WHERE YOU STAND').setFontWeight('bold')
    .setBackground(STYLE.sub.bg);
  sh.getRange(r, 1, 1, 6).setBackground(STYLE.sub.bg);
  r++;

  if (myStat) {
    const cards = [
      ['Record', myStat.record],
      ['All-play', myStat.allPlay + '  (' + Math.round(myStat.allPlayPct * 100) + '%)'],
      ['True rank', rank + ' of ' + stats.length],
      ['Points for', Math.round(myStat.pf * 10) / 10],
      ['Start/sit efficiency', Math.round(myStat.efficiency * 1000) / 10 + '%'],
      ['Luck', (myStat.luck >= 0 ? '+' : '') + (Math.round(myStat.luck * 10) / 10) + ' wins']
    ];
    if (matchup && !matchup.none) {
      cards.push(['This week', 'vs ' + matchup.opp.team.name.trim() + ' — ' +
        Math.round(matchup.pOptimal * 100) + '% to win, expected ' +
        (Math.round(matchup.me.optimal * 10) / 10) + ' to ' +
        (Math.round(matchup.opp.optimal * 10) / 10) + '. See "' + SHEETS.MATCHUP + '"']);
    }
    cards.forEach((c, i) => {
      sh.getRange(r + i, 1).setValue(c[0]).setFontColor(STYLE.muted);
      sh.getRange(r + i, 2).setValue(c[1]).setFontWeight('bold');
    });
    r += cards.length + 1;
  }

  // Where the roster is thin. Total value hides shape: you can lead the league
  // overall and still be 9th at a position, because depth elsewhere covers it.
  if (needs && needs.length) {
    sh.getRange(r, 1).setValue('ROSTER SHAPE  (weakest position first)').setFontWeight('bold');
    sh.getRange(r, 1, 1, 6).setBackground(STYLE.sub.bg);
    r++;

    const needRows = needs.map(x => [
      x.pos,
      x.rank + ' of ' + x.of,
      Math.round(x.value * 10) / 10,
      (x.vsMedian >= 0 ? '+' : '') + Math.round(x.vsMedian * 10) / 10,
      x.waiverFixable
        ? 'Waivers can help — best free agent ' + pName(m, x.bestFa) +
          ' (' + Math.round(x.bestFaValue) + ') beats your weakest starter here'
        : 'Waivers cannot fix this — best free agent is ' +
          Math.round(x.weakestStarter - x.bestFaValue) + ' behind your weakest starter. Trade.'
    ]);
    const needStart = r + 1;
    r = writeTable_(sh, r, ['Pos', 'Rank', 'ROS value', 'vs median', 'Fix'], needRows, { freeze: 0 });
    needRows.forEach((row, i) => {
      if (needs[i].rank > needs.length) return;
      if (needs[i].vsMedian < 0) {
        sh.getRange(needStart + i, 1, 1, 5).setBackground(STYLE.badBg);
      }
    });
    r += 1;
  }

  // This week's decisions
  sh.getRange(r, 1).setValue('DO THIS WEEK').setFontWeight('bold');
  sh.getRange(r, 1, 1, 6).setBackground(STYLE.sub.bg);
  r++;

  const actions = [];

  if (lineup && lineup.changes.length) {
    lineup.changes.forEach(c => {
      actions.push(['Lineup', 'Start ' + c.inLabel + ' over ' + c.outLabel,
        '+' + (Math.round(c.delta * 10) / 10) + ' pts', 'See "' + SHEETS.LINEUP + '"']);
    });
  } else if (lineup) {
    actions.push(['Lineup', 'Your lineup is already optimal', '—', '']);
  }

  (waivers || []).slice(0, 3).forEach(w => {
    if (w.net <= 0) return;
    actions.push(['Waiver', 'Add ' + pLabel(m, w.id) + ', drop ' + pLabel(m, w.drop),
      '+' + (Math.round(w.net * 10) / 10) + ' ROS', 'See "' + SHEETS.WAIVERS + '"']);
  });

  (trades || []).slice(0, 3).forEach(t => {
    actions.push(['Trade',
      'Send ' + t.give.map(id => pName(m, id)).join(' + ') +
      ' to ' + t.partner.name + ' for ' + t.get.map(id => pName(m, id)).join(' + '),
      '+' + (Math.round(t.myGain * 10) / 10) + ' you / +' +
      (Math.round(t.theirGain * 10) / 10) + ' them', 'See "' + SHEETS.TRADES + '"']);
  });

  if (!actions.length) actions.push(['—', 'Nothing actionable found this week', '', '']);

  r = writeTable_(sh, r, ['Type', 'Action', 'Value', 'Detail'], actions, { freeze: 0 });
  r += 2;

  // What the waiver wire is actually worth, by position. This is the number
  // that decides whether carrying depth at a position is smart or wasteful:
  // if a startable QB is always free, a second QB is not worth a bench spot.
  sh.getRange(r, 1).setValue('WHAT THE WIRE IS WORTH  (pts/week from a freely available player)')
    .setFontWeight('bold');
  sh.getRange(r, 1, 1, 6).setBackground(STYLE.sub.bg);
  r++;

  const repl = replacementSummary(m).sort((a, b) => b.perWeek - a.perWeek);
  // The depth column is the STREAM_DEPTH actually in force. It is shown so a
  // setting that is not doing what you think is visible at a glance.
  const replRows = repl.map(x => [
    x.pos,
    Math.round(x.perWeek * 10) / 10,
    x.perWeek >= 12 ? 'Deep — carrying a backup here wastes a roster spot'
      : x.perWeek >= 8 ? 'Streamable'
        : 'Scarce — depth here has real value',
    'Free agent #' + streamDepthFor(x.pos)
  ]);
  r = writeTable_(sh, r, ['Pos', 'Replacement', 'Read', 'Measured at'], replRows, { freeze: 0 });

  sh.setColumnWidth(1, 90);
  sh.setColumnWidth(2, 520);
  sh.setColumnWidth(3, 170);
  sh.setColumnWidth(4, 180);
  return sh;
}

// ----------------------------------------------------------------- My Lineup

const LINEUP_COLS = ['Slot', 'Player', 'Team', 'Pos', 'Opp', 'Status', 'Score', 'Chances',
  'Tgt %', 'Rush %', 'RZ %', 'Snap %', 'Trend', 'Games', 'Role', 'Opp volume', 'Opp efficiency',
  'Weather', 'Action'];

/** "+8%" / "-5%" for a multiplier, or a dash when it is within half a point of neutral. */
function adj_(mult) {
  if (mult === undefined || mult === null) return '';
  const p = Math.round((mult - 1) * 100);
  if (!p) return '—';
  return (p > 0 ? '+' : '') + p + '%';
}

/** One player's row of factors, in LINEUP_COLS order from 'Team' to 'Weather'. */
function factorCells_(m, id, week, final, usage) {
  const f = (usage.f && usage.f[id]) || null;
  const g = pGame(m, id, week);
  const opp = final ? 'Final' : (g ? (g.h === false ? '@ ' : 'v ') + g.o : 'Bye');
  const head = [pTeam(m, id), pPos(m, id), opp, pInj(m, id)];
  const score = Math.round(((usage.score[id]) || 0) * 100) / 100;

  // No usage record: week-1 fallback, or a player with no games this season.
  if (!f || f.role === undefined) {
    const why = usage.fallback ? '' : (f && f.note ? f.note : 'No games yet');
    return head.concat([score, why, '', '', '', '', '', f ? f.g : '', '', '', '', '']);
  }

  const pos = f.pos;
  let chances = '';
  if (pos === 'QB') chances = Math.round(f.xAtt) + ' att, ' + Math.round(f.xCar) + ' car';
  else if (pos === 'RB') chances = (Math.round(f.xCar * 10) / 10) + ' car, ' + (Math.round(f.xTgt * 10) / 10) + ' tgt';
  else if (pos === 'WR' || pos === 'TE') chances = (Math.round(f.xTgt * 10) / 10) + ' tgt';

  const skill = pos === 'QB' || pos === 'RB' || pos === 'WR' || pos === 'TE';
  const share = x => (skill && x > 0.004) ? Math.round(x * 1000) / 1000 : '';
  const weather = f.wx ? f.wx + (f.wxm < 0.995 ? '  (' + adj_(f.wxm) + ')' : '') : '';

  return head.concat([
    score,
    chances,
    pos === 'QB' ? '' : share(f.tgt),
    share(f.car),
    pos === 'QB' ? '' : share(f.rz),
    share(f.snp),
    f.trend > 0 ? '▲' : (f.trend < 0 ? '▼' : ''),
    f.g,
    Math.round(f.role * 10) / 10,
    adj_(f.vol),
    adj_(f.def),
    weather
  ]);
}

function renderLineup(m, lineup) {
  const sh = resetSheet_(SHEETS.LINEUP);
  const usage = lineup.usage || { score: m.weekly[m.week] || {}, f: {}, fallback: true };
  const W = LINEUP_COLS.length;

  const basis = usage.fallback
    ? (m.week <= 1
      ? 'Week 1: no games have been played yet, so this falls back to Sleeper projections. ' +
        'From week 2 it switches to the usage score. '
      : 'Sleeper\'s stats feed could not be loaded on this refresh, so this falls back to ' +
        'Sleeper projections. Refresh again to get the usage score. ')
    : 'Ranked by the usage score — each player\'s role, this week\'s opponent' +
      (usage.weatherOn ? ' and the weather' : '') + ' — ' +
      'from real stats in weeks ' + usage.weeks[0] + '–' + usage.weeks[usage.weeks.length - 1] +
      '. Sleeper projections are not used. ';
  let r = titleBlock_(sh, 'My Lineup — Week ' + m.week,
    basis + 'Set the lineup in Sleeper: ' + lineupUrl_(m));

  sh.getRange(r, 1).setValue('Current lineup').setFontColor(STYLE.muted);
  sh.getRange(r, 2).setValue(Math.round(lineup.current * 100) / 100).setFontWeight('bold');
  sh.getRange(r + 1, 1).setValue('Best lineup').setFontColor(STYLE.muted);
  sh.getRange(r + 1, 2).setValue(Math.round(lineup.optimal * 100) / 100).setFontWeight('bold');
  sh.getRange(r + 2, 1).setValue('Left on the bench').setFontColor(STYLE.muted);
  sh.getRange(r + 2, 2).setValue(Math.round((lineup.optimal - lineup.current) * 100) / 100)
    .setFontWeight('bold')
    .setFontColor(lineup.optimal - lineup.current > 0.5 ? STYLE.bad : STYLE.good);
  sh.getRange(r, 2, 3, 1).setHorizontalAlignment('left');
  r += 4;

  const week = m.week;
  const rows = lineup.rows.map(p => {
    if (!p.id) {
      const blank = [p.slot, '(empty)'];
      while (blank.length < W) blank.push('');
      return blank;
    }
    return [p.slot, pName(m, p.id)]
      .concat(factorCells_(m, p.id, week, p.final, usage))
      .concat([p.isChange ? 'SWAP IN' : '']);
  });
  r = writeTable_(sh, r, LINEUP_COLS, rows);

  const startRow = r - rows.length;
  const paint = (first, list, action) => {
    list.forEach((row, i) => {
      if (row[W - 1] === action) sh.getRange(first + i, 1, 1, W).setBackground(STYLE.goodBg);
      if (row[5]) sh.getRange(first + i, 6).setFontColor(STYLE.bad);
      if (row[12] === '▲') sh.getRange(first + i, 13).setFontColor(STYLE.good);
      if (row[12] === '▼') sh.getRange(first + i, 13).setFontColor(STYLE.bad);
      [15, 16].forEach(c => {
        const v = String(row[c]);
        if (v.charAt(0) === '+') sh.getRange(first + i, c + 1).setFontColor(STYLE.good);
        if (v.charAt(0) === '-') sh.getRange(first + i, c + 1).setFontColor(STYLE.bad);
      });
      if (/\(-\d+%\)/.test(String(row[17]))) sh.getRange(first + i, 18).setFontColor(STYLE.bad);
    });
    if (list.length) {
      sh.getRange(first, 7, list.length, 1).setNumberFormat('0.00').setFontWeight('bold');
      sh.getRange(first, 9, list.length, 4).setNumberFormat('0%');
      sh.getRange(first, 15, list.length, 1).setNumberFormat('0.0');
      sh.getRange(first, 13, list.length, 2).setHorizontalAlignment('center');
    }
  };
  paint(startRow, rows, 'SWAP IN');

  r += 1;
  sh.getRange(r, 1).setValue('BENCH').setFontWeight('bold').setBackground(STYLE.sub.bg);
  sh.getRange(r, 1, 1, W).setBackground(STYLE.sub.bg);
  r++;

  const benchRows = lineup.bench.map(b => ['', pName(m, b.id)]
    .concat(factorCells_(m, b.id, week, b.final, usage))
    .concat([b.isChange ? 'SIT' : '']));
  const benchHead = LINEUP_COLS.slice();
  benchHead[0] = '';
  r = writeTable_(sh, r, benchHead, benchRows, { freeze: 0 });
  paint(r - benchRows.length, benchRows, 'SIT');

  if (!usage.fallback) {
    r += 1;
    const notes = [
      'Score = Role × Opp volume × Opp efficiency × Weather, in your league scoring. ' +
        'Weather applies to passing, receiving and kicking only.',
      'Chances: targets and carries he should see this week. Tgt % / Rush % / RZ %: his share of the team\'s ' +
        'targets, carries and red-zone work in the games he played, recent games weighted more. ' +
        'Trend: ▲ or ▼ when his last game moved away from the ones before it. Games: how many the shares rest on.',
      'Role: what that workload is worth against an average defense. Opp volume: how many targets or carries ' +
        'this defense allows to his position. Opp efficiency: how many points it gives up per target or carry.',
      'Not in the number: a role that changes this week (injury ahead of him, return from injury, trade). ' +
        'A game already played is marked Final and is not moved.' +
        (!usage.weatherOn ? ' Weather is switched off (USE_WEATHER on the Settings sheet).'
          : (usage.weatherLoaded ? ''
            : ' Weather could not be loaded on this refresh, so no weather adjustment was made.'))
    ];
    notes.forEach(n => {
      sh.getRange(r, 1).setValue(n).setFontColor(STYLE.muted).setFontSize(9);
      r++;
    });
  }

  sh.setColumnWidth(1, 60);
  sh.setColumnWidth(2, 185);
  sh.setColumnWidth(3, 50);
  sh.setColumnWidth(4, 45);
  sh.setColumnWidth(5, 65);
  sh.setColumnWidth(6, 95);
  sh.setColumnWidth(7, 60);
  sh.setColumnWidth(8, 120);
  [9, 10, 11, 12].forEach(c => sh.setColumnWidth(c, 60));
  sh.setColumnWidth(13, 50);
  sh.setColumnWidth(14, 55);
  sh.setColumnWidth(15, 55);
  sh.setColumnWidth(16, 85);
  sh.setColumnWidth(17, 95);
  sh.setColumnWidth(18, 190);
  sh.setColumnWidth(19, 75);
  return sh;
}

function lineupUrl_(m) {
  return 'https://sleeper.com/leagues/' + m.leagueId + '/team';
}

// -------------------------------------------------------------------- Matchup

function recordOf_(t) {
  return t.wins + '-' + t.losses + (t.ties ? '-' + t.ties : '');
}

function pct_(p) { return Math.round(p * 100) + '%'; }

function r1_(x) { return Math.round(x * 10) / 10; }

function renderMatchup(m, mu) {
  const sh = resetSheet_(SHEETS.MATCHUP);
  const W = 8;

  let r;
  if (mu.none) {
    r = titleBlock_(sh, 'Matchup — Week ' + mu.week, stamp_(m));
    sh.getRange(r, 1).setValue(mu.reason).setFontColor(STYLE.muted);
    r += 2;
  } else {
    const me = mu.me, opp = mu.opp;
    r = titleBlock_(sh, 'Matchup — Week ' + mu.week,
      me.team.name.trim() + ' vs ' + opp.team.name.trim() + '. Finished games use real ' +
      'points; everyone else is valued by the usage score' +
      (mu.fallback ? ' (not available on this refresh, so Sleeper projections stand in)' : '') +
      ', not Sleeper projections. ' + stamp_(m));

    // ---- summary. Values sit above the column they describe in the table below.
    const line = (label, a, b, edge) => [label, a, '', '', b, '', '', edge === undefined ? '' : edge];
    const summary = [
      line('Record', recordOf_(me.team), recordOf_(opp.team)),
      line('Win probability', pct_(mu.pOptimal), pct_(1 - mu.pOptimal)),
      line('Expected final', r1_(me.optimal), r1_(opp.optimal), r1_(me.optimal - opp.optimal)),
      line('   already scored', r1_(me.scored), r1_(opp.scored), r1_(me.scored - opp.scored)),
      line('   still to play', r1_(me.bestToPlay), r1_(opp.bestToPlay), r1_(me.bestToPlay - opp.bestToPlay)),
      line('Lineups exactly as set now', r1_(me.asSet), r1_(opp.asSet), r1_(me.asSet - opp.asSet)),
      line('Win probability as set', pct_(mu.pSet), pct_(1 - mu.pSet))
    ];
    const sumStart = r + 1;
    r = writeTable_(sh, r,
      ['', me.team.name.trim(), '', '', opp.team.name.trim(), '', '', 'Edge'],
      summary, { freeze: 0 });
    sh.getRange(sumStart, 1, summary.length, 1).setFontColor(STYLE.muted);
    sh.getRange(sumStart + 1, 2, 2, 1).setFontWeight('bold');
    sh.getRange(sumStart + 1, 5, 2, 1).setFontWeight('bold');
    sh.getRange(sumStart, 2, summary.length, 1).setHorizontalAlignment('left');
    sh.getRange(sumStart, 5, summary.length, 1).setHorizontalAlignment('left');
    sh.getRange(sumStart + 1, 2).setFontColor(mu.pOptimal >= 0.5 ? STYLE.good : STYLE.bad);
    sh.getRange(sumStart + 1, 5).setFontColor(mu.pOptimal >= 0.5 ? STYLE.bad : STYLE.good);
    summary.forEach((row, i) => {
      if (typeof row[7] !== 'number') return;
      sh.getRange(sumStart + i, W).setFontColor(row[7] >= 0 ? STYLE.good : STYLE.bad);
    });

    r += 1;
    const notes = [];
    notes.push('"Expected final" assumes both sides fill every open slot with their best ' +
      'available player. "As set" scores the lineups exactly as they stand in Sleeper right now.');
    notes.push('Teams in this league land about ±' + Math.round(mu.sd) + ' pts from this number' +
      (mu.calSamples
        ? ' (measured by replaying ' + mu.calWeeks + ' completed week' + (mu.calWeeks === 1 ? '' : 's') +
          ', ' + mu.calSamples + ' team-weeks).'
        : ' (a starting assumption; it is measured from this league once two weeks have been played).'));
    if (mu.oppGap > 0.5) {
      notes.push(opp.team.name.trim() + ' has ' + r1_(mu.oppGap) + ' pts sitting on the bench as set. ' +
        'Expect them to fix it before kickoff.');
    }
    if (mu.myGap > 0.5) {
      notes.push('You have ' + r1_(mu.myGap) + ' pts sitting on your bench. See "' + SHEETS.LINEUP + '".');
    }
    notes.forEach(n => {
      sh.getRange(r, 1).setValue(n).setFontColor(STYLE.muted).setFontSize(9);
      r++;
    });
    r += 1;

    // ---- slot by slot
    sh.getRange(r, 1).setValue('SLOT BY SLOT  (lineups as set)').setFontWeight('bold');
    sh.getRange(r, 1, 1, W).setBackground(STYLE.sub.bg);
    r++;

    const who = l => !l.id ? '(empty)' : pName(m, l.id) + (pInj(m, l.id) ? ' [' + pInj(m, l.id) + ']' : '');
    const game = l => !l.id ? '' : (l.final ? 'Final'
      : (l.game && l.game.o ? (l.game.h === false ? '@ ' : 'v ') + l.game.o : 'No game'));
    const dead = l => !l.id || (!l.final && !l.proj);

    const rows = mu.rows.map(x => [
      x.slot,
      who(x.mine), game(x.mine), Math.round(x.mine.pts * 100) / 100,
      who(x.theirs), game(x.theirs), Math.round(x.theirs.pts * 100) / 100,
      Math.round(x.edge * 100) / 100
    ]);
    rows.push(['', 'Total as set', '', Math.round(me.asSet * 100) / 100,
      'Total as set', '', Math.round(opp.asSet * 100) / 100,
      Math.round((me.asSet - opp.asSet) * 100) / 100]);

    const first = r + 1;
    r = writeTable_(sh, r, ['Slot', 'You', 'Game', 'Pts', 'Opponent', 'Game', 'Pts', 'Edge'],
      rows, { freeze: 0 });

    mu.rows.forEach((x, i) => {
      // A slot that will score nothing: empty, on bye, or out.
      if (dead(x.mine)) sh.getRange(first + i, 2, 1, 3).setBackground(STYLE.badBg);
      if (dead(x.theirs)) sh.getRange(first + i, 5, 1, 3).setBackground(STYLE.warnBg);
      if (x.mine.final) sh.getRange(first + i, 3, 1, 2).setFontWeight('bold');
      if (x.theirs.final) sh.getRange(first + i, 6, 1, 2).setFontWeight('bold');
      sh.getRange(first + i, W).setFontColor(x.edge >= 0 ? STYLE.good : STYLE.bad);
    });
    const totalRow = first + rows.length - 1;
    sh.getRange(totalRow, 1, 1, W).setFontWeight('bold').setBackground(STYLE.sub.bg);
    sh.getRange(totalRow, W).setFontColor(me.asSet >= opp.asSet ? STYLE.good : STYLE.bad);
    sh.getRange(first, 4, rows.length, 1).setNumberFormat('0.00');
    sh.getRange(first, 7, rows.length, 2).setNumberFormat('0.00');
    r += 1;
  }

  // ---- the rest of the league
  if (mu.league.length) {
    sh.getRange(r, 1).setValue('AROUND THE LEAGUE  (expected finals, favourite on the left)')
      .setFontWeight('bold');
    sh.getRange(r, 1, 1, W).setBackground(STYLE.sub.bg);
    r++;

    const slate = mu.league.map(g => [
      g.isMine ? 'YOU' : '',
      g.a.team.name.trim(), recordOf_(g.a.team), r1_(g.a.optimal),
      g.b.team.name.trim(), recordOf_(g.b.team), r1_(g.b.optimal),
      pct_(g.pOptimal)
    ]);
    const first = r + 1;
    r = writeTable_(sh, r,
      ['', 'Team', 'Record', 'Exp', 'Team', 'Record', 'Exp', 'Left wins'],
      slate, { freeze: 0 });
    mu.league.forEach((g, i) => {
      if (g.isMine) sh.getRange(first + i, 1, 1, W).setBackground(STYLE.goodBg);
    });
    sh.getRange(first, 4, slate.length, 1).setNumberFormat('0.0');
    sh.getRange(first, 7, slate.length, 1).setNumberFormat('0.0');
  }

  sh.setFrozenRows(0);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(2, 210);
  sh.setColumnWidth(3, 75);
  sh.setColumnWidth(4, 70);
  sh.setColumnWidth(5, 210);
  sh.setColumnWidth(6, 75);
  sh.setColumnWidth(7, 70);
  sh.setColumnWidth(W, 80);
  return sh;
}

// ------------------------------------------------------------ Waiver Targets

function renderWaivers(m, waivers) {
  const sh = resetSheet_(SHEETS.WAIVERS);
  let r = titleBlock_(sh, 'Waiver Targets',
    'Still built on Sleeper projections — the usage score covers My Lineup and Matchup so far. ' +
    'Net gain = your optimal lineup with this player added and the listed drop ' +
    'removed, summed to the end of the playoffs. ' + stamp_(m));

  const rows = waivers.map(w => [
    pName(m, w.id),
    pTeam(m, w.id),
    pPos(m, w.id),
    pInj(m, w.id),
    Math.round(w.ros * 10) / 10,
    Math.round(w.net * 10) / 10,
    w.drop ? pName(m, w.drop) : '',
    w.trend || ''
  ]);

  r = writeTable_(sh, r,
    ['Player', 'Team', 'Pos', 'Status', 'ROS proj', 'Net gain', 'Drop', 'Adds (48h)'],
    rows);

  const first = r - rows.length;
  colorScaleOnColumn_(sh, first, 6, rows.length);
  sh.getRange(first, 5, Math.max(rows.length, 1), 2).setNumberFormat('0.0');

  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(7, 180);
  [2, 3, 4, 5, 6, 8].forEach(c => sh.setColumnWidth(c, 95));
  return sh;
}

// -------------------------------------------------------------- Trade Finder

function renderTrades(m, trades) {
  const sh = resetSheet_(SHEETS.TRADES);
  let r = titleBlock_(sh, 'Trade Finder',
    'Still built on Sleeper projections — the usage score covers My Lineup and Matchup so far. ' +
    'Only deals where BOTH rosters improve. Gains are projected starting-lineup ' +
    'points through the fantasy playoffs, with playoff weeks weighted ' +
    cfg('PLAYOFF_WEIGHT') + 'x. ' + stamp_(m));

  const rows = trades.map(t => [
    t.partner.name,
    t.give.map(id => pLabel(m, id)).join('  +  '),
    t.get.map(id => pLabel(m, id)).join('  +  '),
    Math.round(t.myGain * 10) / 10,
    Math.round(t.theirGain * 10) / 10,
    Math.round((t.myGain + t.theirGain) * 10) / 10,
    t.overMax ? 'They must drop ' + (t.theirCount - t.rosterMax) : ''
  ]);

  r = writeTable_(sh, r,
    ['Partner', 'You send', 'You get', 'Your gain', 'Their gain', 'Total', 'Note'], rows);

  const first = r - rows.length;
  colorScaleOnColumn_(sh, first, 4, rows.length);
  sh.getRange(first, 4, Math.max(rows.length, 1), 3).setNumberFormat('0.0');

  sh.setColumnWidth(1, 190);
  sh.setColumnWidth(2, 280);
  sh.setColumnWidth(3, 280);
  [4, 5, 6].forEach(c => sh.setColumnWidth(c, 95));
  sh.setColumnWidth(7, 160);

  if (!rows.length) {
    sh.getRange(r + 1, 1).setValue(
      'No mutually-improving deals cleared the ' + cfg('TRADE_MIN_GAIN') +
      '-point threshold. Lower TRADE_MIN_GAIN on the Settings sheet to see closer calls.')
      .setFontColor(STYLE.muted);
  }
  return sh;
}

// ------------------------------------------------------------ Power Rankings

function renderPower(m, stats) {
  const sh = resetSheet_(SHEETS.POWER);
  let r = titleBlock_(sh, 'Power Rankings',
    'Ranked by all-play win rate, which strips out schedule luck. ' + stamp_(m));

  const rows = stats.map((s, i) => [
    i + 1,
    s.team.name,
    s.record,
    s.allPlay,
    Math.round(s.allPlayPct * 1000) / 10,
    Math.round(s.pf * 10) / 10,
    Math.round(s.avg * 10) / 10,
    Math.round(s.stdev * 10) / 10,
    Math.round(s.high * 10) / 10,
    Math.round(s.low * 10) / 10,
    Math.round(s.efficiency * 1000) / 10,
    Math.round(s.pointsLeftOnBench * 10) / 10,
    Math.round(s.luck * 10) / 10
  ]);

  r = writeTable_(sh, r,
    ['#', 'Team', 'Record', 'All-play', 'All-play %', 'PF', 'Avg', 'Std dev',
      'High', 'Low', 'Efficiency %', 'Left on bench', 'Luck (wins)'], rows);

  const first = r - rows.length;
  colorScaleOnColumn_(sh, first, 5, rows.length);
  colorScaleOnColumn_(sh, first, 11, rows.length);
  colorScaleOnColumn_(sh, first, 13, rows.length);

  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 210);
  for (let c = 3; c <= 13; c++) sh.setColumnWidth(c, 95);
  return sh;
}

// -------------------------------------------------------- Positional Matrix

function renderMatrix(m, matrix) {
  const sh = resetSheet_(SHEETS.MATRIX);
  let r = titleBlock_(sh, 'Positional Matrix',
    'Rest-of-season projected points from the players who would actually start ' +
    'at each spot. Find a team long where you are short. ' + stamp_(m));

  const cols = matrix.positions.concat(['FLEX', 'BENCH']);
  const headers = ['Team'].concat(cols);
  const rows = matrix.rows.map(row => {
    const out = [row.team.name];
    cols.forEach(p => out.push(Math.round(row.values[p] * 10) / 10));
    return out;
  });

  r = writeTable_(sh, r, headers, rows);
  const first = r - rows.length;
  for (let c = 2; c <= headers.length; c++) {
    colorScaleOnColumn_(sh, first, c, rows.length);
  }
  sh.getRange(first, 2, Math.max(rows.length, 1), cols.length).setNumberFormat('0.0');
  sh.setColumnWidth(1, 210);
  for (let c = 2; c <= headers.length; c++) sh.setColumnWidth(c, 85);
  return sh;
}

// -------------------------------------------------------------- All Rosters

function renderRosters(m) {
  const sh = resetSheet_(SHEETS.ROSTERS);
  let r = titleBlock_(sh, 'League Rosters',
    'Every roster with rest-of-season projections and bye weeks. ' + stamp_(m));

  const ros = rosWeeks(m).concat(playoffWeeks(m));
  const byeMap = inferByeWeeks(m);

  const rows = [];
  m.teams.forEach(t => {
    const sorted = t.players.slice().sort((a, b) =>
      playerTotal(m, b, ros) - playerTotal(m, a, ros));
    sorted.forEach(id => {
      rows.push([
        t.name,
        (t.starters || []).indexOf(id) >= 0 ? 'START' : '',
        pName(m, id),
        pTeam(m, id),
        pPos(m, id),
        byeMap[pTeam(m, id)] || '',
        pInj(m, id),
        Math.round(playerTotal(m, id, ros) * 10) / 10
      ]);
    });
  });

  r = writeTable_(sh, r,
    ['Team', 'Slot', 'Player', 'NFL', 'Pos', 'Bye', 'Status', 'ROS proj'], rows);

  sh.setColumnWidth(1, 200);
  sh.setColumnWidth(3, 190);
  [2, 4, 5, 6, 7, 8].forEach(c => sh.setColumnWidth(c, 85));

  const first = r - rows.length;
  if (rows.length) {
    sh.getRange(first, 1, rows.length, 8).createFilter();
    sh.getRange(first, 8, rows.length, 1).setNumberFormat('0.0');
  }
  return sh;
}
