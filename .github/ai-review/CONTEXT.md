# sleeper-control-panel: notes for the reviewer

Public repo. A Google Apps Script project bound to a Google Sheet (deployed with clasp, never through GitHub). It reads a Sleeper fantasy football league through Sleeper's public, read-only API, plus ESPN's public scoreboard, the US National Weather Service and Open-Meteo. No keys, no logins.

- Settings come from the Settings sheet; `LEAGUE_ID` is blank in the code on purpose.
- Data from those APIs is written into the user's own spreadsheet. Nothing is sent anywhere else.
- `.clasp.json` (the script ID) is gitignored.

What matters most: anything that would send sheet data to a third party, or build a URL from sheet values without encoding it.
