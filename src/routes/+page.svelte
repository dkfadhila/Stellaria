<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { StarRenderer } from '$lib/renderer/StarRenderer';
  import { ConstellationRenderer } from '$lib/renderer/ConstellationRenderer';
  import { MilkyWayRenderer } from '$lib/renderer/MilkyWayRenderer';
  import { SkyControls } from '$lib/engine/SkyControls';
  import {
    loadStarCatalog, loadNamedStars, loadConstellationLines,
    loadConstellationNames, radecToVector, SPHERE_RADIUS
  } from '$lib/catalog/CatalogLoader';
  import { rotationMatrix, lstDegrees, degToHms, degToDms, horizontalToAltAz } from '$lib/astronomy/coordinates';
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
  let showNames = false;
  let magLimit = 6.0;
  let fovLabel = 75;
  let azLabel = 0, altLabel = 45;
  let lstLabel = '';
  let timeSpeed = 0; // 0 = real-time, else seconds per second
  let lastClockMs = Date.now();
  let hud = { lat, lon, lst: '', fov: 75, az: 0, alt: 45, stars: 0, cons: 0 };
  let selected: any = null;
  let loadMsg = 'Loading star catalog...';

  function updateRotation() {
    if (!starRenderer || !constellationRenderer) return;
    const m = rotationMatrix(new Date(dateMs), lat, lon);
    rotationMat.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    starRenderer.setRotation(rotationMat);
    constellationRenderer.setRotation(rotationMat);
    if (milkyWayRenderer) milkyWayRenderer.setRotation(rotationMat);
    lastUpdateMs = dateMs;
    lstLabel = degToHms(lstDegrees(new Date(dateMs), lon));
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
    }
    azLabel = controls.azimuth;
    altLabel = controls.altitude;
    fovLabel = controls.fov;
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
    raycaster.params.Points!.threshold = 0.08; // ~4.6° on unit sphere — click-friendly
    const hits = raycaster.intersectObject(starRenderer.points, false);
    if (hits.length === 0) { selectedStar.set(null); selected = null; return; }
    // Filter out the Sun (Sol, index 0, mag -26.7) — it is not on the celestial
    // sphere and its extreme magnitude would always win any brightness sort.
    const magAttr = starRenderer.points.geometry.getAttribute('aMag') as THREE.BufferAttribute;
    const valid = hits.filter(h => magAttr.getX(h.index!) > -20);
    if (valid.length === 0) { selectedStar.set(null); selected = null; return; }
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
  }

  function applyRot(m: THREE.Matrix3, x: number, y: number, z: number): [number, number, number] {
    const e = m.elements;
    return [
      e[0] * x + e[3] * y + e[6] * z,
      e[1] * x + e[4] * y + e[7] * z,
      e[2] * x + e[5] * y + e[8] * z
    ];
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
    animate();
  }

  function applyManualLocation() {
    lat = +lat; lon = +lon;
    locationLabel = `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`;
    updateRotation();
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

  function changeMagLimit() {
    starRenderer.setMagLimit(magLimit);
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
        loadStarCatalog(), loadNamedStars(), loadConstellationLines(), loadConstellationNames()
      ]);
      console.log('STELLARIA: Promise.all resolved', catResult[0].length, 'stars');
      [stars, namedStars, , conNames] = catResult;
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

      controls = new SkyControls(camera, canvas);
      controls.onMove = () => { azLabel = controls.azimuth; altLabel = controls.altitude; fovLabel = controls.fov; };
      canvas.addEventListener('click', onClick);

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
    controls?.dispose();
    starRenderer?.dispose();
    constellationRenderer?.dispose();
    milkyWayRenderer?.dispose();
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

