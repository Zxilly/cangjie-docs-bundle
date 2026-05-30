# cangjie-docs-bundle

Mirror generated Cangjie mdBook HTML documentation and package it as:

```text
cangjie-docs-html-<version>.tar.gz
```

The crawler downloads older mdBook versions from:

```text
https://docs.cangjie-lang.cn/docs/<version>/
```

For VitePress versions starting with 1.1.3, it downloads from:

```text
https://cj-docs.gitcode.com/zh/<version>/
```

It does not rebuild the docs from source. It parses generated HTML/CSS/JavaScript, uses Babel for JavaScript AST parsing, and downloads discovered files concurrently.

The crawler core is source-agnostic. Source-specific behavior lives in separate profiles:

- `src/sources/mdbook.ts` handles older mdBook output and mdBook fallback assets.
- `src/sources/vitepress.ts` handles GitCode VitePress output, including bootstrap pages, VitePress route metadata, page chunks, and hosted path rewriting.

## Install

```bash
pnpm install --frozen-lockfile
```

## Build One Version

```bash
pnpm run download -- 1.1.0 --force --concurrency 32
```

Output:

```text
dist/cangjie-docs-html-1.1.0.tar.gz
```

## Build Versions From Manifest

```bash
pnpm run build:versions --version all --keep-going --force --concurrency 32
```

The manifest is downloaded from:

```text
https://raw.githubusercontent.com/Zxilly/cangjie-version-manifest/master/versions.json
```

To build a single version from the manifest:

```bash
pnpm run build:versions --version 1.1.0 --force --concurrency 32
```

CI passes `--skip-existing-releases` so versions that already have GitHub releases
are not crawled again:

```bash
pnpm run build:versions --version all --skip-existing-releases --github-repository owner/repo
```

## Test

```bash
pnpm test
pnpm run check
```
