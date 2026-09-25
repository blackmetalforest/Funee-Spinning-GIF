/**
 * The Rendering section's quick buttons: eight lighting setups per path.
 *
 * A preset is a complete lighting setup, never a nudge. Every setting in
 * PRESET_KEYS is written each time, the ones a preset does not name coming
 * from the app's defaults, so a button gives the same picture whatever was
 * clicked before it. Only lighting is covered: the model's placement, the
 * debug switches and Overall Brightness are left where they are, so a preset
 * can be tried on top of the brightness you already settled on.
 *
 * The first preset of each path is the default look, and names no values at
 * all: Studio is the Realistic path as it has always rendered, and Standard
 * is the Retro one, the original renderer's lighting to the last decimal.
 *
 * Angles are the Advanced Lighting ones: around the view, 0° straight from
 * the camera and positive to the right; height is degrees above the view.
 *
 * DOM-free, so the tests can run it under Node.
 */

/** Every setting a preset decides. */
export const PRESET_KEYS = [
  'ambient', 'ambientColor',
  'keyLight', 'keyAzimuth', 'keyHeight', 'keyColor',
  'fillLight', 'fillAzimuth', 'fillHeight', 'fillColor',
  'rimLight', 'specular', 'shininess',
  'environment', 'envIntensity', 'envRotation',
  'toneMapping', 'exposure',
  'shadows', 'shadowDarkness',
];

/*
 * Realistic: physically based materials, lit by an environment as well as the
 * lights, with tone mapping. The environment carries most of the ambient light
 * here, so the ambient slider plays no part.
 */
const REALISTIC = [
  { id: 'studio', label: 'Studio',
    title: 'Softboxes in a grey room. The default.',
    values: {} },
  { id: 'outdoors', label: 'Outdoors',
    title: 'High sun and open sky, with the model shadowing itself.',
    values: {
      environment: 'soft', envIntensity: 0.9,
      keyLight: 1.5, keyAzimuth: 35, keyHeight: 55, keyColor: '#fff3e0',
      fillLight: 0.15, fillAzimuth: -60, fillHeight: 10, fillColor: '#cfdcff',
      shadows: 'model',
    } },
  { id: 'indoors', label: 'Indoors',
    title: 'Warm lamps overhead in a room.',
    values: {
      environment: 'studio', envIntensity: 0.45,
      keyLight: 0.8, keyAzimuth: 15, keyHeight: 60, keyColor: '#ffdcb0',
      fillLight: 0.3, fillAzimuth: -50, fillHeight: 20, fillColor: '#ffe8cc',
      exposure: 1.1,
    } },
  { id: 'soft', label: 'Soft',
    title: 'An overcast sky: even light and gentle shadows.',
    values: {
      environment: 'soft', envIntensity: 1.1,
      keyLight: 0.3, keyAzimuth: 20, keyHeight: 45,
      fillLight: 0.2,
    } },
  { id: 'product', label: 'Product',
    title: 'Bright product shot with edge highlights.',
    values: {
      environment: 'studio', envIntensity: 1.1,
      keyLight: 1.0, fillLight: 0.5, rimLight: 0.25,
      toneMapping: 'aces', exposure: 0.85,
    } },
  { id: 'sunset', label: 'Sunset',
    title: 'Low orange sun from the side, blue sky behind.',
    values: {
      environment: 'soft', envIntensity: 0.4,
      keyLight: 1.5, keyAzimuth: 70, keyHeight: 10, keyColor: '#ffb070',
      fillLight: 0.35, fillAzimuth: -60, fillHeight: 25, fillColor: '#8aa4ff',
      rimLight: 0.2,
    } },
  { id: 'dramatic', label: 'Dramatic',
    title: 'One hard light, deep shadows and a bright edge.',
    values: {
      environment: 'studio', envIntensity: 0.12,
      keyLight: 1.8, keyAzimuth: 65, keyHeight: 35,
      fillLight: 0, rimLight: 0.3,
      shadows: 'model',
    } },
  { id: 'night', label: 'Night',
    title: 'Cool moonlight.',
    values: {
      environment: 'soft', envIntensity: 0.25,
      keyLight: 0.7, keyAzimuth: -30, keyHeight: 45, keyColor: '#a8bcff',
      fillLight: 0.1, fillColor: '#6f7cff', rimLight: 0.35,
    } },
];

/*
 * Retro: the classic Phong path, the look of games and modelling tools from
 * before physically based materials. No environment and no tone mapping: an
 * ambient term, two lights, a rim and Phong's highlight are the whole kit.
 */
const RETRO = [
  { id: 'standard', label: 'Standard',
    title: 'The original lighting. The default.',
    values: {} },
  { id: 'flat', label: 'Flat',
    title: 'Textures at their painted colour, no light and shade. For sprites and unlit games.',
    values: { ambient: 1.0, keyLight: 0, fillLight: 0 } },
  { id: 'viewport', label: 'Viewport',
    title: 'A light from the viewer, as in a modelling program: how the modeller saw it.',
    values: {
      ambient: 0.25,
      keyLight: 0.9, keyAzimuth: 10, keyHeight: 12,
      fillLight: 0.2, fillAzimuth: -70, fillHeight: 10,
      specular: 0.2, shininess: 25,
    } },
  { id: 'console', label: 'Console',
    title: 'Strong ambient and one light from above, as 90s consoles lit their models.',
    values: {
      ambient: 0.55,
      keyLight: 0.7, keyAzimuth: 30, keyHeight: 45,
      fillLight: 0,
    } },
  { id: 'sunlit', label: 'Sunlit',
    title: 'Warm sun overhead with a blue sky ambient.',
    values: {
      ambient: 0.4, ambientColor: '#c4d8ff',
      keyLight: 1.05, keyAzimuth: 40, keyHeight: 55, keyColor: '#fff1d6',
      fillLight: 0.1,
      specular: 0.1, shininess: 20,
    } },
  { id: 'showcase', label: 'Showcase',
    title: 'Character-select lighting: a bright edge all round.',
    values: {
      ambient: 0.2,
      keyLight: 0.9, fillLight: 0.35, fillColor: '#a8b8ff',
      rimLight: 0.6, specular: 0.15,
    } },
  { id: 'glossy', label: 'Glossy',
    title: 'Shiny plastic, like a toy.',
    values: { specular: 0.8, shininess: 60, fillLight: 0.35 } },
  { id: 'night', label: 'Night',
    title: 'Cool moonlight.',
    values: {
      ambient: 0.15, ambientColor: '#6070ff',
      keyLight: 0.6, keyAzimuth: -30, keyHeight: 45, keyColor: '#a8bcff',
      fillLight: 0.1, rimLight: 0.35, specular: 0.2,
    } },
];

/** By path: the same 'physical' and 'classic' the Lighting setting uses. */
export const PRESETS = { physical: REALISTIC, classic: RETRO };

/** A preset's full lighting, filled out from `defaults`. */
export function presetValues(preset, defaults) {
  const values = {};
  for (const key of PRESET_KEYS) values[key] = preset.values[key] ?? defaults[key];
  return values;
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * Which of a path's presets `current` is exactly, or null once anything has
 * been changed by hand. `adjust`, if given, is applied to each preset's
 * values first — for a browser that cannot do everything a preset asks.
 */
export function matchingPreset(shading, current, defaults, adjust = (v) => v) {
  for (const preset of PRESETS[shading] ?? []) {
    const values = adjust(presetValues(preset, defaults));
    if (PRESET_KEYS.every((key) => same(values[key], current[key]))) return preset;
  }
  return null;
}
