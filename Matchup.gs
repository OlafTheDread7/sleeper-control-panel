/**
 * Matchup.gs — this week's head-to-head.
 *
 * Every other sheet in the panel looks at the rest of the season. This one
 * answers the question you actually have on a Sunday morning: who is ahead in
 * my game, by how much, and how safe is it.
 *
 * Three ideas do the work.
 *
 * Players who have not played yet are valued by the usage score (Usage.gs):
 * role, opponent and weather. Sleeper's projections are not used here.
 *
 * 1. PLAYED GAMES ARE FACTS, NOT FORECASTS.
 *    Once a player's NFL game is over his outlook is irrelevant; he scored
 *    what he scored. The schedule carries each game's date, so any game dated
 *    before today is taken from the real box score and everything else from
 *    the usage score. A lineup that led off with a big
 *    Thursday night is therefore already ahead here, exactly as it is in
 *    Sleeper, instead of being re-scored as if the game had not happened.
 *    Games dated today count as not yet played — the schedule has no kickoff
 *    time, so mid-game the sheet shows the pre-game number until tomorrow.
 *
 * 2. THE LINEUP AS SET, AND THE LINEUP AS IT COULD BE.
 *    Early in the week your opponent has not touched their lineup: a player on
 *    bye or ruled out is still sitting in a starting slot. Scoring only what is
 *    set would flatter you. So each side is shown twice — as currently set, and
 *    with every still-open slot filled optimally from the players whose games
 *    have not started. The second number is what a competent opponent ends up
 *    with. Finished games are never reshuffled: a bench player who went off on
 *    Thursday cannot be started retroactively.
 *
 * 3. A WIN PROBABILITY THAT IS MEASURED, NOT ASSUMED.
 *    An 8-point lead on paper means nothing without knowing how far teams land
 *    from the number. That is measured from this league: for each completed
 *    week the usage score is rebuilt exactly as it would have stood beforehand,
 *    from the weeks before it, and compared with what every team's starters
 *    then scored. The spread of those misses is the yardstick. Early in the
 *    season there are few weeks to measure, so the estimate leans on a prior
 *    and hands over to the league's own data as it accumulates. Only the part
 *    of each lineup still to be played carries uncertainty, so the probability
 *    tightens toward 0 or 100 as the week's games finish.
 */

const MATCHUP = {
  // How far a team typically lands from its expected total, in points.
  // Used until the league has enough completed weeks to say for itself.
  SD_PRIOR: 32,
  // The prior counts as this many observed team-weeks.
  PRIOR_WEIGHT: 12
};

/** Today in the NFL's time zone, as yyyy-MM-dd, comparable to game dates. */
function todayEastern_() {
  return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
}

/** True once a player's game this week is in the books. */
function gameIsFinal_(m, id, week, today) {
  const g = pGame(m, id, week);
  return !!(g && g.d && g.d < today);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error < 1.5e-7). */
