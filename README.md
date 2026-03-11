# eVTOL Sizer v2.0 — Trail 1

Full aircraft sizing and analysis tool for the Trail 1 lift+cruise hybrid tilt-rotor eVTOL.

## Features
- Weight & balance convergence loop (MTOW, battery, structural)
- Wing & aerodynamics sizing (NACA 4-digit, drag polar, CL/CD)
- Propulsion sizing (hover rotors + tilt rotors + tail pusher)
- Battery pack sizing with cell-level specific energy
- V-tail (ruddervator) sizing with stability margins
- CG/NP/static margin computation
- 10-tab dashboard with recharts visualisations
- **OpenVSP AngelScript export** — downloads a `.as` script, run inside OpenVSP via File → Run Script → instantly generates a valid `.vsp3` model

## Quick Start

```bash
npm install
npm run dev
```
Open http://localhost:5173

## Deploy to GitHub Pages

Push to `main` branch — GitHub Actions builds and deploys automatically.

## OpenVSP Export

1. Go to the **OpenVSP** tab
2. Set tilt angle (0° = cruise, 90° = hover)
3. Click **Download .as**
4. In OpenVSP 3.48.2: **File → Run Script** → select the `.as` file
5. Model builds and saves as `Trail1_eVTOL_tiltXXdeg.vsp3`

## Trail 1 Propulsion Layout
- 2× wingtip tilt rotors (tilt between cruise and hover)
- 4× boom-mounted lift rotors (2 fore + 2 aft, fixed vertical)
- 1× tail pusher propeller (horizontal cruise thrust)
