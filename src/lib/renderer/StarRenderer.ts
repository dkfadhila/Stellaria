import * as THREE from 'three';
import { starVertexShader, starFragmentShader } from './shaders';
import { radecToVector, SPHERE_RADIUS } from '../catalog/CatalogLoader';
import type { Star, NamedStar } from '../catalog/types';

export class StarRenderer {
  points: THREE.Points;
  private material: THREE.ShaderMaterial;
  private hipToIndex = new Map<number, number>();

  constructor(stars: Star[], namedStars: NamedStar[]) {
    const count = stars.length;
    const positions = new Float32Array(count * 3);
    const mags = new Float32Array(count);
    const cis = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const s = stars[i];
      const [x, y, z] = radecToVector(s.ra, s.dec, 1);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      mags[i] = s.mag;
      cis[i] = s.ci;
      if (s.hip) this.hipToIndex.set(s.hip, i);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aMag', new THREE.BufferAttribute(mags, 1));
    geometry.setAttribute('aCi', new THREE.BufferAttribute(cis, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: starVertexShader,
      fragmentShader: starFragmentShader,
      uniforms: {
        uRotation: { value: new THREE.Matrix3() },
        uRadius: { value: SPHERE_RADIUS },
        uPixelScale: { value: 1.0 },
        uMagLimit: { value: 6.5 },
        uDpr: { value: Math.min(window.devicePixelRatio, 2) }
      },
      transparent: true,
      depthWrite: false,
      depthTest: false
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  setRotation(mat3: THREE.Matrix3) {
    this.material.uniforms.uRotation.value.copy(mat3);
  }

  setMagLimit(limit: number) {
    this.material.uniforms.uMagLimit.value = limit;
  }

  setPixelScale(scale: number) {
    this.material.uniforms.uPixelScale.value = scale;
  }

  /** Find the star nearest to a screen-space point via raycasting. */
  pickStar(raycaster: THREE.Raycaster, camera: THREE.Camera, maxMag = 4.5): { index: number; star: Star } | null {
    // Use the geometry's world position buffer; raycaster works on Points threshold.
    raycaster.params.Points!.threshold = 6;
    const intersects = raycaster.intersectObject(this.points, false);
    if (intersects.length === 0) return null;
    // Prefer brightest visible
    let best = intersects[0];
    for (const hit of intersects) {
      const idx = hit.index!;
      // distance penalty: closer to ray = better, but prefer brighter
    }
    const idx = best.index!;
    return { index: idx, star: this.getStarByIndex(idx) };
  }

  getStarByIndex(index: number): Star {
    const geo = this.points.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const mag = geo.getAttribute('aMag') as THREE.BufferAttribute;
    const ci = geo.getAttribute('aCi') as THREE.BufferAttribute;
    return {
      ra: 0, dec: 0, // filled by caller if needed via inverse; kept minimal here
      mag: mag.getX(index),
      ci: ci.getX(index),
      hip: 0, con: 0, spect: 0
    };
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
