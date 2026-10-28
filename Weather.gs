/**
 * Weather.gs — game-day weather for the usage score.
 *
 * Three free sources, none needing a key:
 *
 *   ESPN's public scoreboard gives each game's kickoff time, venue, whether it
 *   is indoors and whether it is at a neutral site. One call per week.
 *
 *   The US National Weather Service gives an hourly forecast for a stadium's
 *   coordinates: wind, temperature, chance of rain. This is the number that
 *   matters, because wind is what actually hurts a passing game.
 *
 *   Open-Meteo is the fallback when the Weather Service does not answer.
 *
 * Weather is best-effort by design. If a source is down, the game simply gets
 * no adjustment and the sheet says the weather is unknown — a refresh never
 * fails because a forecast could not be fetched. Roofed stadiums are skipped.
 * Neutral-site games abroad have no coordinates here and are left alone.
 *
 * The size of each adjustment below is a judgment, not a fitted number. Wind
 * is the one with a real effect; the rest are deliberately small. Change them
 * here if your read is different.
 */

const WEATHER = {
  // Sustained wind in mph at or above the first number scales passing-game
  // points by the second and kicker points by the third.
  WIND: [
    [25, 0.82, 0.78],
    [20, 0.88, 0.84],
    [15, 0.93, 0.90],
    [12, 0.97, 0.96]
  ],
  // Chance of precipitation at or above this counts as a wet game.
  WET_PROB: 60,
  WET: [0.96, 0.97],
  SNOW: [0.92, 0.94],
  // At or below this temperature (F).
  COLD_F: 25,
  COLD: [0.97, 0.97],
  FLOOR: 0.75,
  // Hours of forecast to consider from kickoff.
  GAME_HOURS: 3.5
};

// Home stadiums. roof: 'open', or anything else for a game played under cover
// (fixed dome, retractable roof, or a canopy that takes the wind out of it).
const STADIUMS = {
  ARI: { lat: 33.5276, lon: -112.2626, roof: 'retractable' },
  ATL: { lat: 33.7554, lon: -84.4008, roof: 'retractable' },
  BAL: { lat: 39.2780, lon: -76.6227, roof: 'open' },
  BUF: { lat: 42.7738, lon: -78.7870, roof: 'open' },
  CAR: { lat: 35.2258, lon: -80.8528, roof: 'open' },
  CHI: { lat: 41.8623, lon: -87.6167, roof: 'open' },
  CIN: { lat: 39.0955, lon: -84.5161, roof: 'open' },
  CLE: { lat: 41.5061, lon: -81.6995, roof: 'open' },
  DAL: { lat: 32.7473, lon: -97.0945, roof: 'retractable' },
  DEN: { lat: 39.7439, lon: -105.0201, roof: 'open' },
  DET: { lat: 42.3400, lon: -83.0456, roof: 'dome' },
  GB: { lat: 44.5013, lon: -88.0622, roof: 'open' },
  HOU: { lat: 29.6847, lon: -95.4107, roof: 'retractable' },
  IND: { lat: 39.7601, lon: -86.1639, roof: 'retractable' },
  JAX: { lat: 30.3239, lon: -81.6373, roof: 'open' },
  KC: { lat: 39.0489, lon: -94.4839, roof: 'open' },
  LAC: { lat: 33.9535, lon: -118.3392, roof: 'covered' },
  LAR: { lat: 33.9535, lon: -118.3392, roof: 'covered' },
  LV: { lat: 36.0909, lon: -115.1833, roof: 'dome' },
  MIA: { lat: 25.9580, lon: -80.2389, roof: 'open' },
  MIN: { lat: 44.9737, lon: -93.2575, roof: 'dome' },
  NE: { lat: 42.0909, lon: -71.2643, roof: 'open' },
  NO: { lat: 29.9511, lon: -90.0812, roof: 'dome' },
  NYG: { lat: 40.8135, lon: -74.0745, roof: 'open' },
  NYJ: { lat: 40.8135, lon: -74.0745, roof: 'open' },
  PHI: { lat: 39.9008, lon: -75.1675, roof: 'open' },
  PIT: { lat: 40.4468, lon: -80.0158, roof: 'open' },
  SEA: { lat: 47.5952, lon: -122.3316, roof: 'open' },
  SF: { lat: 37.4033, lon: -121.9694, roof: 'open' },
  TB: { lat: 27.9759, lon: -82.5033, roof: 'open' },
  TEN: { lat: 36.1665, lon: -86.7713, roof: 'open' },
  WAS: { lat: 38.9076, lon: -76.8645, roof: 'open' }
};

