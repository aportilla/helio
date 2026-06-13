// Body lighting helper — pushes a StarLightSource[] into a ShaderMaterial
// built by makePlanetMaterial. Lives here (rather than inside each layer
// file) so PlanetsLayer and MoonsLayer share one implementation; sits
// outside ./materials because the input type (StarLightSource) is owned
// by ./types.

import type { Color, ShaderMaterial, Vector2 } from 'three';
import { MAX_LIGHTS } from '../materials';
import type { StarLightSource } from './types';

export function writeLightUniforms(
  material: ShaderMaterial,
  lights: readonly StarLightSource[],
): void {
  const count = Math.min(lights.length, MAX_LIGHTS);
  material.uniforms.uLightCount!.value = count;
  const posArr = material.uniforms.uLightPos!.value as Vector2[];
  const colArr = material.uniforms.uLightColor!.value as Color[];
  const intArr = material.uniforms.uLightIntensity!.value as Float32Array;
  for (let i = 0; i < count; i++) {
    const L = lights[i]!;
    posArr[i]!.set(L.x, L.y);
    colArr[i]!.setRGB(L.color[0], L.color[1], L.color[2]);
    intArr[i] = L.intensity;
  }
}
