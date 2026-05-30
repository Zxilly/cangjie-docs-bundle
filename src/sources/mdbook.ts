import { HttpFetchError } from "../http.js";
import { normalizeBaseUrl } from "../urls.js";
import { genericProfile } from "./generic.js";
import type { CrawlProfile, DocsSource } from "./types.js";

export const MDBOOK_BASE_URL = "https://docs.cangjie-lang.cn/docs/{version}/";

export const mdBookProfile: CrawlProfile = {
  ...genericProfile,
  ignoreFetchError: (url, error) =>
    error instanceof HttpFetchError &&
    error.status === 404 &&
    new URL(url).pathname.endsWith("/searchindex.json"),
};

export function createMdBookSource(version: string): DocsSource {
  const baseUrl = normalizeBaseUrl(MDBOOK_BASE_URL.replace("{version}", version));
  return {
    kind: "mdbook",
    baseUrl,
    startUrls: [baseUrl],
    profile: mdBookProfile,
  };
}
