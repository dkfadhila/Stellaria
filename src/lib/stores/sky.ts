import { writable } from 'svelte/store';

export interface SkyState {
  latitude: number;
  longitude: number;
  dateMs: number;
  showConstellations: boolean;
  showNames: boolean;
  magLimit: number;
  ready: boolean;
  starCount: number;
  constellationCount: number;
  message: string;
}

export const skyState = writable<SkyState>({
  latitude: 0,
  longitude: 0,
  dateMs: Date.now(),
  showConstellations: true,
  showNames: false,
  magLimit: 6.0,
  ready: false,
  starCount: 0,
  constellationCount: 0,
  message: 'Loading star catalog...'
});

export interface SelectedStar {
  name: string;
  hip: number;
  ra: number;
  dec: number;
  mag: number;
  ci: number;
  con: string;
  spect: string;
  alt: number;
  az: number;
}

export const selectedStar = writable<SelectedStar | null>(null);
