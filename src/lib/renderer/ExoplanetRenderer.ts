import * as THREE from 'three';
import { radecToVector, SPHERE_RADIUS } from '../catalog/CatalogLoader';

// Exoplanet markers — distinct diamond/cross glyph to distinguish from stars
// and DSOs. Type-based coloring encodes planet class.
//
// aType IDs:
//   0=rocky   1=terran   2=super   3=neptune   4=gas   5=water
// aHabitable: 1.0 = inside optimistic HZ, 0.0 = outside

const exoVertexShader = /* glsl */ `
attribute float aMag;       // host star apparent magnitude
attribute float aType;
attribute float aHabitable;

uniform mat3 uRotation;
uniform float uRadius;
uniform float uDpr;
uniform float uVisible;

varying float vType;
varying float vHabitable;
varying float vAlpha;

void main() {
  vec3 horiz = uRotation * position;
  vec4 mvPosition = modelViewMatrix * vec4(horiz * uRadius, 1.0);

  vAlpha = uVisible;
  if (mvPosition.z > 0.0) vAlpha = 0.0;   // behind camera
  vType = aType;
  vHabitable = aHabitable;

  // Exoplanet hosts are often faint — clamp size floor so they stay visible.
  float size = max(5.0, (9.0 - aMag) * 2.5) * uDpr;
  gl_PointSize = size;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const exoFragmentShader = /* glsl */ `
precision mediump float;
varying float vType;
varying float vHabitable;
varying float vAlpha;

vec3 typeColor(float t) {
  if (t < 0.5)  return vec3(0.85, 0.55, 0.35);  // rocky — rust
  if (t < 1.5)  return vec3(0.35, 0.95, 0.55);  // terran — green (Earth-like)
  if (t < 2.5)  return vec3(0.55, 0.85, 0.95);  // super-Earth — pale cyan
  if (t < 3.5)  return vec3(0.45, 0.55, 1.0);   // neptune — blue
  if (t < 4.5)  return vec3(1.0, 0.75, 0.35);   // gas giant — amber
  if (t < 5.5)  return vec3(0.35, 0.65, 1.0);   // water world — deep blue
  return vec3(0.8, 0.8, 0.8);
}

void main() {
  if (vAlpha <= 0.0) discard;
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c) * 2.0;

  // Diamond glyph: |x| + |y| < r
  float ax = abs(c.x), ay = abs(c.y);
  float diamond = smoothstep(0.6, 0.45, ax + ay);

  // Crosshair arms (thin)
  float arm = max(
    smoothstep(0.02, 0.0, abs(c.y)) * smoothstep(0.5, 0.4, abs(c.x)),
    smoothstep(0.02, 0.0, abs(c.x)) * smoothstep(0.5, 0.4, abs(c.y))
  ) * 0.5;

  // Central core dot
  float core = smoothstep(0.25, 0.1, d) * 0.8;

  // Habitable-zone ring pulse — gold halo
  float hzRing = 0.0;
  if (vHabitable > 0.5) {
    hzRing = smoothstep(0.95, 0.88, d) * smoothstep(0.78, 0.85, d) * 0.7;
  }

  vec3 col = typeColor(vType);
  if (vHabitable > 0.5) col = mix(col, vec3(1.0, 0.85, 0.3), hzRing);

  float a = (diamond * 0.9 + arm + core + hzRing) * vAlpha;
  if (a < 0.03) discard;
  gl_FragColor = vec4(col, a);
}
`;

const TYPE_MAP: Record<string, number> = {
  'rocky': 0,
  'terran': 1,
  'super': 2,
  'neptune': 3,
  'gas': 4,
  'water': 5,
};

// Compact exoplanet data format:
// [hostName, planetName, ra, dec, hostMag, typeStr, periodDays, year, massEarth, radiusEarth, habitableFlag]
type ExoEntry = [string, string, number, number, number, string, number, number, number, number, number];

export interface Exoplanet {
  host: string;
  name: string;
  ra: number;
  dec: number;
  hostMag: number;
  type: string;
  period: number;
  year: number;
  mass: number;       // Earth masses
  radius: number;     // Earth radii
  habitable: boolean;
}

export class ExoplanetRenderer {
  points: THREE.Points;
  private material: THREE.ShaderMaterial;
  objects: Exoplanet[] = [];

  constructor(data: ExoEntry[]) {
    const count = data.length;
    const positions = new Float32Array(count * 3);
    const mags = new Float32Array(count);
    const types = new Float32Array(count);
    const habit = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const [host, name, ra, dec, hostMag, typeStr, period, year, mass, radius, hab] = data[i];
      const [x, y, z] = radecToVector(ra, dec, 1);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      mags[i] = hostMag;
      types[i] = TYPE_MAP[typeStr] ?? 0;
      habit[i] = hab;

      this.objects.push({
        host, name, ra, dec, hostMag,
        type: typeStr, period, year,
        mass, radius,
        habitable: hab === 1,
      });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geometry.setAttribute('aType', new THREE.BufferAttribute(types, 1));
    geometry.setAttribute('aHabitable', new THREE.BufferAttribute(habit, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: exoVertexShader,
      fragmentShader: exoFragmentShader,
      uniforms: {
        uRotation: { value: new THREE.Matrix3() },
        uRadius: { value: SPHERE_RADIUS * 0.998 },  // between stars (1.0) and DSO (0.999)
        uDpr: { value: Math.min(window.devicePixelRatio, 2) },
        uVisible: { value: 1.0 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  setRotation(mat3: THREE.Matrix3) {
    this.material.uniforms.uRotation.value.copy(mat3);
  }

  setVisible(v: boolean) {
    this.material.uniforms.uVisible.value = v ? 1.0 : 0.0;
  }

  /** Pick nearest exoplanet via raycasting */
  pickObject(raycaster: THREE.Raycaster): Exoplanet | null {
    raycaster.params.Points!.threshold = 8;
    const intersects = raycaster.intersectObject(this.points, false);
    if (intersects.length === 0) return null;
    const idx = intersects[0].index!;
    return this.objects[idx] ?? null;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
