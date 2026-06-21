<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { StarRenderer } from '$lib/renderer/StarRenderer';
  import { ConstellationRenderer } from '$lib/renderer/ConstellationRenderer';
  import { MilkyWayRenderer } from '$lib/renderer/MilkyWayRenderer';
  import { PlaneOverlayRenderer } from '$lib/renderer/PlaneOverlayRenderer';
  import { DeepSkyRenderer, type DeepSkyObject } from '$lib/renderer/DeepSkyRenderer';
  import { ExoplanetRenderer, type Exoplanet } from '$lib/renderer/ExoplanetRenderer';
  import { SkyControls } from '$lib/engine/SkyControls';
  import {
    loadStarCatalog, loadNamedStars, loadConstellationLines,
    loadConstellationNames, loadMessierCatalog, loadExoplanetCatalog,
    radecToVector, SPHERE_RADIUS
  } from '$lib/catalog/CatalogLoader';
  import { rotationMatrix, lstDegrees, gmstDegrees, degToHms, degToDms, horizontalToAltAz, raDecToAltAz } from '$lib/astronomy/coordinates';
  import { SPECTRAL_NAMES } from '$lib/catalog/types';
  import { skyState, selectedStar } from '$lib/stores/sky';
  import type { Star, NamedStar } from '$lib/catalog/types';

  let canvas: HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let controls: SkyControls;
  let starRenderer: StarRenderer;
  let constellationRenderer: ConstellationRenderer;
  let milkyWayRenderer: MilkyWayRenderer;
  let planeOverlay: PlaneOverlayRenderer;
  let deepSkyRenderer: DeepSkyRenderer | null = null;
  let exoRenderer: ExoplanetRenderer | null = null;
  let raycaster = new THREE.Raycaster();

  let stars: Star[] = [];
  let namedStars: NamedStar[] = [];
  let conNames: string[] = [];
  let hipToStar = new Map<number, Star>();
  let nameByHip = new Map<number, string>();
  let rotationMat = new THREE.Matrix3();

  let running = false;
  let rafId = 0;
  let lastUpdateMs = 0;

  // UI-bound locals
  let lat = 0, lon = 0, locationLabel = 'Detecting...';
  let dateMs = Date.now();
  let showCons = true;
  let showMilkyWay = true;
  let showEcliptic = true;
  let showGalactic = false;
  let showDSO = true;
  let selectedDSO: DeepSkyObject | null = null;
  let showExo = true;
  let selectedExo: Exoplanet | null = null;
  let showNames = false;
  let showConNames = false;
  let showCompass = true;
  let magLimit = 6.0;
  let fovLabel = 75;
  let azLabel = 0, altLabel = 45;
  let lstLabel = '';
  let gmstLabel = '';
  let utcLabel = '';
  let timeSpeed = 0; // 0 = real-time, else seconds per second
  let lastClockMs = Date.now();
  let hud = { lat, lon, lst: '', fov: 75, az: 0, alt: 45, stars: 0, cons: 0 };
  let selected: any = null;
  let loadMsg = 'Loading star catalog...';
  let cursorAz = 0, cursorAlt = 0, cursorVisible = false;
  let trackTarget: { ra: number; dec: number; name: string } | null = null;
  let searchQuery = '';
  let searchResults: { name: string; ra: number; dec: number; kind: string }[] = [];
  let searchOpen = false;
  let visibleStarCount = 0;
  let dsoCount = 0;
  let exoCount = 0;
  let constellationCount = 0;
  let dateInput = '';

  // Label overlay state — updated in animate() with throttling.
  // Star labels: only named stars with mag below threshold and currently in front of camera.
  // Constellation labels: IAU constellation name at its centroid (computed once on load).
  let nameLabels: { name: string; x: number; y: number; mag: number }[] = [];
  let conLabels: { name: string; x: number; y: number }[] = [];
  // Precomputed constellation centroids in J2000 equatorial unit vectors.
  let conCentroids: { idx: number; name: string; x: number; y: number; z: number }[] = [];
  let lastLabelMs = 0;
  const _v3 = new THREE.Vector3();
  const _proj = new THREE.Vector3();

  function updateRotation() {
    if (!starRenderer || !constellationRenderer) return;
    const m = rotationMatrix(new Date(dateMs), lat, lon);
    rotationMat.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    starRenderer.setRotation(rotationMat);
    constellationRenderer.setRotation(rotationMat);
    if (milkyWayRenderer) milkyWayRenderer.setRotation(rotationMat);
    if (planeOverlay) planeOverlay.setRotation(rotationMat);
    if (deepSkyRenderer) deepSkyRenderer.setRotation(rotationMat);
    if (exoRenderer) exoRenderer.setRotation(rotationMat);
    lastUpdateMs = dateMs;
    const d = new Date(dateMs);
    lstLabel = degToHms(lstDegrees(d, lon));
    gmstLabel = degToHms(gmstDegrees(d));
    utcLabel = d.toISOString().slice(11, 19) + ' UTC';
    dateInput = d.toISOString().slice(0, 10);
    // If tracking, re-point camera at the target's current alt/az
    if (trackTarget && controls) {
      const { az, alt } = raDecToAltAz(trackTarget.ra, trackTarget.dec, d, lat, lon);
      controls.lookAt(az, alt);
    }
  }

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function animate() {
    if (!running) return;
    if (timeSpeed !== 0) {
      const now = Date.now();
      const dt = (now - lastClockMs) / 1000;
      lastClockMs = now;
      dateMs += dt * timeSpeed * 1000;
    } else {
      lastClockMs = Date.now();
    }
    // Recompute rotation when the effective time has moved by >30s of sidereal time
    if (Math.abs(dateMs - lastUpdateMs) > 30000) {
      updateRotation();
      estimateVisibleStars();
    }
    azLabel = controls.azimuth;
    altLabel = controls.altitude;
    fovLabel = controls.fov;
    // Label overlay — throttle to ~15fps to keep DOM churn low.
    const nowMs = performance.now();
    if ((showNames || showConNames) && (nowMs - lastLabelMs > 65)) {
      updateLabels();
      lastLabelMs = nowMs;
    }
    renderer.render(scene, camera);
    rafId = requestAnimationFrame(animate);
  }

  function onClick(e: MouseEvent) {
    if (!starRenderer) return;
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    // The shader rotates `position` (equatorial J2000) by uRotation into the
    // horizontal frame at render time, so what the user sees is rotated. The
    // geometry attribute itself stays equatorial, so raycaster.intersectObject
    // would test the ray against equatorial positions and always hit the same
    // star whose equatorial coord happens to lie near the default camera ray.
    // Fix: inverse-rotate the ray from camera/horizontal frame back into the
    // equatorial frame so the pick matches what the user actually clicked.
    const R = (starRenderer.material as THREE.ShaderMaterial).uniforms.uRotation.value as THREE.Matrix3;
    const Rinv = new THREE.Matrix3().copy(R).invert();
    raycaster.ray.origin.applyMatrix3(Rinv);
    raycaster.ray.direction.applyMatrix3(Rinv).normalize();

    // Try DSO pick first — Messier markers are bigger targets
    if (deepSkyRenderer && showDSO) {
      raycaster.params.Points!.threshold = 0.06;
      const dsoHits = raycaster.intersectObject(deepSkyRenderer.points, false);
      if (dsoHits.length > 0) {
        const dso = deepSkyRenderer.objects[dsoHits[0].index!];
        if (dso) {
          selectedDSO = dso;
          selectedStar.set(null);
          selected = null;
          selectedExo = null;
          return;
        }
      }
    }

    // Exoplanet hosts — diamond markers, similar pick radius to DSO
    if (exoRenderer && showExo) {
      raycaster.params.Points!.threshold = 0.06;
      const exoHits = raycaster.intersectObject(exoRenderer.points, false);
      if (exoHits.length > 0) {
        const exo = exoRenderer.objects[exoHits[0].index!];
        if (exo) {
          selectedExo = exo;
          selectedStar.set(null);
          selected = null;
          selectedDSO = null;
          return;
        }
      }
    }

    raycaster.params.Points!.threshold = 0.08; // ~4.6° on unit sphere — click-friendly
    const hits = raycaster.intersectObject(starRenderer.points, false);
    if (hits.length === 0) { selectedStar.set(null); selected = null; selectedDSO = null; selectedExo = null; return; }
    // Filter out the Sun (Sol, index 0, mag -26.7) — it is not on the celestial
    // sphere and its extreme magnitude would always win any brightness sort.
    const magAttr = starRenderer.points.geometry.getAttribute('aMag') as THREE.BufferAttribute;
    const valid = hits.filter(h => magAttr.getX(h.index!) > -20);
    if (valid.length === 0) { selectedStar.set(null); selected = null; selectedDSO = null; selectedExo = null; return; }
    // Pick the star closest to where the user clicked (distanceToRay), using
    // brightness as a tiebreaker so a faint star directly behind a bright one
    // doesn't win purely on position noise.
    valid.sort((a, b) => {
      const da = (a.distanceToRay ?? 0) - (b.distanceToRay ?? 0);
      if (Math.abs(da) > 0.001) return da;
      return magAttr.getX(a.index!) - magAttr.getX(b.index!);
    });
    const idx = valid[0].index!;
    const s = stars[idx];
    const [cx, cy, cz] = radecToVector(s.ra, s.dec, 1);
    const [hx, hy, hz] = applyRot(rotationMat, cx, cy, cz);
    const { az, alt } = horizontalToAltAz(hx, hy, hz);
    const conName = conNames[s.con] || '—';
    const name = nameByHip.get(s.hip) || `HIP ${s.hip || '?'}`;
    const sel = {
      name, hip: s.hip, ra: s.ra, dec: s.dec, mag: s.mag, ci: s.ci,
      con: conName, spect: s.spect < 7 ? SPECTRAL_NAMES[s.spect] : '—', alt, az
    };
    selectedStar.set(sel);
    selected = sel;
    selectedDSO = null;
    selectedExo = null;
  }

  function applyRot(m: THREE.Matrix3, x: number, y: number, z: number): [number, number, number] {
    const e = m.elements;
    return [
      e[0] * x + e[3] * y + e[6] * z,
      e[1] * x + e[4] * y + e[7] * z,
      e[2] * x + e[5] * y + e[8] * z
    ];
  }

  /** Point camera at a J2000 RA/Dec using current date/location. */
  function lookAtRaDec(ra: number, dec: number, name?: string) {
    if (!controls) return;
    const { az, alt } = raDecToAltAz(ra, dec, new Date(dateMs), lat, lon);
    trackTarget = name ? { ra, dec, name } : null;
    controls.lookAt(az, alt);
    azLabel = az; altLabel = alt;
  }

  function trackSelected() {
    if (selected) {
      trackTarget = { ra: selected.ra, dec: selected.dec, name: selected.name };
    } else if (selectedExo) {
      trackTarget = { ra: selectedExo.ra, dec: selectedExo.dec, name: selectedExo.name };
    } else if (selectedDSO) {
      trackTarget = { ra: selectedDSO.ra, dec: selectedDSO.dec, name: 'M' + selectedDSO.m };
    }
  }

  function stopTracking() {
    trackTarget = null;
  }

  // Search: name → RA/Dec across named stars, exoplanets, Messier, constellations.
  function runSearch() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) { searchResults = []; return; }
    const out: { name: string; ra: number; dec: number; kind: string }[] = [];
    for (const n of namedStars) {
      if (n.name && n.name.toLowerCase().includes(q) && n.hip > 0) {
        out.push({ name: n.name, ra: n.ra, dec: n.dec, kind: 'star' });
      }
    }
    if (exoRenderer) {
      for (const e of exoRenderer.objects) {
        if (e.host.toLowerCase().includes(q) || e.name.toLowerCase().includes(q)) {
          out.push({ name: e.name, ra: e.ra, dec: e.dec, kind: 'exoplanet' });
        }
      }
    }
    if (deepSkyRenderer) {
      for (const d of deepSkyRenderer.objects) {
        if (d.name.toLowerCase().includes(q) || ('m' + d.m).includes(q)) {
          out.push({ name: 'M' + d.m + ' — ' + d.name, ra: d.ra, dec: d.dec, kind: 'messier' });
        }
      }
    }
    searchResults = out.slice(0, 12);
  }

  function pickSearch(r: { name: string; ra: number; dec: number; kind: string }) {
    lookAtRaDec(r.ra, r.dec, r.name);
    searchOpen = false;
    searchQuery = '';
    searchResults = [];
  }

  // Quick jump presets — hand-picked objects spanning both hemispheres.
  const JUMP_TARGETS: { label: string; ra: number; dec: number; sub: string }[] = [
    { label: 'Polaris', ra: 37.95, dec: 89.26, sub: 'North Celestial Pole' },
    { label: 'Orion Nebula', ra: 83.82, dec: -5.39, sub: 'M42' },
    { label: 'Pleiades', ra: 56.85, dec: 24.12, sub: 'M45' },
    { label: 'Sirius', ra: 101.29, dec: -16.72, sub: 'α CMa' },
    { label: 'Andromeda', ra: 10.68, dec: 41.27, sub: 'M31' },
    { label: 'Galactic Center', ra: 266.42, dec: -29.01, sub: 'Sgr A*' },
    { label: 'Vega', ra: 279.23, dec: 38.78, sub: 'α Lyr' },
    { label: 'Proxima Cen', ra: 217.43, dec: -62.68, sub: 'nearest star' },
    { label: 'Crab Nebula', ra: 83.63, dec: 22.01, sub: 'M1' },
    { label: 'Ring Nebula', ra: 283.40, dec: 33.03, sub: 'M57' },
    { label: 'TRAPPIST-1', ra: 346.62, dec: -5.03, sub: '7-planet system' },
    { label: 'Sombrero', ra: 189.99, dec: -11.62, sub: 'M104' },
  ];

  function jumpTo(t: { label: string; ra: number; dec: number; sub: string }) {
    lookAtRaDec(t.ra, t.dec, t.label);
  }

  // Live cursor alt/az readout — project the screen point onto the celestial
  // sphere and read its horizontal coordinate.
  function onMouseMove(e: MouseEvent) {
    if (!canvas || !controls) return;
    const rect = canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(new THREE.Vector2(nx, ny), camera);
    // Intersect unit sphere centered at origin (camera is at origin).
    const dir = raycaster.ray.direction.clone();
    const t = -raycaster.ray.origin.dot(dir) / dir.dot(dir);
    if (t <= 0) { cursorVisible = false; return; }
    const hit = raycaster.ray.origin.clone().add(dir.multiplyScalar(t));
    // hit is in the horizontal frame (camera space) — already alt/az.
    const { az, alt } = horizontalToAltAz(hit.x, hit.y, hit.z);
    cursorAz = az; cursorAlt = alt;
    cursorVisible = true;
  }

  function onMouseLeave() { cursorVisible = false; }

  function applyDate() {
    if (!dateInput) return;
    const newDate = new Date(dateInput + 'T' + new Date(dateMs).toISOString().slice(11, 19) + 'Z');
    if (!isNaN(newDate.getTime())) {
      dateMs = newDate.getTime();
      updateRotation();
    }
  }

  function setTimeSpeed(v: number) {
    timeSpeed = v;
    lastClockMs = Date.now();
  }

  function estimateVisibleStars() {
    if (!starRenderer || !stars.length) { visibleStarCount = 0; return; }
    // Approximate: stars with mag ≤ magLimit AND currently above horizon.
    // Full per-frame culling is done in the shader; this is a coarse estimate.
    let count = 0;
    const m = rotationMatrix(new Date(dateMs), lat, lon);
    const rotMat3 = new THREE.Matrix3().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    const up = new THREE.Vector3(0, 1, 0); // y=up in horizontal frame
    const v = new THREE.Vector3();
    for (const s of stars) {
      if (s.mag > magLimit) continue;
      const [x, y, z] = radecToVector(s.ra, s.dec, 1);
      v.set(x, y, z).applyMatrix3(rotMat3);
      if (v.y > -0.05) count++; // slightly below horizon to account for refraction
    }
    visibleStarCount = count;
  }

  function detectLocation() {
    if (!navigator.geolocation) { setDefaultLocation(); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        lat = +pos.coords.latitude.toFixed(4);
        lon = +pos.coords.longitude.toFixed(4);
        locationLabel = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
        afterLocation();
      },
      () => { setDefaultLocation(); },
      { timeout: 8000 }
    );
  }

  function setDefaultLocation() {
    // Equator default so the whole sky is visible
    lat = 0; lon = 0;
    locationLabel = '0°, 0° (equator)';
    afterLocation();
  }

  function afterLocation() {
    updateRotation();
    skyState.update(s => ({ ...s, latitude: lat, longitude: lon, dateMs, ready: true }));
    running = true;
    lastClockMs = Date.now();
    estimateVisibleStars();
    animate();
  }

  function applyManualLocation() {
    lat = +lat; lon = +lon;
    locationLabel = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    updateRotation();
    estimateVisibleStars();
  }

  function resetTime() { dateMs = Date.now(); timeSpeed = 0; updateRotation(); }
  function stepTime(sec: number) { dateMs += sec * 1000; updateRotation(); }

  function toggleCons() {
    showCons = !showCons;
    constellationRenderer.setVisible(showCons);
  }

  function toggleMilkyWay() {
    showMilkyWay = !showMilkyWay;
    if (milkyWayRenderer) milkyWayRenderer.setVisible(showMilkyWay);
  }

  function toggleEcliptic() {
    showEcliptic = !showEcliptic;
    if (planeOverlay) planeOverlay.setEclipticVisible(showEcliptic);
  }

  function toggleGalactic() {
    showGalactic = !showGalactic;
    if (planeOverlay) planeOverlay.setGalacticVisible(showGalactic);
  }

  function toggleDSO() {
    showDSO = !showDSO;
    if (deepSkyRenderer) deepSkyRenderer.setVisible(showDSO);
  }

  function toggleExo() {
    showExo = !showExo;
    if (exoRenderer) exoRenderer.setVisible(showExo);
  }

  function toggleNames() {
    showNames = !showNames;
    if (!showNames) nameLabels = [];
  }

  function toggleConNames() {
    showConNames = !showConNames;
    if (!showConNames) conLabels = [];
  }

  /** Project a J2000 equatorial unit vector (x,y,z) into screen-space pixel coords.
   *  Returns null if the point is behind the camera or outside the viewport. */
  function projectToScreen(eqX: number, eqY: number, eqZ: number): { x: number; y: number } | null {
    // Apply equatorial → horizontal frame rotation (same as vertex shader).
    _v3.set(eqX, eqY, eqZ).applyMatrix3(rotationMat);
    // Place on the celestial sphere at SPHERE_RADIUS.
    _v3.multiplyScalar(SPHERE_RADIUS);
    // Transform into camera space. Camera looks down −z, so points in front
    // have z < 0; points behind the camera have z > 0 — filter those out
    // *before* the projection matrix divides by w (which flips signs and
    // makes the NDC z test unreliable for behind-camera points).
    _v3.applyMatrix4(camera.matrixWorldInverse);
    if (_v3.z > 0) return null;
    // Apply projection matrix → NDC.
    _proj.copy(_v3).applyMatrix4(camera.projectionMatrix);
    // NDC → screen pixel
    const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    if (sx < -40 || sx > window.innerWidth + 40 || sy < -40 || sy > window.innerHeight + 40) return null;
    return { x: sx, y: sy };
  }

  /** Rebuild label overlay positions. Throttled to ~12 fps inside animate().
   *  Named stars: filtered by magnitude threshold + visibility.
   *  Constellations: centroid (precomputed at load). */
  function updateLabels() {
    if (!showNames && !showConNames) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (showNames) {
      const out: { name: string; x: number; y: number; mag: number }[] = [];
      // Label only named stars brighter than a fixed mag threshold so the sky
      // doesn't get cluttered. Use a tighter limit than the render magLimit.
      const labelMagCut = Math.min(magLimit, 4.5);
      for (const n of namedStars) {
        if (!n.hip || n.hip <= 0) continue;
        if (n.mag > labelMagCut) continue;
        const [x, y, z] = radecToVector(n.ra, n.dec, 1);
        const p = projectToScreen(x, y, z);
        if (p) out.push({ name: n.name, x: p.x, y: p.y, mag: n.mag });
      }
      nameLabels = out;
    }
    if (showConNames) {
      const out: { name: string; x: number; y: number }[] = [];
      for (const c of conCentroids) {
        const p = projectToScreen(c.x, c.y, c.z);
        if (p) out.push({ name: c.name, x: p.x, y: p.y });
      }
      conLabels = out;
    }
  }

  function changeMagLimit() {
    starRenderer.setMagLimit(magLimit);
    estimateVisibleStars();
  }

  onMount(async () => {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000010, 1);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, SPHERE_RADIUS * 4);
    onResize();
    window.addEventListener('resize', onResize);

    loadMsg = 'Fetching star catalog...';
    try {
      console.log('STELLARIA: onMount started, about to fetch');
      const _t0 = performance.now();
      const catResult = await Promise.all([
        loadStarCatalog(), loadNamedStars(), loadConstellationLines(), loadConstellationNames(),
        loadMessierCatalog(), loadExoplanetCatalog()
      ]);
      console.log('STELLARIA: Promise.all resolved', catResult[0].length, 'stars');
      [stars, namedStars, , conNames] = catResult;
      const messierData = catResult[4];
      const exoData = catResult[5];
      loadMsg = `Loaded ${stars.length} stars, ${namedStars.length} named, ${conNames.length} constellations`;
      await new Promise(r => setTimeout(r, 100));
      const consLines = await loadConstellationLines();
      for (const s of stars) if (s.hip) hipToStar.set(s.hip, s);
      // Only register names for valid HIP numbers — multiple named-stars entries
      // share hip=0 (Sol, Castor B, Guniibuu B, ...) and would otherwise collide,
      // making nameByHip.get(0) return the last-inserted name ("Guniibuu B").
      for (const n of namedStars) if (n.hip && n.hip > 0) nameByHip.set(n.hip, n.name);

      const hipToVec = new Map<number, [number, number, number]>();
      for (const s of stars) if (s.hip) hipToVec.set(s.hip, radecToVector(s.ra, s.dec, 1));

      // Precompute constellation centroids (mean of all member stars' unit
      // vectors) for the constellation-name label overlay. We average in
      // Cartesian space then renormalize — this is the standard way to find
      // the centroid of points on a sphere.
      const conAccum: Map<number, { x: number; y: number; z: number; n: number }> = new Map();
      for (const s of stars) {
        if (!s.con) continue;
        const [x, y, z] = radecToVector(s.ra, s.dec, 1);
        const acc = conAccum.get(s.con) || { x: 0, y: 0, z: 0, n: 0 };
        acc.x += x; acc.y += y; acc.z += z; acc.n++;
        conAccum.set(s.con, acc);
      }
      conCentroids = [];
      for (const [idx, acc] of conAccum) {
        const len = Math.hypot(acc.x, acc.y, acc.z) || 1;
        conCentroids.push({
          idx,
          name: conNames[idx] || `Con ${idx}`,
          x: acc.x / len, y: acc.y / len, z: acc.z / len
        });
      }

      loadMsg = 'Building scene...';
      await new Promise(r => setTimeout(r, 50));
      starRenderer = new StarRenderer(stars, namedStars);
      loadMsg = 'Star renderer built';
      await new Promise(r => setTimeout(r, 50));
      constellationRenderer = new ConstellationRenderer(consLines, hipToVec);
      loadMsg = 'Constellation renderer built';
      await new Promise(r => setTimeout(r, 50));
      constellationRenderer.setVisible(showCons);
      scene.add(starRenderer.points);
      scene.add(constellationRenderer.lines);

      // Milky Way band — build last (procedural, no catalog fetch needed)
      milkyWayRenderer = new MilkyWayRenderer(40000);
      milkyWayRenderer.setVisible(showMilkyWay);
      scene.add(milkyWayRenderer.points);

      // Ecliptic + galactic plane great-circle overlays
      planeOverlay = new PlaneOverlayRenderer();
      planeOverlay.setEclipticVisible(showEcliptic);
      planeOverlay.setGalacticVisible(showGalactic);
      scene.add(planeOverlay.group);

      // Messier deep-sky objects
      if (messierData && messierData.length > 0) {
        deepSkyRenderer = new DeepSkyRenderer(messierData);
        deepSkyRenderer.setVisible(showDSO);
        scene.add(deepSkyRenderer.points);
      }

      // Notable exoplanets — diamond glyphs, type-colored, HZ ring for habitable
      if (exoData && exoData.length > 0) {
        exoRenderer = new ExoplanetRenderer(exoData);
        exoRenderer.setVisible(showExo);
        scene.add(exoRenderer.points);
      }

      controls = new SkyControls(camera, canvas);
      controls.onMove = () => { azLabel = controls.azimuth; altLabel = controls.altitude; fovLabel = controls.fov; };
      canvas.addEventListener('click', onClick);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mouseleave', onMouseLeave);

      // Populate catalog counts and initial visible-star estimate
      dsoCount = deepSkyRenderer?.objects.length ?? 0;
      exoCount = exoRenderer?.objects.length ?? 0;
      constellationCount = consLines.length;
      estimateVisibleStars();

      skyState.update(s => ({ ...s, starCount: stars.length, constellationCount: consLines.length }));
      loadMsg = '';
      detectLocation();
    } catch (err) {
      console.error('onMount error:', err);
      loadMsg = 'Error: ' + (err as Error).message + ' | ' + (err as Error).stack;
    }
  });

  onDestroy(() => {
    running = false;
    cancelAnimationFrame(rafId);
    window.removeEventListener('resize', onResize);
    canvas?.removeEventListener('click', onClick);
    canvas?.removeEventListener('mousemove', onMouseMove);
    canvas?.removeEventListener('mouseleave', onMouseLeave);
    controls?.dispose();
    starRenderer?.dispose();
    constellationRenderer?.dispose();
    milkyWayRenderer?.dispose();
    planeOverlay?.dispose();
    deepSkyRenderer?.dispose();
    exoRenderer?.dispose();
    renderer?.dispose();
  });

  $: if (stars.length && lat !== undefined && starRenderer) updateRotation();
