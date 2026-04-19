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
- Logs **+1 SHOT** for unplanned pickups without affecting the forecast
- Calculates pace from elapsed time vs resolved planned minutes
- Forecasts wrap and flags behind schedule, must-have shots at risk, and deadline conflicts in a single prioritized alert
- Plays a martini glass clink via Web Audio API when the last must-have shot is locked
- Persists everything in browser local storage
- Caches the app shell for full offline use via service worker

---

## Priority tiers

The `priority` column replaces a simple required/optional flag with three tiers:

| Value | Meaning | Alert behavior |
|-------|---------|----------------|
| `1` | Must-Have | Triggers DANGER alert if at risk |
| `2` | Want | Triggers WARNING alert if deadline conflict |
| `3` | Nice | Silent — no alert impact |

Legacy CSVs using `required: true/false` are automatically migrated on import.

---

## CSV format

```csv
id,scene,label,planned minutes,priority,optional deadline tag
1,12A,Wide master,18,1,10:30 AM
2,12A,Two-shot at booth,14,1,
3,12A,Insert coffee pour,6,3,
4,12B,Close on Mia,11,2,12:15 PM
```

Headers are flexible — the parser accepts common variations like `mins`, `minutes`, `shot`, `description`, `deadline`, `tag`.

---

## Alert hierarchy

MARTINI surfaces one alert at a time, in strict priority order:

1. Must-Have shot with a deadline conflict → **DANGER**
2. Must-Have shots at risk before hard wrap → **DANGER**
3. Want shot with a deadline conflict → **WARNING**
4. Forecast wrap exceeds hard wrap → **WARNING**
5. Behind schedule by 5+ minutes → **WARNING**
6. All clear → **ON PACE**

---

## Running it locally

No build step. Open `index.html` in a browser or serve the folder with any static server:

```bash
npx serve .
```

For service worker caching to activate, the app must be served over HTTPS or localhost.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and markup |
| `styles.css` | All styling and layout |
| `app.js` | State, logic, pace engine, Web Audio clink |
| `sw.js` | Service worker for offline caching |
| `manifest.webmanifest` | PWA manifest |

---

## Contributing

Pull requests welcome. If you're an AD, script supervisor, or filmmaker who wants a feature — open an issue and describe the problem it solves on set. MARTINI is built from real production frustration and that's the standard for what gets added.

Keep it lean. The goal is Alexa-level simplicity — one signal, three taps, no bloat.

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

*When two minds meet, a third appears. — HiveMind*
