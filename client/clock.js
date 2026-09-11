import { useEffect, useState } from 'react';
import { locale } from './i18n';

/**
 * Clock bits shared by every stage that shows a deadline.
 *
 * Three stages now count down to the same two instants — submit to the cutoff, waiting
 * to the target round, and the header timeline to both — and a countdown that is
 * implemented twice is a countdown that disagrees with itself on one of them.
 */

/** Re-render on a timer. Returns nothing: the tick is the point. */
export function useTick(ms = 1000) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function split(msLeft) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  return {
    d: Math.floor(s / 86400),
    h: Math.floor((s % 86400) / 3600),
    m: Math.floor((s % 3600) / 60),
    s: s % 60,
  };
}

/**
 * An instant a player may have to act on, stated so that it cannot be misread.
 *
 * Two forms, both shown: the reader's own local time, which is what they will look at a
 * clock and compare against, and the UTC instant, which is what the protocol names and
 * what anyone in another timezone can check against. The offset is printed next to the
 * local time because "20:30" alone is ambiguous the moment two players are in different
 * places, and this draw has been run across three.
 */
export function formatExact(iso, lang) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const local = d.toLocaleString(locale(lang), {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  // Intl names the zone; the numeric offset is the part that removes all doubt.
  // "UTC+8", not "UTC+08:00": the half-hour zones need their minutes and nobody else
  // does, and the short form is the one people write.
  const mins = -d.getTimezoneOffset();
  const sign = mins < 0 ? '-' : '+';
  const abs = Math.abs(mins);
  const offset = `UTC${sign}${Math.floor(abs / 60)}`
    + (abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : '');
  const utc = d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  return { local, offset, utc };
}
