import type { DiscoveredReference, ReferenceContext } from "../references.js";

export type DocsSourceKind = "mdbook" | "vitepress";

export type CrawlProfile = {
  extractReferences: (body: Buffer, localPath: string, contentType: string) => DiscoveredReference[];
  rewriteAssetForDisk?: (
    body: Buffer,
    localPath: string,
    contentType: string,
    baseUrl: string,
  ) => Buffer;
  ignoreFetchError?: (url: string, error: unknown) => boolean;
};

export type DocsSource = {
  kind: DocsSourceKind;
  baseUrl: string;
  startUrls: string[];
  profile: CrawlProfile;
};

export type { DiscoveredReference, ReferenceContext };
