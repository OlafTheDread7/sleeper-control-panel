/**
 * Config.gs — all tunable settings live here.
 *
 * Everything in DEFAULTS can be overridden from the "Settings" sheet without
 * touching code. The Settings sheet is created automatically on first run and
 * upgraded in place when a newer version of the code adds a setting.
 */

const DEFAULTS = {
  // Your Sleeper league. Find it in the URL: sleeper.com/leagues/<THIS>/team
  LEAGUE_ID: '',

  // Your Sleeper username or team name. Used once to auto-detect which roster
  // is yours. Leave blank and set MY_ROSTER_ID manually if you prefer.
  MY_USERNAME: '',
  MY_ROSTER_ID: '',

  // Season. Auto-detected from /state/nfl if left blank.
  SEASON: '',

  // Rest-of-season horizon. Regular season ends the week before playoffs.
  // Auto-detected from the league's playoff_week_start.
  ROS_LAST_WEEK: '',

  // Playoff weeks are weighted higher in trade evaluation, because a title
  // is won in weeks 15-17 and a player who is on bye then costs you nothing.
  PLAYOFF_WEIGHT: 1.5,

  // Trade finder: only surface deals where BOTH sides gain at least this many
  // projected points over the evaluation horizon. Raise it to cut noise.
  TRADE_MIN_GAIN: 8,

  // Trade finder: max number of deals to write out, best-for-you first.
  TRADE_MAX_RESULTS: 40,

  // Trade finder: also search 2-for-1 packages (slower, ~2x runtime).
  TRADE_INCLUDE_2FOR1: true,

  // Waiver finder: ignore free agents projected below this ROS total.
  WAIVER_MIN_ROS: 15,

  // Waiver finder: how many rows to write.
  WAIVER_MAX_RESULTS: 60,

  // Only surface moves that bring in this position. Blank = all positions.
  // Set it to RB when you know you need a running back and want the engines
  // to search for one specifically instead of ranking every possible move.
  TARGET_POSITION: '',

  // Streaming replacement depth, PER POSITION. An empty lineup slot is
  // credited with the Nth-best free agent at that position, because you could
  // always pick someone up. The right N differs enormously by position and
  // getting it wrong is the single biggest way this tool can mislead you:
  //
  //   QB/K/DEF are genuinely streamable. There is always a startable one free,
  //   you can see the matchup coming, and week-to-week it works. Shallow N.
  //
  //   RB is not. The "3rd best available RB" is a projection artifact — a
  //   committee back whose value depends on an injury that has not happened.
  //   You cannot count on that every week, so a shallow N invents a floor you
  //   will never actually hit, and any back on your roster below that phantom
  //   floor becomes invisible to the engine. Deep N.
  //
  // Format: POS:N pairs. Anything unlisted falls back to DEFAULT.
  // A bare number ("5") is also accepted and means that depth everywhere.
  STREAM_DEPTH: 'DEFAULT:5, QB:3, K:3, DEF:3, TE:8, WR:10, RB:10',

  // The usage score (Usage.gs) learns each player's role from this many of
  // the most recent completed weeks.
  USAGE_WEEKS: 6,

  // How much each week further back counts relative to the one after it.
  // 1 treats every week alike; lower leans harder on the latest games.
  USAGE_RECENCY: 0.75,

  // Adjust the usage score for wind, rain and cold at outdoor games.
  USE_WEATHER: true,

  // Cache lifetime in minutes for the heavy weekly projection pulls.
  // Projections update a few times a week; 180 is a sane default.
  CACHE_MINUTES: 180
};

const SETTING_NOTES = {
  LEAGUE_ID: 'From your league URL: sleeper.com/leagues/<THIS>/team',
  MY_USERNAME: 'Your Sleeper username or team name. Used to auto-detect your roster.',
  MY_ROSTER_ID: 'Leave blank to auto-detect from username.',
  SEASON: 'Blank = auto-detect current season.',
  ROS_LAST_WEEK: 'Blank = auto-detect (week before playoffs start).',
  PLAYOFF_WEIGHT: 'Multiplier on playoff-week value in trade scoring.',
  TRADE_MIN_GAIN: 'Both sides must gain at least this much to be listed.',
  TRADE_MAX_RESULTS: 'Row cap on the Trade Finder sheet.',
  TRADE_INCLUDE_2FOR1: 'TRUE searches 2-for-1 packages as well.',
  WAIVER_MIN_ROS: 'Hide free agents below this rest-of-season projection.',
  WAIVER_MAX_RESULTS: 'Row cap on the Waiver Targets sheet.',
  TARGET_POSITION: 'Blank = all. Set to RB/WR/TE/QB to only surface moves that bring in that position.',
  STREAM_DEPTH: 'POS:N pairs. An empty slot is credited with the Nth-best free agent at that position. Low N for streamable spots (QB/K/DEF), high N for scarce ones (RB).',
  USAGE_WEEKS: 'How many recent completed weeks the usage score learns each role from.',
  USAGE_RECENCY: 'Weight on each week further back. 1 = all weeks equal; lower = lean on the latest games.',
  USE_WEATHER: 'TRUE adjusts the usage score for wind, rain and cold at outdoor games.',
  CACHE_MINUTES: 'How long to reuse downloaded projections and forecasts.'
};

// Bumped whenever the meaning of an existing setting changes, so a Settings
// sheet written by an older version can be upgraded exactly once.
//   2 — STREAM_DEPTH went from one flat number to per-position POS:N pairs.
const SETTINGS_SCHEMA = 2;

