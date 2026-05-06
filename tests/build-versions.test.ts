import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { fetchVersionsJson, loadVersionEntries, selectVersionEntries } from "../src/build-versions.js";

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
});
