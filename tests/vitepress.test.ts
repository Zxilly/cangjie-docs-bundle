import { describe, expect, test } from "vitest";

import {
  resolveDiscoveredReference,
  type DiscoveredReference,
} from "../src/references.js";
import {
  createVitePressSource,
  extractVitePressReferences,
  usesVitePressSource,
  vitePressProfile,
} from "../src/sources/vitepress.js";

function referenceValues(refs: DiscoveredReference[]): string[] {
  return refs.map((ref) => ref.value);
}

describe("VitePress source", () => {
  test("uses the GitCode VitePress source for stable versions from 1.1.3", () => {
    expect(usesVitePressSource("1.1.0")).toBe(false);
    expect(usesVitePressSource("1.1.3")).toBe(true);
    expect(createVitePressSource("1.1.3")).toMatchObject({
      kind: "vitepress",
      baseUrl: "https://cj-docs.gitcode.com/zh/1.1.3/",
      startUrls: [
        "https://cj-docs.gitcode.com/zh/1.1.3/dev-guide/source_zh_cn/first_understanding/basic.html",
      ],
    });
  });

  test("extracts routes and page chunks from VitePress global site data", () => {
    const hashMap = JSON.stringify(
      JSON.stringify({
        "libs_std_std_module_overview.md": "DYcBA_XC",
        "tools_source_zh_cn_cmd-tools_cjpm_manual.md": "A-b_12",
        "ignored.md": 42,
        "ignored.html": "ValidHash",
        "bad_hash.md": "../bad",
      }),
    );
    const siteData = JSON.stringify(
      JSON.stringify({
        themeConfig: {
          sidebar: [
            { text: "API", link: "libs/std/std_module_overview.md" },
            { text: "CJPM", link: "tools/source_zh_cn/cmd-tools/cjpm_manual.md#usage" },
          ],
        },
      }),
    );

    const refs = extractVitePressReferences(`
        <script>window.__VP_HASH_MAP__=JSON.parse(${hashMap});</script>
        <script>window.__VP_SITE_DATA__=JSON.parse(${siteData});</script>
      `);

    expect(referenceValues(refs)).toEqual(
      expect.arrayContaining([
        "/assets/libs_std_std_module_overview.md.DYcBA_XC.lean.js",
        "/assets/libs_std_std_module_overview.md.DYcBA_XC.js",
        "/assets/tools_source_zh_cn_cmd-tools_cjpm_manual.md.A-b_12.lean.js",
        "/assets/tools_source_zh_cn_cmd-tools_cjpm_manual.md.A-b_12.js",
        "/libs/std/std_module_overview.html",
        "/tools/source_zh_cn/cmd-tools/cjpm_manual.html#usage",
      ]),
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "/assets/libs_std_std_module_overview.md.DYcBA_XC.lean.js",
          kind: "vitepress-page-chunk",
          source: "vitepress",
          resolution: "base-url",
        }),
        expect.objectContaining({
          value: "/libs/std/std_module_overview.html",
          kind: "vitepress-route",
          source: "vitepress",
          resolution: "base-url",
        }),
      ]),
    );
    const values = referenceValues(refs);
    expect(values).not.toContain("/assets/ignored.md.42.lean.js");
    expect(values).not.toContain("/assets/ignored.html.ValidHash.lean.js");
    expect(values).not.toContain("/assets/bad_hash.md.../bad.lean.js");
  });

  test("combines generic page references with VitePress route metadata", () => {
    const refs = vitePressProfile.extractReferences(
      Buffer.from(`
        <meta name="generator" content="VitePress v2.0.0-alpha.12">
        <link rel="preload stylesheet" href="/zh/1.1.3/assets/style.hash.css" as="style">
        <script type="module" src="/zh/1.1.3/assets/app.hash.js"></script>
        <link rel="modulepreload" href="/zh/1.1.3/assets/page.md.hash.lean.js">
        <a href="/zh/1.1.3/libs/std/std_module_overview.html">API</a>
        <script>const filePath = "libs/std/std_module_overview.md";</script>
      `),
      "libs/std/std_module_overview.html",
      "text/html",
    );

    const values = referenceValues(refs);
    expect(values).toEqual(
      expect.arrayContaining([
        "/zh/1.1.3/assets/style.hash.css",
        "/zh/1.1.3/assets/app.hash.js",
        "/zh/1.1.3/assets/page.md.hash.lean.js",
        "/zh/1.1.3/libs/std/std_module_overview.html",
      ]),
    );
    expect(values).not.toContain("libs/std/std_module_overview.md");
  });

  test("resolves VitePress chunk dependencies relative to the site root", () => {
    const ref = vitePressProfile
      .extractReferences(
        Buffer.from(`const deps = ["assets/chunks/lazy.js"];`),
        "assets/chunks/theme.js",
        "application/javascript",
      )
      .find((candidate) => candidate.value === "assets/chunks/lazy.js");

    expect(ref).toMatchObject({
      kind: "javascript-path",
      source: "generic",
      resolution: "base-url",
    });
    expect(ref && resolveDiscoveredReference(ref, {
      baseUrl: "https://cj-docs.gitcode.com/zh/1.1.3/",
      currentUrl: "https://cj-docs.gitcode.com/zh/1.1.3/assets/chunks/theme.js",
      localPath: "assets/chunks/theme.js",
    })).toBe("https://cj-docs.gitcode.com/zh/1.1.3/assets/chunks/lazy.js");
  });

});
