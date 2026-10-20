/**
 * paper_* 工具：确定性工程操作，不做任何「写作」判断。
 */
import { join } from "node:path";
import {
  appendBibtex,
  bibFingerprints,
  fetchArxivById,
  fetchCrossrefByDoi,
  makeCitationKey,
  normalizeArxivId,
  normalizeDoi,
  searchArxiv,
  toBibtex,
  uniqueKey,
  PaperError,
} from "./bibtex.js";
import { auditCitations, parseBibEntries } from "./audit.js";
import { createBridge } from "./bridges.js";
import { compileProject, detectEngine } from "./compile.js";
import { exportProject } from "./export.js";
import { buildArchiveNotes, loadArchiveInputs } from "./notes.js";
import { readJson, readText, writeFileAtomic, writeJsonAtomic } from "./fsutil.js";
import {
  appendHistory,
  countChars,
  countCites,
  createProject,
  findSection,
  loadProject,
  makeSectionId,
  projectPaths,
  readSectionText,
  renderMainTex,
  saveProject,
  sectionFileName,
  slugify,
  validateSlug,
  writeSectionText,
} from "./project.js";
import { renderVerdict, reviewProject } from "./review.js";
import { createZoteroLocal, resolveLocalKey } from "./zotero-local.js";

function toText(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function wrap(handler) {
  return async (args, exec) => {
    try {
      return await handler(args ?? {}, exec);
    } catch (error) {
      if (error instanceof PaperError || error?.code) {
        return { error: { code: error.code ?? "TOOL_FAILED", message: error.message ?? String(error) } };
      }
      return { error: { code: "TOOL_FAILED", message: String(error?.message ?? error) } };
    }
  };
}

function renderError(v) {
  return toText(v?.error ? `失败 [${v.error.code}] ${v.error.message}` : v);
}

async function mustLoad(config, slug) {
  const project = await loadProject(config, slug);
  if (!project) {
    throw new PaperError("PROJECT_NOT_FOUND", `工程不存在：${slug}。先运行 paper_init。`);
  }
  return { project, paths: projectPaths(config, slug) };
}

/** 读 main.tex + 所有 outline 节文件。 */
export async function collectSources(paths, project) {
  const sources = [{ file: paths.main, text: await readText(paths.main, "") }];
  for (const section of project.outline) {
    const abs = join(paths.root, section.file);
    sources.push({ file: abs, text: await readText(abs, "") });
  }
  return sources;
}

/** 论文完成度与下一步建议。 */
export function computeStatus(project, audit, paths) {
  const todo = project.outline.filter((s) => s.status !== "done");
  const latestReview = project.review.at(-1) ?? null;
  const missing = audit?.missingInBib ?? [];
  const compilePassed = project.compile?.status === "passed";

  let nextAction;
  if (project.outline.length <= 1) {
    nextAction = "paper_outline：先确定 6–8 节 IMRaD 结构";
  } else if (project.citations.length < 3) {
    nextAction = "paper_bib_add：先至少入库 3 条真实文献（建议 6 条以上）";
  } else if (todo.length > 0) {
    nextAction = `paper_write_section：${todo[0].id}（${todo[0].title}）`;
  } else if (!compilePassed) {
    nextAction = "paper_compile：编译并修复 errors";
  } else if (missing.length > 0) {
    nextAction = `paper_cite_audit：补齐缺失引用 ${missing.slice(0, 5).join(", ")}`;
  } else if (!latestReview || latestReview.verdict !== "PASS") {
    nextAction = "paper_review：独立审稿并按 issues 修复";
  } else if (!project.export) {
    nextAction = "paper_export：导出 PDF 与 zip";
  } else {
    nextAction = "done：论文已完成（编译通过、引用齐全、审稿 PASS、已导出）";
  }

  return {
    slug: project.slug,
    title: project.title,
    lang: project.lang,
    root: paths.root,
    sections: project.outline.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      chars: s.chars,
      cites: s.cites,
      file: s.file,
    })),
    doneCount: project.outline.filter((s) => s.status === "done").length,
    totalCount: project.outline.length,
    citations: project.citations.length,
    compile: project.compile,
    review: latestReview ? { verdict: latestReview.verdict, at: latestReview.at, issues: latestReview.issues } : null,
    export: project.export,
    audit,
    nextAction,
  };
}

