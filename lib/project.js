/**
 * 论文工程模型：slug、路径、project.json、outline 与分节文件。
 *
 * 设计要点：正文按「一节一文件」（sections/NN-id.tex）落盘，main.tex 只负责
 * \input 顺序。这样每次写作都是单文件原子替换，不会破坏其它节，也不需要
 * 在单个 main.tex 里解析标记边界。
 */
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  isoNow,
  pathExists,
  readJson,
  readText,
  writeFileAtomic,
  writeJsonAtomic,
} from "./fsutil.js";

export const SCHEMA_VERSION = 1;

const RESERVED_IDS = new Set([
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6",
  "com7", "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7",
  "lpt8", "lpt9",
]);

/** 标题 → 目录 slug；含中文时保留汉字（LaTeX 侧的文件名另由 section id 处理）。 */
export function slugify(input) {
  const raw = String(input ?? "").trim();
  if (/[\u4e00-\u9fa5]/.test(raw)) {
    const cjk = raw
      .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48);
    if (cjk) return cjk;
  }
  const ascii = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  const base = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return base || `paper-${Date.now().toString(36)}`;
}

/** 目录名合法性：禁止路径分隔符、上级引用与控制字符。 */
export function validateSlug(slug) {
  const value = String(slug ?? "").trim();
  if (!value) return { ok: false, reason: "slug 不能为空" };
  if (value.length > 80) return { ok: false, reason: "slug 过长（>80）" };
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(value)) {
    return { ok: false, reason: "slug 含非法字符（路径分隔符或控制字符）" };
  }
  if (value === "." || value === ".." || value.includes("..")) {
    return { ok: false, reason: "slug 不能包含 .." };
  }
  if (RESERVED_IDS.has(value.toLowerCase())) {
    return { ok: false, reason: `slug 是 Windows 保留名：${value}` };
  }
  return { ok: true, value };
}

/** 把字体里危险的控制字符剔掉，避免写进 tex 后编译炸裂。 */
export function cleanText(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
}

