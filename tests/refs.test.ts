import { describe, expect, test } from "vitest";

import {
  extractReferences,
  rewriteCssAssetReferences,
  shouldSkipReference,
} from "../src/refs.js";
import type { DiscoveredReference } from "../src/references.js";
import { localPathForUrl } from "../src/urls.js";

function referenceValues(refs: DiscoveredReference[]): string[] {
  return refs.map((ref) => ref.value);
}

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

    expect(referenceValues(refs)).toEqual(
      expect.arrayContaining([
        "css/general.css",
        "toc.js",
        "small.png",
        "images/big.png",
        "theme.css",
        "../fonts/open.woff2",
      ]),
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "css/general.css",
          kind: "html-attribute",
          source: "generic",
          resolution: "current-url",
        }),
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

    const values = referenceValues(refs);
    expect(values).toEqual(expect.arrayContaining(["dev-guide/basic.html", "assets/sidebar.js"]));
    expect(values).not.toContain("previousButton.href;");
    expect(values).not.toContain("path_to_root");
    expect(values).not.toContain("tex2jax.js");
    expect(values).not.toContain(".nav-chapters.next");
    expect(values).not.toContain("title.function");
    expect(values).not.toContain("10.7.0");
  });

  test("extracts mdBook search assets from JavaScript without broad root guesses", () => {
    const refs = extractReferences(
      Buffer.from(`
        <script>
          const path_to_root = "";
          window.path_to_searchindex_js = "searchindex.js";
          fetch(path_to_root + 'searchindex.json')
            .catch(error => { script.src = path_to_root + 'searchindex.js'; });
          const selector = ".theme-selected";
        </script>
      `),
      "index.html",
      "text/html",
    );

    const values = referenceValues(refs);
    expect(values).toContain("searchindex.js");
    expect(values).toContain("searchindex.json");
    expect(values).not.toContain(".theme-selected");
  });

  test("extracts mdBook noscript iframe fallback references", () => {
    const refs = extractReferences(
      Buffer.from(`
        <noscript>
          <iframe class="sidebar-iframe-outer" src="toc.html"></iframe>
        </noscript>
      `),
      "index.html",
      "text/html",
    );

    expect(referenceValues(refs)).toContain("toc.html");
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
    expect(shouldSkipReference("libs/std/deriving/deriving_samples/deriving_user_guide.md")).toBe(
      true,
    );
    expect(shouldSkipReference("release/1.1")).toBe(true);
    expect(shouldSkipReference("dev-guide/basic.html")).toBe(false);
  });

  test("does not crawl links embedded in VitePress page chunk HTML strings", () => {
    const refs = extractReferences(
      Buffer.from(`
        const html = '<a href="../not-a-real-route.html">route</a>';
        const dep = "assets/chunks/framework.js";
      `),
      "assets/libs_std_std_module_overview.md.Hash.js",
      "application/javascript",
    );

    const values = referenceValues(refs);
    expect(values).toContain("assets/chunks/framework.js");
    expect(values).not.toContain("../not-a-real-route.html");
  });

  test("keeps cache-busted asset URLs that carry a query string", () => {
    expect(shouldSkipReference("../fonts/fontawesome-webfont.woff2?v=4.7.0")).toBe(false);
    expect(shouldSkipReference("../fonts/fontawesome-webfont.eot?#iefix&v=4.7.0")).toBe(false);

    const refs = extractReferences(
      Buffer.from(
        `@font-face{src:url('../fonts/fontawesome-webfont.eot?v=4.7.0');` +
          `src:url('../fonts/fontawesome-webfont.eot?#iefix&v=4.7.0') format('embedded-opentype'),` +
          `url('../fonts/fontawesome-webfont.woff2?v=4.7.0') format('woff2'),` +
          `url('../fonts/fontawesome-webfont.woff?v=4.7.0') format('woff'),` +
          `url('../fonts/fontawesome-webfont.ttf?v=4.7.0') format('truetype'),` +
          `url('../fonts/fontawesome-webfont.svg?v=4.7.0#fontawesomeregular') format('svg')}`,
      ),
      "FontAwesome/css/font-awesome.css",
      "text/css",
    );

    expect(referenceValues(refs)).toEqual(
      expect.arrayContaining([
        "../fonts/fontawesome-webfont.woff2?v=4.7.0",
        "../fonts/fontawesome-webfont.woff?v=4.7.0",
        "../fonts/fontawesome-webfont.ttf?v=4.7.0",
      ]),
    );
  });

  test("handles deeply nested generated HTML without recursive stack overflow", () => {
    const html = `${"<div>".repeat(20_000)}<a href="deep/page.html">deep</a>${"</div>".repeat(
      20_000,
    )}`;

    expect(referenceValues(extractReferences(Buffer.from(html), "toc.html", "text/html"))).toContain(
      "deep/page.html",
    );
  });
});

describe("rewriteCssAssetReferences", () => {
  test("strips cache-buster query strings from relative url() references so file:// resolves", () => {
    const css =
      `@font-face{src:url('../fonts/fa.eot?v=4.7.0');` +
      `src:url('../fonts/fa.eot?#iefix&v=4.7.0') format('embedded-opentype'),` +
      `url('../fonts/fa.woff2?v=4.7.0') format('woff2'),` +
      `url('../fonts/fa.svg?v=4.7.0#fontawesomeregular') format('svg')}`;

    const rewritten = rewriteCssAssetReferences(css);

    expect(rewritten).not.toMatch(/\?v=4\.7\.0/);
    expect(rewritten).toContain("../fonts/fa.eot");
    expect(rewritten).toContain("../fonts/fa.woff2");
    expect(rewritten).toContain("../fonts/fa.svg#fontawesomeregular");
  });

  test("keeps query strings on absolute URLs because remote servers may need them", () => {
    const css = `body{background:url('https://cdn.example.com/img.png?v=2')}`;
    const rewritten = rewriteCssAssetReferences(css);
    expect(rewritten).toContain("https://cdn.example.com/img.png?v=2");
  });

  test("strips query strings from relative @import references", () => {
    const css = `@import "theme.css?v=1.0"; @import url('reset.css?token=abc');`;
    const rewritten = rewriteCssAssetReferences(css);
    expect(rewritten).not.toContain("?v=1.0");
    expect(rewritten).not.toContain("?token=abc");
    expect(rewritten).toContain("theme.css");
    expect(rewritten).toContain("reset.css");
  });

  test("works on inline style declaration lists", () => {
    const css = `background: url('img/x.png?v=1'); color: red`;
    const rewritten = rewriteCssAssetReferences(css, "declarationList");
    expect(rewritten).toContain("img/x.png");
    expect(rewritten).not.toContain("?v=1");
  });
});
