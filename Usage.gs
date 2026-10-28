/**
 * Usage.gs — the usage score: what a player is worth this week, built from
 * what he has actually been given rather than from anyone's projection.
 *
 * Sleeper publishes two feeds. One is projections. The other is what really
 * happened: targets, red-zone targets, carries, red-zone carries, pass
 * attempts and snaps, for every player and every team, every week. This file
 * uses only the second.
 *
 * The score is assembled in four steps, and each one is shown on the sheet so
 * a number can always be traced back to the reason for it.
 *
 * 1. ROLE — how much of his offense runs through him.
 *    Target share, carry share and their red-zone versions, over the games he
 *    played, with recent games weighted more. Shares are multiplied by his own
 *    team's volume to get expected targets and carries, and those are valued
 *    at what a target or a carry has been worth to his position across the
 *    league this season, in YOUR scoring. Touchdowns are not taken from his
 *    touchdown total, which is mostly noise over a month. They come from his
 *    red-zone work, valued at the rate red-zone chances have actually turned
 *    into scores league-wide. A light, heavily damped adjustment covers how
 *    efficient he has been with his chances.
 *
 * 2. OPPONENT VOLUME — the scheme proxy.
 *    How many targets this week's defense allows to his position, how many
 *    carries it allows to backs, how many pass attempts it faces, against the
 *    league average. This is where a run funnel or a defense that leaks
 *    targets to tight ends shows up. Real coverage and blitz data is not free,
 *    so this is the honest substitute: what offenses end up doing against it.
 *
 * 3. OPPONENT EFFICIENCY — how soft it is per chance.
 *    Points allowed per target to his position, per carry to backs, per pass
 *    attempt to quarterbacks, against the league average. Kept separate from
 *    volume on purpose, so a defense that is thrown on a lot is not counted
 *    twice.
 *
 * 4. WEATHER — wind, rain, cold, for outdoor games. See Weather.gs.
 *
 * Every opponent number is pulled toward the league average in proportion to
 * how little data there is behind it, and capped, because four games is not
 * much. None of it is adjusted for the quality of the offenses a defense has
 * faced.
 *
 * WHAT THIS CANNOT SEE. A role that changes this week — a starter ruled out
 * ahead of him, a player back from injury, a trade — is not in last month's
 * shares. The Games and Trend columns are there to flag thin or shifting
 * roles. That judgment stays with you.
 */

const USAGE = {
  // Games of league-average data mixed into each estimate. Higher = slower to
  // believe a small sample. A defense's first month is especially noisy, so
  // its numbers are held closest to average.
  SHRINK_TEAM_GAMES: 3,
  SHRINK_DEF_GAMES: 5,
  SHRINK_KDEF_GAMES: 3,

  // Caps on the opponent adjustments, as multipliers.
  VOLUME_CLAMP: [0.85, 1.15],
  DEF_CLAMP: [0.80, 1.25],
  DST_OPP_CLAMP: [0.70, 1.40],

  // Player efficiency: how many points of league-average production are mixed
  // in before his own efficiency is believed, and the cap on the result.
  EFF_PRIOR_PTS: { rec: 25, rush: 20, pass: 40 },
  EFF_CLAMP: [0.80, 1.30],

  // A share change of this size between the last game and the games before
  // it is marked as a trend.
  TREND_STEP: 0.04,

  // Injury designations that mean "will not play".
  OUT: ['Out', 'IR', 'PUP', 'Sus', 'NA', 'Doubtful', 'DNR', 'COV', 'NFI']
};

const SKILL = ['QB', 'RB', 'WR', 'TE'];

// Compact stat row layout (arrays keep the cached payload small).
const U = {
  POS: 0, TEAM: 1, OPP: 2, SNP: 3, TSNP: 4,
  TGT: 5, RZTGT: 6, CAR: 7, RZCAR: 8, ATT: 9, RZATT: 10,
  REC_N: 11, REC_T: 12, RUSH_N: 13, RUSH_T: 14, PASS_N: 15, PASS_T: 16, TOTAL: 17
};

