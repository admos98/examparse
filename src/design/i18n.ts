export type UiLanguage = 'en' | 'fa';

/** The UI keeps English and Persian copy adjacent, matching the existing assistant/memory pattern. */
export function uiText(language: UiLanguage | undefined, english: string, persian: string): string {
  return language === 'fa' ? persian : english;
}