// ESPN's abbreviations where they differ from Sleeper's.
const ESPN_TEAM = { WSH: 'WAS', JAC: 'JAX', LA: 'LAR' };

/** One quiet attempt at a JSON fetch. Returns null instead of throwing. */
function tryJson_(url) {
  try {
    const res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true, followRedirects: true,
      headers: { Accept: 'application/geo+json, application/json' }
    });
    if (res.getResponseCode() !== 200) return null;
    return JSON.parse(res.getContentText());
  } catch (e) { return null; }
}

/** This week's games from ESPN: [{home, away, kickoff(ms), indoor, neutral, cond, temp}]. */
function espnGames_(season, week) {
  const data = tryJson_('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard' +
    '?week=' + week + '&seasontype=2&dates=' + season);
  if (!data || !data.events) return null;
  const fix = a => ESPN_TEAM[a] || a;
  const out = [];
  data.events.forEach(ev => {
    const c = (ev.competitions || [])[0];
    if (!c || !c.competitors) return;
    const home = c.competitors.filter(x => x.homeAway === 'home')[0];
    const away = c.competitors.filter(x => x.homeAway === 'away')[0];
    if (!home || !away) return;
    const wx = ev.weather || c.weather || {};
    out.push({
      home: fix(home.team.abbreviation),
      away: fix(away.team.abbreviation),
      kickoff: new Date(ev.date).getTime(),
      indoor: !!(c.venue && c.venue.indoor),
      neutral: !!c.neutralSite,
      cond: wx.displayValue || '',
      temp: (wx.temperature !== undefined && wx.temperature !== null) ? Number(wx.temperature) : null
    });
  });
  return out;
}

/** Largest number in a string such as "10 to 15 mph". */
function maxNumber_(s) {
  const found = String(s || '').match(/\d+(\.\d+)?/g);
  if (!found) return null;
  return Math.max.apply(null, found.map(Number));
}

/**
 * Hourly forecast for a stadium over the game window, from the National
 * Weather Service. Returns {wind, temp, precip, text} or null.
 */
function nwsForecast_(team, stadium, kickoff) {
  const props = PropertiesService.getScriptProperties();
  const key = 'NWS_HOURLY_' + team;
  let url = props.getProperty(key);
  if (!url) {
    const pt = tryJson_('https://api.weather.gov/points/' + stadium.lat + ',' + stadium.lon);
    url = pt && pt.properties && pt.properties.forecastHourly;
    if (!url) return null;
    props.setProperty(key, url);   // a stadium's forecast grid does not move
  }
  const fc = tryJson_(url);
  const periods = fc && fc.properties && fc.properties.periods;
  if (!periods || !periods.length) return null;

  const from = kickoff - 30 * 60000, to = kickoff + WEATHER.GAME_HOURS * 3600000;
  let wind = null, temp = null, precip = null, text = '';
  periods.forEach(p => {
    const t = new Date(p.startTime).getTime();
    if (t < from || t > to) return;
    const w = maxNumber_(p.windSpeed);
    if (w !== null && (wind === null || w > wind)) wind = w;
    if (typeof p.temperature === 'number' && (temp === null || p.temperature < temp)) temp = p.temperature;
    const pr = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
    if (typeof pr === 'number' && (precip === null || pr > precip)) precip = pr;
    if (!text && p.shortForecast) text = p.shortForecast;
    if (/snow|sleet|ice/i.test(p.shortForecast || '')) text = p.shortForecast;
  });
  if (wind === null && temp === null) return null;   // game is past the forecast horizon
  return { wind: wind, temp: temp, precip: precip, text: text };
}

