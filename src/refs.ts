import { parse as parseJavaScript } from "@babel/parser";
import * as parse5 from "parse5";

const CSS_URL_RE = /\burl\(\s*(['"]?)(.*?)\1\s*\)/gis;
const CSS_IMPORT_RE =
  /@import\s+(?:url\(\s*(['"]?)(.*?)\1\s*\)|(['"])(.*?)\3)/gis;

const HTML_ATTRS = new Set(["href", "src", "poster"]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);

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

export function shouldSkipReference(ref: string): boolean {
  const value = ref.trim();
  if (!value || value.startsWith("#") || value.endsWith("/")) {
    return true;
  }
  if (Array.from(value).some((char) => /\s/.test(char))) {
    return true;
  }
  if (/['"<>{}\\()=;\[\]]/.test(value)) {
    return true;
  }
  if (value.includes(".href")) {
    return true;
  }

  const scheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.exec(value)?.[0].slice(0, -1);
  if (scheme && ["data", "mailto", "javascript", "tel"].includes(scheme.toLowerCase())) {
    return true;
  }

  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const lastSegment = withoutQuery.split("/").filter(Boolean).at(-1) ?? "";
  if (!lastSegment.includes(".") && !scheme) {
    return true;
  }

  return false;
}

export function extractReferences(
  body: Buffer | string,
  localPath: string,
  contentType = "",
): string[] {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  const refs: string[] = [];
  const loweredType = contentType.toLowerCase();
  const loweredPath = localPath.toLowerCase();

  if (
    loweredType.includes("html") ||
    loweredPath.endsWith(".html") ||
    loweredPath.endsWith(".htm") ||
    loweredPath.endsWith(".svg")
  ) {
    refs.push(...extractHtmlReferences(text));
  }
  if (loweredType.includes("css") || loweredPath.endsWith(".css")) {
    refs.push(...extractCssReferences(text));
  }
  if (
    loweredType.includes("javascript") ||
    loweredPath.endsWith(".js") ||
    loweredPath.endsWith(".mjs")
  ) {
    refs.push(...extractJavaScriptReferences(text));
  }
  if (loweredType.includes("json") || loweredPath.endsWith(".json")) {
    refs.push(...extractStringReferences(text));
  }

  return uniqueUsableReferences(refs);
}

function extractHtmlReferences(source: string): string[] {
  const refs: string[] = [];
  const document = parse5.parse(source, { scriptingEnabled: false });
  walkHtml(document, (node) => {
    const attrs = getAttrs(node);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (HTML_ATTRS.has(name)) {
        refs.push(attr.value);
      } else if (SRCSET_ATTRS.has(name)) {
        refs.push(...splitSrcset(attr.value));
      } else if (name === "style") {
        refs.push(...extractCssReferences(attr.value));
      }
    }

    const tagName = getTagName(node);
    if (tagName === "style") {
      refs.push(...extractCssReferences(getTextContent(node)));
    } else if (tagName === "script" && !attrs.some((attr) => attr.name.toLowerCase() === "src")) {
      refs.push(...extractJavaScriptReferences(getTextContent(node)));
    }
  });
  return refs;
}

function extractCssReferences(source: string): string[] {
  const refs: string[] = [];

  for (const match of source.matchAll(CSS_URL_RE)) {
    if (match[2]) {
      refs.push(match[2]);
    }
  }
  for (const match of source.matchAll(CSS_IMPORT_RE)) {
    const ref = match[2] ?? match[4];
    if (ref) {
      refs.push(ref);
    }
  }

  return refs;
}

function extractJavaScriptReferences(source: string): string[] {
  let ast: unknown;
  try {
    ast = parseJavaScript(source, {
      allowReturnOutsideFunction: true,
      errorRecovery: true,
      plugins: ["jsx", "typescript"],
      sourceType: "unambiguous",
    });
  } catch {
    return [];
  }

  const refs: string[] = [];
  walkAst(ast, (value) => {
    refs.push(...extractJavaScriptStringReferences(value));
  });
  return refs;
}

function extractJavaScriptStringReferences(value: string): string[] {
  const refs: string[] = [];
  if (/[<][a-zA-Z!/]/.test(value)) {
    refs.push(...extractHtmlReferences(value));
  }
  if (/\b(?:url\(|@import\b)/i.test(value)) {
    refs.push(...extractCssReferences(value));
  }
  if (looksLikeJavaScriptPathLiteral(value)) {
    refs.push(value);
  }
  return refs;
}

function extractStringReferences(value: string): string[] {
  const refs: string[] = [];
  if (/[<][a-zA-Z!/]/.test(value)) {
    refs.push(...extractHtmlReferences(value));
  }
  if (/\b(?:url\(|@import\b)/i.test(value)) {
    refs.push(...extractCssReferences(value));
  }
  refs.push(value);
  return refs;
}

function looksLikeJavaScriptPathLiteral(value: string): boolean {
  const ref = value.trim();
  if (shouldSkipReference(ref)) {
    return false;
  }
  if (/^searchindex(?:-[0-9a-f]{8})?\.js$/i.test(ref)) {
    return true;
  }
  if (/^https?:\/\//i.test(ref)) {
    return true;
  }
  if (ref.startsWith(".") && !ref.startsWith("./") && !ref.startsWith("../")) {
    return false;
  }
  return ref.includes("/");
}

function uniqueUsableReferences(refs: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const ref of refs) {
    const value = ref.trim();
    if (shouldSkipReference(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function splitSrcset(value: string): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/, 1)[0])
    .filter((candidate): candidate is string => Boolean(candidate));
}

type HtmlNode = {
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
  nodeName?: string;
  tagName?: string;
  value?: string;
};

function walkHtml(node: HtmlNode, visit: (node: HtmlNode) => void): void {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    visit(current);
    const children = current.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        stack.push(child);
      }
    }
  }
}

function getAttrs(node: HtmlNode): Array<{ name: string; value: string }> {
  return node.attrs ?? [];
}

function getTagName(node: HtmlNode): string | null {
  return node.tagName?.toLowerCase() ?? null;
}

function getTextContent(node: HtmlNode): string {
  let text = "";
  const stack = [...(node.childNodes ?? [])].reverse();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    if (typeof current.value === "string") {
      text += current.value;
    }
    const children = current.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        stack.push(child);
      }
    }
  }
  return text;
}

function walkAst(node: unknown, visitString: (value: string) => void, seen = new WeakSet<object>()): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (seen.has(node)) {
    return;
  }
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visitString, seen);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  if (record.type === "StringLiteral" && typeof record.value === "string") {
    visitString(record.value);
  } else if (record.type === "DirectiveLiteral" && typeof record.value === "string") {
    visitString(record.value);
  } else if (record.type === "TemplateLiteral" && Array.isArray(record.expressions)) {
    const expressions = record.expressions as unknown[];
    const quasis = Array.isArray(record.quasis) ? (record.quasis as Array<Record<string, unknown>>) : [];
    if (expressions.length === 0) {
      visitString(
        quasis
          .map((quasi) => {
            const value = quasi.value as { cooked?: unknown; raw?: unknown } | undefined;
            return typeof value?.cooked === "string"
              ? value.cooked
              : typeof value?.raw === "string"
                ? value.raw
                : "";
          })
          .join(""),
      );
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (["start", "end", "loc", "leadingComments", "trailingComments", "innerComments"].includes(key)) {
      continue;
    }
    walkAst(value, visitString, seen);
  }
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
