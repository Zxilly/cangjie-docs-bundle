import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { downloadDocsHtml, USER_AGENT } from "./download-docs-html.js";

export const DEFAULT_VERSIONS_URL =
  "https://raw.githubusercontent.com/Zxilly/cangjie-version-manifest/master/versions.json";

export type VersionEntry = {
  channel: string;
  version: string;
};

type FetchVersionsOptions = {
  fetcher?: typeof fetch;
  retries?: number;
};

type BuildVersionsOptions = {
  version: string;
  versionsJson?: string;
  versionsUrl: string;
  buildRoot: string;
  distDir: string;
  force: boolean;
  keepGoing: boolean;
  concurrency: number;
};

export async function fetchVersionsJson(
  url: string,
  destination: string,
  { fetcher = fetch, retries = 2 }: FetchVersionsOptions = {},
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetcher(url, { headers: { "User-Agent": USER_AGENT } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }
      await writeFile(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        break;
      }
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function loadVersionEntries(manifestPath: string): Promise<VersionEntry[]> {
  const data = JSON.parse(await readFile(manifestPath, "utf8")) as {
    channels?: Record<string, { versions?: Record<string, unknown> }>;
  };
  const entries: VersionEntry[] = [];
  for (const [channel, channelData] of Object.entries(data.channels ?? {})) {
    for (const version of Object.keys(channelData.versions ?? {})) {
      entries.push({ channel, version });
    }
  }
  return entries;
}

export function selectVersionEntries(entries: VersionEntry[], requested: string): VersionEntry[] {
  if (requested === "all") {
    return entries;
  }
  const selected = entries.filter((entry) => entry.version === requested);
  if (selected.length === 0) {
    throw new Error(`version not found in versions.json: ${requested}`);
  }
  return selected;
}

export async function buildVersionEntry(
  entry: VersionEntry,
  options: Pick<BuildVersionsOptions, "buildRoot" | "distDir" | "force" | "concurrency">,
): Promise<string> {
  const archive = path.join(options.distDir, `cangjie-docs-html-${entry.version}.tar.gz`);
  await downloadDocsHtml({
    version: entry.version,
    outputDir: path.join(options.buildRoot, entry.version),
    archive,
    force: options.force,
    concurrency: options.concurrency,
  });
  return archive;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const versionsJson = args.versionsJson ?? path.join("build", "versions.json");
  if (!args.versionsJson) {
    await fetchVersionsJson(args.versionsUrl, versionsJson);
  }

  const entries = selectVersionEntries(await loadVersionEntries(versionsJson), args.version);
  const failures: Array<{ entry: VersionEntry; error: unknown }> = [];
  for (const entry of entries) {
    console.log(`building ${entry.channel}/${entry.version}`);
    try {
      const archive = await buildVersionEntry(entry, args);
      console.log(`created ${archive}`);
    } catch (error) {
      if (!args.keepGoing) {
        throw error;
      }
      failures.push({ entry, error });
      console.error(`failed ${entry.channel}/${entry.version}: ${formatError(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error("failed versions:");
    for (const failure of failures) {
      console.error(`- ${failure.entry.channel}/${failure.entry.version}: ${formatError(failure.error)}`);
    }
    return 1;
  }

  return 0;
}

function parseArgs(argv: string[]): BuildVersionsOptions {
  const args: BuildVersionsOptions = {
    version: "all",
    versionsUrl: DEFAULT_VERSIONS_URL,
    buildRoot: path.join("build", "versions"),
    distDir: "dist",
    force: false,
    keepGoing: false,
    concurrency: 16,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) {
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
      case "--version":
        args.version = readValue();
        break;
      case "--versions-json":
        args.versionsJson = readValue();
        break;
      case "--versions-url":
        args.versionsUrl = readValue();
        break;
      case "--build-root":
        args.buildRoot = readValue();
        break;
      case "--dist-dir":
        args.distDir = readValue();
        break;
      case "--force":
        args.force = true;
        break;
      case "--keep-going":
        args.keepGoing = true;
        break;
      case "--concurrency":
        args.concurrency = Number.parseInt(readValue(), 10);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}
