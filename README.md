# EmberScope

**Wildfire risk visualization for any property — in your browser, with no install.**

EmberScope is a single-page web app that lets you search an address, drop a property box on real satellite imagery, and watch a cellular-automata wildfire spread across your parcel under realistic fire weather conditions. It gives homeowners a plain-language risk read and gives insurance/risk assessors the actuarial-style numbers they need (ignition probability, flame length, rate of spread, defensible-space score, ember exposure).

It's designed so that as LiDAR drone scans become available they can replace the synthetic fuel layer — but it already produces location-varying estimates today using free public data.

---

## What it does

- Search any address worldwide (three geocoder fallbacks — Photon, Nominatim, Maps.co)
- Drop a draggable, resizable parcel rectangle on real Esri World Imagery
- Auto-fill live wind direction, wind speed and humidity from Open-Meteo
- Infer the local biome (chaparral, montane conifer, grassland, southern pine, etc.) and shift the fuel mix accordingly
- Pull the state's median home value (Zillow/ACS) and regional wildfire-risk multiplier (NIFC/USDA WUI) so loss estimates vary by region
- Simulate fire spread as a Rothermel/Anderson-inspired cellular automaton with wind/slope/moisture/fuel coupling
- Show a pre-ignition "cone of likely spread" so users can see where the fire would run before it starts
- Report estimated property loss, rate of spread, flame length, ember cast distance, defensible-space score
- Recommend mitigation (Zone 0/1/2, home hardening) + goat-grazing service for shrub reduction

## Stack

- Single HTML file, single JS file. No build step.
- Leaflet 1.9 for mapping (CDN)
- Esri World Imagery basemap
- Open-Meteo API for live weather + elevation
- Photon / Nominatim / Maps.co for geocoding
- Inter font from Google Fonts
- Pure vanilla JS — no frameworks

## Files

```
wildfire-risk-app.html   # the page + all styling
wildfire-app.js          # all behavior (search, map, sim, panels)
```

## Running it

Because it's a static page, any of these work:

**Double-click:** open `wildfire-risk-app.html` in your browser. Works from `file://`.

**Simple local server (recommended):**
```bash
# Python 3
python -m http.server 8000
# or Node
npx serve .
```
Then visit `http://localhost:8000/wildfire-risk-app.html`.

**Deploy it free:**
- **GitHub Pages** — push this repo, go to Settings → Pages, pick the `main` branch, and you'll get a public URL in about a minute.
- **Netlify / Vercel** — drag the folder onto their dashboard. Done.

## How the simulation works

The parcel is discretized to a 120×160-ish cell grid. Each cell has a fuel type (grass, shrub, tree, structure, road, cleared) and a burn state (unburned, burning, burned). Every sim tick each burning cell attempts to ignite its 8 neighbors with a probability computed from:

- **Fuel value** — grass/shrub/tree each have their own flammability
- **Wind alignment** — spread is strongly favored in the wind direction, with magnitude scaled by wind speed
- **Moisture** — higher fuel moisture suppresses ignition probability non-linearly
- **Slope** — upslope spread is faster when wind aligns with slope

It's a research-grade approximation, not a physics-accurate fire model — the goal is decision-useful visualization, not predictive certainty.

## Data sources

| Layer | Source | Role |
|---|---|---|
| Satellite imagery | Esri World Imagery | Basemap tiles |
| Geocoding | Photon (Komoot) → Nominatim → Maps.co | Address → lat/lon |
| Live weather | Open-Meteo | Wind, humidity, elevation |
| Home values | State medians (Zillow / ACS 2024) | Regional loss baseline |
| Wildfire risk | State-level NIFC/USDA WUI index | Regional risk multiplier |
| Fuel grid | Synthetic (value-noise) today; LiDAR drone scan planned | Fuel map |

## Roadmap

- Upload + ingest LiDAR point clouds to replace synthetic fuel
- Integrate LANDFIRE fuel-model tiles
- Hindcasting: replay historical wildfire events against a user's parcel
- Insurance-grade PDF report export
- Mobile / tablet layout polish

## License

MIT — see [LICENSE](./LICENSE).

## Credits

Built on Claude. Satellite imagery © Esri. Geocoding courtesy of Photon, OpenStreetMap / Nominatim, and Maps.co. Weather data courtesy of Open-Meteo.
