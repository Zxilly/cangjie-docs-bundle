import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

import * as tar from "tar";

export async function createArchive(root: string, archive: string): Promise<void> {
  const files = await listFiles(root);
  await mkdir(path.dirname(archive), { recursive: true });
  await tar.create(
    {
      cwd: root,
      file: archive,
      gzip: true,
      mtime: new Date(0),
      noMtime: true,
      portable: true,
      sync: false,
    },
    files,
  );
}

async function listFiles(root: string, relativeDir = ""): Promise<string[]> {
  const absoluteDir = path.join(root, ...relativeDir.split("/").filter(Boolean));
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}
