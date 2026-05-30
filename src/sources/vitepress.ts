import { z } from "zod";

import { extractReferences } from "../refs.js";
import {
  discoveredReference,
  uniqueDiscoveredReferences,
  type DiscoveredReference,
} from "../references.js";
import { normalizeBaseUrl } from "../urls.js";
import { genericProfile, isParseable } from "./generic.js";
import type { CrawlProfile, DocsSource } from "./types.js";

export const VITEPRESS_BASE_URL = "https://cj-docs.gitcode.com/zh/{version}/";

const VITEPRESS_BOOTSTRAP_PATH = "dev-guide/source_zh_cn/first_understanding/basic.html";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const vitePressHashMapSchema = z.record(z.string(), z.unknown()).transform((entries) => {
  const hashMap: Record<string, string> = {};
  for (const [page, hash] of Object.entries(entries)) {
    if (typeof hash === "string" && page.endsWith(".md") && /^[\w-]+$/.test(hash)) {
      hashMap[page] = hash;
    }
  }
  return hashMap;
});
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export function createVitePressSource(version: string): DocsSource {
  const baseUrl = normalizeBaseUrl(VITEPRESS_BASE_URL.replace("{version}", version));
  return {
    kind: "vitepress",
    baseUrl,
    startUrls: [new URL(VITEPRESS_BOOTSTRAP_PATH, baseUrl).toString()],
    profile: vitePressProfile,
  };
}

export function usesVitePressSource(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    return false;
  }

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  const patch = Number.parseInt(match[3] ?? "", 10);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 3)));
}

export const vitePressProfile: CrawlProfile = {
  extractReferences: extractVitePressAwareReferences,
  rewriteAssetForDisk: rewriteVitePressAssetForDisk,
};

function extractVitePressAwareReferences(
  body: Buffer,
  localPath: string,
  contentType: string,
): DiscoveredReference[] {
  const genericRefs = withVitePressPageChunkCompanions(
    extractReferences(body, localPath, contentType).map((ref) =>
      normalizeVitePressGenericReference(ref, localPath),
    ),
  );
  if (!isHtml(localPath, contentType)) {
    return genericRefs;
  }

  const text = body.toString("utf8");
  return uniqueDiscoveredReferences([...extractVitePressReferences(text), ...genericRefs]);
}

export function extractVitePressReferences(source: string): DiscoveredReference[] {
  const refs: DiscoveredReference[] = [];
  const hashMap = parseVitePressGlobalJson(source, "__VP_HASH_MAP__", vitePressHashMapSchema);
  if (hashMap) {
    for (const [page, hash] of Object.entries(hashMap)) {
      refs.push(
        toVitePressRootReference(`/assets/${page}.${hash}.lean.js`, "vitepress-page-chunk", {
          optional: true,
        }),
      );
      refs.push(
        toVitePressRootReference(`/assets/${page}.${hash}.js`, "vitepress-page-chunk", {
          optional: true,
        }),
      );
    }
  }

  const siteData = parseVitePressGlobalJson(source, "__VP_SITE_DATA__", jsonValueSchema);
  if (siteData) {
    walkJsonStrings(siteData, (value) => {
      const htmlRef = vitePressMarkdownLinkToHtmlRef(value);
      if (htmlRef) {
        refs.push(toVitePressRootReference(htmlRef, "vitepress-route"));
      }
    });
  }
  return uniqueDiscoveredReferences(refs);
}

function rewriteVitePressAssetForDisk(
  body: Buffer,
  localPath: string,
  contentType: string,
  baseUrl: string,
): Buffer {
  if (!isParseable(localPath, contentType)) {
    return body;
  }
  const cssRewritten = genericProfile.rewriteAssetForDisk?.(body, localPath, contentType, baseUrl) ?? body;
  const original = cssRewritten.toString("utf8");
  const rewritten = rewriteHostedPathPrefix(original, baseUrl);
  return rewritten === original ? cssRewritten : Buffer.from(rewritten, "utf8");
}

function rewriteHostedPathPrefix(source: string, baseUrl: string): string {
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.hostname !== "cj-docs.gitcode.com") {
    return source;
  }
  const prefix = parsedBaseUrl.pathname.replace(/\/+$/, "/");
  if (prefix === "/") {
    return source;
  }
  return source.split(prefix).join("/");
}

function parseVitePressGlobalJson<T>(
  source: string,
  name: string,
  schema: z.ZodType<T>,
): T | null {
  const pattern = new RegExp(`window\\.${escapeRegExp(name)}\\s*=\\s*JSON\\.parse\\("((?:\\\\.|[^"\\\\])*)"\\)`);
  const rawArgument = pattern.exec(source)?.[1];
  if (!rawArgument) {
    return null;
  }
  try {
    const encodedJson = z.string().parse(JSON.parse(`"${rawArgument}"`));
    const parsedJson = JSON.parse(encodedJson) as unknown;
    const result = schema.safeParse(parsedJson);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function vitePressMarkdownLinkToHtmlRef(value: string): string | null {
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ||
    Array.from(trimmed).some((char) => /\s/.test(char))
  ) {
    return null;
  }
  const fragmentIndex = trimmed.indexOf("#");
  const pathPart = fragmentIndex >= 0 ? trimmed.slice(0, fragmentIndex) : trimmed;
  const fragment = fragmentIndex >= 0 ? trimmed.slice(fragmentIndex) : "";
  if (!pathPart.toLowerCase().endsWith(".md")) {
    return null;
  }
  const htmlPath = `${pathPart.slice(0, -".md".length)}.html`;
  return htmlPath.startsWith("/") ? `${htmlPath}${fragment}` : `/${htmlPath}${fragment}`;
}

function walkJsonStrings(value: JsonValue, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      walkJsonStrings(item, visit);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const item of Object.values(value)) {
    walkJsonStrings(item, visit);
  }
}

function isHtml(localPath: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  const loweredPath = localPath.toLowerCase();
  return loweredType.includes("html") || loweredPath.endsWith(".html") || loweredPath.endsWith(".htm");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toVitePressRootReference(
  value: string,
  kind: "vitepress-page-chunk" | "vitepress-route",
  options: { optional?: boolean } = {},
): DiscoveredReference {
  return discoveredReference(value, {
    kind,
    source: "vitepress",
    resolution: "base-url",
    optional: options.optional,
  });
}

function normalizeVitePressGenericReference(
  ref: DiscoveredReference,
  localPath: string,
): DiscoveredReference {
  const resolution =
    localPath.startsWith("assets/") && ref.value.startsWith("assets/")
      ? "base-url"
      : ref.resolution;

  if (vitePressFullPageChunkValue(ref.value)) {
    return {
      ...ref,
      resolution,
      kind: "vitepress-page-chunk",
      source: "vitepress",
    };
  }

  return resolution === ref.resolution ? ref : { ...ref, resolution };
}

function withVitePressPageChunkCompanions(
  refs: DiscoveredReference[],
): DiscoveredReference[] {
  const expanded: DiscoveredReference[] = [];
  for (const ref of refs) {
    expanded.push(ref);
    const fullChunk = vitePressFullPageChunkValue(ref.value);
    if (fullChunk) {
      expanded.push({
        ...ref,
        value: fullChunk,
        kind: "vitepress-page-chunk",
        source: "vitepress",
      });
    }
  }
  return uniqueDiscoveredReferences(expanded);
}

function vitePressFullPageChunkValue(value: string): string | null {
  const fullValue = value.replace(/\.lean\.js(?=([?#]|$))/, ".js");
  return fullValue === value ? null : fullValue;
}
