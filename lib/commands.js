/**
 * /paper-* 命令：把「建工程 + 推进下一步」的编排交给 agent。
 *
 * 关键：profile 插件无法 import `@deepseek-ai/dsh-llm`（宿主包不可解析），
 * 因此这里自建与 `createUserMessage` 等价的消息对象：{...input, role:"user", id}。
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { PaperError } from "./bibtex.js";
import { auditCitations } from "./audit.js";
import { exportProject } from "./export.js";
import { readJson, readText } from "./fsutil.js";
import {
  appendHistory,
  createProject,
  loadProject,
  projectPaths,
  saveProject,
  slugify,
  validateSlug,
} from "./project.js";
import { renderVerdict, reviewProject } from "./review.js";
import { collectSources, computeStatus } from "./tools.js";

function createUserMessage(input) {
  // 与 @deepseek-ai/dsh-llm 的 createUserMessage 等价（宿主包在 profile 里不可 import）。
  return Object.freeze(structuredClone({ ...input, role: "user", id: randomUUID() }));
}

function followup(agent, text) {
  if (!agent || typeof agent.followup !== "function") return false;
  try {
    agent.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
    return true;
  } catch {
    return false;
  }
}

/** 参数为空时，挑 papersRoot 下最近更新的工程；支持传入完整标题作为 slug。 */
async function resolveSlug(config, raw) {
  const text = String(raw ?? "").trim();
  const token = text.split(/\s+/)[0] ?? "";
  for (const candidate of [text, token]) {
    if (!candidate) continue;
    const direct = await loadProject(config, candidate);
    if (direct) return direct.slug;
    const bySlug = slugify(candidate);
    if (bySlug !== candidate) {
      const hit = await loadProject(config, bySlug);
      if (hit) return hit.slug;
    }
  }
  if (token) return slugify(text || token);
  const entries = await readdir(config.papersRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readJson(join(config.papersRoot, entry.name, ".paper", "project.json"), null);
    if (state?.updatedAt) candidates.push({ slug: entry.name, updatedAt: state.updatedAt });
  }
  candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return candidates[0]?.slug ?? "";
}

function usage(text) {
  return { kind: "error", text };
}

function ok(text) {
  return { kind: "success", text };
}

