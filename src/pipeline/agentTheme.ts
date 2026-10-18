import { z } from 'zod';
import { AppSettings } from '../types';
export const THEME_DEFAULTS = {
  primary: '#3B82F6',
  background: '#F8FAFC',
  foreground: '#0F172A',
} as const;
export const ThemeTokenSchema = z.enum(['primary', 'background', 'foreground']);
// Deliberately small CSS-color grammar; no URLs, var(), functions, declarations or executable CSS.
export const ColorSchema = z
  .string()
  .regex(
    /^(?:#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?|(?:black|white|red|blue|yellow|green|orange|purple|gray|transparent))$/,
    'Use a hex color or a supported named color.',
  );
export function applyTheme(
  settings: Pick<AppSettings, 'themeTokens'>,
  style = typeof document === 'undefined'
    ? undefined
    : document.documentElement.style,
): void {
  if (!style) return;
  for (const token of Object.keys(THEME_DEFAULTS) as Array<
    keyof typeof THEME_DEFAULTS
  >) {
    const value = settings.themeTokens?.[token];
    style.setProperty(
      `--app-${token}`,
      value && ColorSchema.safeParse(value).success
        ? value
        : THEME_DEFAULTS[token],
    );
  }
}
