/** Syntax only: scheme, no credentials, bounded length. The address itself is checked when connecting. */
export function parseWebhookUrl(raw: string, allowPrivate: boolean): URL | null {
  if (raw.length > 500) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) return null;
  return url;
}
