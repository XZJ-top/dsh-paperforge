/**
 * dsh-paperforge — 零依赖配置。
 *
 * 与 `@deepseek-ai/*` 包完全不耦合：profile 里的插件无法解析宿主的
 * workspace 包（实测 `import("@deepseek-ai/dsh-llm")` 失败），因此配置走
 * Standard Schema，工具/命令/消息对象全部在本插件内自洽。
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DEFAULTS = {
  /** 论文工程根目录。 */
  papersRoot: join(homedir(), "dsh", "research", "papers"),
  /** LaTeX 编译设置。 */
  latex: {
    /** auto = 按主文件里的 ctexart/xeCJK 判定；也可强制 xelatex/pdflatex/lualatex。 */
    engine: "auto",
    /** latexmk 可执行文件；留空则先用 PATH，再回退到 MiKTeX 常见安装位置。 */
    latexmk: "",
    /** 单次编译预算。 */
    timeoutMs: 180000,
  },
  /** 文献抓取设置。 */
  bib: {
    timeoutMs: 30000,
    /** 单次 query 搜索返回的候选数。 */
    queryLimit: 8,
    userAgent: "dsh-paperforge/0.1 (mailto:paperforge@example.com)",
  },
  /** 独立审稿设置。 */
  reviewer: {
    provider: "spawn",
    timeoutMs: 900000,
  },
  /** Zotero 本地 API（建集合/归入集合）；key 来自一次性本地授权。 */
  zotero: {
    localBaseUrl: "http://localhost:23119",
    localApiKeyRef: "ZOTERO_LOCAL_API_KEY",
    timeoutMs: 30000,
  },
  /** 导出设置。 */
  export: {
    zip: true,
  },
};

const STRING_FIELDS = ["papersRoot"];

function pickString(value, fallback, { allowEmpty = false } = {}) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) return fallback;
  return trimmed;
}

function pickNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 把原始 cordis 配置解析为完整、经过校验的值。 */
export function resolveConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const out = {
    papersRoot: pickString(value.papersRoot, CONFIG_DEFAULTS.papersRoot),
    latex: { ...CONFIG_DEFAULTS.latex },
    bib: { ...CONFIG_DEFAULTS.bib },
    reviewer: { ...CONFIG_DEFAULTS.reviewer },
    zotero: { ...CONFIG_DEFAULTS.zotero },
    export: { ...CONFIG_DEFAULTS.export },
  };

  for (const key of STRING_FIELDS) {
    out[key] = pickString(value[key], CONFIG_DEFAULTS[key]);
  }

  const latex = value.latex && typeof value.latex === "object" ? value.latex : {};
  const engine = pickString(latex.engine, CONFIG_DEFAULTS.latex.engine);
  out.latex.engine = ["auto", "xelatex", "pdflatex", "lualatex"].includes(engine)
    ? engine
    : "auto";
  out.latex.latexmk = pickString(latex.latexmk, CONFIG_DEFAULTS.latex.latexmk);
  out.latex.timeoutMs = pickNumber(latex.timeoutMs, CONFIG_DEFAULTS.latex.timeoutMs, {
    min: 10000,
    max: 900000,
  });

  const bib = value.bib && typeof value.bib === "object" ? value.bib : {};
  out.bib.timeoutMs = pickNumber(bib.timeoutMs, CONFIG_DEFAULTS.bib.timeoutMs, {
    min: 3000,
    max: 120000,
  });
  out.bib.queryLimit = pickNumber(bib.queryLimit, CONFIG_DEFAULTS.bib.queryLimit, {
    min: 1,
    max: 30,
  });
  out.bib.userAgent = pickString(bib.userAgent, CONFIG_DEFAULTS.bib.userAgent);

  const reviewer = value.reviewer && typeof value.reviewer === "object" ? value.reviewer : {};
  out.reviewer.provider = pickString(reviewer.provider, CONFIG_DEFAULTS.reviewer.provider);
  out.reviewer.timeoutMs = pickNumber(reviewer.timeoutMs, CONFIG_DEFAULTS.reviewer.timeoutMs, {
    min: 60000,
    max: 3600000,
  });

  const zotero = value.zotero && typeof value.zotero === "object" ? value.zotero : {};
  out.zotero.localBaseUrl = pickString(zotero.localBaseUrl, CONFIG_DEFAULTS.zotero.localBaseUrl);
  out.zotero.localApiKeyRef = pickString(zotero.localApiKeyRef, CONFIG_DEFAULTS.zotero.localApiKeyRef);
  out.zotero.timeoutMs = pickNumber(zotero.timeoutMs, CONFIG_DEFAULTS.zotero.timeoutMs, {
    min: 1000,
    max: 120000,
  });

  const exp = value.export && typeof value.export === "object" ? value.export : {};
  out.export.zip = typeof exp.zip === "boolean" ? exp.zip : CONFIG_DEFAULTS.export.zip;

  return out;
}

/** cordis Loader 使用的 Standard Schema。 */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-paperforge",
    validate(value) {
      if (value !== undefined && value !== null && typeof value !== "object") {
        return { issues: [{ message: "配置必须是对象", path: [] }] };
      }
      return { value: resolveConfig(value) };
    },
  },
  shape: {
    papersRoot: "string",
    latex: "object",
    bib: "object",
    reviewer: "object",
    zotero: "object",
    export: "object",
  },
  defaults: CONFIG_DEFAULTS,
};