function statsUrl_(season, week) {
  const qs = PROJ_POSITIONS.map(p => 'position[]=' + p).join('&');
  return API + '/stats/nfl/' + season + '/' + week + '?season_type=regular&' + qs;
}

/**
 * Splits one stat line into receiving, rushing and passing points in league
 * scoring, each divided into the part that comes from scoring plays and the
 * part that does not.
 */
function splitPoints_(st, scoring) {
  const out = { recN: 0, recT: 0, rushN: 0, rushT: 0, passN: 0, passT: 0 };
  for (const key in scoring) {
    const w = scoring[key];
    if (!w) continue;
    const v = st[key];
    if (v === undefined || v === null) continue;
    const pts = v * w;

    let group = '';
    if (key === 'rec' || key.indexOf('rec_') === 0 || key.indexOf('bonus_rec') === 0) group = 'rec';
    else if (key.indexOf('rush_rec') === 0 || key.indexOf('bonus_rush_rec') === 0) group = '';
    else if (key.indexOf('rush_') === 0 || key.indexOf('bonus_rush') === 0) group = 'rush';
    else if (key.indexOf('pass_') === 0 || key.indexOf('bonus_pass') === 0) group = 'pass';
    if (!group) continue;

    // An interception returned for a score is not a scoring play for the passer.
    const scoringPlay = key !== 'pass_int_td' &&
      (key.indexOf('_td') >= 0 || key.indexOf('_2pt') >= 0);
    out[group + (scoringPlay ? 'T' : 'N')] += pts;
  }
  return out;
}

function round2_(x) { return Math.round(x * 100) / 100; }

/** Downloads one completed week of real stats and reduces it to compact rows. */
function fetchWeekStats_(season, week, scoring) {
  const raw = httpJson_(statsUrl_(season, week));
  const rows = {};
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const st = r.stats || {};
    const p = r.player || {};
    const pos = p.position === 'FB' ? 'RB' : p.position;
    if (PROJ_POSITIONS.indexOf(pos) === -1) continue;
    if (!r.team) continue;

    const played = st.gp || st.gms_active || st.off_snp || st.st_snp || st.def_snp || pos === 'DEF';
    if (!played) continue;

    const s = splitPoints_(st, scoring);
    rows[r.player_id] = [
      pos, r.team, r.opponent || '',
      st.off_snp || 0, st.tm_off_snp || 0,
      st.rec_tgt || 0, st.rec_rz_tgt || 0,
      st.rush_att || 0, st.rush_rz_att || 0,
      st.pass_att || 0, st.pass_rz_att || 0,
      round2_(s.recN), round2_(s.recT), round2_(s.rushN), round2_(s.rushT),
      round2_(s.passN), round2_(s.passT),
      round2_(scoreStats(st, scoring))
    ];
  }
  return rows;
}

/** Cached wrapper. A completed week never changes, so it is kept the maximum. */
function getWeekStats(season, week, scoring, scoringKey) {
  const key = 'u1_' + season + '_' + week + '_' + scoringKey;
  const cached = cacheGetJson_(key);
  if (cached) return cached;
  const data = fetchWeekStats_(season, week, scoring);
  // An empty week (not played yet) is not worth remembering.
  if (Object.keys(data).length > 50) cachePutJson_(key, data, 21600);
  return data;
}

/**
 * The NFL schedule: week -> team -> {o: opponent, d: 'yyyy-MM-dd', h: home?}.
 * One small call covers the season.
 */