export function registerTools(ctx, deps) {
  const { config, getSubagents } = deps;
  const disposers = [];
  const register = (definition) => disposers.push(ctx.tools.register(definition));
  const bridge = createBridge(ctx);

  // ── paper_init ──────────────────────────────────────────────────────────
  register({
    name: "paper_init",
    description:
      "Create a paper project skeleton (main.tex with the right template, references.bib, sections/, figures/, .paper/project.json). "
      + "中文默认 ctexart + xelatex，英文默认 article + pdflatex。已存在的工程不会被覆盖。",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "目录名（可选；默认由 title 生成）" },
        title: { type: "string", description: "论文标题" },
        lang: { type: "string", enum: ["zh", "en"], description: "语言，默认 zh" },
        authors: { type: "array", items: { type: "string" }, description: "作者列表" },
        venue: { type: "string", description: "目标期刊/会议（可选）" },
      },
      required: ["title"],
    },
    timeoutMs: 30000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const slug = String(args.slug ?? "").trim() || slugify(args.title);
      const check = validateSlug(slug);
      if (!check.ok) throw new PaperError("INVALID_SLUG", check.reason);
      const authors = Array.isArray(args.authors)
        ? args.authors
        : typeof args.authors === "string" && args.authors.trim()
          ? [args.authors]
          : [];
      const { created, project, paths } = await createProject(config, {
        slug,
        title: args.title,
        lang: args.lang ?? "zh",
        authors,
        venue: args.venue ?? "",
      });
      return {
        created,
        slug: project.slug,
        root: paths.root,
        lang: project.lang,
        template: project.template,
        files: { main: paths.main, bib: paths.bib, state: paths.stateFile },
        next: created ? "paper_bib_add（先查文献）→ paper_outline" : "工程已存在，调用 paper_status 查看进度",
      };
    }),
  });

  // ── paper_outline ───────────────────────────────────────────────────────
  register({
    name: "paper_outline",
    description:
      "Write the section outline: creates sections/NN-id.tex files and rewrites main.tex's \\input order. "
      + "Keeps existing section text/status for ids that survive.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        sections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              id: { type: "string" },
              level: { type: "number", enum: [1, 2] },
            },
            required: ["title"],
          },
        },
      },
      required: ["slug", "sections"],
    },
    timeoutMs: 30000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const incoming = Array.isArray(args.sections) ? args.sections : [];
      if (incoming.length === 0) throw new PaperError("EMPTY_OUTLINE", "sections 不能为空");

      const previous = new Map(project.outline.map((s) => [s.id, s]));
      const used = new Set();
      const next = [];

      const hasAbstract = incoming.some((s) => String(s?.id ?? "") === "abstract" || /^(摘要|abstract)$/i.test(String(s?.title ?? "").trim()));
      if (!hasAbstract) {
        const kept = previous.get("abstract");
        next.push(kept ?? {
          id: "abstract",
          title: project.lang === "en" ? "Abstract" : "摘要",
          level: 1,
          file: join("sections", "00-abstract.tex"),
          status: "todo",
          chars: 0,
          cites: 0,
        });
        used.add("abstract");
      }

      for (const item of incoming) {
        const title = String(item?.title ?? "").trim();
        if (!title) continue;
        let id = String(item?.id ?? "").trim();
        if (id && used.has(id)) id = "";
        if (!id) {
          const preferred = /^(摘要|abstract)$/i.test(title) ? "abstract" : "";
          // 只有 abstract 尚未占用时才用它，否则退回自动编号，避免出现两个 abstract。
          id = preferred && !used.has(preferred) ? preferred : makeSectionId(title, next.length, used);
        }
        used.add(id);
        const kept = previous.get(id);
        next.push({
          id,
          title,
          level: item?.level === 2 ? 2 : 1,
          file: kept?.file ?? sectionFileName({ id }, next.length, paths),
          status: kept?.status ?? "todo",
          chars: kept?.chars ?? 0,
          cites: kept?.cites ?? 0,
        });
      }

      // 统一的文件路径编号（保留 abstract 为 00）
      next.forEach((section, index) => {
        section.file = join("sections", `${String(index).padStart(2, "0")}-${section.id}.tex`).replace(/\\/g, "/");
      });

      // 记录旧路径：顺序变化时把旧内容搬到新文件名，避免正文“消失”。
      const previousFiles = new Map(project.outline.map((s) => [s.id, s.file]));
      project.outline = next;
      for (const section of next) {
        const abs = join(paths.root, section.file);
        const existing = await readText(abs, "");
        if (existing) continue;
        const oldRelative = previousFiles.get(section.id);
        const oldText = oldRelative ? await readText(join(paths.root, oldRelative), "") : "";
        await writeFileAtomic(abs, oldText);
      }
      await writeFileAtomic(paths.main, renderMainTex(project));
      await writeJsonAtomic(paths.outlineFile, project.outline);
      appendHistory(project, "paper_outline", `${next.length} sections`);
      await saveProject(config, project);

      return {
        slug: project.slug,
        sections: project.outline,
        main: paths.main,
        next: "逐节 paper_write_section → paper_compile",
      };
    }),
  });

  // ── paper_write_section ─────────────────────────────────────────────────
  register({
    name: "paper_write_section",
    description:
      "Write or append body text of one section (atomic file write). Do not repeat the \\section heading inside the body. "
      + "Returns chars/cites and marks the section draft or done.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        section: { type: "string", description: "section id 或标题" },
        content: { type: "string", description: "正文（LaTeX 片段，不含 \\section 标题）" },
        mode: { type: "string", enum: ["replace", "append"], description: "默认 replace" },
        status: { type: "string", enum: ["draft", "done"], description: "写入后的状态，默认 done" },
      },
      required: ["slug", "section", "content"],
    },
    timeoutMs: 30000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const section = findSection(project, args.section);
      if (!section) {
        throw new PaperError(
          "SECTION_NOT_FOUND",
          `找不到节 "${args.section}"；现有：${project.outline.map((s) => s.id).join(", ")}`,
        );
      }
      const incoming = String(args.content ?? "");
      const existing = await readSectionText(paths, section);
      const content = args.mode === "append" && existing.trim()
        ? `${existing.replace(/\s+$/, "")}\n\n${incoming}`
        : incoming;

      const hasHeading = /\\section\*?\{/.test(content);
      await writeSectionText(paths, section, content);
      section.chars = countChars(content);
      section.cites = countCites(content);
      // append 空内容不应把已完成状态降级为 todo。
      if (incoming.trim()) section.status = args.status === "draft" ? "draft" : "done";
      else if (args.mode !== "append") section.status = "todo";
      appendHistory(project, "paper_write_section", `${section.id} ${section.chars} chars`);
      await saveProject(config, project);

      return {
        slug: project.slug,
        section: section.id,
        title: section.title,
        file: section.file,
        chars: section.chars,
        cites: section.cites,
        status: section.status,
        warning: hasHeading
          ? "正文里出现了 \\section{...}：标题已由 main.tex 生成，这里会重复。建议删除正文里的 \\section 标题。"
          : null,
        next: "paper_compile",
      };
    }),
  });

  // ── paper_bib_add ───────────────────────────────────────────────────────
  register({
    name: "paper_bib_add",
    description:
      "Add a real bibliography entry from arXiv (arxiv_id) or Crossref (doi); query mode only lists arXiv candidates. "
      + "Never fabricates entries: upstream failure or unknown id is an error and nothing is written.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        arxiv_id: { type: "string", description: "arXiv id，如 2401.00001" },
        doi: { type: "string", description: "DOI，如 10.1038/s41586-020-2649-2" },
        query: { type: "string", description: "arXiv 关键词搜索（只返回候选，不写入）" },
      },
      required: ["slug"],
    },
    timeoutMs: 60000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const options = {
        timeoutMs: config.bib.timeoutMs,
        userAgent: config.bib.userAgent,
        queryLimit: config.bib.queryLimit,
      };

      if (args.query && !args.arxiv_id && !args.doi) {
        const results = await searchArxiv(args.query, options);
        return {
          mode: "query",
          query: args.query,
          candidates: results,
          next: "从候选里选真实相关者，用 paper_bib_add(arxiv_id=...) 正式入库",
        };
      }

      let meta;
      if (args.arxiv_id) meta = await fetchArxivById(args.arxiv_id, options);
      else if (args.doi) meta = await fetchCrossrefByDoi(args.doi, options);
      else throw new PaperError("NO_IDENTIFIER", "需要 arxiv_id、doi 或 query 之一");

      const bibText = await readText(paths.bib, "");
      const fingerprints = bibFingerprints(bibText);
      const base = makeCitationKey(meta);
      const { key, duplicate } = uniqueKey(base, meta, fingerprints);

      let bibBytes = Buffer.byteLength(bibText, "utf8");
      if (!duplicate) {
        const nextBib = appendBibtex(bibText, toBibtex(meta, key));
        await writeFileAtomic(paths.bib, nextBib);
        bibBytes = Buffer.byteLength(nextBib, "utf8");
      }

      const sources = await readJson(paths.bibSourcesFile, {});
      sources[key] = {
        kind: meta.kind,
        arxivId: meta.arxivId ?? "",
        doi: meta.doi ?? "",
        title: meta.title,
        year: meta.year ?? "",
        urls: meta.url ? [meta.url] : [],
        fetchedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(paths.bibSourcesFile, sources);

      if (!project.citations.includes(key)) project.citations.push(key);
      appendHistory(project, "paper_bib_add", `${key} (${meta.kind})`);
      await saveProject(config, project);

      return {
        mode: "added",
        key,
        duplicate,
        title: meta.title,
        authors: meta.authors ?? [],
        year: meta.year ?? "",
        journal: meta.journal ?? "",
        doi: meta.doi ?? "",
        arxivId: meta.arxivId ?? "",
        bibBytes,
        cite: `\\cite{${key}}`,
        next: duplicate ? "该条目已在 bib 中，直接引用" : "继续补文献或 paper_outline",
      };
    }),
  });

  // ── paper_compile ───────────────────────────────────────────────────────
  register({
    name: "paper_compile",
    description:
      "Compile main.tex with the native engine sequence (engine → bibtex/biber → engine), auto-detecting ctex/xeCJK → xelatex. "
      + "Returns structured errors, warnings, undefined citations, PDF size and a log tail.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        entry: { type: "string", description: "入口文件，默认 main.tex" },
        engine: { type: "string", enum: ["auto", "xelatex", "pdflatex", "lualatex"] },
      },
      required: ["slug"],
    },
    timeoutMs: 300000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const entry = String(args.entry ?? "main.tex").trim() || "main.tex";
      const sources = await collectSources(paths, project);
      const requested = args.engine && args.engine !== "auto" ? args.engine : config.latex.engine;
      const engine = await detectEngine(
        paths.root,
        entry,
        sources.map((s) => s.text),
        requested,
      );
      const result = await compileProject({
        root: paths.root,
        entry,
        engine,
        latexmk: config.latex.latexmk,
        timeoutMs: config.latex.timeoutMs,
      });
      project.compile = {
        status: result.status,
        engine: result.engine,
        at: new Date().toISOString(),
        errors: result.errors.length,
        warnings: result.warnings.length,
        pdfBytes: result.pdfBytes,
        durationMs: result.durationMs,
      };
      appendHistory(project, "paper_compile", `${result.status} (${result.errors.length} errors)`);
      await saveProject(config, project);
      return result;
    }),
  });

  // ── paper_cite_audit ────────────────────────────────────────────────────
  register({
    name: "paper_cite_audit",
    description:
      "Compare \\cite-family keys in main.tex + sections against references.bib. Reports missing keys, uncited entries and duplicate keys.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
    timeoutMs: 30000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const sources = await collectSources(paths, project);
      const bib = await readText(paths.bib, "");
      const audit = auditCitations(sources.map((s) => s.text), bib);
      project.citations = Object.keys(audit.perKey);
      appendHistory(project, "paper_cite_audit", `missing=${audit.missingInBib.length}`);
      await saveProject(config, project);
      return {
        ...audit,
        next: audit.missingInBib.length
          ? `补齐缺失条目：${audit.missingInBib.join(", ")}`
          : audit.uncited.length
            ? "缺失为 0；未引用条目可保留或补充引用"
            : "引用完整",
      };
    }),
  });

  // ── paper_status ────────────────────────────────────────────────────────
  register({
    name: "paper_status",
    description:
      "Report project progress: per-section status/chars/cites, citation audit summary, last compile, last review, and a concrete nextAction.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
    timeoutMs: 30000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const sources = await collectSources(paths, project);
      const bib = await readText(paths.bib, "");
      const audit = auditCitations(sources.map((s) => s.text), bib);
      return computeStatus(project, audit, paths);
    }),
  });

  // ── paper_review ────────────────────────────────────────────────────────
  register({
    name: "paper_review",
    description:
      "Run one independent fresh-subagent review over the paper files (never the author's summary). "
      + "Returns PASS/WARN/FAIL with issues and an academic-integrity check.",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        scope: { type: "string", description: "评审范围描述，默认整篇论文" },
        provider: { type: "string", description: "subagent provider，默认配置值" },
      },
      required: ["slug"],
    },
    timeoutMs: 900000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args, exec) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const sources = await collectSources(paths, project);
      const files = sources.map((s) => s.file).concat([paths.bib]);
      const scope = String(args.scope ?? "").trim() || "整篇论文（结构、论证、引用与数据来源）";
      const reviewConfig = { ...config, reviewer: { ...config.reviewer, provider: args.provider || config.reviewer.provider } };
      let subagents = null;
      try {
        subagents = typeof getSubagents === "function" ? getSubagents() : (ctx.subagents ?? null);
      } catch {
        subagents = null;
      }
      const round = await reviewProject({ subagents }, {
        config: reviewConfig,
        project,
        paths,
        files,
        scope,
        parent: exec?.agent,
        signal: exec?.signal,
      });
      project.review.push({
        at: round.at,
        verdict: round.verdict,
        issues: round.issues.length,
        scope,
      });
      appendHistory(project, "paper_review", round.verdict);
      await saveProject(config, project);
      return {
        ...round,
        rendered: renderVerdict(round),
        next: round.verdict === "PASS"
          ? "paper_export"
          : "按 issues 修改对应节，重新 paper_compile 后再 paper_review",
      };
    }),
  });

  // ── paper_export ────────────────────────────────────────────────────────
  register({
    name: "paper_export",
    description: "Copy PDF/tex/bib/sections/figures/project state into dist/<slug>-<timestamp>/ and zip it.",
    parameters: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
    timeoutMs: 180000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const result = await exportProject({ paths, project, zip: config.export.zip });
      project.export = {
        at: result.exportedAt,
        distDir: result.distDir,
        zipPath: result.zipPath,
        pdfBytes: result.pdfBytes,
      };
      appendHistory(project, "paper_export", result.distDir);
      await saveProject(config, project);
      return result;
    }),
  });

  // ── paper_zotero_sync ───────────────────────────────────────────────────
  register({
    name: "paper_zotero_sync",
    description:
      "把 references.bib 里的每条文献（DOI）通过 dsh-zotero-paperbridge 保存到 Zotero。"
      + "目标集合不存在时可传 create_collection=true 新建（必须先由用户确认，再传 confirmed=true）；"
      + "本地模式下若目标集合未被选中，会保存到当前集合并把条目归入目标集合（assign，默认 true）。",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        collection: { type: "string", description: "目标集合名，默认论文标题" },
        create_collection: { type: "boolean", description: "目标集合不存在时是否新建（需 confirmed=true）" },
        confirmed: { type: "boolean", description: "用户已明确同意新建集合" },
        assign: { type: "boolean", description: "本地模式下把条目归入目标集合（默认 true）" },
        force: { type: "boolean", description: "目标集合无法就绪时也保存到当前集合（默认 false）" },
        dry_run: { type: "boolean", description: "只检查目标与文献清单，不写入" },
      },
      required: ["slug"],
    },
    timeoutMs: 600000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args, exec) => {
      const { project, paths } = await mustLoad(config, args.slug);
      const entries = parseBibEntries(await readText(paths.bib, ""));
      const dois = [...new Set(entries.map((e) => e.doi).filter(Boolean))];
      if (dois.length === 0) {
        throw new PaperError("NO_DOIS", "references.bib 里没有可用 DOI；请先用 paper_bib_add 写入真实文献。");
      }
      for (const needed of ["zotero_status", "zotero_collections", "zotero_save"]) {
        if (!bridge.has(needed)) {
          throw new PaperError(
            "ZOTERO_UNAVAILABLE",
            `未检测到 dsh-zotero-paperbridge 的 ${needed} 工具：请在 profile 中启用该插件。`,
          );
        }
      }

      const status = await bridge.callOk("zotero_status", {}, exec);
      const collections = await bridge.callOk("zotero_collections", {}, exec);
      const list = Array.isArray(collections.collections) ? collections.collections : [];
      const targetName = String(args.collection ?? "").trim() || project.title;
      const normalize = (value) => String(value ?? "").trim().toLowerCase();
      const match =
        list.find((c) => normalize(c.name) === normalize(targetName)) ??
        list.find(
          (c) => normalize(c.name).includes(normalize(targetName))
            || normalize(targetName).includes(normalize(c.name)),
        ) ??
        null;
      const selected = status.selected ?? {};
      const backend = status.backend ?? "local";
      const selectedName = selected.name ?? "";
      let target = match ? { key: match.key, name: match.name } : null;

      const zoteroCfg = config.zotero ?? {
        localBaseUrl: "http://localhost:23119",
        localApiKeyRef: "ZOTERO_LOCAL_API_KEY",
        timeoutMs: 30000,
      };
      const localKey = backend === "local" ? await resolveLocalKey(zoteroCfg.localApiKeyRef) : "";
      const localClient = backend === "local"
        ? createZoteroLocal({
          baseUrl: zoteroCfg.localBaseUrl,
          key: localKey,
          timeoutMs: zoteroCfg.timeoutMs,
        })
        : null;

      let decision;
      if (target && normalize(selectedName) === normalize(target.name)) decision = "save";
      else if (target) decision = args.assign === false ? "need_selection" : "save_then_assign";
      else decision = "need_collection";

      if (args.dry_run) {
        return {
          dryRun: true,
          backend,
          targetName,
          target,
          selected: { name: selectedName, expectedTarget: selected.expectedTarget },
          decision,
          canCreate: Boolean(args.create_collection),
          dois,
        };
      }

      // 目标集合不存在：允许请求创建，但必须由用户确认（confirmed=true）。
      if (!target && args.create_collection) {
        if (!args.confirmed) {
          return {
            ok: false,
            decision: "confirm_create",
            backend,
            collectionName: targetName,
            existingCollections: list.map((c) => c.name),
            total: dois.length,
            hint: `将在 Zotero 新建集合「${targetName}」并把 ${dois.length} 条文献归入。这是对 Zotero 文库的写操作，请联系用户确认后再传 confirmed=true 调用。`,
          };
        }
        target = await localClient.createCollection(targetName, { confirmed: true });
        decision = "create_then_assign";
      }

      if (decision !== "save" && !args.force && decision !== "save_then_assign" && decision !== "create_then_assign") {
        return {
          ok: false,
          decision,
          backend,
          targetName,
          target,
          selected: { name: selectedName, expectedTarget: selected.expectedTarget },
          existingCollections: list.map((c) => c.name),
          saved: 0,
          hint:
            decision === "need_collection"
              ? `Zotero 里还没有集合「${targetName}」。可传 create_collection=true 并在用户确认后传 confirmed=true 自动新建；或先在 Zotero 左侧栏新建集合并选中后重跑；或传 force=true 先存入当前集合「${selectedName}」。`
              : `集合「${target?.name}」已存在但未被选中。可传 assign=true（默认）保存到当前集合并归入目标集合；或传 force=true 先存入当前集合「${selectedName}」。`,
        };
      }

      const chunks = [];
      for (let i = 0; i < dois.length; i += 20) chunks.push(dois.slice(i, i + 20));
      const responses = [];
      // 本地模式没有 selected.key；用集合列表按名字反查，才能让插件的 targetVerified 成立。
      const selectedKey = backend === "local"
        ? list.find((c) => normalize(c.name) === normalize(selectedName))?.key ?? null
        : null;
      for (const chunk of chunks) {
        const payload = { identifiers: chunk, tags: ["paperforge", project.slug] };
        if (backend === "local") {
          payload.expectedTarget = selected.expectedTarget;
          if (selectedKey) payload.expectedCollectionKey = selectedKey;
        } else if (target) {
          payload.collectionKeys = [target.key];
        }
        responses.push(await bridge.callOk("zotero_save", payload, exec));
      }

      const flat = responses.flatMap((r) => (Array.isArray(r.results) ? r.results : []));
      const saved = flat.filter((x) => x.status === "saved").length;
      const duplicates = flat.filter((x) => x.status === "duplicate").length;
      const failed = flat.filter((x) => !["saved", "duplicate"].includes(x.status)).length;

      // 本地模式：新建集合或目标未被选中时，把条目补进目标集合。
      let assigned = null;
      if (backend === "local" && target && decision !== "save") {
        const itemKeys = [...new Set(flat.map((x) => x.item?.key ?? x.existing?.key).filter(Boolean))];
        const titleHints = {};
        for (const x of flat) {
          const k = x.item?.key ?? x.existing?.key;
          if (k && x.paper?.title) titleHints[k] = x.paper.title;
        }
        if (!localKey) {
          assigned = { requested: itemKeys.length, updated: 0, already: 0, failed: [], skipped: `缺少 ${zoteroCfg.localApiKeyRef}：未执行集合归入` };
        } else {
          const result = await localClient.assignItems(itemKeys, target.key, { titleHints });
          assigned = {
            requested: itemKeys.length,
            updated: result.updated.length,
            already: result.updated.filter((u) => u.already).length,
            failed: result.failed,
          };
        }
      }

      project.zotero = {
        at: new Date().toISOString(),
        backend,
        target: target ? target.name : selectedName,
        targetKey: target?.key ?? null,
        created: decision === "create_then_assign",
        coerced: decision !== "save" && decision !== "create_then_assign",
        total: dois.length,
        saved,
        duplicates,
        failed,
        assigned,
      };
      appendHistory(project, "paper_zotero_sync", `${saved} saved / ${duplicates} dup / ${failed} failed`);
      await saveProject(config, project);

      return {
        backend,
        target: project.zotero.target,
        targetKey: project.zotero.targetKey,
        created: project.zotero.created,
        coerced: project.zotero.coerced,
        warning: decision === "save_then_assign"
          ? `目标集合「${target.name}」不是当前选中集合：已保存到当前集合并归入目标集合。`
          : decision !== "save" && decision !== "create_then_assign"
            ? `目标集合「${targetName}」未就绪，已按 force 存入当前集合「${selectedName}」。`
            : null,
        total: dois.length,
        saved,
        duplicates,
        failed,
        assigned,
        results: flat.map((x) => ({
          status: x.status,
          title: x.paper?.title ?? "",
          doi: x.paper?.doi ?? "",
          warning: x.warning ?? null,
        })),
        next: failed > 0 || (assigned?.failed?.length ?? 0) > 0
          ? "检查 failed 条目或集合归属失败项；用 zotero_library_search 复核后再重跑"
          : "Zotero 归档完成",
      };
    }),
  });

  // ── paper_obsidian_archive ─────────────────────────────────────────────
  register({
    name: "paper_obsidian_archive",
    description:
      "把论文使用的数据、工具、算法与结果解释整理成一组 Markdown 笔记，通过 dsh-obsidian-vaultbridge 写入 Obsidian 的新目录"
      + "（默认 Paperforge/<slug>/）。包含：总览、数据与来源、工具与方法、结果与图表、复现与审计。",
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string" },
        dir: { type: "string", description: "Obsidian 目录，默认 Paperforge/<slug>" },
        mode: { type: "string", enum: ["replace", "create", "append"], description: "默认 replace（生成物覆盖）" },
        notes: {
          type: "object",
          description: "作者补充的解释（可选）：summary / dataSources / methods / results / limitations",
          properties: {
            summary: { type: "string" },
            dataSources: { type: "string" },
            methods: { type: "string" },
            results: { type: "string" },
            limitations: { type: "string" },
          },
        },
      },
      required: ["slug"],
    },
    timeoutMs: 180000,
    output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => renderError(v) },
    execute: wrap(async (args, exec) => {
      const { project, paths } = await mustLoad(config, args.slug);
      if (!bridge.has("obsidian_write")) {
        throw new PaperError(
          "OBSIDIAN_UNAVAILABLE",
          "未检测到 dsh-obsidian-vaultbridge 的 obsidian_write 工具：请在 profile 中启用该插件。",
        );
      }
      const inputs = await loadArchiveInputs(paths, project);
      const dir = String(args.dir ?? "").trim().replace(/^\/+|\/+$/g, "") || `Paperforge/${project.slug}`;
      const mode = ["replace", "create", "append"].includes(args.mode) ? args.mode : "replace";
      const docs = buildArchiveNotes({ project, paths, inputs, notes: args.notes ?? {} });
      const written = [];

      for (const doc of docs) {
        const path = `${dir}/${doc.name}`;
        let payload;
        if (mode === "create") {
          payload = { path, content: doc.content, mode: "create" };
        } else if (mode === "append") {
          payload = {
            path,
            content: `\n\n---\n\n## 更新 ${new Date().toISOString()}\n\n${doc.content}`,
            mode: "append",
          };
        } else {
          let sha = null;
          try {
            const existing = await bridge.callOk("obsidian_read", { path }, exec);
            sha = existing?.sha256 ?? null;
          } catch {
            /* 目标不存在 → 走 create */
          }
          payload = sha
            ? { path, content: doc.content, mode: "replace", expectedSha256: sha }
            : { path, content: doc.content, mode: "create" };
        }
        const result = await bridge.callOk("obsidian_write", payload, exec);
        written.push({
          path,
          mode: result?.mode ?? payload.mode,
          sha256: result?.sha256 ?? null,
          chars: doc.content.length,
        });
      }

      project.obsidian = { at: new Date().toISOString(), dir, files: written.map((w) => w.path) };
      appendHistory(project, "paper_obsidian_archive", `${written.length} notes -> ${dir}`);
      await saveProject(config, project);

      return {
        dir,
        mode,
        count: written.length,
        files: written,
        next: `在 Obsidian 打开 ${dir}/ 检查内容；可用 notes 参数补充作者解释后重跑`,
      };
    }),
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* 已释放 */
      }
    }
  };
}
