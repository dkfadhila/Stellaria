import * as THREE from 'three';
import { SPHERE_RADIUS } from '../catalog/CatalogLoader';

/**
 * Procedural Milky Way band renderer.
 *
 * Generates ~40k point sprites distributed along the galactic plane with:
 *  - Gaussian latitude profile (band thickness ~3-5° FWHM)
 *  - Longitude density variation: brighter near galactic center (l~0°),
 *    dimmer toward anti-center and through the Cygnus Rift (l~80°).
 *  - Per-particle brightness jitter so the band looks textured, not flat.
 *
 * Positions are stored in the J2000 equatorial frame (same as the star
 * catalog) so the existing uRotation uniform rotates them into the
 * observer's horizontal frame at render time.
 */

// Galactic -> equatorial (J2000) rotation matrix.
// Rows: equatorial x,y,z expressed in galactic x,y,z.
// Source: ESA / Hipparcos convention (J2000).
const R_GAL_TO_EQ = [
  [-0.054875539, -0.873437109, -0.483834991],
  [ 0.494109439, -0.444829594,  0.746982249],
  [-0.867666136, -0.198076390,  0.455983795]
];

/** Convert galactic longitude (deg) and latitude (deg) to a J2000 equatorial unit vector. */
function galacticToEquatorial(lDeg: number, bDeg: number): [number, number, number] {
  const l = lDeg * Math.PI / 180;
  const b = bDeg * Math.PI / 180;
  const cb = Math.cos(b);
  const xg = cb * Math.cos(l);
  const yg = cb * Math.sin(l);
  const zg = Math.sin(b);
  const r = R_GAL_TO_EQ;
  const xe = r[0][0] * xg + r[0][1] * yg + r[0][2] * zg;
  const ye = r[1][0] * xg + r[1][1] * yg + r[1][2] * zg;
  const ze = r[2][0] * xg + r[2][1] * yg + r[2][2] * zg;
  return [xe, ye, ze];
}

/** Gaussian random via Box-Muller. */
function gaussian(sigma: number): number {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.random();
  return sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const MILKYWAY_VERTEX = /* glsl */ `
uniform mat3 uRotation;
uniform float uRadius;
uniform float uDpr;

attribute float aBrightness;
attribute float aSize;

varying float vBrightness;
varying float vAlpha;

void main() {
  vec3 horiz = uRotation * position;
  vec4 mvPosition = modelViewMatrix * vec4(horiz * uRadius, 1.0);

  // Cull behind camera
  vAlpha = 1.0;
  if (mvPosition.z > 0.0) vAlpha = 0.0;

  // Atmospheric fade near horizon: dim the band as it approaches alt=0.
  // horiz.y is the up component in the horizontal frame; <0 means below horizon.
  float alt = horiz.y;
  float horizonFade = smoothstep(-0.05, 0.15, alt);
  vAlpha *= horizonFade;

  vBrightness = aBrightness;

  gl_PointSize = aSize * uDpr;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const MILKYWAY_FRAGMENT = /* glsl */ `
precision mediump float;
varying float vBrightness;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.01) discard;
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c) * 2.0;
  // soft round sprite
  float core = exp(-d * d * 3.0);
  float a = core * vAlpha * vBrightness;
  if (a < 0.005) discard;
  // slightly warm-white color with faint blue in dim regions
  vec3 col = mix(vec3(0.7, 0.78, 1.0), vec3(1.0, 0.95, 0.85), vBrightness);
  gl_FragColor = vec4(col, a);
}
`;

export class MilkyWayRenderer {
  points: THREE.Points;
  private material: THREE.ShaderMaterial;

  constructor(particleCount = 40000) {
    const positions = new Float32Array(particleCount * 3);
    const brightness = new Float32Array(particleCount);
    const sizes = new Float32Array(particleCount);

    for (let i = 0; i < particleCount; i++) {
      // Longitude: uniform 0-360 but weighted toward galactic center.
      // Use sqrt bias so more particles cluster near l=0 (Sagittarius).
      let lDeg: number;
      const r = Math.random();
      // 50% of particles in the central band |l|<60°, rest spread out.
      if (r < 0.5) {
        // Cluster near galactic center: l in [-60, 60]
        lDeg = gaussian(30); // sigma=30° around l=0
      } else {
        lDeg = Math.random() * 360;
      }
      // Latitude: gaussian around galactic plane, thin band.
      // Sigma varies with longitude — thicker near center, thinner elsewhere.
      const distFromCenter = Math.min(Math.abs(lDeg), Math.abs(lDeg - 360));
      const sigma = distFromCenter < 30 ? 4.0 : 3.0;
      const bDeg = gaussian(sigma);

      // Brightness model:
      //  - Peak near galactic center (l=0), falloff with |l|.
      //  - Dust lanes / rifts: dips around l~80° (Cygnus rift) and l~140°.
      //  - Random per-particle jitter for texture.
      const lNorm = lDeg; // 0-360
      let baseBright = Math.exp(-(distFromCenter * distFromCenter) / (2 * 90 * 90)); // gaussian peak at center
      // Rift: subtract a dip near l=80
      const riftDist = Math.abs(((lNorm + 180) % 360) - 180); // 0-180 distance
      const riftDip = Math.exp(-Math.pow((riftDist - 80) / 12, 2)) * 0.6;
      baseBright = Math.max(0.05, baseBright - riftDip);
      // Random jitter
      const jitter = 0.4 + Math.random() * 0.6;
      const b = baseBright * jitter;
      brightness[i] = Math.min(1, b * 0.6); // overall dim

      // Size: small, slight variation. Brighter particles slightly bigger.
      sizes[i] = 1.2 + b * 1.5 + Math.random() * 0.5;

      const [xe, ye, ze] = galacticToEquatorial(lDeg, bDeg);
      positions[i * 3] = xe;
      positions[i * 3 + 1] = ye;
      positions[i * 3 + 2] = ze;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aBrightness', new THREE.BufferAttribute(brightness, 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: MILKYWAY_VERTEX,
      fragmentShader: MILKYWAY_FRAGMENT,
      uniforms: {
        uRotation: { value: new THREE.Matrix3() },
        uRadius: { value: SPHERE_RADIUS * 0.999 }, // slightly inside star sphere
        uDpr: { value: Math.min(window.devicePixelRatio, 2) }
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  setRotation(mat3: THREE.Matrix3) {
    this.material.uniforms.uRotation.value.copy(mat3);
  }

  setVisible(v: boolean) {
    this.points.visible = v;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