function nflSchedule_(m) {
  if (m.nfl) return m.nfl;
  const key = 'sch1_' + m.season;
  let games = cacheGetJson_(key);
  if (!games) {
    try {
      games = httpJson_(API + '/schedule/nfl/regular/' + m.season);
      cachePutJson_(key, games, 21600);
    } catch (e) { games = []; }
  }
  const out = {};
  (games || []).forEach(g => {
    if (!g.home || !g.away) return;
    const w = out[g.week] = out[g.week] || {};
    w[g.home] = { o: g.away, d: g.date || '', h: true };
    w[g.away] = { o: g.home, d: g.date || '', h: false };
  });
  m.nfl = out;
  return out;
}

function clamp_(x, range) { return Math.min(Math.max(x, range[0]), range[1]); }

/**
 * Least-squares fit of  y = a*x1 + b*x2  through the origin, from running
 * sums. Used to learn what a red-zone chance and an ordinary chance have each
 * been worth in scoring-play points. Falls back to one pooled rate when the
 * two cannot be told apart.
 */
function fitTwo_(s) {
  const det = s.x11 * s.x22 - s.x12 * s.x12;
  const pooled = (s.x1 + s.x2) > 0 ? s.y / (s.x1 + s.x2) : 0;
  if (Math.abs(det) < 1e-9) return { a: pooled, b: pooled };
  let a = (s.x1y * s.x22 - s.x2y * s.x12) / det;
  let b = (s.x2y * s.x11 - s.x1y * s.x12) / det;
  if (a < 0 || b < 0) return { a: pooled, b: pooled };
  return { a: a, b: b };
}

function newFit_() { return { x11: 0, x22: 0, x12: 0, x1y: 0, x2y: 0, x1: 0, x2: 0, y: 0 }; }

function addFit_(s, x1, x2, y) {
  s.x11 += x1 * x1; s.x22 += x2 * x2; s.x12 += x1 * x2;
  s.x1y += x1 * y; s.x2y += x2 * y; s.x1 += x1; s.x2 += x2; s.y += y;
}

/**
 * Builds the usage score for one target week from a set of earlier weeks.
 *
 * It takes its history as an argument, rather than always using "everything
 * so far", so the same code can be run as it would have run in an earlier
 * week. That is how the score is checked against what then happened.
 *
 * @param {Object} rowsByWeek  week -> {player_id: compact row}
 * @param {Array<number>} hist  the weeks to learn from, all before `week`
 * @param {Object} ctx  { sched, teamOf(id, latestTeam), status(id), weather }
 * @return {{score: Object, f: Object, weeks: Array<number>}}
 */
