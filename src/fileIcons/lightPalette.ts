const palettes: Record<'material' | 'seti', Record<string, string>> = {
  material: { '#dea584': '#ad6236', '#8bc34a': '#5f8620', '#fbc02d': '#c38b00', '#f7df1e': '#bfa900', '#90a4ae': '#607784' },
  seti: { '#cbcb41': '#83831a', '#8dc149': '#5e842a', '#d4d7d6': '#5d656a', '#519aba': '#337693', '#8d99ae': '#65738e' },
};
const caches = { material: new Map<string, string>(), seti: new Map<string, string>() };
/** Adjust only low-contrast palette colors, preserving SVG geometry and interior ink. */
export function adaptLightPalette(svg: string, theme: 'material' | 'seti'): string {
  const cache = caches[theme];
  let result = cache.get(svg);
  if (!result) {
    result = svg.replace(/#[0-9a-f]{6}/gi, (color) => palettes[theme][color.toLowerCase()] ?? color);
    cache.set(svg, result);
  }
  return result;
}
