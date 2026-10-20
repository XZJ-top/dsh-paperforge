/**
 * LaTeX 编译：引擎检测、排版序列、日志解析。
 *
 * 不使用 latexmk 驱动：MiKTeX 的 latexmk 在 Windows 上会继承上一次 bibtex
 * 失败的状态（"gave an error in previous invocation of latexmk"），并且首轮
 * fork bibtex 时可能拿不到 PATH。这里显式按
 *   engine → bibtex/biber → engine → engine
 * 执行，每一步都用绝对路径与自建 env，行为可预测、错误可归因。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import { readText } from "./fsutil.js";
import { PaperError } from "./bibtex.js";

/** 常见 TeX 安装位置（不含任何用户专属路径）。 */
function texCandidates() {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return [
    join(localAppData, "Programs", "MiKTeX", "miktex", "bin", "x64"),
    "C:/Program Files/MiKTeX/miktex/bin/x64",
    "/usr/local/texlive/2025/bin/universal-darwin",
    "/usr/local/texlive/2025/bin/x86_64-linux",
    "/usr/local/texlive/2024/bin/x86_64-linux",
    "/Library/TeX/texbin",
    "/usr/local/bin",
  ];
}

/** 找出 MiKTeX/TeX Live 的 bin 目录（存在 latexmk 或 xelatex 即认）。 */
export function resolveBinDir(configured) {
  if (configured && String(configured).trim()) return dirname(resolvePath(String(configured).trim()));
  for (const dir of texCandidates()) {
    if (existsSync(join(dir, "xelatex.exe")) || existsSync(join(dir, "xelatex"))) return dir;
  }
  return "";
}

/** 兼容旧接口：返回 bin 目录里存在的 latexmk（找不到时退化为 "latexmk"）。 */
export function resolveLatexmk(configured) {
  const dir = resolveBinDir(configured);
  if (dir) {
    for (const name of ["latexmk.exe", "latexmk"]) {
      const full = join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return "latexmk";
}

/** 按主文件与章节文件里的 ctex/xeCJK 痕迹判断引擎。 */
export async function detectEngine(root, entry, texSources, configured = "auto") {
  if (configured && configured !== "auto") return configured;
  const haystack = [await readText(join(root, entry), "")].concat(texSources ?? []).join("\n");
  if (/\\documentclass(?:\[[^\]]*\])?\{ctex(art|rep|book|beamer)?\}/.test(haystack)) return "xelatex";
  if (/\\usepackage(?:\[[^\]]*\])?\{(?:ctex|xeCJK|fontspec)\}/.test(haystack)) return "xelatex";
  if (/\\setmainfont|\\setCJKmainfont/.test(haystack)) return "xelatex";
  return "pdflatex";
}

function run(command, args, { cwd, timeoutMs, env }) {
  if (process.env.PAPERFORGE_DEBUG) {
    console.error(`[paperforge:debug] exec ${command} ${args.join(" ")} cwd=${cwd}`);
  }
  return new Promise((resolvePromise) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error?.code ?? 0,
          killed: Boolean(error?.killed),
          error,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
  });
}