function buildUsage_(m, week, rowsByWeek, hist, ctx) {
  const decay = Math.min(Math.max(Number(cfg('USAGE_RECENCY')) || 0.75, 0.1), 1);
  const lastWeek = Math.max.apply(null, hist);
  const wt = w => Math.pow(decay, lastWeek - w);

  // ---- pass 1: team totals, what each defense allowed, league baselines
  const teamWeek = {};   // team -> week -> opportunity totals
  const allow = {};      // defense -> week -> what it gave up
  const base = {};       // position -> league baselines
  SKILL.forEach(p => {
    base[p] = { tgt: 0, recN: 0, car: 0, rushN: 0, att: 0, passN: 0,
      recTd: newFit_(), rushTd: newFit_(), passTd: newFit_() };
  });
  const kdef = { K: { pts: 0, n: 0 }, DEF: { pts: 0, n: 0 } };
  const byPlayer = {};

  const zeroAllow = () => ({
    tgt: { RB: 0, WR: 0, TE: 0 }, rec: { RB: 0, WR: 0, TE: 0 },
    rbCar: 0, rbRush: 0, att: 0, pass: 0, K: 0, DEF: 0
  });

  hist.forEach(w => {
    const rows = rowsByWeek[w] || {};
    for (const id in rows) {
      const r = rows[id];
      const pos = r[U.POS], team = r[U.TEAM], opp = r[U.OPP];

      const tw = teamWeek[team] = teamWeek[team] || {};
      const T = tw[w] = tw[w] || { tgt: 0, rzTgt: 0, car: 0, rzCar: 0, att: 0, rzAtt: 0 };
      T.tgt += r[U.TGT]; T.rzTgt += r[U.RZTGT];
      T.car += r[U.CAR]; T.rzCar += r[U.RZCAR];
      T.att += r[U.ATT]; T.rzAtt += r[U.RZATT];

      if (opp) {
        const aw = allow[opp] = allow[opp] || {};
        const A = aw[w] = aw[w] || zeroAllow();
        if (pos === 'RB' || pos === 'WR' || pos === 'TE') {
          A.tgt[pos] += r[U.TGT];
          A.rec[pos] += r[U.REC_N] + r[U.REC_T];
        }
        if (pos === 'RB') { A.rbCar += r[U.CAR]; A.rbRush += r[U.RUSH_N] + r[U.RUSH_T]; }
        if (pos === 'QB') { A.att += r[U.ATT]; A.pass += r[U.PASS_N] + r[U.PASS_T]; }
        if (pos === 'K') A.K += r[U.TOTAL];
        if (pos === 'DEF') A.DEF += r[U.TOTAL];
      }

      if (base[pos]) {
        const b = base[pos];
        b.tgt += r[U.TGT]; b.recN += r[U.REC_N];
        b.car += r[U.CAR]; b.rushN += r[U.RUSH_N];
        b.att += r[U.ATT]; b.passN += r[U.PASS_N];
        if (r[U.TGT]) addFit_(b.recTd, r[U.RZTGT], r[U.TGT] - r[U.RZTGT], r[U.REC_T]);
        if (r[U.CAR]) addFit_(b.rushTd, r[U.RZCAR], r[U.CAR] - r[U.RZCAR], r[U.RUSH_T]);
        if (r[U.ATT]) addFit_(b.passTd, r[U.RZATT], r[U.ATT] - r[U.RZATT], r[U.PASS_T]);
      } else if (kdef[pos]) {
        kdef[pos].pts += r[U.TOTAL]; kdef[pos].n++;
      }

      (byPlayer[id] = byPlayer[id] || []).push({ w: w, r: r });
    }
  });

  // League rates: what one chance has been worth, by position.
  const rate = {};
  SKILL.forEach(p => {
    const b = base[p];
    rate[p] = {
      perTgt: b.tgt ? b.recN / b.tgt : 0,
      perCar: b.car ? b.rushN / b.car : 0,
      perAtt: b.att ? b.passN / b.att : 0,
      recTd: fitTwo_(b.recTd), rushTd: fitTwo_(b.rushTd), passTd: fitTwo_(b.passTd)
    };
  });

  // League averages per team-game.
  let teamGames = 0;
  const lgTeam = { tgt: 0, rzTgt: 0, car: 0, rzCar: 0, att: 0, rzAtt: 0 };
  for (const t in teamWeek) for (const w in teamWeek[t]) {
    teamGames++;
    for (const k in lgTeam) lgTeam[k] += teamWeek[t][w][k];
  }
  if (!teamGames) return { score: {}, f: {}, weeks: hist };
  for (const k in lgTeam) lgTeam[k] /= teamGames;

  let defGames = 0;
  const lgAllow = zeroAllow();
  for (const d in allow) for (const w in allow[d]) {
    defGames++;
    const A = allow[d][w];
    ['RB', 'WR', 'TE'].forEach(p => { lgAllow.tgt[p] += A.tgt[p]; lgAllow.rec[p] += A.rec[p]; });
    ['rbCar', 'rbRush', 'att', 'pass', 'K', 'DEF'].forEach(k => { lgAllow[k] += A[k]; });
  }
  const dg = Math.max(defGames, 1);
  ['RB', 'WR', 'TE'].forEach(p => { lgAllow.tgt[p] /= dg; lgAllow.rec[p] /= dg; });
  ['rbCar', 'rbRush', 'att', 'pass', 'K', 'DEF'].forEach(k => { lgAllow[k] /= dg; });

  // ---- team volume: recency-weighted, pulled toward the league average
  function teamVolume(team) {
    const tw = teamWeek[team] || {};
    const k = USAGE.SHRINK_TEAM_GAMES;
    const sum = { tgt: 0, rzTgt: 0, car: 0, rzCar: 0, att: 0, rzAtt: 0 };
    let n = 0;
    for (const w in tw) {
      const x = wt(Number(w));
      n += x;
      for (const key in sum) sum[key] += x * tw[w][key];
    }
    const out = {};
    for (const key in sum) out[key] = (sum[key] + k * lgTeam[key]) / (n + k);
    return out;
  }

  // ---- what a defense does to volume and to efficiency, as multipliers
  const defCache = {};
  function defense(opp) {
    if (defCache[opp]) return defCache[opp];
    const aw = allow[opp] || {};
    const k = USAGE.SHRINK_DEF_GAMES;
    const tot = zeroAllow();
    let n = 0;
    for (const w in aw) {
      n++;
      const A = aw[w];
      ['RB', 'WR', 'TE'].forEach(p => { tot.tgt[p] += A.tgt[p]; tot.rec[p] += A.rec[p]; });
      ['rbCar', 'rbRush', 'att', 'pass', 'K', 'DEF'].forEach(key => { tot[key] += A[key]; });
    }
    // Volume allowed per game against the league average.
    const vol = (allowed, lg) => lg > 0
      ? clamp_(((allowed + k * lg) / (n + k)) / lg, USAGE.VOLUME_CLAMP) : 1;
    // Points allowed per chance against the league rate. The prior is k
    // games' worth of league-average chances at the league rate.
    const eff = (pts, chances, lgPts, lgChances) => {
      if (!(lgChances > 0 && lgPts > 0)) return 1;
      const lgRate = lgPts / lgChances;
      const r = (pts + k * lgPts) / (chances + k * lgChances);
      return clamp_(r / lgRate, USAGE.DEF_CLAMP);
    };
    const out = { n: n, volTgt: {}, effRec: {} };
    ['RB', 'WR', 'TE'].forEach(p => {
      out.volTgt[p] = vol(tot.tgt[p], lgAllow.tgt[p]);
      out.effRec[p] = eff(tot.rec[p], tot.tgt[p], lgAllow.rec[p], lgAllow.tgt[p]);
    });
    out.volCar = vol(tot.rbCar, lgAllow.rbCar);
    out.effRush = eff(tot.rbRush, tot.rbCar, lgAllow.rbRush, lgAllow.rbCar);
    out.volAtt = vol(tot.att, lgAllow.att);
    out.effPass = eff(tot.pass, tot.att, lgAllow.pass, lgAllow.att);
    const kk = USAGE.SHRINK_KDEF_GAMES;
    out.kick = lgAllow.K > 0
      ? clamp_(((tot.K + kk * lgAllow.K) / (n + kk)) / lgAllow.K, USAGE.VOLUME_CLAMP) : 1;
    out.dst = lgAllow.DEF > 0
      ? clamp_(((tot.DEF + kk * lgAllow.DEF) / (n + kk)) / lgAllow.DEF, USAGE.DST_OPP_CLAMP) : 1;
    defCache[opp] = out;
    return out;
  }

  // ---- players
  const sched = ctx.sched || {};
  const score = {}, factors = {};

  for (const id in byPlayer) {
    const games = byPlayer[id];
    const latest = games[games.length - 1].r;
    const pos = latest[U.POS];
    const team = ctx.teamOf ? (ctx.teamOf(id, latest[U.TEAM]) || latest[U.TEAM]) : latest[U.TEAM];
    const g = sched[team];
    const status = ctx.status ? (ctx.status(id) || '') : '';

    const f = factors[id] = { pos: pos, g: games.length, opp: g ? g.o : '', status: status };

    if (!g) { f.note = 'Bye'; score[id] = 0; continue; }
    if (USAGE.OUT.indexOf(status) >= 0) { f.note = status; score[id] = 0; continue; }

    const D = defense(g.o);
    const wx = (ctx.weather && ctx.weather[team]) || null;
    const wxPass = wx ? wx.pass : 1;
    const wxKick = wx ? wx.kick : 1;
    f.wx = wx ? wx.txt : '';

    // ---- kickers and team defenses: points per game, then the opponent
    if (pos === 'K' || pos === 'DEF') {
      const lg = kdef[pos].n ? kdef[pos].pts / kdef[pos].n : 0;
      let sum = 0, n = 0;
      games.forEach(x => { const v = wt(x.w); sum += v * x.r[U.TOTAL]; n += v; });
      const k = USAGE.SHRINK_KDEF_GAMES;
      const role = (sum + k * lg) / (n + k);
      const s2 = role * (pos === 'K' ? D.kick : D.dst);
      const s3 = pos === 'K' ? s2 * wxKick : s2;
      f.role = role; f.vol = 1; f.def = role ? s2 / role : 1; f.wxm = s2 ? s3 / s2 : 1;
      score[id] = round2_(s3);
      continue;
    }

    // ---- skill players: shares over the games he played
    let wTgt = 0, wTmTgt = 0, wRz = 0, wTmRz = 0, wCar = 0, wTmCar = 0, wRzCar = 0, wTmRzCar = 0;
    let wAtt = 0, wTmAtt = 0, wRzAtt = 0, wTmRzAtt = 0, wSnp = 0, wTmSnp = 0;
    let recN = 0, tgt = 0, rushN = 0, car = 0, passN = 0, att = 0;
    const perGame = [];
    games.forEach(x => {
      const r = x.r, v = wt(x.w);
      const T = (teamWeek[r[U.TEAM]] || {})[x.w];
      if (!T) return;
      wTgt += v * r[U.TGT]; wTmTgt += v * T.tgt;
      wRz += v * r[U.RZTGT]; wTmRz += v * T.rzTgt;
      wCar += v * r[U.CAR]; wTmCar += v * T.car;
      wRzCar += v * r[U.RZCAR]; wTmRzCar += v * T.rzCar;
      wAtt += v * r[U.ATT]; wTmAtt += v * T.att;
      wRzAtt += v * r[U.RZATT]; wTmRzAtt += v * T.rzAtt;
      wSnp += v * r[U.SNP]; wTmSnp += v * r[U.TSNP];
      recN += r[U.REC_N]; tgt += r[U.TGT];
      rushN += r[U.RUSH_N]; car += r[U.CAR];
      passN += r[U.PASS_N]; att += r[U.ATT];
      perGame.push((T.tgt ? r[U.TGT] / T.tgt : 0) + (T.car ? r[U.CAR] / T.car : 0));
    });
    const share = (a, b) => b > 0 ? a / b : 0;
    const sh = {
      tgt: share(wTgt, wTmTgt), rzTgt: share(wRz, wTmRz),
      car: share(wCar, wTmCar), rzCar: share(wRzCar, wTmRzCar),
      att: share(wAtt, wTmAtt), rzAtt: share(wRzAtt, wTmRzAtt),
      snp: share(wSnp, wTmSnp)
    };

    // Has the role moved? Last game against the games before it.
    f.trend = 0;
    if (perGame.length >= 2) {
      const lastShare = perGame[perGame.length - 1];
      const before = perGame.slice(0, -1).reduce((s, x) => s + x, 0) / (perGame.length - 1);
      if (lastShare - before > USAGE.TREND_STEP) f.trend = 1;
      else if (before - lastShare > USAGE.TREND_STEP) f.trend = -1;
    }

    const V = teamVolume(team);
    const R = rate[pos];

    // Efficiency with his chances, damped toward the league rate.
    const eff = (actual, expected, prior) =>
      clamp_((actual + prior) / (expected + prior), USAGE.EFF_CLAMP);
    const effRec = eff(recN, tgt * R.perTgt, USAGE.EFF_PRIOR_PTS.rec);
    const effRush = eff(rushN, car * R.perCar, USAGE.EFF_PRIOR_PTS.rush);
    const effPass = eff(passN, att * R.perAtt, USAGE.EFF_PRIOR_PTS.pass);

    // Expected chances at his own team's volume.
    const xTgt = sh.tgt * V.tgt, xRzTgt = Math.min(sh.rzTgt * V.rzTgt, xTgt);
    const xCar = sh.car * V.car, xRzCar = Math.min(sh.rzCar * V.rzCar, xCar);
    const xAtt = sh.att * V.att, xRzAtt = Math.min(sh.rzAtt * V.rzAtt, xAtt);

    const rec0 = xTgt * R.perTgt * effRec + R.recTd.a * xRzTgt + R.recTd.b * (xTgt - xRzTgt);
    const rush0 = xCar * R.perCar * effRush + R.rushTd.a * xRzCar + R.rushTd.b * (xCar - xRzCar);
    const pass0 = xAtt * R.perAtt * effPass + R.passTd.a * xRzAtt + R.passTd.b * (xAtt - xRzAtt);

    const volRec = pos === 'QB' ? 1 : (D.volTgt[pos] || 1);
    const effDefRec = pos === 'QB' ? 1 : (D.effRec[pos] || 1);

    const s0 = rec0 + rush0 + pass0;
    const s1 = rec0 * volRec + rush0 * D.volCar + pass0 * D.volAtt;
    const s2 = rec0 * volRec * effDefRec + rush0 * D.volCar * D.effRush + pass0 * D.volAtt * D.effPass;
    const s3 = rec0 * volRec * effDefRec * wxPass + rush0 * D.volCar * D.effRush +
      pass0 * D.volAtt * D.effPass * wxPass;

    f.tgt = sh.tgt; f.car = sh.car; f.snp = sh.snp;
    f.rz = pos === 'QB' ? sh.rzAtt : Math.max(sh.rzTgt, sh.rzCar);
    f.att = sh.att;
    f.xTgt = xTgt * volRec; f.xCar = xCar * D.volCar; f.xAtt = xAtt * D.volAtt;
    f.role = s0;
    f.vol = s0 ? s1 / s0 : 1;
    f.def = s1 ? s2 / s1 : 1;
    f.wxm = s2 ? s3 / s2 : 1;
    score[id] = round2_(s3);
  }

  return { score: score, f: factors, weeks: hist };
}

