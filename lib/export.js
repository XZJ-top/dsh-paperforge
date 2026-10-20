/**
 * 导出：把可复现产物复制到 dist/<slug>-<stamp>，并打 zip。
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { copyDir, fileSize, isFile, pathExists, stampNow, writeJsonAtomic } from "./fsutil.js";
import { PaperError } from "./bibtex.js";

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, timeoutMs = 120000) {
  return new Promise((resolvePromise) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => resolvePromise({ code: error?.code ?? 0, error, stdout, stderr }),
    );
  });
}

/**
 * @param {object} options
 * @param {object} options.paths projectPaths()
 * @param {object} options.project project.json
 * @param {boolean} [options.zip]
 */
export async function exportProject({ paths, project, zip = true }) {
  if (!(await isFile(join(paths.root, "main.pdf")))) {
    throw new PaperError("NO_PDF", "还没有 main.pdf：先运行 paper_compile 并确保编译通过。");
  }

  const stamp = stampNow();
  const distDir = join(paths.distDir, `${project.slug}-${stamp}`);
  await mkdir(distDir, { recursive: true });

  const copied = [];
  const copyFileIfExists = async (relative) => {
    const from = join(paths.root, relative);
    if (!(await pathExists(from))) return;
    const to = join(distDir, relative);
    await mkdir(dirname(to), { recursive: true }).catch(() => {});
    await copyDir(from, to);
    copied.push(relative.replace(/\\/g, "/"));
  };

  for (const relative of ["main.pdf", "main.tex", "references.bib", "sections", "figures", ".paper/project.json", ".paper/bib-sources.json"]) {
    await copyFileIfExists(relative);
  }

  // 若 sections 是目录，copyDir 会整目录复制；此处确保它存在于清单里
  if (!copied.includes("sections") && (await pathExists(join(paths.root, "sections")))) {
    copied.push("sections");
  }

  await writeJsonAtomic(join(distDir, "export.json"), {
    slug: project.slug,
    title: project.title,
    exportedAt: new Date().toISOString(),
    files: copied,
    compile: project.compile ?? null,
  });

  let zipPath = null;
  if (zip) {
    const target = join(paths.distDir, `${project.slug}-${stamp}.zip`);
    const script = `Compress-Archive -Path ${psQuote(join(distDir, "*"))} -DestinationPath ${psQuote(target)} -Force`;
    const result = await runPowerShell(script);
    if (result.code === 0 && (await pathExists(target))) zipPath = target;
  }

  return {
    distDir,
    zipPath,
    files: copied,
    pdfBytes: await fileSize(join(paths.root, "main.pdf")),
    exportedAt: new Date().toISOString(),
  };
}
