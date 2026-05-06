# cangjie-docs-bundle

Mirror generated Cangjie mdBook HTML documentation and package it as:

```text
cangjie-docs-html-<version>.tar.gz
```

The crawler downloads from:

```text
https://docs.cangjie-lang.cn/docs/<version>/
```

It does not rebuild the docs from source. It parses generated HTML/CSS/JavaScript, uses Babel for JavaScript AST parsing, and downloads discovered files concurrently.

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

## Test

```bash
pnpm test
pnpm run check
```
