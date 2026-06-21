# ✦ Stellaria

An interactive, GPU-accelerated star atlas and constellation engine that renders the night sky in real time. Built with SvelteKit, Three.js, and custom GLSL shaders.

## Overview

Stellaria places you at the center of a celestial sphere and lets you look around the night sky as it appears from any location on Earth, at any time. Drag to pan across the heavens, scroll to zoom, and click on any star to identify it.

The catalog is derived from the **Hipparcos** mission — 8,835 stars down to magnitude ~7.5 — each rendered with its true color index (B-V) and apparent brightness. Constellation outlines from IAU-defined star pairs are overlaid on the sky.

## Features

- **8,835 Hipparcos stars** rendered as GPU point sprites with per-star color from B-V color index
- **Real-time sidereal tracking** — GMST/LST computed from J2000 epoch, sky rotates with Earth
- **Location-aware** — set latitude/longitude to see the sky from anywhere on Earth
- **Time scrubbing** — jump to "Now", step ±1 hour, or animate at 5 min/s or 1 h/s
- **88 IAU constellations** with named star labels and line overlays
- **Custom GLSL shaders** — stellar color interpolation (O→B→A→F→G→K→M), magnitude-based point sizing, atmospheric alpha fade near horizon
- **Planetarium-style camera** — origin-locked perspective camera with azimuth/altitude look controls and FOV-based zoom (20°–110°)
- **Star picking** — click any star to see its Hipparcos ID, magnitude, and spectral class

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | SvelteKit + TypeScript |
| Rendering | Three.js (WebGL2, custom ShaderMaterial) |
| Shaders | GLSL ES 3.0 (vertex + fragment) |
| Catalog | Hipparcos (binary packed, streamed fetch) |
| Build | Vite + @sveltejs/adapter-static |
| Astronomy | Custom J2000 coordinate math (GMST, alt-az, equatorial→horizontal) |

## Project Structure

```
src/
├── lib/
│   ├── astronomy/
│   │   └── coordinates.ts      # GMST, LST, radec→vector, alt-az→horizontal
│   ├── catalog/
│   │   ├── CatalogLoader.ts     # Binary star data fetch & parse
│   │   └── types.ts             # Star, NamedStar, ConstellationLine interfaces
│   ├── engine/
│   │   └── SkyControls.ts       # Planetarium camera (drag, zoom, look-at)
│   ├── renderer/
│   │   ├── StarRenderer.ts       # THREE.Points + buffer geometry for stars
│   │   ├── ConstellationRenderer.ts  # Line segments for constellation outlines
│   │   └── shaders.ts           # GLSL vertex/fragment shaders
│   └── stores/
│       └── sky.ts               # Svelte reactive state (location, time, view)
├── routes/
│   ├── +page.svelte             # Main canvas + HUD overlay
│   ├── +layout.svelte           # App shell
│   └── +layout.ts               # SSR/prerender config
└── app.html                     # HTML template
```

## Catalog Data

Star positions are stored as a packed binary file (`static/catalog/stardata`) containing 8,835 records, each with RA, Dec, magnitude, B-V color index, Hipparcos ID, constellation index, and spectral class code. The file is fetched at runtime and decoded into a `Float32Array` position buffer.

Constellation data includes:
- `constellations.json` — 88 IAU constellation definitions (IAU abbreviation, full name)
- `constellation-lines.json` — star pair edges defining each constellation's outline
- `named-stars.json` — traditional proper names for bright stars (Sirius, Vega, Betelgeuse, etc.)

## Astronomy

Positions use the **J2000.0 equatorial frame**. Precession and nutation are omitted in v0.1 (sub-degree accuracy loss, acceptable for visual use). The transform chain is:

1. **RA/Dec → unit vector** (J2000 equatorial)
2. **Rotation by local sidereal time + latitude** (equatorial → horizontal)
3. **Perspective projection** from origin-locked camera

The sidereal time calculation follows the IAU 1982 GMST formula:
```
GMST = 280.46061837 + 360.98564736629 × d  (degrees, d = days since J2000)
LST = GMST + longitude
```

## Shader Pipeline

The vertex shader transforms each star's unit vector through a `mat3` rotation uniform (`uRotation`) that encodes the equatorial-to-horizontal frame rotation, scales by `uRadius` (1000 units), and projects through the camera. Fragment shader interpolates stellar color across the B-V range:

| B-V | Class | Color |
|-----|-------|-------|
| -0.4 | O | Blue |
| 0.0 | B/A | White-blue |
| 0.5 | F/G | White-yellow |
| 1.0 | K | Orange |
| 2.0 | M | Red |

Point size scales with apparent magnitude; stars below the user-set magnitude limit are culled in the shader.

## Roadmap

- [ ] Precession correction (J2000 → date-of-epoch)
- [x] Deep-sky objects (Messier, NGC) — 109 Messier objects with type-colored markers
- [x] Milky Way band rendering (procedural, 40k GPU point sprites)
- [x] Ecliptic and galactic plane overlays (great-circle LineLoops)
- [ ] Exoplanet marker integration
- [ ] Mobile touch gestures (pinch-zoom already supported)

## License

MIT © 2026 Tirta Dhila