function initInstruction({ root, slug, title, auto }) {
  return [
    `论文工程已创建。`,
    `- slug：${slug}`,
    `- 标题：${title}`,
    `- 根目录：${root}`,
    "",
    auto
      ? "你现在要**自主完成整篇论文**，不要等待用户确认。第一步先调用 create_goal 登记目标："
      : "请按下面的顺序推进（每完成一步再进下一步）：",
    auto
      ? `create_goal(objective="完成论文《${title}》（${root}）：真实文献 ≥6 条、编译通过、引用审计 0 missing、独立审稿 PASS、导出 PDF", max_goal_rounds=40)`
      : "",
    "",
    "1. 文献：paper_bib_add 先用 query 模式找 2–4 组关键词的候选；对真正相关的条目用 arxiv_id / doi 正式入库，至少 6 条。每条都必须有真实 arXiv id 或 DOI。",
    "2. 大纲：paper_outline，6–8 节 IMRaD（摘要 / 引言 / 方法 / 结果 / 讨论 / 结论）。",
    "3. 写作：按 outline 顺序逐节 paper_write_section，每节写完立即 paper_compile；编译失败先按 errors 修，再继续。正文只写正文，不要重复 \\section 标题。",
    "4. 引用：paper_cite_audit，missingInBib 必须为 0。",
    "5. 审稿：paper_review；WARN/FAIL 按 issues 修改后重编译、再审，直到 PASS。",
    "6. 导出：paper_export。",
    "7. Zotero 归档：paper_zotero_sync，把 references.bib 里每条文献按 DOI 存进 Zotero。若目标集合不存在，先问用户是否新建；用户同意后传 create_collection=true, confirmed=true。若返回 confirm_create，说明尚未确认，不要假装已建。",
    "8. Obsidian 归档：paper_obsidian_archive，把数据来源、工具链、算法口径、结果明细与复现步骤写成一组笔记（可用 notes 参数补充你的解释）。",
    auto ? "9. 全部满足后调用 update_goal complete；如果卡住，如实说明卡点，不要假装完成。" : "",
    "",
    "纪律（硬性）：数据与结论只能来自工具输出或用户提供的真实数据；没有数据就写方法/综述型论文并在正文声明；引用只能来自 paper_bib_add；禁止编造 DOI、arXiv id、结果数字。",
    "开工前先读 skill「paper-writing」获取完整规程与编译错误速查表。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerCommands(ctx, deps) {
  const { config, getSubagents } = deps;
  const disposers = [];
  const register = (definition) => disposers.push(ctx.commands.register(definition));

  register({
    name: "paper-init",
    description: "Create a paper project and hand the agent a literature-first writing instruction",
    input: { hint: "<title>" },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? "").trim();
      const lang = /--en\b/.test(raw) ? "en" : "zh";
      const title = raw.replace(/--en\b/g, "").trim();
      if (!title) return usage("用法：/paper-init <论文标题> [--en]");
      const slug = slugify(title);
      const check = validateSlug(slug);
      if (!check.ok) return usage(`标题无法生成合法目录名：${check.reason}；请改用 /paper-init 指定英文标题或直接用 paper_init(slug=...)`);
      const { created, project, paths } = await createProject(config, { slug, title, lang });
      followup(invocation.agent, initInstruction({ root: paths.root, slug: project.slug, title, auto: false }));
      return ok(
        `${created ? "已创建" : "工程已存在"}：${paths.root}\n下一步指令已推送给 agent（先文献、再大纲、逐节写作并编译）。`,
      );
    },
  });

  register({
    name: "paper-auto",
    description: "Create a paper project and drive the whole pipeline autonomously (goal-backed)",
    input: { hint: "<title>" },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? "").trim();
      const lang = /--en\b/.test(raw) ? "en" : "zh";
      const title = raw.replace(/--en\b/g, "").trim();
      if (!title) return usage("用法：/paper-auto <论文标题> [--en]");
      const slug = slugify(title);
      const check = validateSlug(slug);
      if (!check.ok) return usage(`标题无法生成合法目录名：${check.reason}`);
      const { project, paths } = await createProject(config, { slug, title, lang });
      const delivered = followup(invocation.agent, initInstruction({ root: paths.root, slug: project.slug, title, auto: true }));
      return ok(
        `${paths.root}\n${delivered ? "自主写作指令已推送：agent 将登记 goal 并连续执行到导出。" : "工程已建好，但当前会话无法自动推送指令；请直接按 skill「paper-writing」的流程调用 paper_* 工具。"}`,
      );
    },
  });

  register({
    name: "paper-write",
    description: "Write the next unfinished section, then compile",
    input: { hint: "[slug]" },
    async handler(invocation) {
      const slug = await resolveSlug(config, invocation.rawInput);
      const project = slug ? await loadProject(config, slug) : null;
      if (!project) return usage("找不到论文工程：先用 /paper-auto <标题> 或 /paper-init <标题>。");
      const paths = projectPaths(config, slug);
      const sources = await collectSources(paths, project);
      const bib = await readText(paths.bib, "");
      const audit = auditCitations(sources.map((s) => s.text), bib);
      const status = computeStatus(project, audit, paths);
      followup(
        invocation.agent,
        [
          `继续推进论文 ${slug}（${paths.root}）。当前下一步：${status.nextAction}`,
          "执行顺序：先完成该 nextAction 指向的工具调用；若写正文，写完立即 paper_compile 并按 errors 修复；然后用 paper_status 重新确认 nextAction。",
          "不要重复已完成章节，不要编造数据/引用。",
        ].join("\n"),
      );
      return ok(`${slug}：${status.nextAction}\n已完成 ${status.doneCount}/${status.totalCount} 节。`);
    },
  });

  register({
    name: "paper-review",
    description: "Run one independent reviewer pass over the paper and hand WARN/FAIL back for revision",
    input: { hint: "[slug]" },
    async handler(invocation) {
      const slug = await resolveSlug(config, invocation.rawInput);
      const project = slug ? await loadProject(config, slug) : null;
      if (!project) return usage("找不到论文工程。");
      const paths = projectPaths(config, slug);
      const sources = await collectSources(paths, project);
      const files = sources.map((s) => s.file).concat([paths.bib]);
      try {
        let subagents = null;
        try {
          subagents = typeof getSubagents === "function" ? getSubagents() : (ctx.subagents ?? null);
        } catch {
          subagents = null;
        }
        const round = await reviewProject({ subagents }, {
          config,
          project,
          paths,
          files,
          scope: "整篇论文（结构、论证、引用与数据来源）",
          parent: invocation.agent,
          signal: invocation.signal,
        });
        project.review.push({ at: round.at, verdict: round.verdict, issues: round.issues.length, scope: "整篇论文" });
        appendHistory(project, "paper_review", round.verdict);
        await saveProject(config, project);
        if (round.verdict !== "PASS") {
          followup(
            invocation.agent,
            [`独立审稿返回 ${round.verdict}。`, "", renderVerdict(round), "", "按 issues 修改对应节，重新 paper_compile，然后再次 paper_review。"].join("\n"),
          );
        }
        return { kind: round.verdict === "FAIL" ? "error" : "success", text: renderVerdict(round) };
      } catch (error) {
        const message = error instanceof PaperError || error?.code
          ? `[${error.code}] ${error.message}`
          : String(error?.message ?? error);
        return usage(`审稿失败：${message}`);
      }
    },
  });

  register({
    name: "paper-status",
    description: "Show paper progress and the concrete next action",
    input: { hint: "[slug]" },
    async handler(invocation) {
      const slug = await resolveSlug(config, invocation.rawInput);
      const project = slug ? await loadProject(config, slug) : null;
      if (!project) return usage("找不到论文工程。");
      const paths = projectPaths(config, slug);
      const sources = await collectSources(paths, project);
      const bib = await readText(paths.bib, "");
      const status = computeStatus(project, auditCitations(sources.map((s) => s.text), bib), paths);
      return ok(renderStatus(status));
    },
  });

  register({
    name: "paper-export",
    description: "Export the paper into dist/ and zip it",
    input: { hint: "[slug]" },
    async handler(invocation) {
      const slug = await resolveSlug(config, invocation.rawInput);
      const project = slug ? await loadProject(config, slug) : null;
      if (!project) return usage("找不到论文工程。");
      const paths = projectPaths(config, slug);
      try {
        const result = await exportProject({ paths, project, zip: config.export.zip });
        project.export = { at: result.exportedAt, distDir: result.distDir, zipPath: result.zipPath, pdfBytes: result.pdfBytes };
        appendHistory(project, "paper_export", result.distDir);
        await saveProject(config, project);
        return ok(
          [`已导出：${result.distDir}`, result.zipPath ? `压缩包：${result.zipPath}` : "（zip 未生成）", `PDF：${result.pdfBytes} 字节`].join("\n"),
        );
      } catch (error) {
        return usage(`导出失败：${error?.message ?? error}`);
      }
    },
  });

  register({
    name: "paper-archive",
    description: "Archive references into Zotero and write the data/method notes into Obsidian (via the two bridge plugins)",
    input: { hint: "[slug] [--force]" },
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? "");
      const force = /--force\b/.test(raw);
      const slug = await resolveSlug(config, raw.replace(/--force\b/g, "").trim());
      const project = slug ? await loadProject(config, slug) : null;
      if (!project) return usage("找不到论文工程：先用 /paper-auto <标题> 或 /paper-init <标题>。");

      const call = async (name, args) => {
        const definition = ctx.tools?.get?.(name);
        if (!definition || typeof definition.execute !== "function") {
          return { error: { code: "TOOL_UNAVAILABLE", message: `工具 ${name} 不可用` } };
        }
        return definition.execute(args, { agent: invocation.agent, signal: invocation.signal, arguments: args });
      };

      const lines = [];
      const zotero = await call("paper_zotero_sync", { slug, force });
      if (zotero?.error) {
        lines.push(`Zotero：失败 [${zotero.error.code}] ${zotero.error.message}`);
      } else if (zotero?.ok === false) {
        lines.push(`Zotero：${zotero.decision}\n${zotero.hint ?? ""}`);
      } else {
        lines.push(`Zotero：${zotero.target}（saved ${zotero.saved}，duplicates ${zotero.duplicates}，failed ${zotero.failed}）`);
      }

      const obsidian = await call("paper_obsidian_archive", { slug });
      if (obsidian?.error) {
        lines.push(`Obsidian：失败 [${obsidian.error.code}] ${obsidian.error.message}`);
      } else {
        lines.push(`Obsidian：${obsidian.dir}（${obsidian.count} 篇）`);
      }
      return ok(lines.join("\n"));
    },
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

function renderStatus(status) {
  const lines = [
    `《${status.title}》(${status.slug}) — ${status.doneCount}/${status.totalCount} 节完成`,
    `路径：${status.root}`,
    "",
    "章节：",
  ];
  for (const section of status.sections) {
    lines.push(`- ${section.id.padEnd(16)} ${section.status.padEnd(6)} ${String(section.chars).padStart(6)} 字  ${section.cites} 引用  ${section.title}`);
  }
  lines.push("");
  if (status.compile) {
    lines.push(`编译：${status.compile.status}（${status.compile.engine}，${status.compile.errors ?? 0} errors，PDF ${status.compile.pdfBytes ?? 0} 字节）`);
  } else {
    lines.push("编译：尚未编译");
  }
  if (status.review) lines.push(`审稿：${status.review.verdict}（${status.review.issues} issues）`);
  lines.push(`引用：${status.citations} 条；缺失 ${status.audit?.missingInBib?.length ?? 0}，未引用 ${status.audit?.uncited?.length ?? 0}`);
  lines.push("", `下一步：${status.nextAction}`);
  return lines.join("\n");
}
