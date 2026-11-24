# PR Utility Status

A free, near-real-time status board for Puerto Rico's utilities, built only from public data.

| Panel | What it shows | Source | Freshness |
|---|---|---|---|
| Electricity — LUMA | Customers without power, % by region, planned work, load-shedding flag | MiLUMA outage API (`api.miluma.lumapr.com`, the same feed as LUMA's outage map) | ~10 min |
| Generation — PREPA plants (Genera PR) | Reserve MW and Genera's own category (narrow / moderate / sufficient), available capacity vs. load | `genera-pr.com/data-generacion` | ~10 min |
| Water — PRASA / AAA | Levels at 7 major supply reservoirs with 24 h / 7-day change, latest AAA notices | USGS real-time gauges + `acueductos.pr.gov` | gauges hourly |
| Telecom — Liberty & Claro | Whether each network is visible on the internet vs. its 24 h baseline, plus active outage alerts | IODA (Georgia Tech) for AS14638 Liberty, AS11992 Liberty Mobile, AS10396 Claro/Datacom Caribe, and Puerto Rico overall | ~5–10 min |

A GitHub Action runs `scripts/collect.mjs` every 10 minutes, saves `docs/status.json` and a 7-day `docs/history.json`, and GitHub Pages serves `docs/index.html`. No server, no API keys, no cost.

## Set it up (about 5 minutes, works from a phone browser)

1. Create a free GitHub account if you don't have one, then make a **new public repository** (e.g. `pr-status`).
2. Upload everything in this folder, keeping the folders (`.github/workflows/`, `docs/`, `scripts/`, `test/`). On github.com: **Add file → Upload files** and drag in the unzipped folder contents.
   - The `.github` folder is hidden on some computers. If it doesn't upload, use **Add file → Create new file**, type `.github/workflows/collect.yml` as the name, and paste the file's contents.
3. **Settings → Actions → General → Workflow permissions →** choose *Read and write permissions* → Save.
4. **Actions** tab → *Collect utility status* → **Run workflow**. Wait ~1 minute for the green check.
5. **Settings → Pages →** Source: *Deploy from a branch*, Branch: `main`, folder: `/docs` → Save.
6. After a minute your app is live at `https://<your-username>.github.io/<repo>/`. On your phone, use **Share → Add to Home Screen** so it opens like an app.

From then on it refreshes itself every ~10 minutes (GitHub sometimes delays scheduled runs). Tap **Run workflow** for an instant update.

## Run it on a computer instead

```bash
node scripts/collect.mjs        # needs Node 20+, no installs
cd docs && python3 -m http.server 8000   # open http://localhost:8000
node --test test/parsers.test.mjs        # parser tests
```

## How the status lights are decided

- **Power:** under 1% of customers out = Normal, 1–5% = Watch, 5%+ = Problem.
- **Generation:** uses Genera PR's published reserve bands — under 100 MW limited, 100–400 narrow (Watch), 400–600 moderate, 600+ sufficient.
- **Water:** Watch when more than half the tracked reservoirs fell over 0.5 ft in the past week. For your street's rationing schedule, use the **MiZona** link — AAA's zone map has no public feed.
- **Telecom:** Outage if IODA has an active critical alert or a network drops below 80% of its normal visibility; Degraded below 93%.

## Caveats (read these)

- **LUMA's API is undocumented.** It's what LUMA's own outage map calls, and several open-source trackers use it, but LUMA can change or block it at any time. LUMA has also asked at least one aggregator (poweroutage.us) to stop republishing its data — fine for personal use, think twice before promoting a public mirror.
- **Genera's page may draw its numbers with JavaScript.** The collector reads the figures if they're in the page's HTML. If they aren't, that panel shows a clear "couldn't read" message with a link to the live page. If that happens, open an issue on your repo and capture the page's network requests in your browser's dev tools — there's usually a JSON endpoint behind it that a small change can read directly.
- **"PREPA" today** owns the plants; Genera PR operates them and LUMA runs the grid. Private plants (AES, EcoEléctrica) are only in Genera's system-wide totals.
- **Liberty and Claro publish no outage feed.** IODA catches network-wide failures (the kind that hit after storms or island-wide blackouts) but not a single neighborhood's cable cut or a cell-tower problem.
- The parsers were tested against sample responses, not live ones (this was built in a sandbox without internet). The first Action run's log prints `ok`/`FAIL` per source. If a source fails, its panel says why and the others keep working.