/**
 * Loads the usage score for the current week into the model.
 *
 * In week 1 there is nothing to learn from yet, so the panel falls back to
 * Sleeper's projections and says so on the sheet.
 */
function loadUsage(m) {
  if (m.usage) return m.usage;
  loadWeeks(m, [m.week]);   // names, positions, current teams, injury status
  const schedule = nflSchedule_(m);

  const last = m.week - 1;
  const span = Math.max(1, Math.round(Number(cfg('USAGE_WEEKS')) || 6));
  const first = Math.max(1, last - span + 1);

  const rows = {};
  const hist = [];
  for (let w = first; w <= last; w++) {
    try {
      const data = getWeekStats(m.season, w, m.scoring, m.scoringKey);
      if (Object.keys(data).length > 50) { rows[w] = data; hist.push(w); }
    } catch (e) { /* a missing week just shortens the history */ }
  }

  if (!hist.length) {
    m.usage = { score: m.weekly[m.week] || {}, f: {}, weeks: [], rows: {}, fallback: true };
    return m.usage;
  }

  const sched = schedule[m.week] || m.sched[m.week] || {};
  const weatherOn = String(cfg('USE_WEATHER')).toUpperCase() !== 'FALSE';
  let weather = null;
  if (weatherOn) {
    try { weather = gameWeather(m, m.week); } catch (e) { weather = null; }
  }

  const out = buildUsage_(m, m.week, rows, hist, {
    sched: sched,
    weather: weather,
    teamOf: (id, latestTeam) => pTeam(m, id) || latestTeam,
    status: id => pInj(m, id)
  });
  out.rows = rows;
  out.fallback = false;
  out.weatherOn = weatherOn;
  out.weatherLoaded = !!weather;
  m.usage = out;
  return out;
}

