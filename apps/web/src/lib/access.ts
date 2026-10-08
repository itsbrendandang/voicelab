/**
 * Optional shared-secret access token. When the page is opened as `/?token=…`
 * the same token is passed on the WebSocket (`/ws?token=…`) and on every
 * `/api/*` request (`?token=…`). Never log it: `redactToken` scrubs it from
 * any text that may reach the UI or the console.
 */

function pageSearch(): string {
  try {
    return typeof location === "undefined" ? "" : location.search;
  } catch {
    return "";
  }
}

export function readAccessToken(search: string = pageSearch()): string | null {
  try {
    const token = new URLSearchParams(search).get("token");
    return token ? token : null;
  } catch {
    return null;
  }
}

/** Append `token` as a query parameter (keeps any existing query and fragment). */
export function withToken(url: string, token: string | null = readAccessToken()): string {
  if (!token) return url;
  const hashAt = url.indexOf("#");
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : "";
  return `${base}${base.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}${hash}`;
}

/** URL for a server HTTP endpoint (`/api/...`), carrying the page's access token. */
export function apiUrl(path: string): string {
  return withToken(path);
}

export function redactToken(text: string, token: string | null = readAccessToken()): string {
  if (!token) return text;
  let out = text.split(token).join("[redacted]");
  const encoded = encodeURIComponent(token);
  if (encoded !== token) out = out.split(encoded).join("[redacted]");
  return out;
}
