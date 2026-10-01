import { getCachedGame, cacheGame } from '../cache/index.js';
import { escapeAttr, isSafeHttpUrl } from '../utils/index.js';

export async function buildRenderableHtml(url: string): Promise<string> {
  if (!isSafeHttpUrl(url)) throw new Error('Refusing to fetch unsafe game URL');
  const cached = await getCachedGame(url);
  if (cached) {
    console.log('[Game Cache] Using cached HTML for:', url);
    return cached;
  }
  console.log('[Game Cache] Fetching HTML from network:', url);
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) throw new Error('Failed to fetch game HTML: ' + res.status);
  let html = await res.text();
  const baseHref = url.slice(0, url.lastIndexOf('/') + 1);
  const inject = `<base href="${escapeAttr(baseHref)}" target="_self"><meta name="referrer" content="no-referrer">`;
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, `<head$1>${inject}`);
  } else {
    html = inject + html;
  }
  await cacheGame(url, html);
  return html;
}
