import { parse as parseJavaScript } from "@babel/parser";
import { generate as generateCss, parse as parseCss, walk as walkCss } from "css-tree";
import * as parse5 from "parse5";

import { discoveredReference, type DiscoveredReference, type ReferenceKind } from "./references.js";

const HTML_ATTRS = new Set(["href", "src", "poster"]);
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
type CssContext = "stylesheet" | "declarationList";

export function shouldSkipReference(ref: string): boolean {
  const value = ref.trim();
  if (!value || value.startsWith("#") || value.endsWith("/")) {
    return true;
  }
  if (Array.from(value).some((char) => /\s/.test(char))) {
    return true;
  }
  if (/['"<>{}\\();\[\]]/.test(value)) {
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
  if (/\.(?:md|markdown)$/i.test(lastSegment)) {
    return true;
  }
  const extension = /\.([^./]+)$/.exec(lastSegment)?.[1];
  if (extension && /^\d+$/.test(extension)) {
    return true;
  }

  return false;
}

export function extractReferences(
  body: Buffer | string,
  localPath: string,
  contentType = "",
): DiscoveredReference[] {
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : body;
  const refs: DiscoveredReference[] = [];
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
    refs.push(...extractJavaScriptReferences(text, localPath));
  }
  if (loweredType.includes("json") || loweredPath.endsWith(".json")) {
    refs.push(...extractStringReferences(text));
  }

  return uniqueUsableReferences(refs);
}

export function rewriteCssAssetReferences(
  source: string,
  context: CssContext = "stylesheet",
): string {
  let ast;
  try {
    ast = parseCss(source, {
      context,
      positions: false,
      onParseError: () => {},
    });
  } catch {
    return source;
  }

  let modified = false;
  walkCss(ast, (node) => {
    if (node.type === "Url") {
      const stripped = stripRelativeQueryString(node.value);
      if (stripped !== node.value) {
        node.value = stripped;
        modified = true;
      }
      return;
    }
    if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
      const prelude = node.prelude;
      if (!prelude || prelude.type !== "AtrulePrelude") {
        return;
      }
      for (const child of prelude.children) {
        if (child.type === "String") {
          const stripped = stripRelativeQueryString(child.value);
          if (stripped !== child.value) {
            child.value = stripped;
            modified = true;
          }
          break;
        }
        if (child.type === "Url") {
          break;
        }
      }
    }
  });

  if (!modified) {
    return source;
  }
  try {
    return generateCss(ast);
  } catch {
    return source;
  }
}

function extractHtmlReferences(source: string): DiscoveredReference[] {
  const refs: DiscoveredReference[] = [];
  const document = parse5.parse(source, { scriptingEnabled: false });
  walkHtml(document, (node) => {
    const attrs = getAttrs(node);
    for (const attr of attrs) {
      const name = attr.name.toLowerCase();
      if (HTML_ATTRS.has(name)) {
        refs.push(toReference(attr.value, "html-attribute"));
      } else if (SRCSET_ATTRS.has(name)) {
        refs.push(...splitSrcset(attr.value).map((value) => toReference(value, "html-srcset")));
      } else if (name === "style") {
        refs.push(...extractCssReferences(attr.value, "declarationList"));
      }
    }

    const tagName = getTagName(node);
    if (tagName === "style") {
      refs.push(...extractCssReferences(getTextContent(node)));
    } else if (tagName === "script" && !attrs.some((attr) => attr.name.toLowerCase() === "src")) {
      refs.push(...extractJavaScriptReferences(getTextContent(node), ""));
    }
  });
  return refs;
}

function extractCssReferences(
  source: string,
  context: CssContext = "stylesheet",
): DiscoveredReference[] {
  const refs: DiscoveredReference[] = [];

  let ast;
  try {
    ast = parseCss(source, {
      context,
      positions: false,
      onParseError: () => {},
    });
  } catch {
    return refs;
  }

  walkCss(ast, (node) => {
    if (node.type === "Url") {
      refs.push(toReference(node.value, "stylesheet-url"));
      return;
    }
    if (node.type === "Atrule" && node.name.toLowerCase() === "import") {
      const prelude = node.prelude;
      if (!prelude || prelude.type !== "AtrulePrelude") {
        return;
      }
      for (const child of prelude.children) {
        if (child.type === "String") {
          refs.push(toReference(child.value, "stylesheet-import"));
          break;
        }
        if (child.type === "Url") {
          break;
        }
      }
    }
  });

  return refs;
}

function extractJavaScriptReferences(
  source: string,
  localPath: string,
): DiscoveredReference[] {
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

  const refs: DiscoveredReference[] = [];
  walkAst(ast, (value) => {
    refs.push(...extractJavaScriptStringReferences(value, localPath));
  });
  return refs;
}

function extractJavaScriptStringReferences(
  value: string,
  localPath: string,
): DiscoveredReference[] {
  const refs: DiscoveredReference[] = [];
  if (/[<][a-zA-Z!/]/.test(value) && !localPath.startsWith("assets/")) {
    refs.push(...extractHtmlReferences(value));
  }
  if (/\b(?:url\(|@import\b)/i.test(value)) {
    refs.push(...extractCssReferences(value));
  }
  if (looksLikeJavaScriptPathLiteral(value)) {
    refs.push(toReference(value, "javascript-path"));
  }
  return refs;
}

function extractStringReferences(value: string): DiscoveredReference[] {
  const refs: DiscoveredReference[] = [];
  if (/[<][a-zA-Z!/]/.test(value)) {
    refs.push(...extractHtmlReferences(value));
  }
  if (/\b(?:url\(|@import\b)/i.test(value)) {
    refs.push(...extractCssReferences(value));
  }
  refs.push(toReference(value, "json-string"));
  return refs;
}

function stripRelativeQueryString(value: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//")) {
    return value;
  }
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) {
    return value;
  }
  const fragmentIndex = value.indexOf("#", queryIndex);
  if (fragmentIndex < 0) {
    return value.slice(0, queryIndex);
  }
  return value.slice(0, queryIndex) + value.slice(fragmentIndex);
}

function looksLikeJavaScriptPathLiteral(value: string): boolean {
  const ref = value.trim();
  if (shouldSkipReference(ref)) {
    return false;
  }
  if (/^searchindex(?:-[0-9a-f]{8})?\.(?:js|json)$/i.test(ref)) {
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

function uniqueUsableReferences(refs: DiscoveredReference[]): DiscoveredReference[] {
  const seen = new Set<string>();
  const output: DiscoveredReference[] = [];
  for (const ref of refs) {
    const value = ref.value.trim();
    const key = `${ref.resolution}\0${value}`;
    if (shouldSkipReference(value) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push({ ...ref, value });
  }
  return output;
}

function toReference(value: string, kind: ReferenceKind): DiscoveredReference {
  return discoveredReference(value, { kind });
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
