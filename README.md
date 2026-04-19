# MARTINI

**One screen. One day. One signal.**

MARTINI is a mobile-first, offline shoot tracker for indie film crews. It compares planned shot time against real elapsed time, forecasts wrap, and surfaces the single highest-priority risk while the day is running — so the AD and director can stay heads-down on set instead of doing mental math.

Built by [HiveMind](https://thehivemind.tv).

---

## Live App

[hivemindprojector.github.io/martini](https://hivemindprojector.github.io/martini)

Works entirely in the browser. No account, no server, no install required. Add to your phone's home screen for a full PWA experience with offline support.

---

## What it does

- Imports a CSV shot list with `id`, `scene`, `label`, `planned minutes`, `priority`, and optional `deadline tag`
- Starts the day with a single hard wrap time, then switches to tap-only tracking
- Marks the current shot as **DONE** or **SKIP** with automatic timestamps
- Shows a **live per-shot timer** — "Live 8 min" while in range, flashes "Over by 3 min" when past plan
- Gives you a **5-second UNDO** after every DONE or SKIP in case of a fat-finger
- Logs **+1 SHOT** for unplanned pickups without affecting the forecast
- Calculates pace from elapsed time vs resolved planned minutes, with cold-start handling so the forecast stays honest before the first lock
- Forecasts wrap and flags behind schedule, must-have shots at risk, and deadline conflicts in a single prioritized alert
- Plays a martini glass clink via Web Audio API when the last must-have shot is locked
- **Exports the day** as CSV — planned shots with resolution timestamps plus all +1 pickups
- Persists everything in browser local storage
- Caches the app shell for full offline use via service worker

---

## Priority tiers

The `priority` column replaces a simple required/optional flag with three tiers:

| Value | Meaning    | Alert behavior                           |
|-------|------------|------------------------------------------|
| `1`   | Must-Have  | Triggers DANGER alert if at risk         |
| `2`   | Want       | Triggers WARNING alert if deadline conflict |
| `3`   | Nice       | Silent — never surfaces an alert         |

Legacy CSVs using `required: true/false` are automatically migrated on import.

---

## CSV format

```csv
id,scene,label,planned minutes,priority,optional deadline tag
1,12A,Wide master,18,1,10:30 AM
2,12A,Two-shot at booth,14,1,
3,12A,Insert coffee pour,6,3,
4,12B,Close on Mia,11,1,12:15 PM
```

Headers are flexible — the parser accepts common variations like `mins`, `minutes`, `shot`, `description`, `deadline`, `tag`.

See [sample-shots.csv](./sample-shots.csv) for a full example.

---

## Alert hierarchy

MARTINI surfaces one alert at a time, in strict priority order:

1. Must-Have shot with a deadline conflict → **DANGER**
2. Must-Have shots at risk before hard wrap → **DANGER**
3. Want shot with a deadline conflict → **WARNING**
4. Forecast wrap exceeds hard wrap → **WARNING**
5. Behind schedule by 5+ minutes → **WARNING**
6. All clear → **ON PACE**

Priority 3 (Nice) shots are silent regardless of deadline tag — they still count toward elapsed time in the forecast, but they never push the banner.

---

## Export

At any point during the day, tap **Export CSV** in the Day Snapshot panel to download a log of the day so far. It includes every planned shot with status and resolution timestamps plus all `+1 SHOT` pickups. Starting a new day also offers an auto-export before it clears state, so you never lose the editorial trail.

---

## Running it locally

No build step. Open `index.html` in a browser or serve the folder with any static server:

```bash
npx serve .
```

For service worker caching to activate, the app must be served over HTTPS or localhost.

---

## Files

| File                        | Purpose                                          |
|-----------------------------|--------------------------------------------------|
| `index.html`                | App shell and markup                             |
| `styles.css`                | All styling and layout                           |
| `app.js`                    | State, logic, pace engine, undo, export, Web Audio clink |
| `sw.js`                     | Service worker for offline caching               |
| `manifest.webmanifest`      | PWA manifest                                     |
| `sample-shots.csv`          | Example shot list                                |

---

## Contributing

Pull requests welcome. If you're an AD, script supervisor, or filmmaker who wants a feature — open an issue and describe the problem it solves on set. MARTINI is built from real production frustration and that's the standard for what gets added.

Keep it lean. The goal is Alexa-level simplicity — one signal, three taps, no bloat.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*When two minds meet, a third appears. — HiveMind*