/** The table start/sit decisions are made from: player_id -> points. */
function usageScores(m) { return loadUsage(m).score; }

/**
 * The usage score as it would have been before an earlier week, using only
 * the weeks before that one. No injury report and no weather: neither is
 * recoverable after the fact. Returns null when there is no earlier week.
 */
function usageAsOf_(m, week) {
  const u = loadUsage(m);
  if (u.fallback) return null;
  const hist = u.weeks.filter(w => w < week);
  if (!hist.length) return null;
  const played = u.rows[week] || {};
  return buildUsage_(m, week, u.rows, hist, {
    sched: nflSchedule_(m)[week] || {},
    weather: null,
    teamOf: (id, latestTeam) => (played[id] ? played[id][U.TEAM] : latestTeam),
    status: null
  });
}

/**
 * Menu item: how well has the usage score called it so far?
 *
 * For each completed week it rebuilds the score from the weeks before, then
 * compares it — and Sleeper's projection for the same week — with what the
 * league's starters actually scored. Lower average miss is better.
 */
function verifyUsageScore() {
  const m = buildModel();
  const r = backtestUsage_(m);
  const ui = SpreadsheetApp.getUi();
  if (!r.n) {
    ui.alert('Usage score check', 'Not enough completed weeks yet. Two are needed.', ui.ButtonSet.OK);
    return;
  }
  const line = x => x.label + ':  usage misses by ' + x.usageMae.toFixed(1) +
    ' pts,  Sleeper projection by ' + x.projMae.toFixed(1) + '   (' + x.n + ' starts)';
  const msg = 'Every lineup start in this league, weeks ' + r.weeks.join(', ') + '.\n' +
    'Average miss against what the player actually scored:\n\n' +
    r.rows.map(line).join('\n') + '\n\n' +
    'The usage score for each week was built only from the weeks before it, ' +
    'with no injury report and no weather. Early in the season it is working ' +
    'from very few games.';
  ui.alert('Usage score check', msg, ui.ButtonSet.OK);
}

