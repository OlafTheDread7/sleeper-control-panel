/**
 * Api.gs — Sleeper HTTP layer.
 *
 * Sleeper's public API is read-only and unauthenticated. Their documented
 * limit is 1000 calls/minute; this panel uses well under 30 per full refresh.
 *
 * The one expensive call is the weekly projections feed (~2 MB per week), so
 * results are reduced to a compact id->points map and cached. We deliberately
 * never download /v1/players/nfl (14 MB) — the projections feed already
 * carries name, team, position and injury status for every rostered player.
 */

const API = 'https://api.sleeper.app';
const PROJ_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

function httpJson_(url) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
    const code = res.getResponseCode();
    if (code === 200) {
      try {
        return JSON.parse(res.getContentText());
      } catch (e) {
        lastErr = new Error('Bad JSON from ' + url);
      }
    } else if (code === 429 || code >= 500) {
      Utilities.sleep(800 * (attempt + 1));
      lastErr = new Error('HTTP ' + code + ' from ' + url);
      continue;
    } else {
      throw new Error('HTTP ' + code + ' from ' + url + ' — ' + res.getContentText().slice(0, 200));
    }
  }
  throw lastErr || new Error('Request failed: ' + url);
}

// ---------------------------------------------------------------- league reads

function apiState() { return httpJson_(API + '/v1/state/nfl'); }
function apiLeague(id) { return httpJson_(API + '/v1/league/' + id); }
function apiRosters(id) { return httpJson_(API + '/v1/league/' + id + '/rosters'); }
function apiUsers(id) { return httpJson_(API + '/v1/league/' + id + '/users'); }
function apiMatchups(id, week) { return httpJson_(API + '/v1/league/' + id + '/matchups/' + week); }
function apiTransactions(id, week) { return httpJson_(API + '/v1/league/' + id + '/transactions/' + week); }

function apiTrending(type, hours, limit) {
  return httpJson_(API + '/v1/players/nfl/trending/' + type +
    '?lookback_hours=' + (hours || 48) + '&limit=' + (limit || 200));
}

// ------------------------------------------------------------- projections

function projUrl_(season, week) {
  const qs = PROJ_POSITIONS.map(p => 'position[]=' + p).join('&');
  return API + '/projections/nfl/' + season + '/' + week +
    '?season_type=regular&order_by=ppr&' + qs;
}

/**
 * Downloads one week of projections and reduces it to:
 *   { scores: {player_id: pointsInLeagueScoring},
 *     meta:   {player_id: {...}},
 *     sched:  {NFL_TEAM: {o: opponent, d: 'yyyy-MM-dd'}} }
 *
 * Players on bye simply have no projection row with stats, so they fall out
 * naturally and contribute zero to any rest-of-season sum. That is the
 * behaviour we want and it is why byes never need a hardcoded lookup table.
 *
 * `sched` is the week's NFL schedule as a side effect of the same feed: every
 * projected row names its opponent and game date. The Matchup sheet uses the
 * date to tell which games are already over. It is per week, unlike `meta`.
 */
function fetchWeekProjections_(season, week, scoring) {
  const raw = httpJson_(projUrl_(season, week));
  const scores = {};
  const meta = {};
  const sched = {};
  for (let i = 0; i < raw.length; i++) {
    const row = raw[i];
    const st = row.stats || {};
    const p = row.player || {};
    const id = row.player_id;

    meta[id] = {
      n: p.position === 'DEF' ? (row.team || id) + ' DEF'
        : ((p.first_name || '') + ' ' + (p.last_name || '')).trim(),
      pos: p.position || '',
      tm: row.team || p.team || '',
      inj: p.injury_status || '',
      bp: p.injury_body_part || ''
    };

    // No pts_ppr means no projected game this week (bye, inactive, or not
    // projected at all). Skip rather than score a bag of ADP metadata.
    if (st.pts_ppr === undefined || st.pts_ppr === null) continue;

    const pts = scoreStats(st, scoring);
    if (pts !== 0) scores[id] = Math.round(pts * 100) / 100;
    if (row.opponent) meta[id].opp = row.opponent;

    const tm = row.team || p.team;
    if (tm && !sched[tm] && (row.opponent || row.date)) {
      sched[tm] = { o: row.opponent || '', d: row.date || '' };
    }
  }
  return { scores: scores, meta: meta, sched: sched };
}

/**
 * Cached wrapper. Projections for a given week only move a few times a week.
 *
 * @param {number=} ttlSeconds  overrides CACHE_MINUTES. Used for weeks that
 *     have already been played, whose projections can no longer change.
 */
function getWeekProjections(season, week, scoring, scoringKey, ttlSeconds) {
  // "p2": the payload gained `sched`. The prefix change retires older entries.
  const key = 'p2_' + season + '_' + week + '_' + scoringKey;
  const cached = cacheGetJson_(key);
  if (cached) return cached;
  const data = fetchWeekProjections_(season, week, scoring);
  cachePutJson_(key, data, ttlSeconds || Number(cfg('CACHE_MINUTES')) * 60);
  return data;
}

// ------------------------------------------------------- chunked cache utils
// CacheService caps a single value at 100 KB, so payloads are split.

const CHUNK = 90000;

function cachePutJson_(key, obj, ttlSeconds) {
  const cache = CacheService.getScriptCache();
  const s = JSON.stringify(obj);
  const n = Math.ceil(s.length / CHUNK);
  const ttl = Math.min(ttlSeconds || 3600, 21600); // 6h is the platform max
  const payload = {};
  for (let i = 0; i < n; i++) payload[key + '_' + i] = s.substring(i * CHUNK, (i + 1) * CHUNK);
  payload[key + '_n'] = String(n);
  try {
    cache.putAll(payload, ttl);
  } catch (e) {
    // Cache is best-effort. A failure here just means we refetch next time.
  }
}

function cacheGetJson_(key) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key + '_n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const parts = cache.getAll(keys);
  let s = '';
  for (let i = 0; i < n; i++) {
    const part = parts[key + '_' + i];
    if (part === undefined || part === null) return null; // a chunk expired
    s += part;
  }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function clearProjectionCache() {
  // CacheService has no "clear all", so we bump a salt that is mixed into
  // every cache key. Old entries age out on their own.
  const props = PropertiesService.getScriptProperties();
  props.setProperty('CACHE_SALT', String(Date.now()));
  SpreadsheetApp.getActive().toast('Projection cache cleared.', 'Sleeper Panel', 4);
}

function cacheSalt_() {
  return PropertiesService.getScriptProperties().getProperty('CACHE_SALT') || '0';
}
