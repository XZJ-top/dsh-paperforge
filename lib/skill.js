/**
 * 内置 skill：paper-writing。
 *
 * 这是 agent 在自主模式下唯一需要先读的「操作规程」：它把工具顺序、
 * 每节目标、学术诚信红线、常见编译错误修复写成可执行清单。
 */
export const PAPER_WRITING_SKILL = {
  name: "paper-writing",
  description:
    "端到端完成一篇论文：paper_* 工具的顺序、IMRaD 各节目标、真实文献与数据纪律、LaTeX 编译修错。",
  whenToUse:
    "当用户要求写论文、写综述、把研究结果整理成稿件，或使用 /paper-auto、/paper-init、/paper-write 命令时。",
  content: `# paper-writing：用 paper_* 工具端到端完成论文

## 0. 五条红线（违反即返工）

1. **不编造数据**：结果里的每个数字必须来自工具输出、用户提供的文件或可复现的公开数据。没有数据就写方法/综述型论文，并在正文明确声明"本文为方法/综述型工作，未产生新的实验数据"。
2. **不编造引用**：只能通过 \`paper_bib_add\` 写入 arXiv/Crossref 真实返回的条目；禁止手写 .bib、禁止猜 DOI/arXiv id、禁止引用没读过的文献来凑数。
3. **不虚构结论**：摘要与引言承诺的内容必须在正文兑现；讨论部分的局限必须真实。
4. **中文论文用 ctexart + xelatex**（\`paper_init(lang="zh")\` 默认如此），英文用 article + pdflatex。
5. **每写完一节就编译**；编译失败先修错误，不要继续堆正文。

## 1. 标准流程（严格按序）

\`\`\`
paper_init(slug?, title, lang?, authors?)
  → paper_bib_add ×N（N ≥ 6；先用 query 模式找候选，再用 arxiv_id/doi 正式入库）
  → paper_outline(sections = 摘要/引言/方法/结果/讨论/结论)
  → 逐节：paper_write_section → paper_compile →（失败则修）→ 重编译
  → paper_cite_audit（missingInBib 必须为空）
  → paper_review（WARN/FAIL 则按 issues 修，重跑直到 PASS）
  → paper_export
\`\`\`

## 2. 各节目标

| 节 | 目标 | 常见错误 |
|---|---|---|
| 摘要 abstract | 背景 1 句、方法 1–2 句、主要结果 2–3 句（有数字）、结论 1 句；中文 ≤300 字 | 写成引言；给没有正文支撑的数字 |
| 引言 introduction | 问题重要性 → 已有工作与缺口（引用真实文献）→ 本文贡献（3 条以内） | 只罗列文献不指缺口；贡献与正文不符 |
| 方法 methods | 数据来源、处理步骤、参数、软件版本、统计方法；可复现 | 漏数据来源；漏版本号；步骤无法复现 |
| 结果 results | 只报告观察到的结果，对应图表，给出量化与不确定性 | 把讨论写进结果；无来源数字 |
| 讨论 discussion | 解释结果、与已有工作对比、局限、未来工作 | 重复结果；回避局限 |
| 结论 conclusion | 2–4 句，回答引言提出的问题 | 引入新结果 |

## 3. 工具用法要点

- \`paper_init\`：已存在的工程不会被覆盖；返回 \`created:false\` 时先 \`paper_status\` 看现状。
- \`paper_outline\`：section 文件只写**正文**，不要重复写 \`\\section{...}\`（标题由 main.tex 生成）。
- \`paper_write_section\`：\`section\` 可传 id（如 \`introduction\`）或标题；\`mode:"append"\` 追加，默认替换；写完默认标记 done。
- \`paper_bib_add\`：
  - 先 \`query:"关键词"\` 拿候选（只返回列表，不写文件）；
  - 再 \`arxiv_id:"2401.00001"\` 或 \`doi:"10.xxxx/yyy"\` 正式入库；
  - 返回的 \`key\` 是正文里 \`\\cite{key}\` 要用的唯一标识。
- \`paper_compile\`：返回 \`errors\`（含行号/上下文）、\`undefinedCitations\`、\`pdfBytes\`；\`status:"passed"\` 才算通过。
- \`paper_cite_audit\`：\`missingInBib\` 非空 = 编译一定出问号引用，必须先补；\`uncited\` 可接受但要说明。
- \`paper_status\`：看 \`nextAction\` 决定下一步。
- \`paper_review\`：独立审稿子代理；它会真的读文件，专门抓编造引用与无来源数字。
- \`paper_export\`：产出 \`dist/<slug>-<时间>/\` 与 zip。

## 4. 编译错误速查

| 报错 | 修复 |
|---|---|
| \`! Undefined control sequence.\` | 命令拼错，或缺少宏包；检查是否把中文标点写进命令名 |
| \`! Missing $ inserted.\` | 正文里的 \`_\` \`^\` \`&\` \`%\` \`#\` 未转义；改用 \`\\_\`、\`\\%\` 等 |
| \`! LaTeX Error: File 'xxx.sty' not found.\` | 换用已装宏包（amsmath/graphicx/booktabs/hyperref/ctex/gbt7714） |
| \`Citation 'k' undefined\` | 该 key 不在 references.bib；用 \`paper_bib_add\` 补，或 \`paper_cite_audit\` 查 |
| \`Reference 'fig:x' undefined\` | 图/表没写 \`\\label\`，或需要二次编译 |
| 中文乱码/缺字 | 引擎不是 xelatex；\`paper_compile(engine="xelatex")\` |

## 5. 图表与统计

- 图放 \`figures/\`，正文用 \`\\includegraphics[width=0.8\\linewidth]{figures/xxx}\` + \`\\caption{}\` + \`\\label{fig:xxx}\`，并在正文 \`\\ref{fig:xxx}\`。
- 表用 \`booktabs\`（\`\\toprule/\\midrule/\\bottomrule\`）。
- 报告统计时给出检验名、统计量、p 值、样本量；不要只写"显著"。

## 6. 归档（Zotero + Obsidian）

论文定稿后有两步归档，分别通过已装的 \`dsh-zotero-paperbridge\` 与 \`dsh-obsidian-vaultbridge\` 完成：

- \`paper_zotero_sync(slug, ...)\`：把 \`references.bib\` 里每条文献按 DOI 存进 Zotero，标签为 \`paperforge\` + slug。
  - 目标集合不存在时：**先问用户**是否新建；用户同意后再传 \`create_collection=true, confirmed=true\`（插件用本地授权 key 建集合并把条目归入）。未确认时返回 \`confirm_create\`，不要自行假定同意。
  - 目标集合已存在但未被选中：默认 \`assign=true\`，保存到当前集合并把条目归入目标集合。
  - \`force=true\` 可在目标不可用时先存入当前集合；\`dry_run=true\` 只检查目标。
  - 本地授权 key 存在 DSH 凭据 \`ZOTERO_LOCAL_API_KEY\`（一次性 \`POST /api/local/authorize\` 弹窗确认后写入）。
- \`paper_obsidian_archive(slug, notes?)\`：在 Obsidian 生成 \`Paperforge/<slug>/\` 目录与 5 篇笔记：\`00-总览\`、\`01-数据与来源\`、\`02-工具与方法\`、\`03-结果与图表\`、\`04-复现与审计\`。
  - \`notes\` 可传 \`{summary, dataSources, methods, results, limitations}\`，把你的解释写进去。
- \`/paper-archive [slug] [--force]\`：一次跑完两步。

## 7. 自主模式（/paper-auto）

收到该命令后：
1. 先 \`create_goal\` 登记目标（写清验收条件），最后 \`update_goal complete\`；
2. 按第 1 节流程连续执行，**不要等用户确认**；
3. 每步用工具返回的 \`nextAction\` 自检；
4. 全部满足（编译 passed、引用 0 missing、审稿 PASS、已导出、已归档）才结束；
5. 任何一步失败，先修；修不动就在最终回复里如实说明卡在哪里，不要假装完成。
`,
};
