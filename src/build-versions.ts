import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import { downloadDocsHtml } from "./download-runner.js";
import { USER_AGENT } from "./http.js";

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

type ListExistingReleaseVersionsOptions = {
  repository: string;
  fetcher?: typeof fetch;
  token?: string;
  retries?: number;
};

type BuildVersionsOptions = {
  version: string;
  versionsJson?: string;
  versionsUrl: string;
  githubRepository?: string;
  githubToken?: string;
  buildRoot: string;
  distDir: string;
  force: boolean;
  keepGoing: boolean;
  skipExistingReleases: boolean;
  concurrency: number;
};

const versionsManifestSchema = z
  .object({
    channels: z
      .record(
        z.string(),
        z
          .object({
            versions: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const gitHubReleasePageSchema = z.array(
  z
    .object({
      tag_name: z.string(),
    })
    .passthrough(),
);

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
  const data = versionsManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
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

export function skipReleasedVersionEntries(
  entries: VersionEntry[],
  releasedVersions: Set<string>,
): VersionEntry[] {
  return entries.filter((entry) => !releasedVersions.has(entry.version));
}

export async function listExistingReleaseVersions({
  repository,
  fetcher = fetch,
  token,
  retries = 2,
}: ListExistingReleaseVersionsOptions): Promise<Set<string>> {
  const releasedVersions = new Set<string>();
  const perPage = 100;
  for (let page = 1; ; page += 1) {
    const releases = await fetchReleasePage(
      `https://api.github.com/repos/${repository}/releases?per_page=${perPage}&page=${page}`,
      { fetcher, token, retries },
    );
    for (const release of releases) {
      releasedVersions.add(release.tag_name);
    }
    if (releases.length < perPage) {
      return releasedVersions;
    }
  }
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

  let entries = selectVersionEntries(await loadVersionEntries(versionsJson), args.version);
  if (args.skipExistingReleases) {
    const repository = args.githubRepository ?? process.env.GITHUB_REPOSITORY;
    if (!repository) {
      throw new Error("--skip-existing-releases requires --github-repository or GITHUB_REPOSITORY");
    }
    const releasedVersions = await listExistingReleaseVersions({
      repository,
      token: args.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    });
    const selectedCount = entries.length;
    entries = skipReleasedVersionEntries(entries, releasedVersions);
    const skippedCount = selectedCount - entries.length;
    if (skippedCount > 0) {
      console.log(`skipped ${skippedCount} already released version(s)`);
    }
    if (entries.length === 0) {
      console.log("all selected versions already have releases; nothing to build");
      return 0;
    }
  }

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
    skipExistingReleases: false,
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
      case "--github-repository":
        args.githubRepository = readValue();
        break;
      case "--github-token":
        args.githubToken = readValue();
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
      case "--skip-existing-releases":
        args.skipExistingReleases = true;
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

async function fetchReleasePage(
  url: string,
  {
    fetcher,
    token,
    retries,
  }: {
    fetcher: typeof fetch;
    token?: string;
    retries: number;
  },
): Promise<z.infer<typeof gitHubReleasePageSchema>> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
      const response = await fetcher(url, { headers });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${url}`);
      }
      return gitHubReleasePageSchema.parse(JSON.parse(await response.text()));
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