/** The same thing from Open-Meteo, used when the Weather Service is silent. */
function openMeteoForecast_(stadium, kickoff) {
  const day = d => Utilities.formatDate(new Date(d), 'GMT', 'yyyy-MM-dd');
  const data = tryJson_('https://api.open-meteo.com/v1/forecast?latitude=' + stadium.lat +
    '&longitude=' + stadium.lon +
    '&hourly=temperature_2m,precipitation_probability,snowfall,wind_speed_10m' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=GMT' +
    '&start_date=' + day(kickoff) + '&end_date=' + day(kickoff + 6 * 3600000));
  const h = data && data.hourly;
  if (!h || !h.time) return null;

  const from = kickoff - 30 * 60000, to = kickoff + WEATHER.GAME_HOURS * 3600000;
  let wind = null, temp = null, precip = null, snow = false;
  h.time.forEach((stamp, i) => {
    const t = new Date(stamp + ':00Z').getTime();
    if (t < from || t > to) return;
    const w = h.wind_speed_10m && h.wind_speed_10m[i];
    if (typeof w === 'number' && (wind === null || w > wind)) wind = w;
    const tp = h.temperature_2m && h.temperature_2m[i];
    if (typeof tp === 'number' && (temp === null || tp < temp)) temp = tp;
    const pr = h.precipitation_probability && h.precipitation_probability[i];
    if (typeof pr === 'number' && (precip === null || pr > precip)) precip = pr;
    if (h.snowfall && h.snowfall[i] > 0) snow = true;
  });
  if (wind === null && temp === null) return null;
  return { wind: wind, temp: temp, precip: precip, text: snow ? 'Snow' : '' };
}

/** Turns a forecast into multipliers and a short label for the sheet. */
function weatherEffect_(fc) {
  let pass = 1, kick = 1;
  const bits = [];

  if (fc.wind !== null && fc.wind !== undefined) {
    for (let i = 0; i < WEATHER.WIND.length; i++) {
      if (fc.wind >= WEATHER.WIND[i][0]) { pass *= WEATHER.WIND[i][1]; kick *= WEATHER.WIND[i][2]; break; }
    }
    bits.push(Math.round(fc.wind) + ' mph');
  }
  const snow = /snow|sleet|ice/i.test(fc.text || '');
  const wet = snow || (typeof fc.precip === 'number' && fc.precip >= WEATHER.WET_PROB) ||
    (fc.precip === null && /rain|shower|storm/i.test(fc.text || ''));
  if (snow) { pass *= WEATHER.SNOW[0]; kick *= WEATHER.SNOW[1]; bits.push('snow'); }
  else if (wet) {
    pass *= WEATHER.WET[0]; kick *= WEATHER.WET[1];
    bits.push('rain' + (typeof fc.precip === 'number' ? ' ' + Math.round(fc.precip) + '%' : ''));
  }
  if (typeof fc.temp === 'number') {
    if (fc.temp <= WEATHER.COLD_F) { pass *= WEATHER.COLD[0]; kick *= WEATHER.COLD[1]; }
    bits.push(Math.round(fc.temp) + '°F');
  }
  if (fc.wind === null || fc.wind === undefined) bits.push('wind unknown');

  return {
    pass: Math.max(pass, WEATHER.FLOOR),
    kick: Math.max(kick, WEATHER.FLOOR),
    txt: bits.join(', ')
  };
}

/**
 * Weather for every team playing this week: team -> {pass, kick, txt}.
 * Cached like the projections, because forecasts move slowly.
 */
function gameWeather(m, week) {
  const key = 'wx1_' + m.season + '_' + week;
  const cached = cacheGetJson_(key);
  if (cached) return cached;

  const games = espnGames_(m.season, week);
  if (!games) return null;

  const now = Date.now();
  const out = {};
  games.forEach(g => {
    let eff;
    const stadium = STADIUMS[g.home];
    if (g.kickoff + WEATHER.GAME_HOURS * 3600000 < now) {
      eff = { pass: 1, kick: 1, txt: 'Played' };
    } else if (g.neutral) {
      // Not the home team's building, and no coordinates for it here.
      eff = weatherEffect_({ wind: null, temp: g.temp, precip: null, text: g.cond });
      eff.txt = 'Neutral site' + (g.cond ? ': ' + g.cond.toLowerCase() : '');
    } else if (g.indoor || (stadium && stadium.roof !== 'open')) {
      eff = { pass: 1, kick: 1, txt: 'Roof' };
    } else if (!stadium) {
      eff = { pass: 1, kick: 1, txt: 'Unknown' };
    } else {
      const fc = nwsForecast_(g.home, stadium, g.kickoff) ||
        openMeteoForecast_(stadium, g.kickoff) ||
        // Last resort: ESPN's one-line outlook, which has no wind.
        ((g.cond || g.temp !== null) ? { wind: null, temp: g.temp, precip: null, text: g.cond } : null);
      eff = fc ? weatherEffect_(fc) : { pass: 1, kick: 1, txt: 'Unknown' };
    }
    out[g.home] = eff;
    out[g.away] = eff;
  });

  cachePutJson_(key, out, Number(cfg('CACHE_MINUTES')) * 60);
  return out;
}