</script>

<svelte:head><title>Stellaria — Star Atlas</title></svelte:head>

<canvas bind:this={canvas}></canvas>

{#if loadMsg}
  <div class="loader">
    <div class="loader-card">
      <div class="logo">✦</div>
      <h1>STELLARIA</h1>
      <p class="sub">Interactive Star Atlas</p>
      <div class="bar"><div class="bar-fill"></div></div>
      <p class="msg">{loadMsg}</p>
    </div>
  </div>
{/if}

<!-- Compass rose overlay — cardinal directions at screen edge -->
{#if showCompass && !loadMsg}
  <div class="compass">
    <span class="c-n">N</span>
    <span class="c-e">E</span>
    <span class="c-s">S</span>
    <span class="c-w">W</span>
  </div>
{/if}

<div class="hud" class:hidden={loadMsg}>
  <div class="hud-top">
    <div class="hud-block">
      <span class="k">Location</span>
      <span class="v">{locationLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">LST · Local Sidereal</span>
      <span class="v">{lstLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">GMST · Greenwich</span>
      <span class="v">{gmstLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">UTC</span>
      <span class="v">{utcLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">View</span>
      <span class="v">Az {azLabel.toFixed(1)}° · Alt {altLabel.toFixed(1)}° · FOV {fovLabel.toFixed(1)}°</span>
    </div>
    {#if trackTarget}
      <div class="hud-block tracked">
        <span class="k">◈ Tracking</span>
        <span class="v">{trackTarget.name}</span>
      </div>
    {/if}
  </div>
  <div class="hud-bottom">
    <div class="hud-block">
      <span class="k">Catalog stars</span>
      <span class="v">{stars.length.toLocaleString()}</span>
    </div>
    <div class="hud-block">
      <span class="k">Visible now</span>
      <span class="v">{visibleStarCount.toLocaleString()} <span class="muted">≤ mag {magLimit.toFixed(1)}</span></span>
    </div>
    <div class="hud-block">
      <span class="k">Messier</span>
      <span class="v">{dsoCount}</span>
    </div>
    <div class="hud-block">
      <span class="k">Exoplanets</span>
      <span class="v">{exoCount}</span>
    </div>
    <div class="hud-block">
      <span class="k">Constellations</span>
      <span class="v">{constellationCount}</span>
    </div>
    <div class="hud-block">
      <span class="k">Local time</span>
      <span class="v">{new Date(dateMs).toLocaleTimeString([], {hour12:false})}</span>
    </div>
    <div class="hud-block">
      <span class="k">Date</span>
      <span class="v">{new Date(dateMs).toLocaleDateString()}</span>
    </div>
    {#if cursorVisible}
      <div class="hud-block">
        <span class="k">Cursor</span>
        <span class="v">Az {cursorAz.toFixed(1)}° · Alt {cursorAlt.toFixed(1)}°</span>
      </div>
    {/if}
  </div>
</div>

<!-- Search box -->
<div class="search-wrap" class:hidden={loadMsg}>
  <input
    type="text"
    placeholder="Search star, exoplanet, Messier..."
    bind:value={searchQuery}
    on:input={runSearch}
    on:focus={() => searchOpen = true}
    on:blur={() => setTimeout(() => searchOpen = false, 150)}
  />
  {#if searchOpen && searchResults.length > 0}
    <div class="search-results">
      {#each searchResults as r}
        <button class="search-item" on:mousedown|preventDefault={() => pickSearch(r)}>
          <span class="si-name">{r.name}</span>
          <span class="si-kind">{r.kind}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<div class="controls" class:hidden={loadMsg}>
  <div class="ctrl-group">
    <button class:active={showCons} on:click={toggleCons}>Constellations</button>
    <button class:active={showMilkyWay} on:click={toggleMilkyWay}>Milky Way</button>
    <button class:active={showEcliptic} on:click={toggleEcliptic}>Ecliptic</button>
    <button class:active={showGalactic} on:click={toggleGalactic}>Galactic</button>
    <button class:active={showDSO} on:click={toggleDSO}>Messier</button>
    <button class:active={showExo} on:click={toggleExo}>Exoplanets</button>
    <button class:active={showNames} on:click={toggleNames}>Star Names</button>
    <button class:active={showConNames} on:click={toggleConNames}>Con Names</button>
    <button class:active={showCompass} on:click={() => showCompass = !showCompass}>Compass</button>
  </div>
  <div class="ctrl-group">
    <button on:click={resetTime}>Now</button>
    <button on:click={() => stepTime(-3600)}>−1h</button>
    <button on:click={() => stepTime(3600)}>+1h</button>
    <button on:click={() => stepTime(-86400)}>−1d</button>
    <button on:click={() => stepTime(86400)}>+1d</button>
  </div>
  <div class="ctrl-group">
    <button class:active={timeSpeed === 60} on:click={() => setTimeSpeed(timeSpeed === 60 ? 0 : 60)}>▶ 1m/s</button>
    <button class:active={timeSpeed === 300} on:click={() => setTimeSpeed(timeSpeed === 300 ? 0 : 300)}>▶ 5m/s</button>
    <button class:active={timeSpeed === 3600} on:click={() => setTimeSpeed(timeSpeed === 3600 ? 0 : 3600)}>▶▶ 1h/s</button>
    <button class:active={timeSpeed === 21600} on:click={() => setTimeSpeed(timeSpeed === 21600 ? 0 : 21600)}>▶▶▶ 6h/s</button>
    <button class:active={timeSpeed === 86400} on:click={() => setTimeSpeed(timeSpeed === 86400 ? 0 : 86400)}>▶▶▶▶ 1d/s</button>
    {#if timeSpeed !== 0}
      <button class="danger" on:click={() => setTimeSpeed(0)}>⏸ Pause</button>
    {/if}
  </div>
</div>

<!-- Quick jump presets -->
<div class="jump-panel" class:hidden={loadMsg}>
  <div class="jp-label">Quick Jump</div>
  <div class="jp-grid">
    {#each JUMP_TARGETS as t}
      <button class="jump-btn" on:click={() => jumpTo(t)} title={t.sub}>
        <span class="jb-name">{t.label}</span>
        <span class="jb-sub">{t.sub}</span>
      </button>
    {/each}
  </div>
</div>

<div class="loc-panel" class:hidden={loadMsg}>
  <label>Lat <input type="number" bind:value={lat} step="0.01" on:change={applyManualLocation}></label>
  <label>Lon <input type="number" bind:value={lon} step="0.01" on:change={applyManualLocation}></label>
  <label>Mag <input type="number" bind:value={magLimit} step="0.5" min="2" max="6.5" on:change={changeMagLimit}></label>
  <label>Date <input type="date" bind:value={dateInput} on:change={applyDate}></label>
</div>

{#if selected}
  <div class="info-panel">
    <div class="ip-head">
      <span class="ip-name">{selected.name}</span>
      <button class="ip-close" on:click={() => { selectedStar.set(null); selected = null; trackTarget = null; }}>×</button>
    </div>
    <div class="ip-rows">
      <div><span>Constellation</span><b>{selected.con}</b></div>
      <div><span>Magnitude</span><b>{selected.mag.toFixed(2)}</b></div>
      <div><span>Spectral</span><b>{selected.spect}</b></div>
      <div><span>RA (J2000)</span><b>{degToHms(selected.ra)}</b></div>
      <div><span>Dec (J2000)</span><b>{degToDms(selected.dec)}</b></div>
      <div><span>Altitude</span><b>{selected.alt.toFixed(1)}°</b></div>
      <div><span>Azimuth</span><b>{selected.az.toFixed(1)}°</b></div>
      <div><span>HIP</span><b>{selected.hip || '—'}</b></div>
    </div>
    <div class="ip-actions">
      <button class="ip-track" on:click={trackSelected}>
        {trackTarget?.name === selected.name ? '◆ Tracking' : '◈ Track'}
      </button>
      {#if trackTarget}
        <button class="ip-stop" on:click={stopTracking}>Stop tracking</button>
      {/if}
    </div>
    <p class="ip-hint">Tap empty sky to deselect</p>
  </div>
{/if}

{#if selectedDSO}
  <div class="info-panel">
    <div class="ip-head">
      <span class="ip-name">M{selectedDSO.m} — {selectedDSO.name}</span>
      <button class="ip-close" on:click={() => { selectedDSO = null; }}>×</button>
    </div>
    <div class="ip-rows">
      <div><span>Type</span><b>{selectedDSO.type}</b></div>
      <div><span>Constellation</span><b>{selectedDSO.const}</b></div>
      <div><span>Magnitude</span><b>{selectedDSO.mag.toFixed(2)}</b></div>
      <div><span>RA</span><b>{degToHms(selectedDSO.ra)}</b></div>
      <div><span>Dec</span><b>{degToDms(selectedDSO.dec)}</b></div>
    </div>
    <div class="ip-actions">
      <button class="ip-track" on:click={trackSelected}>
        {trackTarget?.name === 'M' + selectedDSO.m ? '◆ Tracking' : '◈ Track'}
      </button>
      {#if trackTarget}
        <button class="ip-stop" on:click={stopTracking}>Stop tracking</button>
      {/if}
    </div>
    <p class="ip-hint">Messier object · Tap empty sky to deselect</p>
  </div>
{/if}

{#if selectedExo}
  <div class="info-panel">
    <div class="ip-head">
      <span class="ip-name">{selectedExo.name}</span>
      <button class="ip-close" on:click={() => { selectedExo = null; trackTarget = null; }}>×</button>
    </div>
    <div class="ip-rows">
      <div><span>Host star</span><b>{selectedExo.host}</b></div>
      <div><span>Type</span><b>{selectedExo.type}{selectedExo.habitable ? ' · habitable' : ''}</b></div>
      <div><span>Discovery</span><b>{selectedExo.year}</b></div>
      <div><span>Orbital period</span><b>{selectedExo.period < 365
        ? `${selectedExo.period.toFixed(2)} days`
        : `${(selectedExo.period / 365.25).toFixed(2)} years`}</b></div>
      <div><span>Mass</span><b>{selectedExo.mass >= 1
        ? `${selectedExo.mass.toFixed(2)} M⊕`
        : `${selectedExo.mass.toFixed(3)} M⊕`}</b></div>
      <div><span>Radius</span><b>{selectedExo.radius.toFixed(2)} R⊕</b></div>
      <div><span>Host magnitude</span><b>{selectedExo.hostMag.toFixed(2)}</b></div>
      <div><span>RA (J2000)</span><b>{degToHms(selectedExo.ra)}</b></div>
      <div><span>Dec (J2000)</span><b>{degToDms(selectedExo.dec)}</b></div>
    </div>
    <div class="ip-actions">
      <button class="ip-track" on:click={trackSelected}>
        {trackTarget?.name === selectedExo.name ? '◆ Tracking' : '◈ Track'}
      </button>
      {#if trackTarget}
        <button class="ip-stop" on:click={stopTracking}>Stop tracking</button>
      {/if}
    </div>
    <p class="ip-hint">Exoplanet · {selectedExo.habitable ? '◈ In optimistic habitable zone' : 'Tap empty sky to deselect'}</p>
  </div>
{/if}

<!-- Star + constellation name label overlay — DOM text positioned over canvas -->
{#if !loadMsg}
  <div class="label-layer">
    {#if showNames}
      {#each nameLabels as l}
        <span class="star-label" style="left:{l.x}px;top:{l.y}px;opacity:{(1 - l.mag / 5).toFixed(2)}">{l.name}</span>
      {/each}
    {/if}
    {#if showConNames}
      {#each conLabels as l}
        <span class="con-label" style="left:{l.x}px;top:{l.y}px">{l.name}</span>
      {/each}
    {/if}
  </div>
{/if}

<div class="hint" class:hidden={loadMsg}>
  Drag to look · Scroll to zoom · Click a star for info
</div>

<style>
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; }
  .hidden { display: none !important; }
  .muted { color: var(--muted); font-size: 10px; }

  .loader {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: var(--bg); z-index: 100;
  }
  .loader-card { text-align: center; }
  .logo { font-size: 48px; color: var(--accent); margin-bottom: 8px; }
  .loader h1 { letter-spacing: 8px; font-size: 28px; font-weight: 300; color: #fff; }
  .loader .sub { color: var(--muted); letter-spacing: 3px; font-size: 11px; margin-top: 4px; }
  .bar { width: 220px; height: 2px; background: rgba(255,255,255,0.1); margin: 18px auto 0; overflow: hidden; }
  .bar-fill { height: 100%; width: 40%; background: var(--accent); animation: slide 1.2s infinite; }
  @keyframes slide { 0%{transform:translateX(-100%)} 100%{transform:translateX(350%)} }
  .msg { color: var(--muted); font-size: 12px; margin-top: 14px; font-family: var(--mono); }

  /* Compass rose — N/E/S/W pinned to screen edges */
  .compass {
    position: fixed; inset: 0; pointer-events: none; z-index: 9;
    font-family: var(--mono); font-size: 14px; font-weight: 700;
    letter-spacing: 2px;
  }
  .compass span {
    position: absolute; color: var(--accent);
    background: rgba(8, 12, 28, 0.7); border: 1px solid var(--border);
    border-radius: 50%; width: 26px; height: 26px;
    display: flex; align-items: center; justify-content: center;
  }
  .c-n { top: 50%; left: 50%; transform: translate(-50%, -50vh); }
  .c-s { top: 50%; left: 50%; transform: translate(-50%, 50vh); }
  .c-e { top: 50%; left: 50%; transform: translate(50vw, -50%); }
  .c-w { top: 50%; left: 50%; transform: translate(-50vw, -50%); }

  .hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
  .hud-top, .hud-bottom {
    position: absolute; left: 0; right: 0; display: flex; gap: 18px;
    padding: 10px 16px; font-family: var(--mono); font-size: 12px;
    flex-wrap: wrap;
  }
  .hud-top { top: 0; background: linear-gradient(180deg, rgba(0,0,16,0.7), transparent); }
  .hud-bottom { bottom: 0; background: linear-gradient(0deg, rgba(0,0,16,0.7), transparent); }
  .hud-block { display: flex; flex-direction: column; gap: 2px; }
  .hud-block .k { color: var(--muted); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  .hud-block .v { color: var(--fg); }
  .hud-block.tracked .k { color: #f4d17a; }
  .hud-block.tracked .v { color: #f4d17a; font-weight: 600; }

  /* Search box */
  .search-wrap {
    position: fixed; bottom: 56px; right: 16px; z-index: 13; width: 240px;
  }
  .search-wrap input {
    width: 100%; background: var(--panel); border: 1px solid var(--border);
    color: var(--fg); padding: 7px 10px; border-radius: 6px;
    font-family: var(--sans); font-size: 12px; backdrop-filter: blur(8px);
  }
  .search-wrap input:focus { outline: none; border-color: var(--accent); }
  .search-results {
    margin-top: 4px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 6px; overflow: hidden; backdrop-filter: blur(8px);
    max-height: 280px; overflow-y: auto;
  }
  .search-item {
    display: flex; justify-content: space-between; align-items: center;
    width: 100%; text-align: left; padding: 6px 10px;
    border: none; border-radius: 0; background: none; color: var(--fg);
    font-size: 12px; cursor: pointer;
  }
  .search-item:hover { background: rgba(138, 180, 255, 0.1); color: var(--accent); }
  .si-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .si-kind {
    color: var(--muted); font-size: 10px; text-transform: uppercase;
    letter-spacing: 1px; margin-left: 8px; flex-shrink: 0;
  }

  .controls {
    position: fixed; top: 56px; left: 16px; z-index: 12;
    display: flex; flex-direction: column; gap: 6px; max-width: 380px;
  }
  .ctrl-group {
    display: flex; flex-wrap: wrap; gap: 5px;
  }
  .ctrl-group button {
    padding: 5px 10px; font-size: 12px;
  }
  button.danger {
    border-color: rgba(255, 100, 100, 0.4);
    color: #ff8888;
  }
  button.danger:hover { border-color: #ff8888; color: #ffaaaa; }

  /* Quick jump presets */
  .jump-panel {
    position: fixed; top: 50%; right: 16px; transform: translateY(-50%);
    z-index: 11; max-width: 180px; max-height: 70vh; overflow-y: auto;
  }
  .jp-label {
    color: var(--muted); font-size: 10px; letter-spacing: 2px;
    text-transform: uppercase; margin-bottom: 6px;
    font-family: var(--mono); text-align: right;
  }
  .jp-grid {
    display: grid; grid-template-columns: 1fr; gap: 4px;
  }
  .jump-btn {
    display: flex; flex-direction: column; align-items: flex-end;
    padding: 4px 8px; font-size: 11px; line-height: 1.2;
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 4px; cursor: pointer; backdrop-filter: blur(6px);
    text-align: right;
  }
  .jump-btn:hover { border-color: var(--accent); }
  .jb-name { color: var(--fg); font-weight: 500; }
  .jb-sub { color: var(--muted); font-size: 9px; letter-spacing: 0.5px; }

  .loc-panel {
    position: fixed; bottom: 56px; left: 16px; z-index: 12;
    display: flex; gap: 14px; padding: 10px 12px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 8px;
    font-size: 12px;
  }
  .loc-panel label { display: flex; flex-direction: column; gap: 4px; color: var(--muted); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }

  .info-panel {
    position: fixed; top: 100px; right: 16px; z-index: 13;
    width: 260px; padding: 14px 16px;
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    backdrop-filter: blur(8px);
  }
  .ip-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .ip-name { font-size: 16px; font-weight: 600; color: #fff; }
  .ip-close { border: none; background: none; color: var(--muted); font-size: 20px; padding: 0 4px; }
  .ip-close:hover { color: var(--accent); }
  .ip-rows { display: flex; flex-direction: column; gap: 6px; }
  .ip-rows div { display: flex; justify-content: space-between; font-size: 12px; }
  .ip-rows span { color: var(--muted); }
  .ip-rows b { color: var(--fg); font-family: var(--mono); font-weight: 500; }
  .ip-actions {
    display: flex; gap: 6px; margin-top: 10px;
  }
  .ip-track {
    flex: 1; padding: 6px 10px; font-size: 12px;
    border: 1px solid var(--border); background: rgba(138, 180, 255, 0.1);
    color: var(--accent); border-radius: 5px; cursor: pointer;
  }
  .ip-track:hover { background: rgba(138, 180, 255, 0.2); }
  .ip-stop {
    padding: 6px 10px; font-size: 11px;
    border: 1px solid rgba(255, 100, 100, 0.3); background: none;
    color: #ff8888; border-radius: 5px; cursor: pointer;
  }
  .ip-hint { color: var(--muted); font-size: 10px; margin-top: 10px; text-align: center; }

  .hint {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
    color: var(--muted); font-size: 11px; z-index: 11; pointer-events: none;
    background: rgba(0,0,16,0.5); padding: 4px 12px; border-radius: 12px;
  }

  /* Label overlay — DOM text floating over stars and constellation centroids.
   * Position is set inline via left/top in px (screen-space from projectToScreen).
   * translate(-50%, ...) centers the text on the projected point. */
  .label-layer {
    position: fixed; inset: 0; pointer-events: none; z-index: 8;
    overflow: hidden;
  }
  .star-label {
    position: absolute; transform: translate(6px, -50%);
    color: #d6e4ff; font-family: var(--mono); font-size: 10px;
    letter-spacing: 0.5px; text-shadow: 0 0 4px rgba(0,0,16,0.95), 0 0 2px rgba(0,0,16,0.95);
    white-space: nowrap; pointer-events: none;
  }
  .con-label {
    position: absolute; transform: translate(-50%, -50%);
    color: #f4d17a; font-family: var(--mono); font-size: 11px;
    letter-spacing: 2px; text-transform: uppercase; font-weight: 500;
    text-shadow: 0 0 6px rgba(0,0,16,0.95), 0 0 3px rgba(0,0,16,0.95);
    white-space: nowrap; pointer-events: none; opacity: 0.78;
  }

  @media (max-width: 640px) {
    .controls { top: 80px; max-width: calc(100vw - 32px); }
    .loc-panel { bottom: 60px; flex-wrap: wrap; }
    .info-panel { top: auto; bottom: 110px; right: 8px; left: 8px; width: auto; }
    .hud-block:nth-child(3), .hud-block:nth-child(4) { display: none; }
    .jump-panel { display: none; }
    .search-wrap { width: calc(100vw - 32px); }
  }
</style>
