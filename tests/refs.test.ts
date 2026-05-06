import { describe, expect, test } from "vitest";

import {
  extractReferences,
  localPathForUrl,
  shouldSkipReference,
} from "../src/refs.js";

describe("reference extraction", () => {
  test("extracts HTML and CSS references without leaving the version prefix", () => {
    const refs = extractReferences(
      Buffer.from(`
        <link rel="stylesheet" href="css/general.css">
        <script src="toc.js"></script>
        <img srcset="small.png 1x, images/big.png 2x">
        <style>@import "theme.css"; body { background: url('../fonts/open.woff2') }</style>
      `),
      "index.html",
      "text/html",
    );

    expect(refs).toEqual(
      expect.arrayContaining([
        "css/general.css",
        "toc.js",
        "small.png",
        "images/big.png",
        "theme.css",
        "../fonts/open.woff2",
      ]),
    );
  });

  test("uses Babel to extract static links from JavaScript while ignoring dynamic expressions", () => {
    const refs = extractReferences(
      Buffer.from(`
        const sidebar = '<a href="dev-guide/basic.html">Basic</a>';
        const asset = "assets/sidebar.js";
        const rootAsset = "tex2jax.js";
        const selector = ".nav-chapters.next";
        const highlightScope = "title.function";
        const version = "10.7.0";
        nextButton.href = path_to_root + item.path;
        const noisy = "previousButton.href;";
      `),
      "toc.js",
      "application/javascript",
    );

    expect(refs).toEqual(expect.arrayContaining(["dev-guide/basic.html", "assets/sidebar.js"]));
    expect(refs).not.toContain("previousButton.href;");
    expect(refs).not.toContain("path_to_root");
    expect(refs).not.toContain("tex2jax.js");
    expect(refs).not.toContain(".nav-chapters.next");
    expect(refs).not.toContain("title.function");
    expect(refs).not.toContain("10.7.0");
  });

  test("maps URLs to local paths only under the selected docs version", () => {
    const base = "https://docs.cangjie-lang.cn/docs/1.1.0/";

    expect(localPathForUrl("https://docs.cangjie-lang.cn/docs/1.1.0/", base)).toBe("index.html");
    expect(localPathForUrl("https://docs.cangjie-lang.cn/docs/1.1.0/dev/a.html", base)).toBe(
      "dev/a.html",
    );
    expect(localPathForUrl("https://docs.cangjie-lang.cn/docs/1.0.0/dev/a.html", base)).toBeNull();
    expect(localPathForUrl("https://example.com/docs/1.1.0/dev/a.html", base)).toBeNull();
  });

  test("rejects Babel strings that are not static resource references", () => {
    expect(shouldSkipReference("previousButton.href;")).toBe(true);
    expect(shouldSkipReference("' + path_to_root + url[0] +")).toBe(true);
    expect(shouldSkipReference("../../../../")).toBe(true);
    expect(shouldSkipReference("foo bar.html")).toBe(true);
    expect(shouldSkipReference("dev-guide/basic.html")).toBe(false);
  });

  test("handles deeply nested generated HTML without recursive stack overflow", () => {
    const html = `${"<div>".repeat(20_000)}<a href="deep/page.html">deep</a>${"</div>".repeat(
      20_000,
    )}`;

    expect(extractReferences(Buffer.from(html), "toc.html", "text/html")).toContain(
      "deep/page.html",
    );
  });
});
