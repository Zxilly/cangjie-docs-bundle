export function normalizeBaseUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

export function stripUrlFragmentAndQuery(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.search = "";
  return parsed.toString();
}

export function localPathForUrl(url: string, baseUrl: string): string | null {
  const base = new URL(normalizeBaseUrl(baseUrl));
  const parsed = new URL(stripUrlFragmentAndQuery(url));

  if (parsed.protocol !== base.protocol || parsed.host !== base.host) {
    return null;
  }
  if (!parsed.pathname.startsWith(base.pathname)) {
    return null;
  }

  let relativePath = parsed.pathname.slice(base.pathname.length);
  if (!relativePath || relativePath.endsWith("/")) {
    relativePath = `${relativePath}index.html`;
  }

  try {
    relativePath = decodeURIComponent(relativePath);
  } catch {
    return null;
  }

  const normalized = pathPosixNormalize(relativePath);
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
    return null;
  }
  return normalized === "." ? "index.html" : normalized;
}

function pathPosixNormalize(value: string): string {
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length === 0) {
        return "../";
      }
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/") || ".";
}
