export interface Star {
  ra: number;       // right ascension, degrees
  dec: number;      // declination, degrees
  mag: number;      // apparent magnitude
  ci: number;       // B-V color index
  hip: number;      // Hipparcos catalog ID
  con: number;      // constellation index
  spect: number;    // spectral class code (0-6 OBAFGKM, 255 unknown)
}

export interface NamedStar {
  name: string;
  hip: number;
  ra: number;
  dec: number;
  mag: number;
  con: string;
}

export interface ConstellationLine {
  iau: string;
  name: string;
  edges: [number, number][]; // pairs of HIP IDs
}

export const SPECTRAL_NAMES = ['O', 'B', 'A', 'F', 'G', 'K', 'M'];
