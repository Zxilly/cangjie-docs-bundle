export type ReferenceResolution = "current-url" | "base-url";

export type ReferenceSource = "generic" | "vitepress";

export type ReferenceKind =
  | "html-attribute"
  | "html-srcset"
  | "inline-style"
  | "stylesheet-url"
  | "stylesheet-import"
  | "javascript-path"
  | "json-string"
  | "vitepress-page-chunk"
  | "vitepress-route";

export type DiscoveredReference = {
  value: string;
  resolution: ReferenceResolution;
  kind: ReferenceKind;
  source: ReferenceSource;
  optional?: boolean;
};

export type ReferenceContext = {
  baseUrl: string;
  currentUrl: string;
  localPath: string;
};

export function discoveredReference(
  value: string,
  options: {
    kind: ReferenceKind;
    source?: ReferenceSource;
    resolution?: ReferenceResolution;
    optional?: boolean;
  },
): DiscoveredReference {
  return {
    value,
    kind: options.kind,
    source: options.source ?? "generic",
    resolution: options.resolution ?? "current-url",
    optional: options.optional,
  };
}

export function resolveDiscoveredReference(
  ref: DiscoveredReference,
  context: ReferenceContext,
): string {
  if (ref.resolution === "base-url") {
    return new URL(ref.value.replace(/^\/+/, ""), context.baseUrl).toString();
  }
  return new URL(ref.value, context.currentUrl).toString();
}

export function uniqueDiscoveredReferences(
  refs: DiscoveredReference[],
): DiscoveredReference[] {
  const seen = new Set<string>();
  const output: DiscoveredReference[] = [];
  for (const ref of refs) {
    const key = `${ref.resolution}\0${ref.value}`;
    const existingIndex = output.findIndex(
      (candidate) => `${candidate.resolution}\0${candidate.value}` === key,
    );
    if (existingIndex >= 0) {
      if (!ref.optional && output[existingIndex]?.optional) {
        output[existingIndex] = ref;
      }
      continue;
    }
    seen.add(key);
    output.push(ref);
  }
  return output;
}
