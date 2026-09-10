import { createContext, useContext } from 'react';

/**
 * Two languages, one at a time.
 *
 * The players are a mixed group and not all of them read Chinese, so every screen has
 * to exist in English too. Printing both at once was the other option and it loses:
 * UI-SPEC §1 asks for one focal element per stage, and a stage that says everything
 * twice has none. So the language is a choice, remembered, with the toggle in the
 * header where it is visible from every stage.
 *
 * There is no framework here and no key namespace either. Each component carries its
 * own `{ zh, en }` block next to the markup that uses it, because a translation you can
 * see beside its context is one you can check; a central file of two hundred opaque keys
 * is one nobody re-reads. `useText` picks the block for the active language.
 *
 * The first choice is the browser's, not ours: a visitor whose Accept-Language has no
 * Chinese in it gets English without touching anything.
 */

export const LANGS = ['zh', 'en'];
const STORAGE_KEY = 'seating-draw-lang';

export const LangContext = createContext('zh');
export const useLang = () => useContext(LangContext);

/** This component's strings, in the language currently chosen. */
export function useText(dict) {
  const lang = useLang();
  return dict[lang] || dict.zh;
}

export function initialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* private mode, or storage disabled: fall through to the browser's */ }
  const tags = (navigator.languages?.length ? navigator.languages : [navigator.language || '']).join(',');
  return /(^|,)\s*zh/i.test(tags) ? 'zh' : 'en';
}

export function rememberLang(lang) {
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* nothing to do about it */ }
}

/** Dates belong to the reader's language, not to the server's. */
export const locale = (lang) => (lang === 'zh' ? 'zh-CN' : 'en-GB');

export function formatDateTime(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale(lang), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatTime(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(locale(lang));
}

/**
 * Wind names. The letters are the protocol's (§7 encodes E/S/W/N); these are only ever
 * what a player reads, so they follow the chosen language.
 */
export const WINDS = {
  zh: { E: '东', S: '南', W: '西', N: '北' },
  en: { E: 'E', S: 'S', W: 'W', N: 'N' },
};

/** "第 3 桌" / "Table 3" — needed in half a dozen places, so it lives here once. */
export const tableName = (lang, n) => (lang === 'zh' ? `第 ${n} 桌` : `Table ${n}`);
export const roundName = (lang, n) => (lang === 'zh' ? `第 ${n} 轮` : `Round ${n}`);

/** Joins a list the way the language does: 、 in Chinese, commas and "and" in English. */
export function listOf(lang, items) {
  if (lang === 'zh') return items.join('、');
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
