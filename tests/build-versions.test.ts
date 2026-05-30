import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  fetchVersionsJson,
  listExistingReleaseVersions,
  loadVersionEntries,
  main,
  selectVersionEntries,
  skipReleasedVersionEntries,
} from "../src/build-versions.js";

describe("versions manifest", () => {
  test("loads channel versions in manifest order", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cj-versions-"));
    const manifest = path.join(dir, "versions.json");
    try {
      await writeFile(
        manifest,
        JSON.stringify({
          channels: {
            sts: { versions: { "1.1.0": {}, "1.1.1": {} } },
            lts: { versions: { "1.0.5": {} } },
          },
        }),
      );

      await expect(loadVersionEntries(manifest)).resolves.toEqual([
        { channel: "sts", version: "1.1.0" },
        { channel: "sts", version: "1.1.1" },
        { channel: "lts", version: "1.0.5" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("selects a single version or throws for an unknown version", () => {
    const entries = [
      { channel: "sts", version: "1.1.0" },
      { channel: "lts", version: "1.0.5" },
    ];

    expect(selectVersionEntries(entries, "1.0.5")).toEqual([{ channel: "lts", version: "1.0.5" }]);
    expect(() => selectVersionEntries(entries, "missing")).toThrow(/version not found/);
  });

  test("filters versions that already have GitHub releases", () => {
    expect(
      skipReleasedVersionEntries(
        [
          { channel: "sts", version: "1.1.0" },
          { channel: "sts", version: "1.1.3" },
          { channel: "lts", version: "1.0.5" },
        ],
        new Set(["1.1.0", "1.0.5"]),
      ),
    ).toEqual([{ channel: "sts", version: "1.1.3" }]);
  });

  test("rejects malformed version manifests", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cj-versions-"));
    const manifest = path.join(dir, "versions.json");
    try {
      await writeFile(
        manifest,
        JSON.stringify({
          channels: {
            sts: { versions: ["1.1.0"] },
          },
        }),
      );

      await expect(loadVersionEntries(manifest)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("retries manifest downloads after a transient fetch failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cj-versions-"));
    const manifest = path.join(dir, "versions.json");
    let attempts = 0;
    try {
      await fetchVersionsJson("https://versions.example/versions.json", manifest, {
        retries: 1,
        fetcher: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("temporary network failure");
          }
          return new Response('{"channels":{}}', { status: 200 });
        },
      });

      expect(attempts).toBe(2);
      await expect(readFile(manifest, "utf8")).resolves.toBe('{"channels":{}}');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("loads existing GitHub release versions across pages", async () => {
    const requestedUrls: string[] = [];
    const releasedVersions = await listExistingReleaseVersions({
      repository: "owner/repo",
      retries: 0,
      fetcher: async (url, init) => {
        requestedUrls.push(String(url));
        expect(new Headers(init?.headers).get("accept")).toBe("application/vnd.github+json");
        if (String(url).endsWith("page=1")) {
          return new Response(
            JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ tag_name: `1.0.${index}` }))),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([{ tag_name: "1.1.0" }]), { status: 200 });
      },
    });

    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/owner/repo/releases?per_page=100&page=1",
      "https://api.github.com/repos/owner/repo/releases?per_page=100&page=2",
    ]);
    expect(releasedVersions.has("1.0.0")).toBe(true);
    expect(releasedVersions.has("1.0.99")).toBe(true);
    expect(releasedVersions.has("1.1.0")).toBe(true);
  });

  test("skips all selected entries when every version already has a release", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cj-versions-"));
    const manifest = path.join(dir, "versions.json");
    const originalFetch = globalThis.fetch;
    const originalRepository = process.env.GITHUB_REPOSITORY;
    try {
      await writeFile(
        manifest,
        JSON.stringify({
          channels: {
            sts: { versions: { "1.1.0": {}, "1.1.3": {} } },
          },
        }),
      );
      process.env.GITHUB_REPOSITORY = "owner/repo";
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([{ tag_name: "1.1.0" }, { tag_name: "1.1.3" }]), {
          status: 200,
        })) as typeof fetch;

      await expect(
        main(["--versions-json", manifest, "--skip-existing-releases", "--concurrency", "1"]),
      ).resolves.toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalRepository === undefined) {
        delete process.env.GITHUB_REPOSITORY;
      } else {
        process.env.GITHUB_REPOSITORY = originalRepository;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
