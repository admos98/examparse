import fs from 'node:fs';

const css = fs.readFileSync(new URL('../src/design/tokens.css', import.meta.url), 'utf8');
const getBlock = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  return match?.[1] || '';
};
function declarations(block) {
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}
const lightDecl = declarations(getBlock(':root'));
const darkDecl = declarations(getBlock(":root[data-theme='dark']"));
const lightPalette = { ...lightDecl };
const darkPalette = { ...lightDecl, ...darkDecl };
function tokenColor(palette, token, seen = new Set()) {
  if (seen.has(token)) throw new Error(`Cyclic token reference: ${[...seen, token].join(' → ')}`);
  seen.add(token);
  const value = palette[token];
  if (!value) throw new Error(`Missing token ${token}`);
  const mix = value.match(/color-mix\(in srgb,\s*var\((--[\w-]+)\)\s*([\d.]+)%\s*,\s*var\((--[\w-]+)\)\s*\)/);
  if (mix) {
    const [, foregroundToken, foregroundPercent, backgroundToken] = mix;
    const foreground = tokenColor(palette, foregroundToken, new Set(seen));
    const background = tokenColor(palette, backgroundToken, new Set(seen));
    return mixSrgb(foreground, background, Number(foregroundPercent) / 100);
  }
  const fallback = value.match(/#[0-9a-fA-F]{3,8}/)?.[0];
  if (fallback) return fallback;
  const reference = value.match(/var\((--[\w-]+)/)?.[1];
  if (reference) return tokenColor(palette, reference, seen);
  throw new Error(`Unsupported color token value for ${token}: ${value}`);
}
function normalize(hex) {
  let raw = hex.replace('#', '');
  if (raw.length === 3) raw = [...raw].map(ch => ch + ch).join('');
  if (raw.length === 8) raw = raw.slice(0, 6);
  if (raw.length !== 6) throw new Error(`Unsupported color: ${hex}`);
  return raw;
}
function mixSrgb(foreground, background, weight) {
  const fg = normalize(foreground);
  const bg = normalize(background);
  const channels = [0, 2, 4].map(index => Math.round(
    parseInt(fg.slice(index, index + 2), 16) * weight + parseInt(bg.slice(index, index + 2), 16) * (1 - weight),
  ).toString(16).padStart(2, '0'));
  return `#${channels.join('')}`;
}
function linear(channel) { return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4; }
function luminance(hex) {
  const raw = normalize(hex);
  const [r, g, b] = [0, 2, 4].map(index => linear(parseInt(raw.slice(index, index + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(foreground, background) {
  const [high, low] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (high + 0.05) / (low + 0.05);
}
const pairs = [
  ['--ink', '--paper'], ['--ink', '--paper-raised'],
  ['--ink-2', '--paper'], ['--ink-2', '--paper-raised'],
  ['--ink-3-text', '--paper'], ['--ink-3-text', '--paper-raised'],
  ['--accent-ink', '--paper'], ['--accent-ink', '--paper-raised'],
  ['--ok', '--paper'], ['--ok', '--paper-raised'], ['--ok', '--ok-soft'],
  ['--warn-ink', '--paper'], ['--warn-ink', '--paper-raised'], ['--warn-ink', '--warn-soft'],
  ['--danger', '--paper'], ['--danger', '--paper-raised'], ['--danger', '--danger-soft'],
  ['--on-accent', '--accent'], ['--on-accent', '--danger'], ['--on-accent', '--warn'],
  ['--paper', '--danger'], ['--focus', '--paper'], ['--focus', '--paper-raised'],
];
let failed = false;
for (const [theme, palette] of [['light', lightPalette], ['dark', darkPalette]]) {
  console.log(`${theme.toUpperCase()} THEME`);
  for (const [foregroundToken, backgroundToken] of pairs) {
    const fg = tokenColor(palette, foregroundToken);
    const bg = tokenColor(palette, backgroundToken);
    const value = ratio(fg, bg);
    const minimum = foregroundToken === '--focus' ? 3 : 4.5;
    const status = value >= minimum ? 'PASS' : 'FAIL';
    if (value < minimum) failed = true;
    console.log(`${status} ${foregroundToken} on ${backgroundToken}: ${value.toFixed(2)}:1`);
  }
}
const scrim = ratio('#FFFFFF', mixSrgb('#000000', '#FFFFFF', 0.72));
console.log(`SCRIM ${scrim >= 4.5 ? 'PASS' : 'FAIL'} white text over a 72% black overlay on white media: ${scrim.toFixed(2)}:1`);
if (scrim < 4.5) failed = true;
if (failed) process.exitCode = 1;
