/**
 * 文件系统小工具：原子写、JSON 读写、时间戳、目录复制。
 */
import { mkdir, readFile, rename, rm, stat, writeFile, cp } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** 进程内单调递增的临时后缀，避免同名临时文件互撞。 */
let tmpCounter = 0;

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标。
 * Windows 的 rename 会覆盖已存在文件（MoveFileEx + REPLACE_EXISTING）。
 */
export async function writeFileAtomic(path, content, encoding = "utf8") {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${++tmpCounter}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, content, encoding);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(path, value) {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(path, fallback = null) {
  try {
    const text = await readFile(path, "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function readText(path, fallback = "") {
  try {
    return await readFile(path, "utf8");
  } catch {
    return fallback;
  }
}

export async function copyDir(from, to) {
  await cp(from, to, { recursive: true, force: true, errorOnExist: false });
}

export function isoNow() {
  return new Date().toISOString();
}

/** 文件系统安全的时间戳：20261020-203045 */
export function stampNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

/** 面向用户的时间戳：2026-10-20 20:30:45 */
export function humanNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
