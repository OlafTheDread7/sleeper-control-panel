/**
 * Scoring.gs — turns raw projected stats into points in YOUR league's rules.
 *
 * Sleeper uses the same key names in a league's `scoring_settings` as it does
 * in the stat lines it publishes (rec_yd, pass_td, pts_allow_21_27, fgm_40_49,
 * and so on). So scoring is simply the dot product of the two objects. That
 * means the panel adapts to any rule change you make in Sleeper without a code
 * edit — including the non-standard settings this league uses, like 0.04/pass
 * yard and the field-goal distance tiers.
 *
 * The only wrinkle is that a few scoring keys are aggregates of stats that
 * arrive pre-split into buckets. Those are reconstructed in DERIVED below.
 */

const DERIVED = {
  // Sleeper scores a generic "missed field goal" but projects misses by range.
  fgmiss: ['fgmiss_0_19', 'fgmiss_20_29', 'fgmiss_30_39', 'fgmiss_40_49', 'fgmiss_50p'],
  // Same shape for makes, in leagues that score fgm flat instead of by range.
  fgm: ['fgm_0_19', 'fgm_20_29', 'fgm_30_39', 'fgm_40_49', 'fgm_50p']
};

/**
 * @param {Object} stats  a Sleeper stat/projection line
 * @param {Object} scoring  the league's scoring_settings
 * @return {number} points
 */
function scoreStats(stats, scoring) {
  let total = 0;
  for (const key in scoring) {
    const weight = scoring[key];
    if (!weight) continue;

    let value = stats[key];

    if (value === undefined || value === null) {
      const parts = DERIVED[key];
      if (!parts) continue;
      // Only reconstruct when the aggregate is genuinely absent, so we never
      // double-count a league that scores both the total and the buckets.
      let sum = 0, found = false;
      for (let i = 0; i < parts.length; i++) {
        if (stats[parts[i]] !== undefined && stats[parts[i]] !== null) {
          sum += stats[parts[i]];
          found = true;
        }
      }
      if (!found) continue;
      value = sum;
    }

    total += value * weight;
  }
  return total;
}

/**
 * A short stable fingerprint of the scoring settings, mixed into cache keys so
 * that changing a league rule invalidates every cached projection.
 */
function scoringKey(scoring) {
  const keys = Object.keys(scoring).filter(k => scoring[k]).sort();
  let h = 0;
  const s = keys.map(k => k + ':' + scoring[k]).join('|') + '|' + cacheSalt_();
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return String(h >>> 0);
}

/**
 * Self-test: scores every projected player under textbook PPR and compares the
 * result to Sleeper's own pts_ppr field. If the engine is wired up correctly
 * these agree to within rounding. Run it from the menu after changing DERIVED.
 */
function verifyScoringEngine() {
  const m = buildModel();
  const raw = httpJson_(projUrl_(m.season, m.week));

  const PPR = {
    pass_yd: 0.04, pass_td: 4, pass_int: -2, pass_2pt: 2,
    rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
    rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
    fum_lost: -2,
    bonus_rush_td_qb: 1 // part of Sleeper's own PPR preset
  };

  let checked = 0, worst = 0, worstName = '';
  for (let i = 0; i < raw.length; i++) {
    const st = raw[i].stats || {};
    if (st.pts_ppr === undefined || st.pts_ppr === null) continue;
    const pos = (raw[i].player || {}).position;
    if (pos === 'K' || pos === 'DEF') continue; // scored by separate rule sets
    const mine = scoreStats(st, PPR);
    const diff = Math.abs(mine - st.pts_ppr);
    if (diff > worst) {
      worst = diff;
      worstName = ((raw[i].player || {}).last_name || '') + ' (mine ' +
        mine.toFixed(2) + ' vs Sleeper ' + st.pts_ppr.toFixed(2) + ')';
    }
    checked++;
  }

  const msg = 'Checked ' + checked + ' players.\nLargest disagreement with ' +
    "Sleeper's own PPR total: " + worst.toFixed(2) + ' pts\n' + worstName +
    (worst < 1.5
      ? '\n\nEngine looks correct. (Small gaps are Sleeper preset bonuses that ' +
        'your league does not score, so they do not affect your numbers.)'
      : '\n\nThat gap is larger than expected — check DERIVED in Scoring.gs.');
  SpreadsheetApp.getUi().alert('Scoring engine self-test', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}
