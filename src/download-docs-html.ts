import { pathToFileURL } from "node:url";

import { downloadDocsHtml, type DownloadOptions } from "./download-runner.js";

export {
  DEFAULT_BASE_URL,
  GITCODE_BASE_URL,
  crawlDocsSite,
  downloadDocsHtml,
  resolveDefaultDocsSource,
  resolveDownloadSource,
  USER_AGENT,
} from "./download-runner.js";
export type {
  CrawlResult,
  DocsSource,
  DownloadOptions,
  DownloadResult,
  Fetcher,
  FetchResult,
} from "./download-runner.js";

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
      case "--start-url":
        args.startUrls = [...(args.startUrls ?? []), readValue()];
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
