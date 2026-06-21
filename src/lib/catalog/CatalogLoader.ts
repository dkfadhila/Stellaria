import type { Star, NamedStar, ConstellationLine } from './types';

const SPHERE_RADIUS = 1000;

/**
 * Load the binary star catalog. Format per star (24 bytes, little-endian):
 *   float32 ra, float32 dec, float32 mag, float32 ci, uint32 hip, uint32 flags
 *   flags = (conIndex << 8) | spectCode
 */
export async function loadStarCatalog(): Promise<Star[]> {
  const res = await fetch('/catalog/stardata');
  if (!res.ok) throw new Error('Failed to load star catalog: ' + res.status);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const count = buf.byteLength / 24;
  const stars: Star[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const off = i * 24;
    const ra = view.getFloat32(off, true);
    const dec = view.getFloat32(off + 4, true);
    const mag = view.getFloat32(off + 8, true);
    const ci = view.getFloat32(off + 12, true);
    const hip = view.getUint32(off + 16, true);
    const flags = view.getUint32(off + 20, true);
    stars[i] = {
      ra, dec, mag, ci, hip,
      con: (flags >> 8) & 0xffff,
      spect: flags & 0xff
    };
  }
  return stars;
}

export async function loadNamedStars(): Promise<NamedStar[]> {
  const res = await fetch('/catalog/named-stars.json');
  if (!res.ok) return [];
  return res.json();
}

export async function loadConstellationLines(): Promise<ConstellationLine[]> {
  const res = await fetch('/catalog/constellation-lines.json');
  if (!res.ok) return [];
  return res.json();
}

export async function loadConstellationNames(): Promise<string[]> {
  const res = await fetch('/catalog/constellations.json');
  if (!res.ok) return [];
  return res.json();
}

/** Load Messier deep-sky catalog (109 objects, compact array format). */
export async function loadMessierCatalog(): Promise<[number, number, number, number, string, string, string][]> {
  const res = await fetch('/catalog/messier.json');
  if (!res.ok) return [];
  return res.json();
}

/** Convert RA (deg) and Dec (deg) to a 3D unit vector in J2000 equatorial frame. */
export function radecToVector(raDeg: number, decDeg: number, radius = 1): [number, number, number] {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const cd = Math.cos(dec);
  return [cd * Math.cos(ra) * radius, Math.sin(dec) * radius, cd * Math.sin(ra) * radius];
}

export { SPHERE_RADIUS };
