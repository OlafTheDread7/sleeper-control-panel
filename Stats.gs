/**
 * Stats.gs — league-wide measurement.
 *
 * Win/loss record is a poor description of a fantasy team, because roughly
 * half of it is the schedule. Three better numbers are computed here:
 *
 *   All-play record — your record if you had played every team every week.
 *     Removes schedule luck entirely. The best predictor of the rest of a
 *     season that a fantasy league produces.
 *
 *   Manager efficiency — points you actually scored divided by the most you
 *     could have scored with the roster you had. Measures start/sit decisions
 *     only, with roster quality divided out.
 *
 *   Luck — actual wins minus all-play expected wins. Positive means the
 *     schedule has been carrying you, and it will stop.
 *
 * All three use real scored results from the matchups endpoint, which already
 * returns points in league scoring, so no re-scoring is needed.
 */

function computeSeasonStats(m) {
  const lastCompleted = Math.max(0, m.week - 1);
  const ordered = slotOrder_(m.slots);

  const acc = {};
  m.teams.forEach(t => {
    acc[t.rosterId] = {
      team: t, allPlayW: 0, allPlayL: 0, allPlayT: 0,
      actual: 0, optimal: 0, weeks: 0, best: 0, worst: Infinity, scores: []
    };
  });

  for (let w = 1; w <= lastCompleted; w++) {
    let rows;
    try { rows = apiMatchups(m.leagueId, w); } catch (e) { continue; }
    if (!rows || !rows.length) continue;

    const weekScores = [];
    rows.forEach(r => {
      const a = acc[r.roster_id];
      if (!a) return;
      const pts = Number(r.points) || 0;
      if (!pts && !(r.players_points && Object.keys(r.players_points).length)) return;

      weekScores.push({ rosterId: r.roster_id, pts: pts });
      a.actual += pts;
      a.weeks++;
      a.scores.push(pts);
      if (pts > a.best) a.best = pts;
      if (pts < a.worst) a.worst = pts;

      // Best lineup that was available from the players on the roster that week.
      const pp = r.players_points || {};
      const ids = r.players || Object.keys(pp);
      const byPos = {};
      ids.forEach(id => {
        const pos = pPos(m, id);
        if (!pos) return;
        (byPos[pos] = byPos[pos] || []).push({ id: id, pts: Number(pp[id]) || 0 });
      });
      for (const p in byPos) byPos[p].sort((x, y) => y.pts - x.pts);
      a.optimal += fillFromBuckets_(byPos, ordered);
    });

    // All-play for this week
    weekScores.forEach(s => {
      weekScores.forEach(o => {
        if (s.rosterId === o.rosterId) return;
        if (s.pts > o.pts) acc[s.rosterId].allPlayW++;
        else if (s.pts < o.pts) acc[s.rosterId].allPlayL++;
        else acc[s.rosterId].allPlayT++;
      });
    });
  }

  const n = m.teams.length - 1;
  const results = m.teams.map(t => {
    const a = acc[t.rosterId];
    const games = a.allPlayW + a.allPlayL + a.allPlayT;
    const allPlayPct = games ? a.allPlayW / games : 0;
    const expWins = allPlayPct * a.weeks;
    const avg = a.weeks ? a.actual / a.weeks : 0;
    const variance = a.weeks
      ? a.scores.reduce((s, x) => s + Math.pow(x - avg, 2), 0) / a.weeks : 0;

    return {
      team: t,
      record: t.wins + '-' + t.losses + (t.ties ? '-' + t.ties : ''),
      wins: t.wins,
      pf: t.pf,
      pa: t.pa,
      avg: avg,
      stdev: Math.sqrt(variance),
      high: a.best || 0,
      low: a.worst === Infinity ? 0 : a.worst,
      allPlay: a.allPlayW + '-' + a.allPlayL + (a.allPlayT ? '-' + a.allPlayT : ''),
      allPlayPct: allPlayPct,
      efficiency: a.optimal ? a.actual / a.optimal : 0,
      pointsLeftOnBench: a.optimal - a.actual,
      luck: t.wins - expWins
    };
  });

  results.sort((a, b) => b.allPlayPct - a.allPlayPct || b.pf - a.pf);
  return results;
}

