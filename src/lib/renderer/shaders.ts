// GLSL shaders for star rendering.

export const starVertexShader = /* glsl */ `
attribute float aMag;
attribute float aCi;

uniform mat3 uRotation;   // celestial -> horizontal frame
uniform float uRadius;
uniform float uPixelScale;
uniform float uMagLimit;
uniform float uDpr;

varying vec3 vColor;
varying float vAlpha;

// B-V color index to RGB (approximate stellar colors)
vec3 bvToRgb(float bv) {
  bv = clamp(bv, -0.4, 2.0);
  float t = (bv + 0.4) / 2.4;
  // interpolate blue-white-yellow-orange-red
  vec3 c0 = vec3(0.6, 0.7, 1.0);   // O/B: blue
  vec3 c1 = vec3(0.85, 0.9, 1.0);  // A: white-blue
  vec3 c2 = vec3(1.0, 1.0, 0.95);  // F: white-yellow
  vec3 c3 = vec3(1.0, 0.95, 0.8);  // G: yellow
  vec3 c4 = vec3(1.0, 0.8, 0.55);  // K: orange
  vec3 c5 = vec3(1.0, 0.6, 0.45);  // M: red
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5)  return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.7)  return mix(c2, c3, (t - 0.5) / 0.2);
  if (t < 0.85) return mix(c3, c4, (t - 0.7) / 0.15);
  return mix(c4, c5, (t - 0.85) / 0.15);
}

void main() {
  // Transform equatorial (J2000) -> horizontal frame
  vec3 horiz = uRotation * position;
  vec4 mvPosition = modelViewMatrix * vec4(horiz * uRadius, 1.0);

  // Cull stars behind camera or below magnitude limit
  vAlpha = 1.0;
  if (mvPosition.z > 0.0) vAlpha = 0.0;
  if (aMag > uMagLimit) vAlpha = 0.0;

  // Stellar color from B-V index
  vColor = bvToRgb(aCi);

  // Point size: brighter stars = bigger
  float size = max(1.0, (7.0 - aMag) * 1.5 * uDpr);
  gl_PointSize = size;
  gl_Position = projectionMatrix * mvPosition;
}
`;

export const starFragmentShader = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;

void main() {
  if (vAlpha <= 0.0) discard;
  vec2 c = gl_PointCoord - vec2(0.5);
  float d = length(c) * 2.0;
  // soft gaussian-ish core + faint halo
  float core = exp(-d * d * 4.0);
  float halo = exp(-d * d * 1.2) * 0.4;
  float a = (core + halo) * vAlpha;
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a);
}
`;

export const lineVertexShader = /* glsl */ `
uniform mat3 uRotation;
uniform float uRadius;
void main() {
  vec3 horiz = uRotation * position;
  float vis = horiz.y >= 0.0 ? 1.0 : 0.0;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(horiz * uRadius, 1.0);
}
`;

export const lineFragmentShader = /* glsl */ `
precision mediump float;
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
}
`;