function resolveExe(binDir, name) {
  if (binDir) {
    for (const candidate of [`${name}.exe`, name]) {
      const full = join(binDir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return name;
}

/** 解析 latex 日志：错误、警告、未定义引用、overfull。 */
export function parseLatexLog(logText, consoleText = "") {
  const text = `${logText ?? ""}\n${consoleText ?? ""}`;
  const lines = text.split(/\r?\n/);

  const errors = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^!\s+/.test(line)) continue;
    const message = line.replace(/^!\s+/, "").trim();
    let context = "";
    let lineNo = null;
    let file = null;
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      const follow = lines[j];
      const fileLine = follow.match(/^(?:\.\/)?([^:\r\n]+\.tex):(\d+):/);
      if (fileLine) {
        file = fileLine[1];
        lineNo = Number(fileLine[2]);
        context = follow.slice(fileLine[0].length).trim();
        break;
      }
      if (/^l\.\d+/.test(follow)) {
        const m = follow.match(/^l\.(\d+)\s*(.*)$/);
        lineNo = m ? Number(m[1]) : null;
        context = m ? m[2].trim() : follow.trim();
        break;
      }
      if (/^!\s+/.test(follow)) break;
      if (follow.trim()) context = follow.trim();
    }
    errors.push({ message, line: lineNo, context: context.slice(0, 300), file });
    if (errors.length >= 40) break;
  }

  const undefinedCitations = new Set();
  for (const match of text.matchAll(/Citation\s+[`'"]([^`'"]+)[`'"](?:\s+on page \d+)?\s+undefined/gi)) {
    undefinedCitations.add(match[1]);
  }

  const undefinedReferences = new Set();
  for (const match of text.matchAll(/Reference\s+[`'"]([^`'"]+)[`'"]\s+on page \d+\s+undefined/gi)) {
    undefinedReferences.add(match[1]);
  }
  for (const match of text.matchAll(/LaTeX Warning:\s+Reference\s+[`'"]([^`'"]+)[`'"]\s+undefined/gi)) {
    undefinedReferences.add(match[1]);
  }

  const warnings = [];
  for (const line of lines) {
    const match = line.match(/^(?:LaTeX|Package|Class)\s+(?:[A-Za-z0-9_-]+\s+)?Warning:\s+(.+)$/);
    if (match) warnings.push(match[1].trim());
    if (warnings.length >= 60) break;
  }

  const overfullCount = (text.match(/Overfull \\hbox/g) ?? []).length;
  const underfullCount = (text.match(/Underfull \\hbox/g) ?? []).length;
  const fatal = /Emergency stop|Fatal error occurred|job aborted/i.test(text);
  const rerun = /Rerun to get cross-references right|Label\(s\) may have changed|Please \(re\)run|There were undefined references/i.test(text);
  const missingBbl = /No file .*\.bbl|I couldn't open (?:database|style) file|I found no \\bibdata/i.test(text);

  return {
    errors,
    warnings,
    undefinedCitations: [...undefinedCitations].sort(),
    undefinedReferences: [...undefinedReferences].sort(),
    overfullCount,
    underfullCount,
    fatal,
    rerun,
    missingBbl,
    logTail: lines.filter((l) => l.trim()).slice(-40).join("\n"),
  };
}

/** 从 .aux 中读出 \bibdata{...} 的 bib 文件名（默认 references）。 */
async function detectBibName(auxPath) {
  const aux = await readText(auxPath, "");
  const match = aux.match(/\\bibdata\{([^}]*)\}/);
  return match ? match[1].split(",")[0].trim() : "references";
}

/**
 * 编译一个论文工程。
 * @returns {{status:"passed"|"failed", engine:string, ...}}
 */
export async function compileProject({
  root,
  entry = "main.tex",
  engine = "xelatex",
  latexmk,
  timeoutMs = 180000,
}) {
  const entryPath = join(root, entry);
  if (!existsSync(entryPath)) {
    throw new PaperError("PROJECT_NOT_FOUND", `入口文件不存在：${entryPath}`);
  }

  const base = entryPath.replace(/\.tex$/i, "");
  const logPath = `${base}.log`;
  const pdfPath = `${base}.pdf`;
  const auxPath = `${base}.aux`;
  const before = await stat(pdfPath).catch(() => null);
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  const binDir = resolveBinDir(latexmk);
  const engineExe = resolveExe(binDir, engine);
  const bibtexExe = resolveExe(binDir, "bibtex");
  const biberExe = resolveExe(binDir, "biber");

  const env = { ...process.env };
  if (binDir) {
    const withBin = `${binDir}${delimiter}${env.PATH ?? env.Path ?? ""}`;
    env.PATH = withBin;
    env.Path = withBin;
  }

  const mainSource = await readText(entryPath, "");
  const usesBiber = /\\usepackage(?:\[[^\]]*\])?\{biblatex\}|\\addbibresource/.test(mainSource);
  const steps = [];

  const runEngine = async () => {
    if (Date.now() >= deadline) {
      throw new PaperError("COMPILE_TIMEOUT", `编译超时（${timeoutMs} ms）`);
    }
    const remaining = Math.max(5000, deadline - Date.now());
    const result = await run(engineExe, ["-interaction=nonstopmode", "-halt-on-error", "-file-line-error", entry], {
      cwd: root,
      timeoutMs: remaining,
      env,
    });
    if (result.error?.code === "ENOENT") {
      throw new PaperError("LATEX_ENGINE_MISSING", `找不到 LaTeX 引擎：${engineExe}`);
    }
    steps.push({ step: engine, code: result.code, ms: 0 });
    return result;
  };

  const runBibTool = async () => {
    const aux = await readText(auxPath, "");
    if (!/\\citation\{/.test(aux) && !/\\abx@aux@cite/.test(aux)) return null;
    const bibName = usesBiber ? null : await detectBibName(auxPath);
    if (!usesBiber && !existsSync(join(root, `${bibName}.bib`))) return { skipped: `${bibName}.bib 不存在` };
    if (Date.now() >= deadline) return null;
    const remaining = Math.max(5000, deadline - Date.now());
    if (usesBiber) {
      const result = await run(biberExe, [base.split(/[\\/]/).pop()], { cwd: root, timeoutMs: remaining, env });
      steps.push({ step: "biber", code: result.code });
      return result;
    }
    const result = await run(bibtexExe, [base.split(/[\\/]/).pop()], { cwd: root, timeoutMs: remaining, env });
    steps.push({ step: "bibtex", code: result.code });
    return result;
  };

  let last = await runEngine();
  const bibResult = await runBibTool();

  // 最多再排版两遍：交叉引用、目录、引用列表都需要收敛。
  for (let pass = 0; pass < 2; pass += 1) {
    const logNow = await readText(logPath, "");
    if (!/Rerun to get|Label\(s\) may have changed|There were undefined references|undefined citations/i.test(logNow)) {
      if (pass > 0 || !/undefined/i.test(logNow)) break;
    }
    last = await runEngine();
  }

  const logText = await readText(logPath, "");
  const consoleText = `${last.stdout}\n${last.stderr}`;
  const parsed = parseLatexLog(logText, consoleText);
  if (last.killed) {
    parsed.errors.unshift({ message: `编译超时（${timeoutMs} ms），进程被终止`, line: null, context: "", file: null });
  }

  const after = await stat(pdfPath).catch(() => null);
  const pdfWritten = after != null && (!before || after.mtimeMs >= before.mtimeMs);
  const passed = last.code === 0 && pdfWritten && parsed.errors.length === 0 && !parsed.fatal;
  const durationMs = Date.now() - startedAt;

  return {
    status: passed ? "passed" : "failed",
    engine,
    entry,
    ...(process.env.PAPERFORGE_DEBUG ? { _debug: { binDir, engineExe, steps } } : {}),
    exitCode: last.code,
    durationMs,
    steps,
    bibliography: bibResult?.skipped ? { skipped: bibResult.skipped } : { tool: usesBiber ? "biber" : "bibtex", code: bibResult?.code ?? null },
    errors: parsed.errors.slice(0, 30),
    warnings: parsed.warnings.slice(0, 30),
    undefinedCitations: parsed.undefinedCitations,
    undefinedReferences: parsed.undefinedReferences,
    overfullCount: parsed.overfullCount,
    underfullCount: parsed.underfullCount,
    rerun: parsed.rerun,
    missingBbl: parsed.missingBbl,
    pdfPath: pdfWritten ? pdfPath : null,
    pdfBytes: after?.size ?? 0,
    logPath,
    logTail: parsed.logTail,
    stdoutTail: consoleText.trim().split(/\r?\n/).slice(-20).join("\n"),
  };
}
