import { rm, stat } from "node:fs/promises";
import path from "node:path";

import { createArchive } from "./archive.js";
import { crawlDocsSite, type CrawlResult } from "./crawler.js";
import {
  MDBOOK_BASE_URL,
  resolveDefaultDocsSource,
  VITEPRESS_BASE_URL,
  type DocsSource,
} from "./sources/index.js";
import { localPathForUrl, normalizeBaseUrl } from "./urls.js";

export const DEFAULT_BASE_URL = MDBOOK_BASE_URL;
export const GITCODE_BASE_URL = VITEPRESS_BASE_URL;

export type DownloadOptions = {
  version: string;
  baseUrl?: string;
  startUrls?: string[];
  outputDir?: string;
  archive?: string;
  force?: boolean;
  noArchive?: boolean;
  concurrency?: number;
  maxFiles?: number;
  retries?: number;
  timeoutMs?: number;
  verbose?: boolean;
};

export type DownloadResult = {
  crawl: CrawlResult;
  archive?: string;
};

export { crawlDocsSite, resolveDefaultDocsSource };
export { USER_AGENT } from "./http.js";
export type { CrawlResult, DocsSource };
export type { FetchResult, Fetcher } from "./http.js";

export async function downloadDocsHtml(options: DownloadOptions): Promise<DownloadResult> {
  const source = resolveDownloadSource(options);
  const outputDir = options.outputDir ?? path.join("build", `docs-html-${options.version}`);
  const archive = options.archive ?? path.join("dist", `cangjie-docs-html-${options.version}.tar.gz`);

  if (await exists(outputDir)) {
    if (!options.force) {
      throw new Error(`output directory already exists: ${outputDir}; use --force to replace it`);
    }
    await rm(outputDir, { recursive: true, force: true });
  }
  if (!options.noArchive && options.force && (await exists(archive))) {
    await rm(archive, { force: true });
  }

  const crawl = await crawlDocsSite({
    source,
    outputDir,
    concurrency: options.concurrency,
    maxFiles: options.maxFiles,
    retries: options.retries,
    timeoutMs: options.timeoutMs,
    verbose: options.verbose,
  });

  if (!options.noArchive) {
    await createArchive(outputDir, archive);
    return { crawl, archive };
  }
  return { crawl };
}

export function resolveDownloadSource(options: DownloadOptions): DocsSource {
  const defaultSource = resolveDefaultDocsSource(options.version);
  if (!options.baseUrl) {
    return {
      ...defaultSource,
      startUrls: options.startUrls ?? defaultSource.startUrls,
    };
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  return {
    ...defaultSource,
    baseUrl,
    startUrls: options.startUrls ?? rebaseStartUrls(defaultSource, baseUrl),
  };
}

function rebaseStartUrls(source: DocsSource, baseUrl: string): string[] {
  return source.startUrls.map((startUrl) => {
    const absoluteStartUrl = new URL(startUrl, source.baseUrl).toString();
    const localPath = localPathForUrl(absoluteStartUrl, source.baseUrl);
    return localPath ? new URL(localPath, baseUrl).toString() : new URL(startUrl, baseUrl).toString();
  });
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