function backtestUsage_(m) {
  const u = loadUsage(m);
  const acc = {};
  const add = (label, usage, proj, actual) => {
    const a = acc[label] = acc[label] || { label: label, n: 0, u: 0, p: 0 };
    a.n++; a.u += Math.abs(usage - actual); a.p += Math.abs(proj - actual);
  };
  const weeks = [];
  if (!u.fallback) {
    u.weeks.forEach(w => {
      const as = usageAsOf_(m, w);
      if (!as) return;
      let matchups, proj;
      try {
        matchups = apiMatchups(m.leagueId, w);
        proj = getWeekProjections(m.season, w, m.scoring, m.scoringKey, 21600).scores;
      } catch (e) { return; }
      weeks.push(w);
      (matchups || []).forEach(row => {
        const pp = row.players_points || {};
        (row.starters || []).forEach(id => {
          if (!id || id === '0') return;
          const played = u.rows[w][id];
          if (!played) return;   // did not play: neither number was a real call
          const actual = Number(pp[id]) || 0;
          const pos = played[U.POS];
          add('All', as.score[id] || 0, proj[id] || 0, actual);
          add(pos, as.score[id] || 0, proj[id] || 0, actual);
        });
      });
    });
  }
  const order = ['All', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  const rows = order.filter(k => acc[k]).map(k => ({
    label: k, n: acc[k].n, usageMae: acc[k].u / acc[k].n, projMae: acc[k].p / acc[k].n
  }));
  return { n: acc.All ? acc.All.n : 0, weeks: weeks, rows: rows };
}
