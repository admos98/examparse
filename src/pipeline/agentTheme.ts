import { z } from 'zod';
import { AppSettings } from '../types';

/** Legacy allowlist remains stable for the assistant; visual tokens are PAPERWORK aliases. */
export const THEME_DEFAULTS = {
  primary: '#B3402A',
  background: '#FAF7F2',
  foreground: '#1A1815',
} as const;
export const ThemeTokenSchema = z.enum(['primary', 'background', 'foreground']);

export function nextThemeMode(current: AppSettings['themeMode'], systemDark: boolean): 'light' | 'dark' {
  return current === 'dark' || (current === 'system' && systemDark) ? 'light' : 'dark';
}
// Deliberately small CSS-color grammar; no URLs, var(), functions, declarations or executable CSS.
export const ColorSchema = z
  .string()
  .regex(
    /^(?:#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?|(?:black|white|red|blue|yellow|green|orange|purple|gray|transparent))$/,
    'Use a hex color or a supported named color.',
  );

/**
 * Compatibility migration: assistant `primary/background/foreground` values are
 * applied as accent/paper/ink aliases. Existing local custom colors are retained;
 * themeMode controls whether the light or dark token set is active.
 */
export function applyTheme(
  settings: Pick<AppSettings, 'themeTokens' | 'themeMode'>,
  style = typeof document === 'undefined'
    ? undefined
    : document.documentElement.style,
): void {
  if (!style) return;
  const aliases = {
    primary: '--legacy-accent',
    background: '--legacy-paper',
    foreground: '--legacy-ink',
  } as const;
  for (const token of Object.keys(THEME_DEFAULTS) as Array<keyof typeof THEME_DEFAULTS>) {
    const value = settings.themeTokens?.[token];
    const validValue = value && ColorSchema.safeParse(value).success ? value : undefined;
    style.setProperty(`--app-${token}`, validValue || THEME_DEFAULTS[token]);
    if (validValue) style.setProperty(aliases[token], validValue);
    else style.removeProperty?.(aliases[token]);
  }
  if (typeof document !== 'undefined' && document.documentElement) {
    if (!settings.themeMode || settings.themeMode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = settings.themeMode;
  }
}
