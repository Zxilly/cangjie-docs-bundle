import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { crawlDocsSite } from "../src/crawler.js";
import type { FetchResult } from "../src/http.js";
import { discoveredReference } from "../src/references.js";
import { genericProfile } from "../src/sources/generic.js";
import type { CrawlProfile, DocsSource } from "../src/sources/types.js";
import { vitePressProfile } from "../src/sources/vitepress.js";

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
        source: testSource(base),
        outputDir,
        fetcher,
        concurrency: 3,
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
        source: testSource(base),
        outputDir,
        fetcher,
        concurrency: 2,
      });

      expect(result.fileCount).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(requested).not.toContain(`${base}libs/std/pkg//pkg_api/item.html`);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not request hard-coded mdBook common paths that were not discovered", async () => {
    const base = "https://docs.example/docs/1.1.0/";
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      requested.push(url);
      if (url === base) {
        return {
          body: Buffer.from('<script src="toc.js"></script>'),
          contentType: "text/html",
        };
      }
      if (url === `${base}toc.js`) {
        return { body: Buffer.from(""), contentType: "application/javascript" };
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      const result = await crawlDocsSite({
        source: testSource(base),
        outputDir,
        fetcher,
        concurrency: 2,
      });

      expect(result.fileCount).toBe(2);
      expect(result.warnings).toEqual([]);
      expect(requested).toEqual([base, `${base}toc.js`]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("starts from explicit seed URLs when the docs root has no index page", async () => {
    const base = "https://cj-docs.gitcode.com/zh/1.1.3/";
    const startUrl = `${base}libs/std/deriving/deriving_samples/deriving_user_guide.html`;
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      requested.push(url);
      if (url === base) {
        throw new Error("root should not be requested");
      }
      if (url === startUrl) {
        return {
          body: Buffer.from(`
            <link rel="stylesheet" href="/zh/1.1.3/assets/style.css">
            <script src="/zh/1.1.3/assets/chunks/theme.js"></script>
            <link rel="modulepreload" href="/zh/1.1.3/assets/libs_std_std_module_overview.md.Hash.lean.js">
            <a href="/zh/1.1.3/libs/std/std_module_overview.html">API</a>
          `),
          contentType: "text/html",
        };
      }
      if (url === `${base}assets/style.css`) {
        return { body: Buffer.from("body{}"), contentType: "text/css" };
      }
      if (url === `${base}assets/chunks/theme.js`) {
        return {
          body: Buffer.from(`const deps = ["assets/chunks/lazy.js"];`),
          contentType: "application/javascript",
        };
      }
      if (url === `${base}assets/chunks/lazy.js`) {
        return { body: Buffer.from("export default {};"), contentType: "application/javascript" };
      }
      if (url === `${base}assets/libs_std_std_module_overview.md.Hash.lean.js`) {
        return { body: Buffer.from("export const __pageData = {};"), contentType: "application/javascript" };
      }
      if (url === `${base}assets/libs_std_std_module_overview.md.Hash.js`) {
        return { body: Buffer.from("export default {};"), contentType: "application/javascript" };
      }
      if (url === `${base}libs/std/std_module_overview.html`) {
        return { body: Buffer.from("API"), contentType: "text/html" };
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      const result = await crawlDocsSite({
        source: testSource(base, { startUrls: [startUrl], profile: vitePressProfile }),
        outputDir,
        fetcher,
        concurrency: 1,
      });

      expect(result.fileCount).toBe(7);
      expect(requested).not.toContain(base);
      expect(requested).not.toContain(`${base}assets/chunks/assets/chunks/lazy.js`);
      expect(requested).toContain(`${base}assets/libs_std_std_module_overview.md.Hash.js`);
      await expect(
        readFile(
          path.join(
            outputDir,
            "libs",
            "std",
            "deriving",
            "deriving_samples",
            "deriving_user_guide.html",
          ),
          "utf8",
        ),
      ).resolves.toContain('href="/libs/std/std_module_overview.html"');
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("strips cache-buster query strings from saved CSS so file:// can resolve assets", async () => {
    const base = "https://docs.example/docs/1.1.0/";
    const fetcher = async (url: string): Promise<FetchResult> => {
      if (url === base) {
        return {
          body: Buffer.from(`<link rel="stylesheet" href="FontAwesome/css/font-awesome.css">`),
          contentType: "text/html",
        };
      }
      if (url === `${base}FontAwesome/css/font-awesome.css`) {
        return {
          body: Buffer.from(
            `@font-face{src:url('../fonts/fa.woff2?v=4.7.0') format('woff2'),` +
              `url('../fonts/fa.svg?v=4.7.0#fontawesomeregular') format('svg')}`,
          ),
          contentType: "text/css",
        };
      }
      if (url === `${base}FontAwesome/fonts/fa.woff2`) {
        return { body: Buffer.from("woff2"), contentType: "font/woff2" };
      }
      if (url === `${base}FontAwesome/fonts/fa.svg`) {
        return { body: Buffer.from("<svg/>"), contentType: "image/svg+xml" };
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      await crawlDocsSite({ source: testSource(base), outputDir, fetcher, concurrency: 2 });
      const css = await readFile(
        path.join(outputDir, "FontAwesome", "css", "font-awesome.css"),
        "utf8",
      );
      expect(css).not.toMatch(/\?v=4\.7\.0/);
      expect(css).toContain("../fonts/fa.woff2");
      expect(css).toContain("../fonts/fa.svg#fontawesomeregular");
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not request a discovered file after reaching maxFiles", async () => {
    const base = "https://docs.example/docs/1.1.0/";
    const requested: string[] = [];
    const fetcher = async (url: string): Promise<FetchResult> => {
      requested.push(url);
      if (url === base) {
        return {
          body: Buffer.from('<a href="extra.html">extra</a>'),
          contentType: "text/html",
        };
      }
      if (url === `${base}extra.html`) {
        return { body: Buffer.from("extra"), contentType: "text/html" };
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      await expect(
        crawlDocsSite({
          source: testSource(base),
          outputDir,
          fetcher,
          concurrency: 1,
          maxFiles: 1,
        }),
      ).rejects.toThrow(/more than 1 files/);
      expect(requested).toEqual([base]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("does not warn when an optional discovered reference is missing upstream", async () => {
    const base = "https://cj-docs.gitcode.com/zh/1.1.3/";
    const fetcher = async (url: string): Promise<FetchResult> => {
      if (url === base) {
        return { body: Buffer.from("root"), contentType: "text/html" };
      }
      if (url === `${base}assets/stale-page-chunk.js`) {
        throw new Error("HTTP 404");
      }
      throw new Error(`unexpected ${url}`);
    };

    const outputDir = await mkdtemp(path.join(tmpdir(), "cj-docs-"));
    try {
      const result = await crawlDocsSite({
        source: testSource(base, {
          profile: {
            ...genericProfile,
            extractReferences: () => [
              discoveredReference("/assets/stale-page-chunk.js", {
                kind: "vitepress-page-chunk",
                source: "vitepress",
                resolution: "base-url",
                optional: true,
              }),
            ],
          },
        }),
        outputDir,
        fetcher,
        concurrency: 1,
      });

      expect(result.fileCount).toBe(1);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

function testSource(
  baseUrl: string,
  options: { startUrls?: string[]; profile?: CrawlProfile } = {},
): DocsSource {
  return {
    kind: "mdbook",
    baseUrl,
    startUrls: options.startUrls ?? [baseUrl],
    profile: options.profile ?? genericProfile,
  };
}
