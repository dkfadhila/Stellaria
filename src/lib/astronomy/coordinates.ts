// Astronomy coordinate math: GMST, LST, and celestial->horizontal transforms.
// Positions use the J2000 equatorial frame; precession/nutation are omitted
// in v0.1 (sub-degree accuracy loss, acceptable for visual use).

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

/**
 * Build the 3x3 rotation matrix that maps a unit vector in the J2000
 * equatorial frame (x=vernal equinox, y=north celestial pole,
 * z=equatorial 90deg from x) into the observer's horizontal frame
 * (x=south, y=zenith/up, z=east).
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

  // Row-major for Three.js Matrix3.set(n11,n12,n13, n21,n22,n23, n31,n32,n33)
  return [m00, m01, m02, m10, m11, m12, m20, m21, m22];
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
