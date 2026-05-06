import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { USER_AGENT } from "../src/download-docs-html.js";

describe("project metadata", () => {
  test("uses the cangjie-docs-bundle repository identity", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      repository: { url: string };
      bugs: { url: string };
      homepage: string;
    };
    const readme = await readFile("README.md", "utf8");

    expect(pkg.name).toBe("cangjie-docs-bundle");
    expect(pkg.repository.url).toBe("git+https://github.com/Zxilly/cangjie-docs-bundle.git");
    expect(pkg.bugs.url).toBe("https://github.com/Zxilly/cangjie-docs-bundle/issues");
    expect(pkg.homepage).toBe("https://github.com/Zxilly/cangjie-docs-bundle#readme");
    expect(readme).toMatch(/^# cangjie-docs-bundle/m);
    expect(USER_AGENT).toContain("cangjie-docs-bundle/0.1");
    expect(USER_AGENT).toContain("https://github.com/Zxilly/cangjie-docs-bundle");
  });

  test("enables actions-bbr before installing dependencies", async () => {
    const workflow = await readFile(".github/workflows/build-docs.yml", "utf8");
    const bbrIndex = workflow.indexOf("uses: Zxilly/actions-bbr@v1");
    const installIndex = workflow.indexOf("name: Install");

    expect(bbrIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(-1);
    expect(bbrIndex).toBeLessThan(installIndex);
  });

  test("builds all versions automatically and uploads each archive to a matching release", async () => {
    const workflow = await readFile(".github/workflows/build-docs.yml", "utf8");

    expect(workflow).toContain("push:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain("default: \"all\"");
    expect(workflow).toContain('npm run build:versions -- --version "$VERSION" --keep-going --force --concurrency 32');
    expect(workflow).toContain('version="${name#cangjie-docs-html-}"');
    expect(workflow).toContain('version="${version%.tar.gz}"');
    expect(workflow).toContain('gh release create "$version" --title "$version" --notes "$notes"');
    expect(workflow).toContain('gh release upload "$version" "$archive" --clobber');
  });
});
