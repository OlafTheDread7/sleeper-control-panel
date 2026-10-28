/**
 * Model.gs — assembles one consistent snapshot of the league that every other
 * module reads from. Built once per refresh so a run never mixes data pulled
 * at different moments.
 */

let _model = null;

function buildModel(force) {
  if (_model && !force) return _model;

  const leagueId = String(cfg('LEAGUE_ID')).trim();
  if (!leagueId) throw new Error('Set LEAGUE_ID on the Settings sheet first.');

  const state = apiState();
  const league = apiLeague(leagueId);
  const rosters = apiRosters(leagueId);
  const users = apiUsers(leagueId);

  const season = String(cfg('SEASON') || league.season || state.season);
  const week = Number(state.week) || 1;

  const playoffStart = Number((league.settings || {}).playoff_week_start) || 15;
  const rosLast = Number(cfg('ROS_LAST_WEEK')) || (playoffStart - 1);

  // Team name lookup
  const userById = {};
  users.forEach(u => {
    userById[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name || 'Team';
  });

  const teams = rosters.map(r => ({
    rosterId: r.roster_id,
    ownerId: r.owner_id,
    name: userById[r.owner_id] || ('Roster ' + r.roster_id),
    players: (r.players || []).slice(),
    starters: (r.starters || []).slice(),
    reserve: (r.reserve || []).slice(),
    wins: (r.settings || {}).wins || 0,
    losses: (r.settings || {}).losses || 0,
    ties: (r.settings || {}).ties || 0,
    pf: ((r.settings || {}).fpts || 0) + ((r.settings || {}).fpts_decimal || 0) / 100,
    pa: ((r.settings || {}).fpts_against || 0) + ((r.settings || {}).fpts_against_decimal || 0) / 100
  }));

  // Which roster is mine?
  let myRosterId = Number(cfg('MY_ROSTER_ID')) || null;
  if (!myRosterId) {
    const uname = String(cfg('MY_USERNAME') || '').trim().toLowerCase();
    if (uname) {
      // Username first; a team name is accepted too, since that is what
      // people tend to type into the Settings sheet.
      const u = users.find(x => String(x.display_name || '').toLowerCase() === uname) ||
        users.find(x => String((x.metadata && x.metadata.team_name) || '').trim().toLowerCase() === uname);
      if (u) {
        const r = rosters.find(x => x.owner_id === u.user_id);
        if (r) myRosterId = r.roster_id;
      }
    }
  }

  const scoring = league.scoring_settings || {};
  const sk = scoringKey(scoring);

  // Starting-lineup shape, bench slots removed.
  const slots = (league.roster_positions || []).filter(p => BENCH_SLOTS.indexOf(p) === -1);

  const rosteredIds = {};
  teams.forEach(t => t.players.forEach(p => { rosteredIds[p] = t.rosterId; }));

  _model = {
    leagueId: leagueId,
    league: league,
    leagueName: league.name,
    season: season,
    week: week,
    playoffStart: playoffStart,
    rosLastWeek: rosLast,
    teams: teams,
    teamById: teams.reduce((m, t) => { m[t.rosterId] = t; return m; }, {}),
    myRosterId: myRosterId,
    me: teams.find(t => t.rosterId === myRosterId) || null,
    scoring: scoring,
    scoringKey: sk,
    slots: slots,
    rosteredIds: rosteredIds,
    meta: {},      // player_id -> {n,pos,tm,inj}
    weekly: {},    // week -> {player_id: points}  (Sleeper projections)
    sched: {},     // week -> {NFL_TEAM: {o: opponent, d: 'yyyy-MM-dd'}}
    nfl: null,     // full-season schedule, loaded on demand (Usage.gs)
    usage: null    // this week's usage score, loaded on demand (Usage.gs)
  };

  return _model;
}

/**
 * Loads projections for a list of weeks into the model, merging player meta.
 * Returns the model for chaining.
 */
function loadWeeks(m, weeks) {
  weeks.forEach(w => {
    if (m.weekly[w]) return;
    const data = getWeekProjections(m.season, w, m.scoring, m.scoringKey);
    m.weekly[w] = data.scores;
    m.sched[w] = data.sched || {};
    for (const id in data.meta) {
      if (!m.meta[id]) m.meta[id] = data.meta[id];
      else if (data.meta[id].inj && !m.meta[id].inj) m.meta[id].inj = data.meta[id].inj;
    }
  });
  return m;
}

function weekRange(from, to) {
  const out = [];
  for (let w = from; w <= to; w++) out.push(w);
  return out;
}

/** Rest-of-season weeks, current week included. */
function rosWeeks(m) {
  return weekRange(Math.max(1, m.week), m.rosLastWeek);
}

/** Fantasy playoff weeks. */
function playoffWeeks(m) {
  return weekRange(m.playoffStart, m.playoffStart + 2);
}

/**
 * Total projected points for a player across a set of weeks.
 * Byes contribute zero because Sleeper publishes no projection that week.
 */
function playerTotal(m, playerId, weeks, weightMap) {
  let t = 0;
  for (let i = 0; i < weeks.length; i++) {
    const w = weeks[i];
    const tbl = m.weekly[w];
    if (!tbl) continue;
    const v = tbl[playerId] || 0;
    t += weightMap && weightMap[w] ? v * weightMap[w] : v;
  }
  return t;
}

function pName(m, id) { return (m.meta[id] && m.meta[id].n) || id; }
function pPos(m, id) { return (m.meta[id] && m.meta[id].pos) || ''; }
function pTeam(m, id) { return (m.meta[id] && m.meta[id].tm) || ''; }
function pInj(m, id) { return (m.meta[id] && m.meta[id].inj) || ''; }

/**
 * A player's NFL game in a given week: {o: opponent, d: 'yyyy-MM-dd'}, or null
 * when his team has no game that week (a bye) or the week is not loaded.
 */
function pGame(m, id, week) {
  const tm = pTeam(m, id);
  // The season schedule, when it has been loaded, covers every week. The
  // projection feed only knows the weeks that were downloaded.
  const a = m.nfl && m.nfl[week];
  if (a && a[tm]) return a[tm];
  const s = m.sched[week];
  return (s && s[tm]) || null;
}

/** Label like "Josh Allen (BUF QB)" with an injury tag when relevant. */
function pLabel(m, id) {
  const inj = pInj(m, id);
  return pName(m, id) + ' (' + pTeam(m, id) + ' ' + pPos(m, id) + ')' +
    (inj ? ' [' + inj + ']' : '');
}

/**
 * The week a player's team is on bye, inferred from the projection feed:
 * the one week in the regular season with no projection for anyone on
 * that team. No hardcoded bye table to go stale.
 */
function inferByeWeeks(m) {
  const byTeamWeek = {};
  for (const w in m.weekly) {
    const tbl = m.weekly[w];
    for (const id in tbl) {
      const tm = pTeam(m, id);
      if (!tm) continue;
      if (!byTeamWeek[tm]) byTeamWeek[tm] = {};
      byTeamWeek[tm][w] = true;
    }
  }
  const loaded = Object.keys(m.weekly).map(Number).sort((a, b) => a - b);
  const bye = {};
  for (const tm in byTeamWeek) {
    for (let i = 0; i < loaded.length; i++) {
      if (!byTeamWeek[tm][loaded[i]]) { bye[tm] = loaded[i]; break; }
    }
  }
  return bye;
}
