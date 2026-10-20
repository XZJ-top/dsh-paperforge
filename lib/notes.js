/**
 * 论文归档笔记：把「用了什么数据、什么工具、怎么算」写成 Obsidian 笔记。
 *
 * 输入是 project.json、references.bib、.paper/bib-sources.json、
 * .paper/analysis.json（可选）与编译/审计结果；输出 5 篇 Markdown。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./fsutil.js";
import { parseBibEntries } from "./audit.js";

function fmt(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(digits);
  return String(value);
}

function mdTable(headers, rows) {
  const line = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  return [line, sep, ...rows.map((row) => `| ${row.map((cell) => String(cell ?? "").replace(/\|/g, "\\|")).join(" | ")} |`)].join("\n");
}

function frontmatter(title, tags) {
  return [
    "---",
    `title: "${String(title).replace(/"/g, '\\"')}"`,
    `created: ${new Date().toISOString()}`,
    `tags: [${tags.map((t) => `"${t}"`).join(", ")}]`,
    "generator: dsh-paperforge",
    "---",
    "",
  ].join("\n");
}

/** 读取可选的中间结果。 */
export async function loadArchiveInputs(paths, project) {
  const bib = await readFile(paths.bib, "utf8").catch(() => "");
  const sources = await readJson(paths.bibSourcesFile, {});
  const analysis = await readJson(join(paths.stateDir, "analysis.json"), null);
  const audit = await readJson(join(paths.stateDir, "audit.json"), null);
  return { bib, sources, analysis, audit };
}

/**
 * 生成 5 篇笔记。
 * @param {object} options
 * @param {object} options.project
 * @param {object} options.paths
 * @param {object} options.inputs loadArchiveInputs() 的结果
 * @param {object} [options.notes] 调用方补充的解释（summary/dataSources/methods/limitations）
 */
