// Astronomy coordinate math: GMST, LST, and celestial->horizontal transforms.
// Positions use the J2000 equatorial frame; precession (IAU 1976) is applied
// to transform J2000 -> mean-of-date before the equatorial->horizontal rotation.
// Nutation and aberration are omitted (sub-arcminute accuracy loss).

export const J2000_EPOCH_MS = Date.UTC(2000, 0, 1, 12, 0, 0);

/** Days since J2000.0 (UT). */
export function daysSinceJ2000(date: Date): number {
  return (date.getTime() - J2000_EPOCH_MS) / 86400000;
}

/** Greenwich Mean Sidereal Time in degrees [0, 360). */
export function gmstDegrees(date: Date): number {
  const d = daysSinceJ2000(date);
  let g = 280.46061837 + 360.98564736629 * d;
  g = ((g % 360) + 360) % 360;
  return g;
}

/** Local Sidereal Time in degrees [0, 360) for a given longitude (deg east). */
export function lstDegrees(date: Date, longitudeDeg: number): number {
  return (((gmstDegrees(date) + longitudeDeg) % 360) + 360) % 360;
}

const DEG = Math.PI / 180;
const ARCSEC_TO_RAD = Math.PI / (180 * 3600);

/**
 * IAU 1976 (Lieske) precession matrix from J2000.0 to mean equator & equinox
 * of date. Returns a 3x3 row-major flat array [m00..m22] such that
 *   r_mod = P * r_j2000
 * where r is a unit vector in the project's equatorial frame
 * (x=vernal equinox, y=north celestial pole, z=90° from x along equator).
 *
 * NOTE: SOFA's iauPmat76 uses the standard astronomy convention
 * (x, y, z) = (equinox, 6h-on-equator, NCP). This project uses
 * (x, y, z) = (equinox, NCP, 6h-on-equator) — y and z are swapped.
 * The elements below are the SOFA formulae with rows/cols 1 and 2 swapped
 * so the matrix operates in the project's convention directly.
 *
 * For dates near J2000 the rotation is ~1.6 arcsec/year; over a century
 * it accumulates to ~0.64°. Formulae from Lieske et al. (1977), A&A 58, 1,
 * using the SOFA iauPmat76 element expansion (the international standard).
 */
export function precessionMatrix(date: Date): number[] {
  const T = daysSinceJ2000(date) / 36525; // Julian centuries TT (UT approx)

  // Precession angles in arcseconds (IAU 1976)
  const zeta_a  = (2306.2181 * T) + (0.30188  * T * T) + (0.017998 * T * T * T);
  const z_a     = (2306.2181 * T) + (1.09468  * T * T) + (0.018203 * T * T * T);
  const theta_a = (2004.3109 * T) - (0.42665  * T * T) - (0.041833 * T * T * T);

  // Convert to radians
  const zeta  = zeta_a  * ARCSEC_TO_RAD;
  const z     = z_a     * ARCSEC_TO_RAD;
  const theta = theta_a * ARCSEC_TO_RAD;

  const sz = Math.sin(z),     cz = Math.cos(z);
  const st = Math.sin(theta), ct = Math.cos(theta);
  const szeta = Math.sin(zeta), czeta = Math.cos(zeta);

  // SOFA iauPmat76 element expansion (row-major) — original convention
  // (x, y, z) = (equinox, 6h, NCP):
  //   p00 = -sz*szeta + cz*ct*czeta      p01 = -sz*czeta - cz*ct*szeta      p02 = -cz*st
  //   p10 =  cz*szeta + sz*ct*czeta      p11 =  cz*czeta - sz*ct*szeta      p12 = -sz*st
  //   p20 =  st*czeta                    p21 =  st*szeta                    p22 =  ct
  //
  // Swap rows/cols 1<->2 to convert to project convention (x, y, z) = (equinox, NCP, 6h):
  //   P_mine[i][j] = P_sofa[swap(i)][swap(j)]  where swap(1)=2, swap(2)=1, swap(0)=0
  const p00 = -sz * szeta + cz * ct * czeta;       // = SOFA p00
  const p01 = -cz * st;                            // = SOFA p02
  const p02 = -sz * czeta - cz * ct * szeta;       // = SOFA p01
  const p10 =  st * czeta;                         // = SOFA p20
  const p11 =  ct;                                 // = SOFA p22
  const p12 =  st * szeta;                         // = SOFA p21
  const p20 =  cz * szeta + sz * ct * czeta;       // = SOFA p10
  const p21 = -sz * st;                            // = SOFA p12
  const p22 =  cz * czeta - sz * ct * szeta;       // = SOFA p11

  return [p00, p01, p02, p10, p11, p12, p20, p21, p22];
}

