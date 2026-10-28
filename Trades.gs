/**
 * Trades.gs — win/win trade search.
 *
 * The metric is the one that actually matters: how much does each side's
 * OPTIMAL STARTING LINEUP improve, summed week by week to the end of the
 * fantasy playoffs, with unfillable slots credited at streaming replacement
 * level. That single measure captures everything a "trade value chart" misses —
 *
 *   - positional surplus (your WR5 is worth nothing to you and a lot to a team
 *     starting a replacement-level WR3)
 *   - scarcity that is real rather than assumed (if a startable QB is always
 *     sitting on waivers, a second QB scores as near-worthless, automatically)
 *   - bye weeks (a player on bye the week you already have a hole is worth
 *     less to you than to someone whose bye is clear)
 *   - roster shape (trading away your only starter at a position is punished
 *     by exactly the amount the downgrade costs, not by a rule of thumb)
 *   - playoff timing (weeks 15-17 are weighted up, because that is when the
 *     title is decided)
 *
 * A deal is only reported when BOTH sides come out ahead. Those are the ones
 * that get accepted.
 *
 * Performance: rather than rebuilding each roster for every candidate swap,
 * positions are bucketed and pre-sorted once per team per week, and a swap
 * rebuilds only the one or two buckets it touches.
 */

/**
 * Score a roster for one week after removing `outIds` and adding `innIds`,
 * touching only the position buckets that change.
 */
function scoreSwap_(m, base, week, outIds, innIds, orderedSlots, repl) {
  const tbl = m.weekly[week] || {};
  const touched = {};
  outIds.forEach(id => { const p = pPos(m, id); if (p) touched[p] = true; });
  innIds.forEach(id => { const p = pPos(m, id); if (p) touched[p] = true; });

  const view = {};
  for (const p in base) view[p] = base[p];

  for (const pos in touched) {
    const src = base[pos] || [];
    const next = [];
    for (let i = 0; i < src.length; i++) {
      if (outIds.indexOf(src[i].id) === -1) next.push(src[i]);
    }
    for (let i = 0; i < innIds.length; i++) {
      const id = innIds[i];
      if (pPos(m, id) !== pos) continue;
      const pts = tbl[id];
      if (!pts) continue;
      next.push({ id: id, pts: pts });
    }
    next.sort((a, b) => b.pts - a.pts);
    view[pos] = next;
  }
  return fillFromBuckets_(view, orderedSlots, repl);
}

function buildWeightMap_(m, weeks, playoffs, weight) {
  const map = {};
  weeks.forEach(w => { map[w] = 1; });
  playoffs.forEach(w => { map[w] = weight; });
  return map;
}

/** Shared horizon setup used by both the trade and waiver engines. */
function buildHorizon_(m) {
  const ros = rosWeeks(m);
  const po = playoffWeeks(m);
  const weeks = ros.concat(po);
  loadWeeks(m, weeks);
  return {
    ros: ros,
    po: po,
    weeks: weeks,
    weightMap: buildWeightMap_(m, ros, po, Number(cfg('PLAYOFF_WEIGHT')) || 1),
    repl: computeReplacementLevels(m, weeks),
    ordered: slotOrder_(m.slots)
  };
}