/** LaTeX 文本转义（标题、作者、摘要等用户可见文本）。单次扫描，避免替换结果互相污染。 */
export function escapeLatex(value) {
  const map = {
    "\\": "\\textbackslash{}",
    "&": "\\&",
    "%": "\\%",
    $: "\\$",
    "#": "\\#",
    _: "\\_",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return cleanText(value).replace(/[\\&%$#_{}~^]/g, (ch) => map[ch]);
}

export function projectPaths(config, slug) {
  const root = resolve(config.papersRoot, slug);
  const papersRoot = resolve(config.papersRoot);
  if (root !== papersRoot && !root.startsWith(`${papersRoot}${sep}`)) {
    throw new Error(`项目路径越界：${root}`);
  }
  return {
    root,
    main: join(root, "main.tex"),
    bib: join(root, "references.bib"),
    sectionsDir: join(root, "sections"),
    figuresDir: join(root, "figures"),
    stateDir: join(root, ".paper"),
    stateFile: join(root, ".paper", "project.json"),
    stateBackup: join(root, ".paper", "project.json.bak"),
    outlineFile: join(root, ".paper", "outline.json"),
    bibSourcesFile: join(root, ".paper", "bib-sources.json"),
    logsDir: join(root, ".paper", "logs"),
    reviewsDir: join(root, ".paper", "reviews"),
    distDir: join(root, "dist"),
  };
}

export async function loadProject(config, slug) {
  const paths = projectPaths(config, slug);
  let state = await readJson(paths.stateFile, null);
  if (!state) {
    // 主状态损坏时尝试从备份恢复
    const backup = await readJson(paths.stateBackup, null);
    if (backup) {
      state = backup;
      await writeJsonAtomic(paths.stateFile, backup);
    }
  }
  if (!state || typeof state !== "object") return null;
  return normalizeProject(state, paths);
}

function normalizeProject(state, paths) {
  const project = {
    schemaVersion: SCHEMA_VERSION,
    slug: state.slug,
    title: state.title ?? state.slug,
    lang: state.lang === "en" ? "en" : "zh",
    venue: state.venue ?? "",
    authors: Array.isArray(state.authors) ? state.authors.map(String) : [],
    template: state.template ?? (state.lang === "en" ? "article" : "ctexart"),
    createdAt: state.createdAt ?? isoNow(),
    updatedAt: state.updatedAt ?? isoNow(),
    outline: Array.isArray(state.outline) ? state.outline : [],
    citations: Array.isArray(state.citations) ? state.citations.map(String) : [],
    compile: state.compile ?? null,
    review: Array.isArray(state.review) ? state.review : [],
    export: state.export ?? null,
    history: Array.isArray(state.history) ? state.history.slice(-200) : [],
  };
  for (const [index, section] of project.outline.entries()) {
    if (!section.file) section.file = sectionFileName(section, index, paths);
    section.status = ["todo", "draft", "done"].includes(section.status) ? section.status : "todo";
    section.chars = Number.isFinite(section.chars) ? section.chars : 0;
    section.cites = Number.isFinite(section.cites) ? section.cites : 0;
  }
  return project;
}

export async function saveProject(config, project) {
  const paths = projectPaths(config, project.slug);
  project.updatedAt = isoNow();
  const snapshot = JSON.parse(JSON.stringify(project));
  delete snapshot.schemaVersion;
  await writeJsonAtomic(paths.stateFile, { schemaVersion: SCHEMA_VERSION, ...snapshot });
  await writeJsonAtomic(paths.stateBackup, { schemaVersion: SCHEMA_VERSION, ...snapshot });
  return project;
}

export function appendHistory(project, action, detail = "") {
  project.history.push({ at: isoNow(), action, detail: String(detail).slice(0, 300) });
  if (project.history.length > 200) project.history = project.history.slice(-200);
}

export function sectionFileName(section, index, paths) {
  const id = section.id || `section-${index}`;
  return join("sections", `${String(index).padStart(2, "0")}-${id}.tex`);
}

const ZH_SECTION_IDS = {
  摘要: "abstract",
  引言: "introduction",
  绪论: "introduction",
  背景: "background",
  材料与方法: "methods",
  方法: "methods",
  方法学: "methods",
  结果: "results",
  结果与分析: "results",
  讨论: "discussion",
  结论: "conclusion",
  结论与展望: "conclusion",
  参考文献: "references",
  致谢: "acknowledgements",
};

export function makeSectionId(title, index, used = new Set()) {
  const raw = String(title ?? "").trim();
  // 常见中文章节名直接映射为英文 id，便于 \cite/\ref 与文件名稳定可读。
  const mapped = ZH_SECTION_IDS[raw]
    ?? Object.entries(ZH_SECTION_IDS).find(([zh]) => raw.includes(zh))?.[1];
  const ascii = mapped
    ? mapped
    : raw
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  let base = (ascii || `section-${index + 1}`).slice(0, 32);
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

/** 兼容 id、精确标题、大小写不敏感标题三种引用方式。 */
export function findSection(project, ref) {
  const needle = String(ref ?? "").trim();
  if (!needle) return null;
  const lower = needle.toLowerCase();
  return (
    project.outline.find((s) => s.id === needle) ??
    project.outline.find((s) => s.title === needle) ??
    project.outline.find((s) => s.title.toLowerCase() === lower) ??
    project.outline.find((s) => s.id.toLowerCase() === lower) ??
    project.outline.find((s) => s.title.replace(/\s+/g, "") === needle.replace(/\s+/g, "")) ??
    null
  );
}

export async function readSectionText(paths, section) {
  return readText(join(paths.root, section.file), "");
}

export async function writeSectionText(paths, section, content) {
  const file = join(paths.root, section.file);
  await mkdir(join(paths.root, "sections"), { recursive: true });
  await writeFileAtomic(file, content);
  return file;
}

const CITE_RE = /\\(?:cite|citep|citet|citealp|citealt|Citep|Citet|parencite|textcite|autocite|footcite|supercite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g;

export function countCites(text) {
  let count = 0;
  for (const match of String(text ?? "").matchAll(CITE_RE)) {
    for (const key of match[1].split(",")) {
      if (key.trim() && key.trim() !== "*") count += 1;
    }
  }
  return count;
}

/** 正文字数（中文按字符，英文按空白切词，取两者较大的合理值）。 */
export function countChars(text) {
  const plain = String(text ?? "")
    .replace(/%.*$/gm, "")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})?/g, " ")
    .replace(/[{}]/g, " ");
  const cjk = (plain.match(/[\u4e00-\u9fa5]/g) ?? []).length;
  const words = plain.replace(/[\u4e00-\u9fa5]/g, " ").split(/\s+/).filter(Boolean).length;
  return cjk + words;
}

/** 渲染 main.tex：abstract 走 abstract 环境，其余按 outline 顺序 \input。 */
export function renderMainTex(project) {
  const zh = project.lang !== "en";
  const title = escapeLatex(project.title);
  const authors = project.authors.length
    ? project.authors.map(escapeLatex).join(zh ? "、" : " \\and ")
    : zh ? "作者" : "Author";
  const abstract = project.outline.find((s) => s.id === "abstract");
  const body = project.outline.filter((s) => s.id !== "abstract");

  const header = zh
    ? [
      "\\documentclass[UTF8,a4paper,11pt,fontset=windows]{ctexart}",
      "\\usepackage[numbers]{gbt7714}",
      "\\usepackage{amsmath,amssymb}",
      "\\usepackage{graphicx}",
      "\\usepackage{booktabs}",
      "\\usepackage[hidelinks]{hyperref}",
      "",
      `\\title{${title}}`,
      `\\author{${authors}}`,
      "\\date{\\today}",
      "",
      "\\begin{document}",
      "\\maketitle",
      "",
      "\\begin{abstract}",
      `\\input{${stripTex(abstract?.file ?? "sections/00-abstract.tex")}}`,
      "\\end{abstract}",
      "",
    ]
    : [
      "\\documentclass[11pt]{article}",
      "\\usepackage[utf8]{inputenc}",
      "\\usepackage[T1]{fontenc}",
      "\\usepackage{amsmath,amssymb}",
      "\\usepackage{graphicx}",
      "\\usepackage{booktabs}",
      "\\usepackage[round]{natbib}",
      "\\usepackage[hidelinks]{hyperref}",
      "",
      `\\title{${title}}`,
      `\\author{${authors}}`,
      "\\date{\\today}",
      "",
      "\\begin{document}",
      "\\maketitle",
      "",
      "\\begin{abstract}",
      `\\input{${stripTex(abstract?.file ?? "sections/00-abstract.tex")}}`,
      "\\end{abstract}",
      "",
    ];

  const bodyLines = [];
  for (const section of body) {
    const target = stripTex(section.file);
    if (section.level === 2) {
      bodyLines.push(`\\subsection*{${escapeLatex(section.title)}}`, `\\input{${target}}`, "");
    } else {
      bodyLines.push(`\\section{${escapeLatex(section.title)}}`, `\\input{${target}}`, "");
    }
  }

  const footer = zh
    ? [
      "\\bibliographystyle{gbt7714-numerical}",
      "\\bibliography{references}",
      "",
      "\\end{document}",
      "",
    ]
    : [
      "\\bibliographystyle{plainnat}",
      "\\bibliography{references}",
      "",
      "\\end{document}",
      "",
    ];

  return [...header, ...bodyLines, ...footer].join("\n");
}

function stripTex(file) {
  return String(file ?? "").replace(/\\/g, "/").replace(/\.tex$/i, "");
}

/** 新建工程：已存在时绝不覆盖，只返回现状。 */
export async function createProject(config, { slug, title, lang = "zh", authors = [], venue = "" }) {
  const check = validateSlug(slug);
  if (!check.ok) throw Object.assign(new Error(check.reason), { code: "INVALID_SLUG" });
  const paths = projectPaths(config, slug);
  const existing = await loadProject(config, slug);
  if (existing) return { created: false, project: existing, paths };

  await mkdir(paths.sectionsDir, { recursive: true });
  await mkdir(paths.figuresDir, { recursive: true });
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.reviewsDir, { recursive: true });

  const zh = lang !== "en";
  const project = {
    schemaVersion: SCHEMA_VERSION,
    slug,
    title: cleanText(title),
    lang: zh ? "zh" : "en",
    venue: cleanText(venue),
    authors: Array.isArray(authors) ? authors.map((a) => cleanText(a)) : [],
    template: zh ? "ctexart" : "article",
    createdAt: isoNow(),
    updatedAt: isoNow(),
    outline: [
      {
        id: "abstract",
        title: zh ? "摘要" : "Abstract",
        level: 1,
        file: join("sections", "00-abstract.tex"),
        status: "todo",
        chars: 0,
        cites: 0,
      },
    ],
    citations: [],
    compile: null,
    review: [],
    export: null,
    history: [{ at: isoNow(), action: "paper_init", detail: `${slug} (${zh ? "zh" : "en"})` }],
  };

  await writeFileAtomic(paths.bib, "");
  await writeFileAtomic(join(paths.root, "sections", "00-abstract.tex"), "");
  await writeFileAtomic(paths.main, renderMainTex(project));
  await saveProject(config, project);
  await writeJsonAtomic(paths.outlineFile, project.outline);
  await writeJsonAtomic(paths.bibSourcesFile, {});
  return { created: true, project, paths };
}
