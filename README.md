# dsh-paperforge

让 DSH 自主完成一篇完整论文的本地插件：真实文献 → 大纲 → 分节写作 → LaTeX 编译修错 → 引用审计 → 独立审稿 → 导出 PDF。

## 能力

**11 个工具（确定性工程操作）**

| 工具 | 作用 |
|---|---|
| `paper_init` | 建工程：`main.tex`（中文 ctexart / 英文 article）、`references.bib`、`sections/`、`figures/`、`.paper/project.json` |
| `paper_outline` | 定大纲：生成 `sections/NN-id.tex` 并重写 `main.tex` 的 `\input` 顺序（保留已有正文） |
| `paper_write_section` | 原子写入单节正文，返回字数/引用数并更新状态 |
| `paper_bib_add` | 从 arXiv / Crossref 取**真实**元数据写 BibTeX；`query` 模式只返回候选 |
| `paper_compile` | 中文自动 xelatex、英文 pdflatex；`engine → bibtex → engine → engine`；返回结构化错误/警告/未定义引用/PDF 字节数 |
| `paper_cite_audit` | 正文 `\cite` 系列 ↔ `.bib`：缺失 / 未引用 / 重复 key |
| `paper_status` | 完成度、字数、引用、编译、审稿状态 + 确定性 `nextAction` |
| `paper_review` | 起独立 fresh subagent 审稿（只给文件路径，不给作者总结），返回 PASS/WARN/FAIL + 诚信核查 |
| `paper_export` | 复制 PDF/tex/bib/sections/figures/状态到 `dist/<slug>-<时间>/` 并打 zip |
| `paper_zotero_sync` | 通过 `dsh-zotero-paperbridge` 把 `references.bib` 的每条 DOI 存进 Zotero；目标集合不存在时可新建（`create_collection` + `confirmed`，需用户确认），未选中时保存并归入目标集合 |
| `paper_obsidian_archive` | 通过 `dsh-obsidian-vaultbridge` 在 Obsidian 新目录（默认 `Paperforge/<slug>/`）写入 5 篇笔记：总览、数据与来源、工具与方法、结果与图表、复现与审计 |

**7 个命令**

- `/paper-auto <标题> [--en]`：建工程并**自主**跑完整链路（要求 agent 先 `create_goal`，全部达标后 `update_goal complete`）
- `/paper-init <标题> [--en]`：建工程并推送「先文献、再大纲、逐节写作」指令
- `/paper-write [slug]`：按 `nextAction` 推进下一节
- `/paper-review [slug]`：独立审稿，WARN/FAIL 自动把修改清单推回
- `/paper-status [slug]`：进度与下一步
- `/paper-export [slug]`：导出
- `/paper-archive [slug] [--force]`：一次跑完 Zotero 文献归档 + Obsidian 方法笔记归档

**1 个 skill**：`paper-writing`（IMRaD 各节目标、学术诚信红线、编译错误速查、自主模式规程）。

## 安装

```bash
# 把 <path-to-this-plugin> 换成你 clone 下来的目录
dsh plugin --profile desktop add link:<path-to-this-plugin>
```

安装后**完全退出 DSH（含托盘）再打开**，新会话即可看到工具与命令。

插件不声明 `peerDependencies`（零 `@deepseek-ai/*` 运行时依赖），因此不会被 `^0.1.x` 版本门禁拦截。

## 配置

profile 的 `cordis.patch.yml` 里覆盖同名 id 即可（不配置时用 `<home>/dsh/research/papers`）：

```yaml
- id: paperforge
  config:
    papersRoot: /path/to/papers
    latex:
      engine: auto            # auto | xelatex | pdflatex | lualatex
      latexmk: /path/to/latexmk   # 可选；只用来定位 TeX 的 bin 目录
      timeoutMs: 180000
    bib:
      timeoutMs: 30000
      queryLimit: 8
    reviewer:
      provider: spawn
      timeoutMs: 900000
```

`latex.latexmk` 只用来定位 TeX 的 `bin` 目录（插件按 `engine → bibtex → engine → engine` 自己驱动，不依赖 latexmk 的状态缓存）。

## 归档（依赖两个伴生插件）

- **Zotero**：`paper_zotero_sync` 调用 `dsh-zotero-paperbridge` 的 `zotero_status` / `zotero_collections` / `zotero_save`。
  - 本地模式默认保存到「Zotero 当前选中的集合」；若目标集合不存在，可传 `create_collection=true` + `confirmed=true`（**必须先经用户确认**）由插件用本地授权 key 新建集合，再用本地 API 把条目归入（`assign`，默认 true）。
  - 本地授权 key 存于 DSH 凭据 `ZOTERO_LOCAL_API_KEY`：一次性执行 `POST http://localhost:23119/api/local/authorize`（Zotero 弹窗由用户点「允许」）后拿到，插件只读不改。
  - Web 模式（`backend: web`）仍可用 `collectionKeys` 精确落集合，但需要 zotero.org 的 API key。
- **Obsidian**：`paper_obsidian_archive` 调用 `dsh-obsidian-vaultbridge` 的 `obsidian_read` / `obsidian_write`，默认写入 `Paperforge/<slug>/`，`mode=replace` 覆盖上一版、`create` 拒绝覆盖、`append` 追加。

两个工具都不直接实现 HTTP 客户端，全部通过宿主 tools registry 调用对应插件注册的工具（`ctx.tools.get(name).execute(...)`）。

## 学术诚信边界（硬规则）

1. 引用只能来自 `paper_bib_add` 写入的 arXiv/Crossref 真实条目；上游失败或 ID 不存在一律报错，**不写入任何东西**。
2. 结果数字只能来自工具输出或用户提供的真实数据；没有数据就写方法/综述型论文并声明。
3. 独立审稿专门核查：编造引用、无来源的结果数字、结论缺证据；任一项为真不得 PASS。

## 测试

```bash
cd <path-to-this-plugin>
node --test test/core.test.mjs test/bridges.test.mjs
```

覆盖：slug/LaTeX 转义、工程生命周期、大纲渲染、引用审计、BibTeX 生成与去重、日志解析、以及一次真实中文论文编译 + 导出（需要本机 MiKTeX）。
