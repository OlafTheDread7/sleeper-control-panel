/**
 * Lineup.gs — roster scoring primitives and the optimal lineup solver.
 *
 * Slots are filled most-restrictive-first: a QB-only slot before a FLEX,
 * a FLEX before a SUPER_FLEX. For fantasy rosters this greedy order is
 * provably optimal, because the eligibility sets are nested (QB is a subset
 * of SUPER_FLEX; RB/WR/TE are subsets of FLEX) rather than partially
 * overlapping. Add a genuinely overlapping slot type and this would need a
 * real assignment algorithm instead.
 *
 * REPLACEMENT LEVEL — the important idea in this file.
 *
 * When a roster cannot fill a slot in some week (your only QB is on bye), the
 * naive answer is to score that slot zero. That is wrong, and wrong in a way
 * that quietly corrupts every downstream recommendation: it makes bye-week
 * insurance look enormously valuable, so the trade and waiver engines start
 * insisting you acquire a backup at every position.
 *
 * In reality an empty slot is worth whatever you could stream into it. So an
 * unfillable slot is credited at replacement level — the STREAM_DEPTH-th best
 * free agent at that position that week. In this league that turns out to be
 * ~19 points for a QB and ~6.5 for an RB, which is exactly why a second QB is
 * nearly worthless here and RB depth is not.
 */

function slotEligible_(slot) {
  return SLOT_ELIGIBILITY[slot] || [slot];
}

function slotOrder_(slots) {
  return slots
    .map((s, i) => ({ slot: s, i: i, width: slotEligible_(s).length }))
    .sort((a, b) => a.width - b.width || a.i - b.i);
}

/**
 * Buckets a player pool by position, sorted best-first for one week.
 *
 * @param {Object=} table  player_id -> points to rank by. Defaults to Sleeper's
 *     projection for that week, which is what the rest-of-season engines use.
 *     The start/sit sheets pass the usage score instead.
 */
function prepBuckets_(m, ids, week, table) {
  const tbl = table || m.weekly[week] || {};
  const byPos = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const pts = tbl[id];
    if (!pts) continue;           // bye, inactive, or unprojected
    const pos = pPos(m, id);
    if (!pos) continue;
    (byPos[pos] = byPos[pos] || []).push({ id: id, pts: pts });
  }
  for (const p in byPos) byPos[p].sort((a, b) => b.pts - a.pts);
  return byPos;
}

/**
 * Fills the starting lineup from pre-bucketed players.
 * @param {Object} byPos position -> sorted [{id,pts}]
 * @param {Array} orderedSlots from slotOrder_
 * @param {Object=} repl position -> streaming replacement value for this week.
 *     Omit to score unfillable slots as zero (correct when measuring what a
 *     manager actually did with the roster they had).
 */
function fillFromBuckets_(byPos, orderedSlots, repl) {
  const cursor = {};
  let total = 0;

  for (let s = 0; s < orderedSlots.length; s++) {
    const elig = slotEligible_(orderedSlots[s].slot);

    let best = null, bestPos = null;
    for (let e = 0; e < elig.length; e++) {
      const pos = elig[e];
      const list = byPos[pos];
      if (!list) continue;
      const idx = cursor[pos] || 0;
      if (idx >= list.length) continue;
      if (!best || list[idx].pts > best.pts) { best = list[idx]; bestPos = pos; }
    }

    let replValue = 0, haveRepl = false;
    if (repl) {
      for (let e = 0; e < elig.length; e++) {
        const v = repl[elig[e]] || 0;
        if (v > replValue) { replValue = v; haveRepl = true; }
      }
    }

    if (best && best.pts >= replValue) {
      total += best.pts;
      cursor[bestPos] = (cursor[bestPos] || 0) + 1;
    } else if (haveRepl) {
      // Stream someone in. No roster player is consumed.
      total += replValue;
    }
  }
  return total;
}

/**
 * Replacement level per week per position: the Nth-best projected free agent,
 * where N comes from the per-position STREAM_DEPTH setting.
 *
 * Getting N wrong is the main way this tool can quietly mislead you. Set it
 * too shallow for a scarce position and you invent a floor you will never
 * actually hit — and every player on your roster below that phantom floor
 * becomes invisible, because the engine assumes you stream over him. That is
 * how a genuine hole at running back can fail to show up anywhere in the
 * output. See the STREAM_DEPTH comment in Config.gs.
 */
function computeReplacementLevels(m, weeks) {
  const depths = streamDepths();
  const out = {};
  weeks.forEach(w => {
    const tbl = m.weekly[w] || {};
    const pools = {};
    for (const id in tbl) {
      if (m.rosteredIds[id]) continue;
      const pos = pPos(m, id);
      if (!pos) continue;
      (pools[pos] = pools[pos] || []).push(tbl[id]);
    }
    const lvl = {};
    for (const pos in pools) {
      pools[pos].sort((a, b) => b - a);
      const depth = Math.max(1, depths[pos] || depths.DEFAULT || 5);
      lvl[pos] = pools[pos][Math.min(depth - 1, pools[pos].length - 1)] || 0;
    }
    out[w] = lvl;
  });
  return out;
}

/** Best achievable score for one week from a pool of players. */
function optimalWeekScore(m, ids, week, orderedSlots, repl, table) {
  return fillFromBuckets_(prepBuckets_(m, ids, week, table), orderedSlots, repl);
}

/**
 * Detailed single-week optimum for the My Lineup sheet.
 * No replacement level here on purpose: this week you start who you have.
 *
 * @param {Object=} table  player_id -> points to rank by (see prepBuckets_).
 * @param {Array<string>=} slots  the slots to fill. Defaults to the whole
 *     starting lineup; pass fewer to solve only the slots still open.
 */
function optimalWeekDetail(m, ids, week, table, slots) {
  const tbl = table || m.weekly[week] || {};
  const ordered = slotOrder_(slots || m.slots);

  const byPos = {};
  ids.forEach(id => {
    const pos = pPos(m, id);
    if (!pos) return;
    (byPos[pos] = byPos[pos] || []).push({ id: id, pts: tbl[id] || 0 });
  });
  for (const p in byPos) byPos[p].sort((a, b) => b.pts - a.pts);

  const cursor = {};
  const picks = [];
  let total = 0;

  ordered.forEach(o => {
    const elig = slotEligible_(o.slot);
    let best = null, bestPos = null;
    elig.forEach(pos => {
      const list = byPos[pos];
      if (!list) return;
      const idx = cursor[pos] || 0;
      if (idx >= list.length) return;
      if (!best || list[idx].pts > best.pts) { best = list[idx]; bestPos = pos; }
    });
    if (best) {
      cursor[bestPos] = (cursor[bestPos] || 0) + 1;
      total += best.pts;
      picks.push({ order: o.i, slot: o.slot, id: best.id, pts: best.pts });
    } else {
      picks.push({ order: o.i, slot: o.slot, id: null, pts: 0 });
    }
  });

  picks.sort((a, b) => a.order - b.order);
  const startingIds = picks.filter(p => p.id).map(p => p.id);
  const bench = ids.filter(id => startingIds.indexOf(id) === -1)
    .map(id => ({ id: id, pts: tbl[id] || 0 }))
    .sort((a, b) => b.pts - a.pts);

  return { total: total, rows: picks, bench: bench };
}

/** What the roster is actually set to start this week, scored. */
function currentLineupScore(m, team, week, table) {
  const tbl = table || m.weekly[week] || {};
  let total = 0;
  (team.starters || []).forEach(id => {
    if (id && id !== '0') total += tbl[id] || 0;
  });
  return total;
}