const SHEETS = {
  DASH: 'Dashboard',
  LINEUP: 'My Lineup',
  MATCHUP: 'Matchup',
  WAIVERS: 'Waiver Targets',
  TRADES: 'Trade Finder',
  POWER: 'Power Rankings',
  ROSTERS: 'League Rosters',
  MATRIX: 'Positional Matrix',
  SETTINGS: 'Settings'
};

// FLEX eligibility. Extend here if your league adds exotic slots.
const SLOT_ELIGIBILITY = {
  QB: ['QB'],
  RB: ['RB'],
  WR: ['WR'],
  TE: ['TE'],
  K: ['K'],
  DEF: ['DEF'],
  FLEX: ['RB', 'WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB']
};

// Slots that never appear in a starting lineup.
const BENCH_SLOTS = ['BN', 'IR', 'TAXI'];

/**
 * Reads a setting, preferring the Settings sheet over the DEFAULTS above.
 */
function cfg(key) {
  const overrides = readSettingsSheet_();
  const v = overrides[key];
  if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  return DEFAULTS[key];
}

let _settingsCache = null;

function readSettingsSheet_() {
  if (_settingsCache) return _settingsCache;
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEETS.SETTINGS);
  if (!sh) { _settingsCache = {}; return _settingsCache; }
  const values = sh.getDataRange().getValues();
  const out = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || '').trim();
    if (k) out[k] = values[i][1];
  }
  _settingsCache = out;
  return out;
}

function clearSettingsCache_() { _settingsCache = null; }

/** True for a lone number such as 3 or "3" — the pre-per-position format. */
function isBareNumber_(v) {
  return /^\s*\d+(\.\d+)?\s*$/.test(String(v));
}

/**
 * Parses the STREAM_DEPTH setting ("DEFAULT:5, QB:3, RB:10") into a lookup.
 *
 * A bare number means that depth at every position. It is read that way on
 * purpose rather than ignored: silently falling back to the default would
 * leave the sheet showing one number while the engine used another.
 */
function streamDepths() {
  const raw = String(cfg('STREAM_DEPTH') || '');
  if (isBareNumber_(raw) && Number(raw) > 0) return { DEFAULT: Number(raw) };

  const out = { DEFAULT: 5 };
  raw.split(',').forEach(part => {
    const bits = part.split(':');
    if (bits.length !== 2) return;
    const k = bits[0].trim().toUpperCase();
    const v = Number(bits[1]);
    if (k && v > 0) out[k] = v;
  });
  return out;
}

/** The depth actually in force for one position. */
function streamDepthFor(pos) {
  const d = streamDepths();
  return Math.max(1, d[pos] || d.DEFAULT || 5);
}

/** The position the engines should hunt for, or '' for no filter. */
function targetPosition() {
  return String(cfg('TARGET_POSITION') || '').trim().toUpperCase();
}

/**
 * Builds the Settings sheet on first run so everything is editable in-sheet,
 * and brings an existing sheet up to date with the current code:
 *
 *   - any setting the sheet does not have yet is appended with its default
 *   - a flat STREAM_DEPTH left over from before depths were per-position is
 *     replaced with the per-position default, once
 *
 * The second step matters. The sheet overrides DEFAULTS, so an old flat value
 * would otherwise keep every position at one depth forever and quietly undo
 * the per-position setting — which is the whole point of having it.
 * Values you have set yourself are never touched after that one upgrade.
 */
function ensureSettingsSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEETS.SETTINGS);
  const props = PropertiesService.getScriptProperties();

  if (!sh) {
    sh = ss.insertSheet(SHEETS.SETTINGS);
    const rows = [['Setting', 'Value', 'What it does']];
    Object.keys(DEFAULTS).forEach(k => rows.push([k, DEFAULTS[k], SETTING_NOTES[k] || '']));
    sh.getRange(1, 1, rows.length, 3).setValues(rows);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
    sh.setColumnWidth(1, 180);
    sh.setColumnWidth(2, 220);
    sh.setColumnWidth(3, 460);
    sh.setFrozenRows(1);
    props.setProperty('SETTINGS_SCHEMA', String(SETTINGS_SCHEMA));
    clearSettingsCache_();
    return sh;
  }

  const values = sh.getDataRange().getValues();
  const rowOf = {};
  for (let i = 1; i < values.length; i++) {
    const k = String(values[i][0] || '').trim();
    if (k) rowOf[k] = i + 1;
  }
  const changes = [];

  // Settings added since this sheet was created.
  const missing = Object.keys(DEFAULTS).filter(k => !rowOf[k]);
  if (missing.length) {
    const add = missing.map(k => [k, DEFAULTS[k], SETTING_NOTES[k] || '']);
    sh.getRange(values.length + 1, 1, add.length, 3).setValues(add);
    changes.push('added ' + missing.join(', '));
  }

  // One-time upgrade of settings whose format changed.
  const schema = Number(props.getProperty('SETTINGS_SCHEMA')) || 1;
  if (schema < SETTINGS_SCHEMA) {
    const row = rowOf.STREAM_DEPTH;
    if (schema < 2 && row && isBareNumber_(values[row - 1][1])) {
      sh.getRange(row, 2).setValue(DEFAULTS.STREAM_DEPTH);
      sh.getRange(row, 3).setValue(SETTING_NOTES.STREAM_DEPTH);
      changes.push('STREAM_DEPTH ' + values[row - 1][1] + ' → per-position');
    }
    props.setProperty('SETTINGS_SCHEMA', String(SETTINGS_SCHEMA));
  }

  if (changes.length) {
    clearSettingsCache_();
    ss.toast('Settings sheet updated: ' + changes.join('; ') + '.', 'Sleeper Panel', 8);
  }
  return sh;
}