/**
 * Rest-of-season projected strength by position for every team, counting only
 * the slots that actually start. This is the grid that makes trade fit obvious:
 * find a team long where you are short and short where you are long.
 */
function computePositionalMatrix(m) {
  const H = buildHorizon_(m);
  const weeks = H.weeks;
  const weightMap = H.weightMap;

  // How many of each position actually start, flex included at its own row.
  const counts = {};
  m.slots.forEach(s => { counts[s] = (counts[s] || 0) + 1; });

  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

  const rows = m.teams.map(t => {
    const byPos = {};
    positions.forEach(p => { byPos[p] = []; });
    t.players.forEach(id => {
      const pos = pPos(m, id);
      if (byPos[pos]) byPos[pos].push(playerTotal(m, id, weeks, weightMap));
    });
    const out = { team: t, values: {} };
    positions.forEach(p => {
      byPos[p].sort((a, b) => b - a);
      const starts = counts[p] || 0;
      // Value of the players who would actually start at this position.
      out.values[p] = byPos[p].slice(0, Math.max(starts, 1))
        .reduce((s, x) => s + x, 0);
      out.values[p + '_depth'] = byPos[p].length;
    });
    // Flex value: best remaining RB/WR/TE beyond the dedicated slots.
    const flexPool = [];
    ['RB', 'WR', 'TE'].forEach(p => {
      flexPool.push.apply(flexPool, byPos[p].slice(counts[p] || 0));
    });
    flexPool.sort((a, b) => b - a);
    out.values.FLEX = flexPool.slice(0, counts.FLEX || 0).reduce((s, x) => s + x, 0);
    out.values.BENCH = flexPool.slice(counts.FLEX || 0).reduce((s, x) => s + x, 0);
    return out;
  });

  // Rank within each column so the sheet can show "3rd of 12 at RB".
  const cols = positions.concat(['FLEX']);
  cols.forEach(p => {
    const sorted = rows.slice().sort((a, b) => b.values[p] - a.values[p]);
    sorted.forEach((r, i) => { r.values[p + '_rank'] = i + 1; });
  });

  return { rows: rows, positions: positions, counts: counts };
}

/**
 * Where you are strong and where you are thin, stated plainly.
 *
 * Total roster value hides shape. A team can be first in the league overall
 * and still be 9th at one position, because a deep bench at another position
 * covers the total. This is the view that makes that visible, and it also
 * answers the question that follows immediately: can the wire fix it, or does
 * it take a trade?
 */
function computeNeeds(m, matrix) {
  const H = buildHorizon_(m);
  const me = m.me;
  if (!me) return [];

  const myRow = matrix.rows.find(r => r.team.rosterId === me.rosterId);
  if (!myRow) return [];

  const n = matrix.rows.length;

  return matrix.positions.map(pos => {
    const vals = matrix.rows.map(r => r.values[pos]).sort((a, b) => b - a);
    const median = vals[Math.floor(n / 2)];
    const mine = myRow.values[pos];
    const rank = myRow.values[pos + '_rank'];

    // Best free agent at this position, and the weakest player you currently
    // rely on there — the two numbers that decide whether waivers can help.
    let bestFa = null, bestFaVal = 0;
    for (const id in m.meta) {
      if (m.rosteredIds[id]) continue;
      if (pPos(m, id) !== pos) continue;
      const v = playerTotal(m, id, H.weeks, H.weightMap);
      if (v > bestFaVal) { bestFaVal = v; bestFa = id; }
    }

    const mineAtPos = me.players.filter(id => pPos(m, id) === pos)
      .map(id => playerTotal(m, id, H.weeks, H.weightMap))
      .sort((a, b) => b - a);
    const starts = Math.max(matrix.counts[pos] || 0, 1);
    const weakestStarter = mineAtPos.length >= starts
      ? mineAtPos[starts - 1] : 0;

    return {
      pos: pos,
      value: mine,
      rank: rank,
      of: n,
      vsMedian: mine - median,
      bestFa: bestFa,
      bestFaValue: bestFaVal,
      weakestStarter: weakestStarter,
      waiverFixable: bestFaVal > weakestStarter
    };
  }).sort((a, b) => a.rank - b.rank).reverse();
}