<div class="hud" class:hidden={loadMsg}>
  <div class="hud-top">
    <div class="hud-block">
      <span class="k">Location</span>
      <span class="v">{locationLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">LST</span>
      <span class="v">{lstLabel}</span>
    </div>
    <div class="hud-block">
      <span class="k">View</span>
      <span class="v">Az {azLabel.toFixed(0)}° · Alt {altLabel.toFixed(0)}° · FOV {fovLabel.toFixed(0)}°</span>
    </div>
  </div>
  <div class="hud-bottom">
    <div class="hud-block">
      <span class="k">Stars</span>
      <span class="v">{$skyState.starCount.toLocaleString()}</span>
    </div>
    <div class="hud-block">
      <span class="k">Time</span>
      <span class="v">{new Date(dateMs).toLocaleTimeString([], {hour12:false})}</span>
    </div>
    <div class="hud-block">
      <span class="k">Date</span>
      <span class="v">{new Date(dateMs).toLocaleDateString()}</span>
    </div>
  </div>
</div>

<div class="controls" class:hidden={loadMsg}>
  <button class:active={showCons} on:click={toggleCons}>Constellations</button>
  <button class:active={showMilkyWay} on:click={toggleMilkyWay}>Milky Way</button>
  <button on:click={resetTime}>Now</button>
  <button on:click={() => stepTime(-3600)}>−1h</button>
  <button on:click={() => stepTime(3600)}>+1h</button>
  <button class:active={timeSpeed === 300} on:click={() => timeSpeed = timeSpeed === 300 ? 0 : 300}>▶ 5min/s</button>
  <button class:active={timeSpeed === 3600} on:click={() => timeSpeed = timeSpeed === 3600 ? 0 : 3600}>▶▶ 1h/s</button>
</div>

<div class="loc-panel" class:hidden={loadMsg}>
  <label>Lat <input type="number" bind:value={lat} step="0.01" on:change={applyManualLocation}></label>
  <label>Lon <input type="number" bind:value={lon} step="0.01" on:change={applyManualLocation}></label>
  <label>Mag <input type="number" bind:value={magLimit} step="0.5" min="2" max="6.5" on:change={changeMagLimit}></label>
</div>

{#if selected}
  <div class="info-panel">
    <div class="ip-head">
      <span class="ip-name">{selected.name}</span>
      <button class="ip-close" on:click={() => { selectedStar.set(null); selected = null; }}>×</button>
    </div>
    <div class="ip-rows">
      <div><span>Constellation</span><b>{selected.con}</b></div>
      <div><span>Magnitude</span><b>{selected.mag.toFixed(2)}</b></div>
      <div><span>Spectral</span><b>{selected.spect}</b></div>
      <div><span>RA</span><b>{degToHms(selected.ra)}</b></div>
      <div><span>Dec</span><b>{degToDms(selected.dec)}</b></div>
      <div><span>Altitude</span><b>{selected.alt.toFixed(1)}°</b></div>
      <div><span>Azimuth</span><b>{selected.az.toFixed(1)}°</b></div>
      <div><span>HIP</span><b>{selected.hip || '—'}</b></div>
    </div>
    <p class="ip-hint">Tap empty sky to deselect</p>
  </div>
{/if}

<div class="hint" class:hidden={loadMsg}>
  Drag to look · Scroll to zoom · Click a star for info
</div>

<style>
  canvas { position: fixed; inset: 0; width: 100%; height: 100%; }
  .hidden { display: none !important; }

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

  .hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; }
  .hud-top, .hud-bottom {
    position: absolute; left: 0; right: 0; display: flex; gap: 18px;
    padding: 10px 16px; font-family: var(--mono); font-size: 12px;
  }
  .hud-top { top: 0; background: linear-gradient(180deg, rgba(0,0,16,0.6), transparent); }
  .hud-bottom { bottom: 0; background: linear-gradient(0deg, rgba(0,0,16,0.6), transparent); }
  .hud-block { display: flex; flex-direction: column; gap: 2px; }
  .hud-block .k { color: var(--muted); font-size: 10px; letter-spacing: 1px; text-transform: uppercase; }
  .hud-block .v { color: var(--fg); }

  .controls {
    position: fixed; top: 56px; left: 16px; z-index: 12;
    display: flex; flex-wrap: wrap; gap: 6px; max-width: 380px;
  }

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
  .ip-hint { color: var(--muted); font-size: 10px; margin-top: 10px; text-align: center; }

  .hint {
    position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%);
    color: var(--muted); font-size: 11px; z-index: 11; pointer-events: none;
    background: rgba(0,0,16,0.5); padding: 4px 12px; border-radius: 12px;
  }

  @media (max-width: 640px) {
    .controls { top: 80px; max-width: calc(100vw - 32px); }
    .loc-panel { bottom: 60px; flex-wrap: wrap; }
    .info-panel { top: auto; bottom: 110px; right: 8px; left: 8px; width: auto; }
    .hud-block:nth-child(3) { display: none; }
  }
</style>
