import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

const MAX_BYTES = 256 * 1024;

export function readSkillText(file: string, skillsDir: string): string {
  const root = realpathSync(skillsDir);
  const target = realpathSync(file);
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("skill file escapes pack root");
  }
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw Object.assign(new Error("skill is not a regular file"), { code: stat.isDirectory() ? "EISDIR" : "EINVAL" });
    if (stat.size > MAX_BYTES) throw new Error("skill exceeds 256 KiB");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    if (length > MAX_BYTES) throw new Error("skill exceeds 256 KiB");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
