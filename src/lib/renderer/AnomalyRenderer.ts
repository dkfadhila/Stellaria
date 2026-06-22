/**
 * Anomaly Renderer — visualizes gravitational anomaly candidates on the 3D sky.
 *
 * Renders pulsing rings and diamond markers at anomaly positions.
 * Color-coded by object type:
 *   - Red: stellar black holes
 *   - Orange: intermediate black holes
 *   - Purple: supermassive black holes
 *   - Cyan: dark matter concentrations
 *   - Green: rogue planets
 *   - Yellow: unseen companions
 *   - White: unknown
 */

import * as THREE from 'three';
import type { AnomalyCandidate, AnomalyObjectType } from '$lib/ai/anomalyDetector';
import { radecToVector, SPHERE_RADIUS } from '$lib/catalog/CatalogLoader';

const ANOMALY_COLORS: Record<AnomalyObjectType, THREE.Color> = {
  stellar_black_hole: new THREE.Color(0.9, 0.15, 0.15),      // red
  intermediate_black_hole: new THREE.Color(1.0, 0.45, 0.1),  // orange
  supermassive_black_hole: new THREE.Color(0.6, 0.1, 0.9),   // purple
  dark_matter_clump: new THREE.Color(0.1, 0.85, 0.85),       // cyan
  rogue_planet: new THREE.Color(0.2, 0.9, 0.3),              // green
  unseen_companion: new THREE.Color(0.95, 0.85, 0.2),        // yellow
  neutron_star: new THREE.Color(0.5, 0.7, 1.0),              // blue
  unknown: new THREE.Color(0.7, 0.7, 0.7)                    // grey
};

// Vertex shader — instanced ring that pulses
const vertexShader = `
  uniform mat3 uRotation;
  uniform float uTime;
  attribute vec3 aCenter;
  attribute float aPhase;
  attribute float aConfidence;
  attribute vec3 aColor;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    // Pulse effect: expand and fade
    float t = mod(uTime * 0.5 + aPhase, 1.0);
    float scale = 1.0 + t * 0.8;
    vAlpha = (1.0 - t) * 0.6 * aConfidence;

    // Position: center + offset in local tangent plane
    vec3 center = uRotation * aCenter;
    vec3 pos = center * ${SPHERE_RADIUS.toFixed(1)} * scale;

    // Add ring vertex offset
    vec3 localPos = position * 0.12 * scale;
    // Project onto sphere tangent
    vec3 up = normalize(center);
    vec3 right = normalize(cross(up, vec3(0.0, 1.0, 0.0)));
    if (length(right) < 0.01) right = normalize(cross(up, vec3(1.0, 0.0, 0.0)));
    vec3 forward = cross(up, right);
    pos += localPos.x * right + localPos.y * forward;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = 3.0;
  }
`;

const fragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

// Point marker shader
const pointVertexShader = `
  uniform mat3 uRotation;
  uniform float uTime;
  attribute vec3 aCenter;
  attribute float aSize;
  attribute float aPhase;
  attribute vec3 aColor;
  attribute float aConfidence;
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aColor;
    float pulse = 0.7 + 0.3 * sin(uTime * 3.0 + aPhase * 6.28);
    vAlpha = 0.5 + 0.5 * aConfidence;

    vec3 pos = uRotation * aCenter;
    pos *= ${SPHERE_RADIUS.toFixed(1)};

    vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mvPos;
    gl_PointSize = aSize * pulse * (300.0 / -mvPos.z);
  }
`;

const pointFragmentShader = `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    // Diamond shape
    vec2 uv = gl_PointCoord - 0.5;
    float d = abs(uv.x) + abs(uv.y);
    if (d > 0.45) discard;

    // Glow falloff
    float glow = 1.0 - d / 0.45;
    vec3 col = vColor * (0.6 + 0.4 * glow);
    float alpha = vAlpha * glow;

    // Center bright spot
    if (d < 0.15) {
      col = mix(col, vec3(1.0), 0.5);
      alpha = min(1.0, alpha + 0.3);
    }

    gl_FragColor = vec4(col, alpha);
  }
`;

export class AnomalyRenderer {
  points: THREE.Points;
  rings: THREE.LineSegments;
  private _visible = true;
  private _time = 0;
  private _material: THREE.ShaderMaterial;
  private _ringMaterial: THREE.ShaderMaterial;
  private _rotation = new THREE.Matrix3();
  private _objects: AnomalyCandidate[] = [];