/** Multiply two 3x3 row-major matrices: returns A*B (row-major flat). */
function mul3(a: number[], b: number[]): number[] {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        a[i * 3] * b[j] +
        a[i * 3 + 1] * b[3 + j] +
        a[i * 3 + 2] * b[6 + j];
    }
  }
  return r;
}

/**
 * Build the 3x3 rotation matrix that maps a unit vector in the J2000
 * equatorial frame (x=vernal equinox, y=north celestial pole,
 * z=equatorial 90deg from x) into the observer's horizontal frame
 * (x=south, y=zenith/up, z=east).
 *
 * The returned matrix includes IAU 1976 precession J2000 -> mean-of-date,
 * so callers pass raw J2000 RA/Dec and get correct alt/az for the date.
 *
 * Star unit vector from RA/Dec:
 *   cx = cos(dec)*cos(ra)
 *   cy = sin(dec)
 *   cz = cos(dec)*sin(ra)
 */
export function rotationMatrix(date: Date, latitudeDeg: number, longitudeDegDeg: number): number[] {
  const lst = lstDegrees(date, longitudeDegDeg) * DEG;
  const phi = latitudeDeg * DEG;
  const cosLst = Math.cos(lst), sinLst = Math.sin(lst);
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);

  // R_y(LST): rotate around polar axis to convert RA -> hour angle
  // [ cosLst, 0, sinLst]
  // [ 0,      1, 0     ]
  // [-sinLst, 0, cosLst]
  //
  // R_z(90-phi): align celestial pole with zenith
  // [ sinPhi, -cosPhi, 0]
  // [ cosPhi,  sinPhi, 0]
  // [ 0,       0,      1]
  //
  // M = R_z * R_y  (column-major for Three.js Matrix3.set / elements)
  // Row-major result first, then we transpose for column-major.
  const m00 = sinPhi * cosLst;
  const m01 = -cosPhi;
  const m02 = sinPhi * sinLst;
  const m10 = cosPhi * cosLst;
  const m11 = sinPhi;
  const m12 = cosPhi * sinLst;
  const m20 = -sinLst;
  const m21 = 0;
  const m22 = cosLst;

  const M = [m00, m01, m02, m10, m11, m12, m20, m21, m22];

  // Compose with precession: combined = M * P, so r_horiz = M * (P * r_j2000)
  return mul3(M, precessionMatrix(date));
}

/**
 * Convert a horizontal-frame unit vector (x=south, y=up, z=east) into
 * compass bearing (azimuth from North, clockwise) and altitude (deg).
 */
export function horizontalToAltAz(x: number, y: number, z: number): { az: number; alt: number } {
  const alt = Math.asin(Math.max(-1, Math.min(1, y))) / DEG;
  // x=south, z=east. Bearing from North clockwise: North=-x, East=+z
  // az = atan2(east, north) = atan2(z, -x)
  let az = Math.atan2(z, -x) / DEG;
  if (az < 0) az += 360;
  return { az, alt };
}

/**
 * Convert compass bearing (az from North, clockwise) and altitude (deg)
 * into a horizontal-frame unit vector (x=south, y=up, z=east).
 */
export function altAzToHorizontal(azDeg: number, altDeg: number): [number, number, number] {
  const az = azDeg * DEG, alt = altDeg * DEG;
  const ca = Math.cos(alt);
  // north = -x, east = +z
  return [-ca * Math.cos(az), Math.sin(alt), ca * Math.sin(az)];
}

/** Format degrees as HH:MM:SS (for RA/LST display). */
export function degToHms(deg: number): string {
  const h = (((deg % 360) + 360) % 360) / 15;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  const ss = Math.floor((h - hh - mm / 60) * 3600);
  return `${String(hh).padStart(2, '0')}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
}

/** Format degrees as DD:MM:SS with sign. */
export function degToDms(deg: number): string {
  const sign = deg < 0 ? '-' : '+';
  const a = Math.abs(deg);
  const dd = Math.floor(a);
  const mm = Math.floor((a - dd) * 60);
  const ss = Math.floor((a - dd - mm / 60) * 3600);
  return `${sign}${String(dd).padStart(2, '0')}° ${String(mm).padStart(2, '0')}' ${String(ss).padStart(2, '0')}"`;
}
