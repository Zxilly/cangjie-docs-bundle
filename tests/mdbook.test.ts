import { describe, expect, test } from "vitest";

import { HttpFetchError } from "../src/http.js";
import { createMdBookSource, mdBookProfile } from "../src/sources/mdbook.js";

describe("mdBook source", () => {
  test("keeps pre-1.1.3 versions on the docs.cangjie-lang.cn mdBook source", () => {
    expect(createMdBookSource("1.1.0")).toMatchObject({
      kind: "mdbook",
      baseUrl: "https://docs.cangjie-lang.cn/docs/1.1.0/",
    });
  });

  test("treats missing searchindex.json as an optional mdBook fallback", () => {
    expect(
      mdBookProfile.ignoreFetchError?.(
        "https://docs.cangjie-lang.cn/docs/1.1.0/searchindex.json",
        new HttpFetchError("HTTP 404", 404),
      ),
    ).toBe(true);
    expect(
      mdBookProfile.ignoreFetchError?.(
        "https://docs.cangjie-lang.cn/docs/1.1.0/book.js",
        new HttpFetchError("HTTP 404", 404),
      ),
    ).toBe(false);
  });
});