  constructor(anomalies: AnomalyCandidate[]) {
    this._objects = anomalies;
    const count = anomalies.length;
    if (count === 0) {
      // Empty placeholder
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3), 3));
      this._material = new THREE.ShaderMaterial({ vertexShader: pointVertexShader, fragmentShader: pointFragmentShader, transparent: true, depthWrite: false });
      this.points = new THREE.Points(geo, this._material);
      this._ringMaterial = new THREE.ShaderMaterial({ vertexShader, fragmentShader, transparent: true, depthWrite: false });
      this.rings = new THREE.LineSegments(new THREE.BufferGeometry(), this._ringMaterial);
      return;
    }

    // Build point geometry
    const centers = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    const colors = new Float32Array(count * 3);
    const confidences = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const a = anomalies[i];
      const [x, y, z] = radecToVector(a.ra, a.dec, 1);
      centers[i * 3] = x;
      centers[i * 3 + 1] = y;
      centers[i * 3 + 2] = z;

      const color = ANOMALY_COLORS[a.objectType] || ANOMALY_COLORS.unknown;
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;

      sizes[i] = 8 + a.confidence * 12;
      phases[i] = Math.random();
      confidences[i] = a.confidence;
    }

    const pointGeo = new THREE.BufferGeometry();
    pointGeo.setAttribute('aCenter', new THREE.Float32BufferAttribute(centers, 3));
    pointGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(sizes, 1));
    pointGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1));
    pointGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 3));
    pointGeo.setAttribute('aConfidence', new THREE.Float32BufferAttribute(confidences, 1));
    // Dummy position (not used in shader, but required by Three.js)
    pointGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 3), 3));

    this._material = new THREE.ShaderMaterial({
      vertexShader: pointVertexShader,
      fragmentShader: pointFragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uRotation: { value: this._rotation },
        uTime: { value: 0 }
      }
    });

    this.points = new THREE.Points(pointGeo, this._material);

    // Build ring geometry (expanding circles around each anomaly)
    const ringSegments = 16;
    const ringPositions: number[] = [];
    const ringCenters: number[] = [];
    const ringPhases: number[] = [];
    const ringColors: number[] = [];
    const ringConfidences: number[] = [];

    for (let i = 0; i < count; i++) {
      const a = anomalies[i];
      const [x, y, z] = radecToVector(a.ra, a.dec, 1);
      const color = ANOMALY_COLORS[a.objectType] || ANOMALY_COLORS.unknown;

      for (let j = 0; j < ringSegments; j++) {
        const angle1 = (j / ringSegments) * Math.PI * 2;
        const angle2 = ((j + 1) / ringSegments) * Math.PI * 2;

        // Ring vertices in local tangent plane (will be projected in shader)
        ringPositions.push(Math.cos(angle1), Math.sin(angle1), 0);
        ringPositions.push(Math.cos(angle2), Math.sin(angle2), 0);

        ringCenters.push(x, y, z, x, y, z);
        ringPhases.push(phases[i], phases[i]);
        ringColors.push(color.r, color.g, color.b, color.r, color.g, color.b);
        ringConfidences.push(a.confidence, a.confidence);
      }
    }

    const ringGeo = new THREE.BufferGeometry();
    ringGeo.setAttribute('position', new THREE.Float32BufferAttribute(ringPositions, 3));
    ringGeo.setAttribute('aCenter', new THREE.Float32BufferAttribute(ringCenters, 3));
    ringGeo.setAttribute('aPhase', new THREE.Float32BufferAttribute(ringPhases, 1));
    ringGeo.setAttribute('aColor', new THREE.Float32BufferAttribute(ringColors, 3));
    ringGeo.setAttribute('aConfidence', new THREE.Float32BufferAttribute(ringConfidences, 1));

    this._ringMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uRotation: { value: this._rotation },
        uTime: { value: 0 }
      }
    });

    this.rings = new THREE.LineSegments(ringGeo, this._ringMaterial);
  }

  get objects(): AnomalyCandidate[] {
    return this._objects;
  }

  setRotation(m: THREE.Matrix3) {
    this._rotation.copy(m);
  }

  setTime(t: number) {
    this._time = t;
    this._material.uniforms.uTime.value = t;
    this._ringMaterial.uniforms.uTime.value = t;
  }

  setVisible(v: boolean) {
    this._visible = v;
    this.points.visible = v;
    this.rings.visible = v;
  }

  dispose() {
    this.points.geometry.dispose();
    this._material.dispose();
    this.rings.geometry.dispose();
    this._ringMaterial.dispose();
  }
}
