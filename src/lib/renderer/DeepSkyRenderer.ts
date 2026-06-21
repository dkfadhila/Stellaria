import * as THREE from 'three';
import { radecToVector, SPHERE_RADIUS } from '../catalog/CatalogLoader';

// Deep-sky object shaders — marker style distinct from stars
// Type-based coloring: galaxy, globular, open, nebula, planetary, supernova

const dsoVertexShader = /* glsl */ `
attribute float aMag;
attribute float aType;    // 0=galaxy 1=globular 2=open 3=nebula 4=planetary 5=supernova 6=other

uniform mat3 uRotation;
uniform float uRadius;
uniform float uDpr;
uniform float uVisible;   // 0 or 1 — toggle

varying float vType;
varying float vAlpha;

void main() {
  vec3 horiz = uRotation * position;
  vec4 mvPosition = modelViewMatrix * vec4(horiz * uRadius, 1.0);

  vAlpha = uVisible;
  if (mvPosition.z > 0.0) vAlpha = 0.0;  // behind camera
  vType = aType;

  // Bigger than stars — these are extended objects
  float size = max(4.0, (9.0 - aMag) * 2.0) * uDpr;
  gl_PointSize = size;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const dsoFragmentShader = /* glsl */ `
precision mediump float;
varying float vType;
varying float vAlpha;

vec3 typeColor(float t) {
  if (t < 0.5)  return vec3(1.0, 0.4, 0.55);  // galaxy — magenta-red
  if (t < 1.5)  return vec3(1.0, 0.85, 0.4);  // globular — warm yellow
  if (t < 2.5)  return vec3(0.7, 0.85, 1.0);  // open — cool blue-white
  if (t < 3.5)  return vec3(0.4, 1.0, 0.5);   // nebula — green
  if (t < 4.5)  return vec3(0.3, 1.0, 0.9);   // planetary — cyan
  if (t < 5.5)  return vec3(1.0, 0.5, 0.2);   // supernova — orange
  return vec3(0.8, 0.8, 0.8);                 // other — gray
}

void main() {
  if (vAlpha <= 0.0) discard;
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c) * 2.0;

  // Ring marker: hollow center + bright ring — clearly distinct from stars
  float ring = smoothstep(0.75, 0.85, d) * smoothstep(1.0, 0.9, d);
  // Inner soft glow
  float glow = exp(-d * d * 3.0) * 0.5;
  // Center dot
  float core = smoothstep(0.3, 0.15, d) * 0.7;

  float a = (ring * 0.9 + glow + core) * vAlpha;
  if (a < 0.03) discard;
  gl_FragColor = vec4(typeColor(vType), a);
}
`;

// Compact Messier data: [m, ra, dec, mag, type, const, name]
type MessierEntry = [number, number, number, number, string, string, string];

// Type string -> shader type ID
const TYPE_MAP: Record<string, number> = {
  'galaxy': 0,
  'gcl': 1, 'globular': 1,
  'ocl': 2, 'open': 2,
  'neb': 3, 'nebula': 3, 'hii': 3, 'cl+n': 3,
  'planetary': 4, 'pn': 4,
  'supernova': 5, 'snr': 5, 'rfn': 5,
  'double': 6, '*ass': 6, 'other': 6,
};

export interface DeepSkyObject {
  m: number;
  ra: number;
  dec: number;
  mag: number;
  type: string;
  const: string;
  name: string;
}

export class DeepSkyRenderer {
  points: THREE.Points;
  private material: THREE.ShaderMaterial;
  objects: DeepSkyObject[] = [];

  constructor(data: MessierEntry[]) {
    const count = data.length;
    const positions = new Float32Array(count * 3);
    const mags = new Float32Array(count);
    const types = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const [m, ra, dec, mag, typeStr, const_, name] = data[i];
      const [x, y, z] = radecToVector(ra, dec, 1);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      mags[i] = mag;
      types[i] = TYPE_MAP[typeStr] ?? 6;

      this.objects.push({ m, ra, dec, mag, type: typeStr, const: const_, name });
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geometry.setAttribute('aType', new THREE.BufferAttribute(types, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: dsoVertexShader,
      fragmentShader: dsoFragmentShader,
      uniforms: {
        uRotation: { value: new THREE.Matrix3() },
        uRadius: { value: SPHERE_RADIUS * 0.999 }, // just inside star layer
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

  /** Pick nearest DSO via raycasting */
  pickObject(raycaster: THREE.Raycaster): DeepSkyObject | null {
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
