import { extractReferences, rewriteCssAssetReferences } from "../refs.js";
import type { CrawlProfile } from "./types.js";

export const genericProfile: CrawlProfile = {
  extractReferences,
  rewriteAssetForDisk: rewriteCssForDisk,
};

export function rewriteCssForDisk(
  body: Buffer,
  localPath: string,
  contentType: string,
): Buffer {
  if (!isCss(localPath, contentType)) {
    return body;
  }
  const original = body.toString("utf8");
  const rewritten = rewriteCssAssetReferences(original);
  return rewritten === original ? body : Buffer.from(rewritten, "utf8");
}

export function isParseable(localPath: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  if (/(?:text\/|javascript|json|xml|svg)/i.test(loweredType)) {
    return true;
  }
  return /\.(?:html?|css|js|mjs|json|svg)$/i.test(localPath);
}

export function isCss(localPath: string, contentType: string): boolean {
  return contentType.toLowerCase().includes("css") || localPath.toLowerCase().endsWith(".css");
}
