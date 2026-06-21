import * as THREE from 'three';
import { lineVertexShader, lineFragmentShader } from './shaders';
import { radecToVector, SPHERE_RADIUS } from '../catalog/CatalogLoader';

const SEGMENTS = 256;

// North poles (J2000, degrees)
const ECLIPTIC_POLE_RA = 270.0;
const ECLIPTIC_POLE_DEC = 66.5608; // 23.44° obliquity -> pole Dec = 90-23.44
const GALACTIC_POLE_RA = 192.85948;
const GALACTIC_POLE_DEC = 27.12825;

function buildGreatCircle(poleRa: number, poleDec: number, radius: number): number[] {
  // pole unit vector
  const [px, py, pz] = radecToVector(poleRa, poleDec, 1);
  const p = new THREE.Vector3(px, py, pz).normalize();

  // pick arbitrary reference vector not parallel to p
  const ref = Math.abs(p.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);

  // basis vectors orthogonal to pole
  const u = new THREE.Vector3().crossVectors(p, ref).normalize();
  const v = new THREE.Vector3().crossVectors(p, u).normalize();

  const pts: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = (i / SEGMENTS) * Math.PI * 2;
    const x = (Math.cos(t) * u.x + Math.sin(t) * v.x) * radius;
    const y = (Math.cos(t) * u.y + Math.sin(t) * v.y) * radius;
    const z = (Math.cos(t) * u.z + Math.sin(t) * v.z) * radius;
    pts.push(x, y, z);
  }
  return pts;
}

interface PlaneMaterial {
  material: THREE.ShaderMaterial;
  loop: THREE.LineLoop;
}

function makePlane(verts: number[], color: THREE.Color, radius: number): PlaneMaterial {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

  const material = new THREE.ShaderMaterial({
    vertexShader: lineVertexShader,
    fragmentShader: lineFragmentShader,
    uniforms: {
      uRotation: { value: new THREE.Matrix3() },
      uRadius: { value: radius },
      uColor: { value: color },
      uOpacity: { value: 0.45 }
    },
    transparent: true,
    depthWrite: false,
    depthTest: false
  });

  const loop = new THREE.LineLoop(geometry, material);
  loop.frustumCulled = false;
  return { material, loop };
}

export class PlaneOverlayRenderer {
  group: THREE.Group;
  private ecliptic: PlaneMaterial;
  private galactic: PlaneMaterial;

  constructor() {
    this.group = new THREE.Group();

    const rEcl = SPHERE_RADIUS * 1.002;
    const rGal = SPHERE_RADIUS * 1.004;

    this.ecliptic = makePlane(
      buildGreatCircle(ECLIPTIC_POLE_RA, ECLIPTIC_POLE_DEC, 1),
      new THREE.Color(1.0, 0.75, 0.25), // amber — Sun's path
      rEcl
    );
    this.galactic = makePlane(
      buildGreatCircle(GALACTIC_POLE_RA, GALACTIC_POLE_DEC, 1),
      new THREE.Color(0.45, 0.75, 1.0), // cool blue — galactic plane
      rGal
    );

    this.group.add(this.ecliptic.loop);
    this.group.add(this.galactic.loop);
  }

  setRotation(mat3: THREE.Matrix3) {
    this.ecliptic.material.uniforms.uRotation.value.copy(mat3);
    this.galactic.material.uniforms.uRotation.value.copy(mat3);
  }

  setEclipticVisible(v: boolean) {
    this.ecliptic.loop.visible = v;
  }

  setGalacticVisible(v: boolean) {
    this.galactic.loop.visible = v;
  }

  dispose() {
    this.ecliptic.loop.geometry.dispose();
    this.ecliptic.material.dispose();
    this.galactic.loop.geometry.dispose();
    this.galactic.material.dispose();
  }
}
