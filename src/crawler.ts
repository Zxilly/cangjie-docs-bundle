import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchUrl, type Fetcher } from "./http.js";
import { resolveDiscoveredReference } from "./references.js";
import { localPathForUrl, normalizeBaseUrl, stripUrlFragmentAndQuery } from "./urls.js";
import type { DocsSource, ReferenceContext } from "./sources/types.js";

export type CrawlOptions = {
  source: DocsSource;
  outputDir: string;
  fetcher?: Fetcher;
  concurrency?: number;
  maxFiles?: number;
  retries?: number;
  timeoutMs?: number;
  verbose?: boolean;
};

export type CrawlResult = {
  baseUrl: string;
  outputDir: string;
  fileCount: number;
  warnings: string[];
};

export async function crawlDocsSite(options: CrawlOptions): Promise<CrawlResult> {
  const source = normalizeDocsSource(options.source);
  const baseUrl = source.baseUrl;
  const outputDir = options.outputDir;
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const maxFiles = options.maxFiles ?? 10_000;
  const fetcher = options.fetcher ?? ((url: string) => fetchUrl(url, options));
  const profile = source.profile;
  const queue: string[] = [];
  const discovered = new Set<string>();
  const seen = new Set<string>();
  const saved = new Set<string>();
  const warnings: string[] = [];
  const requiredUrls = new Set<string>();
  const optionalUrls = new Set<string>();
  let active = 0;
  let rejected = false;

  await mkdir(outputDir, { recursive: true });

  return await new Promise<CrawlResult>((resolve, reject) => {
    const pump = (): void => {
      if (rejected) {
        return;
      }
      if (saved.size > maxFiles) {
        rejected = true;
        reject(new Error(`refusing to download more than ${maxFiles} files`));
        return;
      }

      while (active < concurrency && queue.length > 0) {
        const url = queue.shift();
        if (!url || seen.has(url)) {
          continue;
        }
        if (seen.size >= maxFiles) {
          rejected = true;
          reject(new Error(`refusing to download more than ${maxFiles} files`));
          return;
        }
        seen.add(url);
        active += 1;
        processUrl(url)
          .catch((error: unknown) => {
            rejected = true;
            reject(error);
          })
          .finally(() => {
            active -= 1;
            pump();
          });
      }

      if (active === 0 && queue.length === 0) {
        resolve({ baseUrl, outputDir, fileCount: saved.size, warnings });
      }
    };

    const processUrl = async (url: string): Promise<void> => {
      const localPath = localPathForUrl(url, baseUrl);
      if (!localPath) {
        return;
      }

      let fetched;
      try {
        fetched = await fetcher(url);
      } catch (error) {
        if (requiredUrls.has(url)) {
          throw error;
        }
        if (optionalUrls.has(url)) {
          return;
        }
        if (!profile.ignoreFetchError?.(url, error)) {
          warnings.push(formatWarning(error, url));
        }
        return;
      }

      const destination = path.join(outputDir, ...localPath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      const bodyToWrite =
        profile.rewriteAssetForDisk?.(fetched.body, localPath, fetched.contentType, baseUrl) ??
        fetched.body;
      await writeFile(destination, bodyToWrite);
      saved.add(localPath);
      if (options.verbose) {
        console.log(`downloaded ${url} -> ${localPath}`);
      }

      const context: ReferenceContext = { baseUrl, currentUrl: url, localPath };
      for (const ref of profile.extractReferences(fetched.body, localPath, fetched.contentType)) {
        const resolvedRef = resolveDiscoveredReference(ref, context);
        enqueue(resolvedRef, { optional: ref.optional });
      }
    };

    function enqueue(url: string, options: { optional?: boolean } = {}): void {
      const stripped = normalizeCrawlUrl(url);
      if (!localPathForUrl(stripped, baseUrl)) {
        return;
      }
      if (options.optional) {
        optionalUrls.add(stripped);
      } else {
        optionalUrls.delete(stripped);
      }
      if (discovered.has(stripped)) {
        return;
      }
      discovered.add(stripped);
      queue.push(stripped);
    }

    for (const startUrl of source.startUrls) {
      enqueueRequired(startUrl);
    }
    pump();

    function enqueueRequired(url: string): void {
      const absoluteUrl = new URL(url, baseUrl).toString();
      const stripped = normalizeCrawlUrl(absoluteUrl);
      if (!localPathForUrl(stripped, baseUrl)) {
        throw new Error(`start URL is outside docs root: ${url}`);
      }
      requiredUrls.add(stripped);
      optionalUrls.delete(stripped);
      enqueue(stripped);
    }
  });
}

function normalizeDocsSource(source: DocsSource): DocsSource {
  const baseUrl = normalizeBaseUrl(source.baseUrl);
  if (source.startUrls.length === 0) {
    throw new Error(`docs source ${source.kind} must define at least one start URL`);
  }
  return {
    ...source,
    baseUrl,
    startUrls: source.startUrls.map((startUrl) => new URL(startUrl, baseUrl).toString()),
  };
}

function formatWarning(error: unknown, url: string): string {
  if (error instanceof Error) {
    return `${error.message}: ${url}`;
  }
  return `${String(error)}: ${url}`;
}

function normalizeCrawlUrl(url: string): string {
  const parsed = new URL(stripUrlFragmentAndQuery(url));
  parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
  return parsed.toString();
}
