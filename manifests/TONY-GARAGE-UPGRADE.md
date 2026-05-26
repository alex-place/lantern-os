# Tony Garage Upgrade

Generated: 2026-05-26.

Purpose: turn the Movie 1 Tony Stark confidence read into an actual Lantern OS
operator cockpit.

## Added

| Artifact | Path | Use |
|---|---|---|
| Garage surface | `surfaces/tony-garage/index.html` | first-screen operator cockpit |
| Garage styles | `surfaces/tony-garage/styles.css` | responsive visual workbench |
| Garage launcher | `scripts/Open-TonyGarage.ps1` | opens the cockpit locally |
| Garage script | `surfaces/tony-garage/garage.js` | cache-busts local links and marks new-tab links |

## What It Shows

- pushed master repo state;
- zero-issue convergence loop state;
- whitepaper and ADS print links;
- RAG house and asset spine;
- wallet bench with cleared cash separated from draft invoice;
- dual-boot prep and held install boundary;
- next 4 actions for cash and dual boot.

## Accessibility / UX Pass

- Skip link added.
- Main landmark target added.
- Visible focus styles added.
- New-tab links are labeled and opened with `noopener noreferrer`.
- CSS/image/document links use cache-busting query strings.
- Mobile layout tightened below 560px.
- Reduced-motion preference respected.

## Validation

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-TonyGarageSurface.ps1
```

Latest output:

```text
manifests/validation/TONY-GARAGE-SURFACE-LATEST.json
```

## Boundary

The garage surface is an operator cockpit. It does not claim v1.0.0, fake cash,
automatic disk changes, or automatic media downloads.
