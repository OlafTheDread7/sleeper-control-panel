# Sleeper Control Panel

A Google Apps Script project bound to a Google Sheet. It reads a Sleeper fantasy football league through Sleeper's public API. The sheet shows my lineup, this week's matchup, waiver targets, a trade finder, power rankings, a positional matrix and every roster in the league.

I built it for my own 12-team league, which has non-standard scoring. It reads each league's own scoring rules, so it works for any Sleeper league.

Sleeper's API is **read-only**. There's no auth and there are no write endpoints, so the panel can't set a lineup, add or drop a player, or propose a trade. It makes recommendations and gives you links. The final click happens in Sleeper.

## Two ways of valuing a player

**Usage score for start/sit.** My Lineup and Matchup don't use projected points. I don't make lineup calls off projections, so the panel doesn't either. It values each player from the work he's actually been given: target share, carry share and red-zone work. Then it accounts for this week's opponent and the weather. See "The usage score" below.

**Sleeper projections for rest of season.** Waiver Targets, Trade Finder, the Positional Matrix and League Rosters still use Sleeper's projection feed. Each of those sheets says so in its subtitle.

## Set it up

You need a Google account, a Sleeper league ID (it's in the league URL: `sleeper.com/leagues/<THIS>/team`) and Node for [clasp](https://github.com/google/clasp).

```bash
npm install -g @google/clasp
clasp login
git clone https://github.com/OlafTheDread7/sleeper-control-panel.git
cd sleeper-control-panel
clasp create --type sheets --title "Sleeper Control Panel"
clasp push
```

`clasp create` makes a new Google Sheet with this script bound to it and writes `.clasp.json` (which stays out of git). Some clasp versions also replace `appsscript.json` with Google's default. If `git status` shows it changed, restore it with `git checkout appsscript.json` before `clasp push`. Then:

1. Open the new sheet and reload it. A **Sleeper Panel** menu appears.
2. Run **Sleeper Panel, First-time setup**. Google asks you to authorize the script (it reads the sheet and calls Sleeper, ESPN and the weather services). The first run creates the **Settings** sheet and stops, asking for a league ID.
3. On Settings, fill in `LEAGUE_ID` and `MY_USERNAME` (your Sleeper username or team name).
4. Run **First-time setup** again. It shows your league, scoring and which roster is yours.
5. Run **Refresh everything**. A cold refresh takes a minute or two.

**Schedule weekly auto-refresh** in the same menu adds a weekly trigger if you want it to stay current on its own.

No clasp? Make a Sheet, open Extensions, Apps Script, add one script file per `.gs` file here with the same name, and paste `appsscript.json` in under Project Settings ("Show appsscript.json manifest file in editor").

## Working on it

```bash
clasp push     # upload local files to the bound script
clasp pull     # download what is deployed (overwrites local)
```

clasp accepts local files as `.gs` or `.js` and stores both as `.gs`. `clasp pull` writes `.js`. Never keep a `.gs` and a `.js` of the same name side by side. After a pull into a folder of `.gs` files, delete one set before pushing. `clasp push` replaces the whole deployed project with what's in this folder. `README.md` and `LICENSE` aren't uploaded.

After a push, reload the sheet and use the **Sleeper Panel** menu.

## Files

| File | What it does |
| --- | --- |
| `Config` | Settings and their defaults, the Settings sheet, slot eligibility. |
| `Api` | Sleeper HTTP calls, the weekly projections feed, chunked caching. |
| `Scoring` | Stats to points in the league's own rules. |
| `Model` | One consistent snapshot of the league per refresh. |
| `Usage` | The usage score: role, opponent volume, opponent efficiency. |
| `Weather` | Game-day weather and its effect on passing and kicking. |
| `Lineup` | Optimal-lineup solver and replacement levels. |
| `Matchup` | This week's head-to-head and win probability. |
| `Trades` | Win/win trade search. |
| `Waivers` | Free agents worth a roster spot, net of who you would drop. |
| `Stats` | All-play record, efficiency, luck, positional matrix, roster needs. |
| `Sheets` | All spreadsheet rendering. |
| `Menu` | The menu and every entry point. |

## Sheets it writes

| Sheet | Built on | Contents |
| --- | --- | --- |
| Dashboard | both | Where you stand, this week's matchup, roster shape, what to do this week, what the waiver wire is worth by position. |
| My Lineup | usage score | Best lineup against what is set, with every factor behind each score. |
| Matchup | usage score | Your lineup against your opponent's, slot by slot, with a win probability, plus the rest of the league's games. |
| Waiver Targets | projections | Free agents ranked by net gain to your starting lineup. |
| Trade Finder | projections | Deals where both rosters improve. |
| Power Rankings | real results | All-play record, efficiency, luck. |
| Positional Matrix | projections | Rest-of-season strength by position for every team. |
| League Rosters | projections | Every roster with rest-of-season values and bye weeks. |
| Settings | | Everything tunable. Overrides the defaults in `Config`. |

## The usage score

Sleeper publishes real weekly stats alongside its projections:

```
https://api.sleeper.app/stats/nfl/{season}/{week}?season_type=regular&position[]=QB&...
```

That feed has targets, red-zone targets, carries, red-zone carries, pass attempts and snap counts for every player. The score uses those stats in four steps. My Lineup shows each one as a column.

1. **Role.** Target share, carry share and red-zone share over the games a player was active, recent games weighted more. Shares times his team's volume give expected targets and carries. Those are valued at what a target or carry has been worth to his position league-wide this season, in the league's scoring. Touchdowns come from red-zone work, not from his touchdown total. A damped adjustment covers his own efficiency.
2. **Opponent volume.** How many targets this week's defense allows to his position, how many carries to backs, how many pass attempts it faces. This is the stand-in for scheme: real coverage and blitz data isn't free.
3. **Opponent efficiency.** Points allowed per target, per carry, per attempt. Kept separate from volume so nothing is counted twice.
4. **Weather.** Wind, rain and cold at outdoor games, applied to passing, receiving and kicking.

Every opponent number is pulled toward the league average based on how little data is behind it, and capped. The constants are at the top of `Usage` and `Weather`.

**What it can't see.** A role that changes this week: a starter ruled out ahead of a player, a return from injury, a trade, or a last game cut short by injury (which drags a share down for no real reason). The Games and Trend columns flag thin or shifting roles. That call stays with you.

**How good is it?** Sleeper Panel, "Check usage score against results" replays each completed week. It builds the score using only the weeks before it, then compares its miss with the miss of Sleeper's projection.

**Week 1.** There are no games to learn from, so the start/sit sheets fall back to Sleeper projections and say so.

### Weather sources

All free. None need a key. ESPN's public scoreboard gives kickoff times, venues and neutral sites. The US National Weather Service gives the hourly forecast for the stadium, with Open-Meteo as the fallback. Weather is best-effort: if a source is down, the game gets no adjustment and the sheet says so. Roofed stadiums are skipped. Neutral-site games abroad get no adjustment. The size of each weather adjustment is a judgment call, not a fitted number.

## Rest-of-season engines

**Projections.** They come from one undocumented endpoint:

```
https://api.sleeper.app/projections/nfl/{season}/{week}?season_type=regular&order_by=ppr&position[]=QB&position[]=RB&position[]=WR&position[]=TE&position[]=K&position[]=DEF
```

It's about 2 MB per week and also returns each player's name, team, position and injury status. That covers every rostered player, so the 14.6 MB `/v1/players/nfl` file is never downloaded.

**Scoring is a dot product.** The league's `scoring_settings` uses the same key names as the stat lines, so points are the sum of stat times weight. Change a rule in Sleeper and the panel picks it up without a code edit. The one exception is handled by the `DERIVED` map in `Scoring`: a league can score a flat `fgmiss` while the stats arrive split by distance (`fgmiss_30_39` and so on).

**Byes need no table.** A player on bye has no projection that week, so he contributes zero to any rest-of-season sum on his own.

**Rate limits.** Sleeper allows 1000 calls a minute. A full refresh on a cold cache makes about 50 calls in total: roughly 30 to Sleeper and the rest to ESPN and the weather services. A repeat refresh inside the cache window makes about a dozen.

### Replacement level

A lineup slot you can't fill is **not** worth zero. It's worth whatever you could stream into it. An unfillable slot gets replacement-level credit: the Nth-best free agent at that position that week.

N is set per position by `STREAM_DEPTH`. Getting it wrong is the main way the rest-of-season engines can mislead you. With one flat N of 3, the implied running back floor in my league was 5.84 points a week. That was higher than two backs on my roster, so the engine assumed it would stream over them. A real hole at running back never showed up in any recommendation.

Current default:

```
DEFAULT:5, QB:3, K:3, DEF:3, TE:8, WR:10, RB:10
```

Quarterback, kicker and defense are genuinely streamable, so they're shallow. Running back isn't, so it's deep. A bare number such as `5` is also accepted and means that depth at every position.

The Dashboard's "What the wire is worth" table shows the depth being used for each position next to the replacement value it produces. If those depths aren't what you expect, the Settings sheet is overriding the code.

`TARGET_POSITION` narrows the trade and waiver engines to moves that bring back one position. Set it to `RB` when you know what you need.

## Matchup

- A game dated before today is scored from the real box score. Everyone else is valued by the usage score. Games dated today count as not yet played, because the schedule has no kickoff time.
- Each side is shown as currently set and with every open slot filled by its best available player. Finished games are never reshuffled.
- The win probability is built from how far teams in the league have actually landed from the number this sheet would have shown them, measured by replaying completed weeks, blended with a prior until there is enough data. Only the part of each lineup still to be played carries uncertainty.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `LEAGUE_ID` | blank | From the league URL. Required. |
| `MY_USERNAME` | blank | Sleeper username or team name, to find your roster. |
| `MY_ROSTER_ID` | blank | Set this to skip the lookup. |
| `SEASON` | blank | Blank auto-detects. |
| `ROS_LAST_WEEK` | blank | Blank means the week before playoffs start. |
| `PLAYOFF_WEIGHT` | 1.5 | Multiplier on playoff weeks in trade and waiver value. |
| `TRADE_MIN_GAIN` | 8 | Both sides must gain at least this much. |
| `TRADE_MAX_RESULTS` | 40 | Row cap on Trade Finder. |
| `TRADE_INCLUDE_2FOR1` | TRUE | Also search 2-for-1 packages. |
| `WAIVER_MIN_ROS` | 15 | Hide free agents below this projection. |
| `WAIVER_MAX_RESULTS` | 60 | Row cap on Waiver Targets. |
| `TARGET_POSITION` | blank | Only surface moves that bring in this position. |
| `STREAM_DEPTH` | see above | Replacement depth per position. |
| `USAGE_WEEKS` | 6 | Recent completed weeks the usage score learns from. |
| `USAGE_RECENCY` | 0.75 | Weight on each week further back. 1 treats all weeks alike. |
| `USE_WEATHER` | TRUE | Adjust the usage score for weather at outdoor games. |
| `CACHE_MINUTES` | 180 | How long to reuse downloaded projections and forecasts. |

The Settings sheet is created on first run. When a setting is added to the code, the next refresh adds it to the sheet. Values you've set are left alone.

## License

MIT. See `LICENSE`.
