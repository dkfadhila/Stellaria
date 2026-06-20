import * as THREE from 'three';
import { lineVertexShader, lineFragmentShader } from './shaders';
import { radecToVector, SPHERE_RADIUS } from '../catalog/CatalogLoader';
import type { ConstellationLine } from '../catalog/types';

export class ConstellationRenderer {
  lines: THREE.LineSegments;
  private material: THREE.ShaderMaterial;

  constructor(constellations: ConstellationLine[], hipToVector: Map<number, [number, number, number]>) {
    const verts: number[] = [];
    for (const c of constellations) {
      for (const [a, b] of c.edges) {
        const va = hipToVector.get(a);
        const vb = hipToVector.get(b);
        if (!va || !vb) continue;
        verts.push(va[0], va[1], va[2], vb[0], vb[1], vb[2]);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));

    this.material = new THREE.ShaderMaterial({
      vertexShader: lineVertexShader,
      fragmentShader: lineFragmentShader,
      uniforms: {
        uRotation: { value: new THREE.Matrix3() },
        uRadius: { value: SPHERE_RADIUS * 1.001 },
        uColor: { value: new THREE.Color(0.4, 0.5, 0.8) },
        uOpacity: { value: 0.35 }
      },
      transparent: true,
      depthWrite: false,
      depthTest: false
    });

    this.lines = new THREE.LineSegments(geometry, this.material);
    this.lines.frustumCulled = false;
  }

  setRotation(mat3: THREE.Matrix3) {
    this.material.uniforms.uRotation.value.copy(mat3);
  }

  setOpacity(o: number) {
    this.material.uniforms.uOpacity.value = o;
  }

  setVisible(v: boolean) {
    this.lines.visible = v;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
