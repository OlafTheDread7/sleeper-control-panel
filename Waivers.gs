/**
 * Waivers.gs — finds free agents worth a roster spot.
 *
 * Raw projection rank is the easy part and the least useful. What decides
 * whether a pickup is worth doing is the NET change to your lineup once you
 * account for who you would have to drop — and once you account for the fact
 * that you could have streamed someone at that position anyway.
 *
 * So each candidate is scored as: your optimal lineup with them added and your
 * most expendable piece removed, minus your optimal lineup today, both
 * measured against streaming replacement level. A player who is merely as good
 * as what is always available on the wire correctly scores near zero.
 *
 * Trending-add counts ride along as a separate signal. They are not a ranking
 * input — they are a warning about how long a name will stay available.
 */

function findWaiverTargets(m) {
  const H = buildHorizon_(m);
  const weeks = H.weeks, wmap = H.weightMap, ordered = H.ordered, repl = H.repl;

  const me = m.me;
  if (!me) throw new Error('Could not identify your roster. Run First-time setup.');

  // Availability signal.
  const trend = {};
  try {
    apiTrending('add', 48, 200).forEach(t => { trend[t.player_id] = t.count; });
  } catch (e) { /* non-fatal */ }

  // Candidate pool: anyone with a projection who is not on a roster.
  const seen = {};
  const pool = [];
  weeks.forEach(w => {
    const tbl = m.weekly[w] || {};
    for (const id in tbl) {
      if (seen[id]) continue;
      seen[id] = true;
      if (m.rosteredIds[id]) continue;
      pool.push(id);
    }
  });

  const minRos = Number(cfg('WAIVER_MIN_ROS'));
  const target = targetPosition();
  const scoredPool = pool
    .filter(id => !target || pPos(m, id) === target)
    .map(id => ({ id: id, ros: playerTotal(m, id, weeks, wmap) }))
    .filter(x => x.ros >= minRos)
    .sort((a, b) => b.ros - a.ros)
    .slice(0, 120);

  // My most expendable pieces.
  const dropCandidates = me.players.slice()
    .sort((a, b) => playerTotal(m, a, weeks, wmap) - playerTotal(m, b, weeks, wmap))
    .slice(0, 6);

  const prep = {};
  let baseTotal = 0;
  weeks.forEach(w => {
    prep[w] = prepBuckets_(m, me.players, w);
    baseTotal += fillFromBuckets_(prep[w], ordered, repl[w]) * (wmap[w] || 1);
  });

  const out = [];
  scoredPool.forEach(cand => {
    let bestNet = -Infinity, bestDrop = null;
    dropCandidates.forEach(dropId => {
      let t = 0;
      for (let i = 0; i < weeks.length; i++) {
        const w = weeks[i];
        t += scoreSwap_(m, prep[w], w, [dropId], [cand.id], ordered, repl[w]) * (wmap[w] || 1);
      }
      const net = t - baseTotal;
      if (net > bestNet) { bestNet = net; bestDrop = dropId; }
    });

    out.push({
      id: cand.id,
      ros: cand.ros,
      net: bestNet,
      drop: bestDrop,
      trend: trend[cand.id] || 0
    });
  });

  out.sort((a, b) => b.net - a.net || b.ros - a.ros);
  return out.slice(0, Number(cfg('WAIVER_MAX_RESULTS')));
}

/**
 * Replacement level as a readable table — what a free agent is actually worth
 * at each position. Useful context: it is the number that decides whether
 * roster depth at a position is valuable or a waste of a spot.
 */
function replacementSummary(m) {
  const H = buildHorizon_(m);
  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
  return positions.map(pos => {
    let sum = 0, n = 0;
    H.weeks.forEach(w => {
      const v = (H.repl[w] || {})[pos];
      if (v) { sum += v; n++; }
    });
    return { pos: pos, perWeek: n ? sum / n : 0 };
  });
}
