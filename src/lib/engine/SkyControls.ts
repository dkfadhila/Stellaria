import * as THREE from 'three';
import { altAzToHorizontal } from '../astronomy/coordinates';

/**
 * Planetarium-style camera controls. The camera sits at the origin and looks
 * toward (azimuth, altitude). Drag looks around; scroll/pinch zooms by
 * changing the field of view.
 */
export class SkyControls {
  azimuth = 0;     // compass bearing from North, degrees
  altitude = 45;   // degrees above horizon
  fov = 75;        // horizontal-ish field of view in degrees
  minFov = 20;
  maxFov = 110;
  minAlt = -5;
  maxAlt = 90;

  private camera: THREE.PerspectiveCamera;
  private dom: HTMLElement;
  private target = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private activePointerId: number | null = null;
  private pinchDist = 0;

  onMove: (() => void) | null = null;

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.dom = dom;
    this.attach();
    this.update();
  }

  private attach() {
    this.dom.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.dom.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.dom.addEventListener('touchstart', this.onTouchStart, { passive: false });
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('touchmove', this.onTouchMove);
    this.dom.removeEventListener('touchstart', this.onTouchStart);
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.dragging) return;
    this.dragging = true;
    this.activePointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging || e.pointerId !== this.activePointerId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.applyDrag(dx, dy);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== this.activePointerId) return;
    this.dragging = false;
    this.activePointerId = null;
  };

  private applyDrag(dx: number, dy: number) {
    // sensitivity scales with current fov
    const sens = this.fov / 800;
    this.azimuth -= dx * sens;
    this.altitude += dy * sens;
    this.altitude = Math.max(this.minAlt, Math.min(this.maxAlt, this.altitude));
    this.azimuth = ((this.azimuth % 360) + 360) % 360;
    this.update();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(e.deltaY * 0.0015);
    this.fov = Math.max(this.minFov, Math.min(this.maxFov, this.fov * factor));
    this.update();
  };

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      this.dragging = false;
      this.pinchDist = this.touchDist(e);
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      const d = this.touchDist(e);
      if (this.pinchDist > 0) {
        const factor = this.pinchDist / d;
        this.fov = Math.max(this.minFov, Math.min(this.maxFov, this.fov * factor));
        this.update();
      }
      this.pinchDist = d;
    }
  };

  private touchDist(e: TouchEvent): number {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  /** Look toward a given bearing/altitude. */
  lookAt(az: number, alt: number) {
    this.azimuth = az;
    this.altitude = Math.max(this.minAlt, Math.min(this.maxAlt, alt));
    this.update();
  }

  update() {
    this.camera.fov = this.fov;
    this.camera.updateProjectionMatrix();
    const [x, y, z] = altAzToHorizontal(this.azimuth, this.altitude);
    this.target.set(x, y, z);
    this.camera.position.set(0, 0, 0);
    this.camera.up.copy(this.up);
    this.camera.lookAt(this.target);
    if (this.onMove) this.onMove();
  }
}
