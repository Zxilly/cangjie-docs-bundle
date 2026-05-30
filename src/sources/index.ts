import { createMdBookSource, MDBOOK_BASE_URL } from "./mdbook.js";
import { createVitePressSource, usesVitePressSource, VITEPRESS_BASE_URL } from "./vitepress.js";
import type { DocsSource } from "./types.js";

export { MDBOOK_BASE_URL, VITEPRESS_BASE_URL, usesVitePressSource };
export type { CrawlProfile, DocsSource } from "./types.js";

export function resolveDefaultDocsSource(version: string): DocsSource {
  return usesVitePressSource(version)
    ? createVitePressSource(version)
    : createMdBookSource(version);
}
