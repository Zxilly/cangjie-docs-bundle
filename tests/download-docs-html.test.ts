import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { crawlDocsSite, type FetchResult } from "../src/download-docs-html.js";

describe("docs crawler", () => {
  test("downloads discovered files concurrently and keeps paths under the docs root", async () => {
    const base = "https://docs.example/docs/1.1.0/";
    const pages = new Map<string, FetchResult>([
      [
        base,
        {
          body: Buffer.from(`
            <a href="a.html">A</a>
            <a href="b.html">B</a>
            <a href="../1.0.0/old.html">old</a>
            <script src="toc.js"></script>
          `),
          contentType: "text/html",
        },
      ],
      [
        `${base}toc.js`,
        {
          body: Buffer.from(`const html = '<a href="guide/c.html">C</a>';`),
          contentType: "application/javascript",
        },
      ],
      [`${base}a.html`, { body: Buffer.from("A"), contentType: "text/html" }],
      [`${base}b.html`, { body: Buffer.from("B"), contentType: "text/html" }],
      [`${base}guide/c.html`, { body: Buffer.from("C"), contentType: "text/html" }],
    ]);
    let active = 0;
    let maxActive = 0;
    const requested: string[] = [];

    const fetcher = async (url: string): Promise<FetchResult> => {
      requested.push(url);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      const page = pages.get(url);
      if (!page) {
        throw new Error(`missing ${url}`);
      }
      return page;
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      const result = await crawlDocsSite({
        baseUrl: base,
        outputDir,
        fetcher,
        concurrency: 3,
        commonPaths: [],
      });

      expect(result.fileCount).toBe(5);
      expect(maxActive).toBeGreaterThan(1);
      expect(requested).not.toContain("https://docs.example/docs/1.0.0/old.html");
      await expect(readFile(path.join(outputDir, "guide", "c.html"), "utf8")).resolves.toBe("C");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("normalizes duplicate slashes in discovered same-prefix paths", async () => {
    const base = "https://docs.example/docs/1.1.0/";
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      requested.push(url);
      if (url === base) {
        return {
          body: Buffer.from('<a href="libs/std/pkg//pkg_api/item.html">item</a>'),
          contentType: "text/html",
        };
      }
      if (url === `${base}libs/std/pkg/pkg_api/item.html`) {
        return { body: Buffer.from("item"), contentType: "text/html" };
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      const result = await crawlDocsSite({
        baseUrl: base,
        outputDir,
        fetcher,
        concurrency: 2,
        commonPaths: [],
      });

      expect(result.fileCount).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(requested).not.toContain(`${base}libs/std/pkg//pkg_api/item.html`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});
