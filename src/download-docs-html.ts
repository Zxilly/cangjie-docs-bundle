import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import * as tar from "tar";

import {
  extractReferences,
  localPathForUrl,
  normalizeBaseUrl,
  stripUrlFragmentAndQuery,
} from "./refs.js";

export const DEFAULT_BASE_URL = "https://docs.cangjie-lang.cn/docs/{version}/";
export const USER_AGENT = "cangjie-docs-bundle/0.1 (+https://github.com/Zxilly/cangjie-docs-bundle)";

const DEFAULT_COMMON_PATHS = [
  "404.html",
  "print.html",
  "toc.html",
  "toc.js",
  "searchindex.js",
  "book.js",
  "clipboard.min.js",
  "elasticlunr.min.js",
  "searcher.js",
  "highlight.js",
  "highlight.css",
  "ayu-highlight.css",
  "tomorrow-night.css",
  "iframe_post_message.js",
  "favicon.png",
  "favicon.svg",
  "cangjie-highlight-export.js",
  "assets/elasticlunr.js",
  "assets/fzf.umd.js",
  "assets/sidebar.js",
  "assets/style.css",
  "assets/theme.css",
  "css/chrome.css",
  "css/general.css",
  "css/print.css",
  "css/variables.css",
];

export type FetchResult = {
  body: Buffer;
  contentType: string;
};

export type Fetcher = (url: string) => Promise<FetchResult>;

export type CrawlOptions = {
  baseUrl: string;
  outputDir: string;
  fetcher?: Fetcher;
  concurrency?: number;
  commonPaths?: string[];
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

export type DownloadOptions = {
  version: string;
  baseUrl?: string;
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

class HttpFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpFetchError";
  }
}

export async function fetchUrl(
  url: string,
  { retries = 2, timeoutMs = 60_000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new HttpFetchError(`HTTP ${response.status}: ${url}`, response.status);
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetriableFetchError(error)) {
        break;
      }
      await sleep(300 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function crawlDocsSite(options: CrawlOptions): Promise<CrawlResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const outputDir = options.outputDir;
  const concurrency = Math.max(1, options.concurrency ?? 16);
  const maxFiles = options.maxFiles ?? 10_000;
  const fetcher = options.fetcher ?? ((url: string) => fetchUrl(url, options));
  const commonPaths = options.commonPaths ?? DEFAULT_COMMON_PATHS;
  const queue: string[] = [];
  const discovered = new Set<string>();
  const seen = new Set<string>();
  const saved = new Set<string>();
  const warnings: string[] = [];
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

      let fetched: FetchResult;
      try {
        fetched = await fetcher(url);
      } catch (error) {
        if (url === stripUrlFragmentAndQuery(baseUrl)) {
          throw error;
        }
        warnings.push(formatWarning(error, url));
        return;
      }

      const destination = path.join(outputDir, ...localPath.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, fetched.body);
      saved.add(localPath);
      if (options.verbose) {
        console.log(`downloaded ${url} -> ${localPath}`);
      }

      if (!isParseable(localPath, fetched.contentType)) {
        return;
      }
      for (const ref of extractReferences(fetched.body, localPath, fetched.contentType)) {
        enqueue(new URL(ref, url).toString());
      }
    };

    function enqueue(url: string): void {
      const stripped = normalizeCrawlUrl(url);
      if (discovered.has(stripped) || !localPathForUrl(stripped, baseUrl)) {
        return;
      }
      discovered.add(stripped);
      queue.push(stripped);
    }

    enqueue(baseUrl);
    for (const item of commonPaths) {
      enqueue(new URL(item, baseUrl).toString());
    }
    pump();
  });
}

export async function downloadDocsHtml(options: DownloadOptions): Promise<DownloadResult> {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? DEFAULT_BASE_URL.replace("{version}", options.version),
  );
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
    baseUrl,
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

export async function createArchive(root: string, archive: string): Promise<void> {
  const files = await listFiles(root);
  await mkdir(path.dirname(archive), { recursive: true });
  await tar.create(
    {
      cwd: root,
      file: archive,
      gzip: true,
      mtime: new Date(0),
      noMtime: true,
      portable: true,
      sync: false,
    },
    files,
  );
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const result = await downloadDocsHtml(args);
    for (const warning of result.crawl.warnings) {
      console.warn(`warning: ${warning}`);
    }
    if (result.archive) {
      console.log(`created ${result.archive} from ${result.crawl.fileCount} files`);
    } else {
      console.log(`downloaded ${result.crawl.fileCount} files into ${result.crawl.outputDir}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function parseArgs(argv: string[]): DownloadOptions {
  const args: DownloadOptions = { version: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
      continue;
    }
    if (!arg.startsWith("-") && !args.version) {
      args.version = arg;
      continue;
    }

    const readValue = (): string => {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    switch (arg) {
      case "--base-url":
        args.baseUrl = readValue();
        break;
      case "--output-dir":
        args.outputDir = readValue();
        break;
      case "--archive":
        args.archive = readValue();
        break;
      case "--force":
        args.force = true;
        break;
      case "--no-archive":
        args.noArchive = true;
        break;
      case "--concurrency":
        args.concurrency = Number.parseInt(readValue(), 10);
        break;
      case "--max-files":
        args.maxFiles = Number.parseInt(readValue(), 10);
        break;
      case "--retries":
        args.retries = Number.parseInt(readValue(), 10);
        break;
      case "--timeout-ms":
        args.timeoutMs = Number.parseInt(readValue(), 10);
        break;
      case "--verbose":
        args.verbose = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!args.version) {
    throw new Error("usage: tsx src/download-docs-html.ts <version> [--force]");
  }
  return args;
}

function isRetriableFetchError(error: unknown): boolean {
  if (error instanceof HttpFetchError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  return !(error instanceof HttpFetchError);
}

function isParseable(localPath: string, contentType: string): boolean {
  const loweredType = contentType.toLowerCase();
  if (/(?:text\/|javascript|json|xml|svg)/i.test(loweredType)) {
    return true;
  }
  return /\.(?:html?|css|js|mjs|json|svg)$/i.test(localPath);
}

async function listFiles(root: string, relativeDir = ""): Promise<string[]> {
  const absoluteDir = path.join(root, ...relativeDir.split("/").filter(Boolean));
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
