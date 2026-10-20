/**
 * 独立审稿：起一个 fresh subagent，只给它文件路径与评审范围，
 * 不让它看到作者的自我总结（reviewer independence）。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PaperError } from "./bibtex.js";
import { stampNow, writeJsonAtomic } from "./fsutil.js";

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["major", "minor"] },
          location: { type: "string" },
          problem: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["severity", "location", "problem", "suggestion"],
        additionalProperties: false,
      },
    },
    integrity: {
      type: "object",
      properties: {
        fabricatedCitations: { type: "boolean" },
        unsupportedClaims: { type: "boolean" },
        missingDataProvenance: { type: "boolean" },
        notes: { type: "string" },
      },
      required: ["fabricatedCitations", "unsupportedClaims", "missingDataProvenance", "notes"],
      additionalProperties: false,
    },
    summary: { type: "string" },
  },
  required: ["verdict", "issues", "integrity", "summary"],
  additionalProperties: false,
};

const REVIEWER_PERSONA =
  "你是严格、不轻信的期刊审稿人。你的职责是找问题：没有依据的结论、缺失的数据来源、" +
  "编造或错配的引用、夸大贡献、写作不清、统计报告不完整。不要夸奖。不要相信作者的自我评价，" +
  "只依据你亲自读到的文件内容判断。";

function buildPrompt({ scope, files, project }) {
  const list = files.map((p) => `- ${p}`).join("\n");
  return [
    `评审对象：${scope}`,
    project?.title ? `论文标题：${project.title}` : "",
    project?.lang === "en" ? "论文语言：English" : "论文语言：中文",
    "",
    "请完整阅读下列文件（不要只看摘要）：",
    list,
    "",
    "核查清单（逐项判断，发现问题必须给出精确位置与可执行修改）：",
    "1. 引用真实性：正文每条 \\cite 是否都能在 references.bib 找到？bib 条目是否像真实条目（有 DOI/arXiv/期刊），而不是占位符？是否存在编造引用？",
    "2. 数据来源：结果/实验/统计数字是否说明了数据来源与获得方式？没有真实数据却给出结果数字 = major。",
    "3. 结论支撑：每条主要结论是否由正文证据支撑？摘要/引言是否承诺了正文没有兑现的内容？",
    "4. 方法与可复现性：方法是否描述到他人可复现的程度？",
    "5. 结构与写作：IMRaD 是否完整，术语是否一致，图表是否被正文引用。",
    "",
    "判定规则：PASS 仅在通过上述全部核查时给出；WARN 表示必须修但不推翻工作；",
    "FAIL 表示存在根本问题（编造引用、无来源的结果数字、核心结论无证据）。",
    "integrity 字段必须如实填写，任何一项为 true 都不得给出 PASS。",
  ]
    .filter(Boolean)
    .join("\n");
}

function pickProvider(subagents, preferred) {
  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  for (const name of [preferred, "spawn"]) {
    try {
      push(subagents.getProvider(name));
    } catch {
      /* ignore */
    }
  }
  try {
    const pool = subagents.providers instanceof Map
      ? [...subagents.providers.values()]
      : Object.values(subagents.providers ?? {});
    for (const p of pool) push(p);
  } catch {
    /* ignore */
  }
  return candidates.find(
    (p) => p?.capabilities?.outputSchema === true && p?.inheritsParentContext !== true,
  ) ?? null;
}

function normalizeVerdict(value) {
  if (!value || typeof value !== "object") throw new Error("审稿人没有返回结构化结论");
  const verdict = value.verdict;
  if (!["PASS", "WARN", "FAIL"].includes(verdict)) {
    throw new Error(`审稿人返回了未知判定：${JSON.stringify(verdict)}`);
  }
  const issues = Array.isArray(value.issues)
    ? value.issues.map((issue) => ({
      severity: issue?.severity === "minor" ? "minor" : "major",
      location: String(issue?.location ?? ""),
      problem: String(issue?.problem ?? ""),
      suggestion: String(issue?.suggestion ?? ""),
    }))
    : [];
  const integrity = {
    fabricatedCitations: Boolean(value.integrity?.fabricatedCitations),
    unsupportedClaims: Boolean(value.integrity?.unsupportedClaims),
    missingDataProvenance: Boolean(value.integrity?.missingDataProvenance),
    notes: String(value.integrity?.notes ?? ""),
  };
  return { verdict, issues, integrity, summary: String(value.summary ?? "") };
}

/**
 * @param {object} ctx cordis context（需要 subagents 服务）
 * @param {object} options
 * @param {object} options.config 插件配置
 * @param {object} options.project project.json
 * @param {object} options.paths projectPaths()
 * @param {string[]} options.files 绝对路径
 * @param {string} options.scope 评审范围描述
 * @param {object} [options.parent] 父 agent（用于归属）
 * @param {AbortSignal} [options.signal]
 */
export async function reviewProject(ctx, { config, project, paths, files, scope, parent, signal }) {
  if (!ctx?.subagents) {
    throw new PaperError("REVIEWER_UNAVAILABLE", "当前 profile 没有 subagents 服务，无法起独立审稿。");
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new PaperError("REVIEWER_UNAVAILABLE", "没有可评审文件：先写正文并编译。");
  }
  const provider = pickProvider(ctx.subagents, config.reviewer.provider);
  if (!provider) {
    throw new PaperError(
      "REVIEWER_UNAVAILABLE",
      `找不到支持结构化输出的审稿 subagent provider（期望 ${config.reviewer.provider}）。`,
    );
  }

  const timeout = AbortSignal.timeout(config.reviewer.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const activation = await ctx.subagents.startActivation({
    provider: provider.label ?? provider.name ?? config.reviewer.provider,
    label: `paperforge review: ${scope}`,
    delivery: "caller",
    signal: combined,
    request: {
      prompt: [{ type: "text", text: `${REVIEWER_PERSONA}\n\n${buildPrompt({ scope, files, project })}` }],
      parent,
      outputSchema: VERDICT_SCHEMA,
    },
  });

  try {
    const result = await activation.result;
    if (result.stopReason !== "completed") {
      throw new PaperError(
        "REVIEW_FAILED",
        `审稿子代理异常结束（${result.stopReason}）${result.diagnostic ? `：${result.diagnostic}` : ""}`,
      );
    }
    const round = normalizeVerdict(result.structured);
    const record = {
      at: new Date().toISOString(),
      scope,
      provider: provider.label ?? provider.name ?? config.reviewer.provider,
      ...round,
    };
    if (paths?.reviewsDir) {
      await mkdir(paths.reviewsDir, { recursive: true });
      await writeJsonAtomic(join(paths.reviewsDir, `review-${stampNow()}.json`), record);
    }
    return record;
  } finally {
    await activation.dispose();
  }
}

export function renderVerdict(round) {
  const lines = [`判定：${round.verdict}`, "", `摘要：${round.summary}`];
  if (round.integrity) {
    const flags = [];
    if (round.integrity.fabricatedCitations) flags.push("疑似编造引用");
    if (round.integrity.unsupportedClaims) flags.push("结论缺证据");
    if (round.integrity.missingDataProvenance) flags.push("数据来源缺失");
    if (flags.length) lines.push("", `诚信核查：${flags.join("；")}`);
    if (round.integrity.notes) lines.push(`说明：${round.integrity.notes}`);
  }
  if (round.issues?.length) {
    lines.push("", "问题：");
    for (const issue of round.issues) {
      lines.push(`- [${issue.severity}] ${issue.location}: ${issue.problem}`, `  建议：${issue.suggestion}`);
    }
  }
  return lines.join("\n");
}