/** Main entry. Returns deals sorted by your gain. */
function findTrades(m) {
  const H = buildHorizon_(m);
  const weeks = H.weeks, wmap = H.weightMap, ordered = H.ordered, repl = H.repl;

  const me = m.me;
  if (!me) throw new Error('Could not identify your roster. Run First-time setup.');

  const rosterMax = m.league.roster_positions.length;
  const minGain = Number(cfg('TRADE_MIN_GAIN'));
  const do2for1 = String(cfg('TRADE_INCLUDE_2FOR1')).toUpperCase() !== 'FALSE';

  // Pre-bucket every team for every week once.
  const prep = {};
  const base = {};
  m.teams.forEach(t => {
    prep[t.rosterId] = {};
    let total = 0;
    weeks.forEach(w => {
      const b = prepBuckets_(m, t.players, w);
      prep[t.rosterId][w] = b;
      total += fillFromBuckets_(b, ordered, repl[w]) * (wmap[w] || 1);
    });
    base[t.rosterId] = total;
  });

  function evalDeal(theirTeam, myOut, theirOut) {
    let mine = 0, theirs = 0;
    for (let i = 0; i < weeks.length; i++) {
      const w = weeks[i];
      const wt = wmap[w] || 1;
      mine += scoreSwap_(m, prep[me.rosterId][w], w, myOut, theirOut, ordered, repl[w]) * wt;
      theirs += scoreSwap_(m, prep[theirTeam.rosterId][w], w, theirOut, myOut, ordered, repl[w]) * wt;
    }
    return { myGain: mine - base[me.rosterId], theirGain: theirs - base[theirTeam.rosterId] };
  }

  function ranked(ids) {
    return ids.slice().sort((a, b) =>
      playerTotal(m, b, weeks, wmap) - playerTotal(m, a, weeks, wmap));
  }

  const myRanked = ranked(me.players);
  const target = targetPosition();
  const deals = [];

  // When you are hunting a specific position, every deal must bring one back.
  function bringsIn(getIds) {
    if (!target) return true;
    for (let i = 0; i < getIds.length; i++) {
      if (pPos(m, getIds[i]) === target) return true;
    }
    return false;
  }

  m.teams.forEach(t => {
    if (t.rosterId === me.rosterId) return;
    const theirRanked = ranked(t.players);
    // For 1-for-1 there is only one incoming player, so the filter can be
    // applied up front — which also cuts the search.
    const theirForSingle = target
      ? theirRanked.filter(id => pPos(m, id) === target)
      : theirRanked;

    // ---- 1-for-1, exhaustive
    for (let i = 0; i < myRanked.length; i++) {
      for (let j = 0; j < theirForSingle.length; j++) {
        const r = evalDeal(t, [myRanked[i]], [theirForSingle[j]]);
        if (r.myGain >= minGain && r.theirGain >= minGain) {
          deals.push({
            partner: t, give: [myRanked[i]], get: [theirForSingle[j]],
            myGain: r.myGain, theirGain: r.theirGain,
            myCount: me.players.length, theirCount: t.players.length
          });
        }
      }
    }

    if (!do2for1) return;

    const myTop = myRanked.slice(0, 10);
    const theirTop = theirRanked.slice(0, 10);

    // Two out, one in. My roster shrinks by one, theirs grows by one.
    for (let i = 0; i < myTop.length; i++) {
      for (let j = i + 1; j < myTop.length; j++) {
        for (let k = 0; k < theirTop.length; k++) {
          const give = [myTop[i], myTop[j]], get = [theirTop[k]];
          if (!bringsIn(get)) continue;
          const r = evalDeal(t, give, get);
          if (r.myGain >= minGain && r.theirGain >= minGain) {
            deals.push({
              partner: t, give: give, get: get,
              myGain: r.myGain, theirGain: r.theirGain,
              myCount: me.players.length - 1, theirCount: t.players.length + 1
            });
          }
        }
      }
    }

    // One out, two in.
    for (let k = 0; k < theirTop.length; k++) {
      for (let l = k + 1; l < theirTop.length; l++) {
        if (!bringsIn([theirTop[k], theirTop[l]])) continue;
        for (let i = 0; i < myTop.length; i++) {
          const give = [myTop[i]], get = [theirTop[k], theirTop[l]];
          const r = evalDeal(t, give, get);
          if (r.myGain >= minGain && r.theirGain >= minGain) {
            deals.push({
              partner: t, give: give, get: get,
              myGain: r.myGain, theirGain: r.theirGain,
              myCount: me.players.length + 1, theirCount: t.players.length - 1
            });
          }
        }
      }
    }
  });

  deals.sort((x, y) => y.myGain - x.myGain);

  // Keep the best variant per (partner, what you receive) so one good player
  // does not fill the sheet with near-identical offers.
  const seen = {};
  const trimmed = [];
  for (let i = 0; i < deals.length; i++) {
    const d = deals[i];
    const key = d.partner.rosterId + '|' + d.get.slice().sort().join(',');
    if (seen[key]) continue;
    seen[key] = true;
    d.overMax = d.myCount > rosterMax || d.theirCount > rosterMax;
    d.rosterMax = rosterMax;
    trimmed.push(d);
    if (trimmed.length >= Number(cfg('TRADE_MAX_RESULTS'))) break;
  }

  return trimmed;
}
