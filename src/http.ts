export const USER_AGENT =
  "cangjie-docs-bundle/0.1 (+https://github.com/Zxilly/cangjie-docs-bundle)";

export type FetchResult = {
  body: Buffer;
  contentType: string;
};

export type Fetcher = (url: string) => Promise<FetchResult>;

export class HttpFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpFetchError";
  }
}

export async function fetchUrl(
  url: string,
  { retries = 2, timeoutMs = 60_000 }: { retries?: number; timeoutMs?: number } = {},
): Promise<FetchResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new HttpFetchError(`HTTP ${response.status}: ${url}`, response.status);
      }
      return {
        body: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !isRetriableFetchError(error)) {
        break;
      }
      await sleep(300 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetriableFetchError(error: unknown): boolean {
  if (error instanceof HttpFetchError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return true;
  }
  return !(error instanceof HttpFetchError);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