export function buildArchiveNotes({ project, paths, inputs, notes = {} }) {
  const entries = parseBibEntries(inputs.bib);
  const analysis = inputs.analysis;
  const compiled = project.compile;
  const now = new Date().toISOString();
  const zh = project.lang !== "en";

  const overview = [
    frontmatter(`${project.title} — 总览`, ["paperforge", "论文归档"]),
    `# ${project.title}`,
    "",
    `- 工程：\`${project.slug}\``,
    `- 目录：\`${paths.root}\``,
    `- 语言：${zh ? "中文（ctexart + xelatex）" : "英文（article + pdflatex）"}`,
    `- 章节：${project.outline.length} 节，完成 ${project.outline.filter((s) => s.status === "done").length} 节`,
    `- 文献：${entries.length} 条（全部来自 arXiv/Crossref 真实元数据）`,
    `- 编译：${compiled ? `${compiled.status}（${compiled.engine}，PDF ${fmt(compiled.pdfBytes)} 字节）` : "尚未编译"}`,
    `- 审稿：${project.review?.at(-1) ? `${project.review.at(-1).verdict}（${project.review.at(-1).issues} issues）` : "尚未审稿"}`,
    `- 导出：${project.export?.distDir ? `\`${project.export.distDir}\`` : "尚未导出"}`,
    `- 归档时间：${now}`,
    "",
    notes.summary ? `## 作者补充\n\n${notes.summary}\n` : "",
    "## 章节清单",
    "",
    mdTable(
      ["节", "标题", "状态", "字数", "引用"],
      project.outline.map((s) => [s.id, s.title, s.status, s.chars, s.cites]),
    ),
  ]
    .filter(Boolean)
    .join("\n");

  const dataRows = entries.map((e) => [
    e.key,
    e.type,
    e.year || "—",
    e.doi || "—",
    e.eprint || "—",
  ]);
  const sourceRows = Object.entries(inputs.sources).map(([key, s]) => [
    key,
    s.kind,
    s.arxivId || "—",
    s.doi || "—",
    s.fetchedAt || "—",
  ]);

  const data = [
    frontmatter(`${project.title} — 数据与来源`, ["paperforge", "数据来源"]),
    `# 数据与来源`,
    "",
    notes.dataSources
      ? `## 作者说明\n\n${notes.dataSources}\n`
      : "## 作者说明\n\n（未提供补充说明；以下为工程内可自动核对的信息。）\n",
    "## 文献来源（references.bib）",
    "",
    dataRows.length
      ? mdTable(["key", "类型", "年份", "DOI", "arXiv"], dataRows)
      : "（暂无文献）",
    "",
    "## 抓取记录（.paper/bib-sources.json）",
    "",
    sourceRows.length
      ? mdTable(["key", "来源", "arXiv", "DOI", "抓取时间"], sourceRows)
      : "（暂无抓取记录；若手工编辑过 .bib，请在此补充来源）",
    "",
    "## 数据集",
    "",
    analysis
      ? [
        `- 主数据：\`${analysis.accession ?? "未记录"}\`（${fmt(analysis.genome_len)} bp，${fmt(analysis.n_genes)} 个基因）`,
        `- 派生结果：\`.paper/analysis.json\`（与本文数字一一对应）`,
        "- 获取方式：见「工具与方法」中的下载/解析步骤",
      ].join("\n")
      : "（本工程未记录结构化数据集；若使用了外部数据，请在此补充 accession、版本与获取日期。）",
  ].join("\n");

  const methods = [
    frontmatter(`${project.title} — 工具与方法`, ["paperforge", "方法"]),
    `# 工具与方法`,
    "",
    notes.methods ? `${notes.methods}\n` : "",
    "## 运行环境",
    "",
    mdTable(
      ["项", "值"],
      [
        ["DSH", "0.2.1-rc.2（desktop profile）"],
        ["dsh-paperforge", "0.1.0"],
        ["LaTeX", "MiKTeX / latexmk 4.88（本工程使用 " + (compiled?.engine ?? "xelatex") + "）"],
        ["文档类", project.template],
        ["Python", "Biopython + NumPy + SciPy（数据分析）"],
      ],
    ),
    "",
    "## 计算口径",
    "",
    "- GC3s：第三位密码子中 G/C 的比例。",
    "- ENC：Wright 同义密码子家族法（F 统计量按家族大小 2/3/4/6 取平均，上限 61）。",
    "- RSCU：某密码子观测数 × 家族大小 ÷ 家族总观测数；=1 无偏好。",
    "",
    analysis
      ? mdTable(
        ["参数", "值"],
        [
          ["遗传密码表", fmt(analysis.codon_table_id)],
          ["密码子总数", fmt(analysis.n_codons_total)],
          ["基因数", fmt(analysis.n_genes)],
          ["统计方法", "Pearson / Spearman（双侧 p 值）"],
        ],
      )
      : "（未检测到结构化参数文件。）",
    "",
    "## 文件与脚本",
    "",
    `- 论文源文件：\`${paths.main}\``,
    `- 分节文件：\`${paths.sectionsDir}\``,
    `- 文献库：\`${paths.bib}\``,
    `- 分析结果：\`.paper/analysis.json\``,
    `- 引用审计：\`.paper/audit.json\``,
    `- 编译日志：\`${paths.logsDir}\` 与主目录 \`main.log\``,
  ].join("\n");

  const results = [
    frontmatter(`${project.title} — 结果与图表`, ["paperforge", "结果"]),
    `# 结果与图表`,
    "",
    notes.results ? `${notes.results}\n` : "",
    analysis?.genes?.length
      ? mdTable(
        ["基因", "长度(nt)", "密码子数", "GC(%)", "GC3s(%)", "ENC"],
        analysis.genes.map((g) => [g.gene, g.nt, g.codons, fmt(g.gc), fmt(g.gc3s), fmt(g.enc)]),
      )
      : "（未检测到逐基因结果表。）",
    "",
    analysis
      ? [
        "## 汇总统计",
        "",
        mdTable(
          ["指标", "值"],
          [
            ["ENC 均值 ± SD", `${fmt(analysis.enc_mean)} ± ${fmt(analysis.enc_sd)}`],
            ["GC3s 均值 ± SD", `${fmt(analysis.gc3s_mean)}% ± ${fmt(analysis.gc3s_sd)}%`],
            ["Pearson r / p", `${fmt(analysis.pearson_r, 3)} / ${fmt(analysis.pearson_p, 4)}`],
            ["Spearman ρ / p", `${fmt(analysis.spearman_rho, 3)} / ${fmt(analysis.spearman_p, 4)}`],
            ["第三位碱基组成", Object.entries(analysis.third_position_pct ?? {}).map(([b, v]) => `${b} ${fmt(v)}%`).join("，")],
          ],
        ),
        "",
        analysis.top_rscu?.length
          ? `**高 RSCU**：${analysis.top_rscu.slice(0, 8).map((x) => `${x.codon} ${fmt(x.rscu, 3)}`).join("，")}`
          : "",
        analysis.low_rscu?.length
          ? `**低 RSCU**：${analysis.low_rscu.slice(0, 6).map((x) => `${x.codon} ${fmt(x.rscu, 3)}`).join("，")}`
          : "",
      ].join("\n")
      : "",
    "",
    "## 图",
    "",
    "![[fig1-gc3s-enc.png]]",
    "",
    "![[fig2-rscu.png]]",
    "",
    "（图片位于工程 `figures/`；在 Obsidian 中若未显示，请把 `figures/` 同步到 vault 或用附件链接。）",
  ].join("\n");

  const reproduce = [
    frontmatter(`${project.title} — 复现与审计`, ["paperforge", "复现"]),
    `# 复现与审计`,
    "",
    "## 复现命令",
    "",
    "```bash",
    `# 编译`,
    `paper_compile(slug="${project.slug}")`,
    "",
    `# 引用审计`,
    `paper_cite_audit(slug="${project.slug}")`,
    "",
    `# 独立审稿`,
    `paper_review(slug="${project.slug}")`,
    "",
    `# 导出`,
    `paper_export(slug="${project.slug}")`,
    "```",
    "",
    "## 本次审计",
    "",
    inputs.audit
      ? mdTable(
        ["项", "值"],
        [
          ["正文引用次数", fmt(inputs.audit.citationCount)],
          ["唯一引用 key", fmt(inputs.audit.uniqueCitationCount)],
          ["bib 条目", fmt(inputs.audit.bibEntryCount)],
          ["缺失（missingInBib）", inputs.audit.missingInBib?.length ? inputs.audit.missingInBib.join(", ") : "0"],
          ["未引用（uncited）", inputs.audit.uncited?.length ? inputs.audit.uncited.join(", ") : "0"],
          ["重复 key", inputs.audit.duplicateKeys?.length ? inputs.audit.duplicateKeys.join(", ") : "0"],
        ],
      )
      : "（尚未运行 paper_cite_audit。）",
    "",
    "## 产物",
    "",
    `- PDF：\`${join(paths.root, "main.pdf")}\``,
    `- 导出目录：\`${project.export?.distDir ?? "尚未导出"}\``,
    `- 归档笔记目录：由 paper_obsidian_archive 指定`,
    "",
    notes.limitations ? `## 局限\n\n${notes.limitations}\n` : "",
  ].join("\n");

  return [
    { name: "00-总览.md", content: overview },
    { name: "01-数据与来源.md", content: data },
    { name: "02-工具与方法.md", content: methods },
    { name: "03-结果与图表.md", content: results },
    { name: "04-复现与审计.md", content: reproduce },
  ];
}