function normCdf_(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 +
    t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * How far teams in this league land from the totals this sheet would have
 * shown them. Returns { sd, weeks, samples }.
 *
 * Each completed week is replayed: the score is rebuilt from only the weeks
 * before it, then set against what each team's starters actually scored. The
 * first week of a season cannot be replayed — there is nothing before it — and
 * until some weeks can, the answer leans on the prior.
 */
function calibrateSpread_(m) {
  const u = loadUsage(m);
  let sumSq = 0, n = 0, weeks = 0;

  (u.fallback ? [] : u.weeks).forEach(w => {
    const asOf = usageAsOf_(m, w);
    if (!asOf) return;
    let rows;
    try { rows = apiMatchups(m.leagueId, w); } catch (e) { return; }
    if (!rows || !rows.length) return;

    let used = 0;
    rows.forEach(r => {
      const actual = Number(r.points) || 0;
      if (!actual) return;
      let expected = 0;
      (r.starters || []).forEach(id => { if (id && id !== '0') expected += asOf.score[id] || 0; });
      if (expected <= 0) return;
      sumSq += Math.pow(actual - expected, 2);
      n++;
      used++;
    });
    if (used) weeks++;
  });

  const k = MATCHUP.PRIOR_WEIGHT;
  const sd = Math.sqrt((k * MATCHUP.SD_PRIOR * MATCHUP.SD_PRIOR + sumSq) / (k + n));
  return { sd: sd, weeks: weeks, samples: n };
}

/**
 * One team's side of a matchup.
 *
 * @param {Object} row  that team's entry from the matchups endpoint, or null
 * @param {Object} tbl  player_id -> expected points for a game not yet played
 */
function matchupSide_(m, team, row, week, today, tbl) {
  const actual = (row && row.players_points) || {};
  const starters = (row && row.starters && row.starters.length) ? row.starters : (team.starters || []);
  const roster = (row && row.players && row.players.length) ? row.players : (team.players || []);

  let scored = 0;      // points already banked from finished games
  let toPlay = 0;      // expected points from starters still to play
  let pregame = 0;     // what the set lineup was worth before any kickoff

  const lines = m.slots.map((slot, i) => {
    const id = starters[i];
    if (!id || id === '0') {
      return { slot: slot, id: null, proj: 0, pts: 0, final: false, game: null };
    }
    const proj = tbl[id] || 0;
    const final = gameIsFinal_(m, id, week, today);
    const pts = final ? (Number(actual[id]) || 0) : proj;
    pregame += proj;
    if (final) scored += pts; else toPlay += proj;
    return { slot: slot, id: id, proj: proj, pts: pts, final: final, game: pGame(m, id, week) };
  });

  // Best finish still available: finished starters stay put, every other slot
  // is refilled from players whose games have not been played. Injured-reserve
  // players are left out — they cannot be started without a roster move.
  const lockedIds = lines.filter(l => l.final).map(l => l.id);
  const openSlots = lines.filter(l => !l.final).map(l => l.slot);
  const reserve = team.reserve || [];
  const available = roster.filter(id =>
    lockedIds.indexOf(id) === -1 &&
    reserve.indexOf(id) === -1 &&
    !gameIsFinal_(m, id, week, today));
  const bestToPlay = optimalWeekScore(m, available, week, slotOrder_(openSlots), null, tbl);

  return {
    team: team,
    lines: lines,
    scored: scored,
    toPlay: toPlay,
    pregame: pregame,
    asSet: scored + toPlay,
    bestToPlay: bestToPlay,
    optimal: scored + bestToPlay,
    empty: lines.filter(l => !l.id || (!l.final && !l.proj)).length
  };
}

/**
 * P(a beats b). Uncertainty scales with the share of a typical lineup that is
 * still to be played, so a side with nothing left to play contributes none.
 */
function winProbability_(aExpected, aToPlay, bExpected, bToPlay, sd, typicalTotal) {
  const base = Math.max(typicalTotal, 1);
  const share = x => Math.min(Math.max(x, 0) / base, 1.5);
  const variance = sd * sd * (share(aToPlay) + share(bToPlay));
  const diff = aExpected - bExpected;
  if (variance <= 0) return diff > 0 ? 1 : (diff < 0 ? 0 : 0.5);
  return normCdf_(diff / Math.sqrt(variance));
}

/**
 * Main entry. Returns the view the Matchup sheet and the Dashboard read.
 * `none` is set, with a reason, when there is no head-to-head to show.
 */
function computeMatchup(m) {
  loadWeeks(m, [m.week]);
  const me = m.me;
  if (!me) throw new Error('Could not identify your roster. Run First-time setup.');

  const week = m.week;
  const today = todayEastern_();
  const usage = loadUsage(m);
  const tbl = usage.score;

  let rows = [];
  try { rows = apiMatchups(m.leagueId, week) || []; } catch (e) { rows = []; }
  const rowById = {};
  rows.forEach(r => { rowById[r.roster_id] = r; });

  const sides = {};
  m.teams.forEach(t => {
    sides[t.rosterId] = matchupSide_(m, t, rowById[t.rosterId] || null, week, today, tbl);
  });

  // What a full lineup is worth in this league this week. The yardstick for
  // "how much of this side is still undecided".
  const totals = m.teams.map(t => sides[t.rosterId].pregame).filter(x => x > 0);
  const typical = totals.length ? totals.reduce((s, x) => s + x, 0) / totals.length : 0;

  const cal = calibrateSpread_(m);

  function pairing(a, b) {
    return {
      a: a, b: b,
      pSet: winProbability_(a.asSet, a.toPlay, b.asSet, b.toPlay, cal.sd, typical),
      pOptimal: winProbability_(a.optimal, a.bestToPlay, b.optimal, b.bestToPlay, cal.sd, typical)
    };
  }

  // Pair teams by matchup_id. A team with no id has no game this week.
  const byMatch = {};
  rows.forEach(r => {
    if (r.matchup_id === null || r.matchup_id === undefined) return;
    if (!sides[r.roster_id]) return;
    (byMatch[r.matchup_id] = byMatch[r.matchup_id] || []).push(r.roster_id);
  });

  const league = [];
  let mine = null;
  Object.keys(byMatch).map(Number).sort((x, y) => x - y).forEach(id => {
    const ids = byMatch[id];
    if (ids.length !== 2) return;
    // Put my team, or else the favourite, on the left.
    let a = sides[ids[0]], b = sides[ids[1]];
    const hasMe = ids.indexOf(me.rosterId) >= 0;
    if (hasMe ? a.team.rosterId !== me.rosterId : b.optimal > a.optimal) {
      const t = a; a = b; b = t;
    }
    const p = pairing(a, b);
    p.matchupId = id;
    p.isMine = hasMe;
    league.push(p);
    if (hasMe) mine = p;
  });

  const view = {
    week: week,
    today: today,
    sd: cal.sd,
    calWeeks: cal.weeks,
    calSamples: cal.samples,
    typical: typical,
    fallback: !!usage.fallback,
    league: league,
    none: !mine,
    reason: ''
  };

  if (!mine) {
    view.reason = rows.length
      ? 'You have no head-to-head this week (a bye, or the season is over).'
      : 'Sleeper has not published matchups for week ' + week + ' yet.';
    return view;
  }

  view.me = mine.a;
  view.opp = mine.b;
  view.pSet = mine.pSet;
  view.pOptimal = mine.pOptimal;

  // Slot-by-slot comparison, in the league's own lineup order.
  view.rows = m.slots.map((slot, i) => {
    const a = mine.a.lines[i], b = mine.b.lines[i];
    return { slot: slot, mine: a, theirs: b, edge: a.pts - b.pts };
  });

  // Opponent's bench upgrades: the swaps that take them from "as set" to
  // "optimal". Worth knowing — these are points they will probably find.
  view.oppGap = mine.b.optimal - mine.b.asSet;
  view.myGap = mine.a.optimal - mine.a.asSet;

  return view;
}
