/**
 * 真实文献抓取与 BibTeX 生成。
 *
 * 硬规则：只接受 arXiv / Crossref 返回的元数据。任何网络失败、ID 不存在
 * 都抛错，绝不回退到「猜测条目」——这是本插件学术诚信的底线。
 */
import { createHash } from "node:crypto";

export class PaperError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const ARXIV_API = "https://export.arxiv.org/api/query";
const CROSSREF_API = "https://api.crossref.org/works";

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(value) {
  return decodeXml(String(value).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i");
  const match = block.match(re);
  return match ? stripTags(match[1]) : "";
}

/** 归一化 arXiv id：接受裸 id、arXiv: 前缀、abs/pdf URL、带版本号。 */
export function normalizeArxivId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  const urlMatch = raw.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i);
  const candidate = urlMatch ? urlMatch[1] : raw.replace(/^arxiv:/i, "");
  return candidate.replace(/\.pdf$/i, "").replace(/v\d+$/i, "").trim();
}

/** 归一化 DOI：去 https://doi.org/ 前缀与 doi: 前缀。 */
export function normalizeDoi(input) {
  return String(input ?? "")
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .trim();
}

async function fetchText(url, { timeoutMs, userAgent }) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal,
      headers: {
        "user-agent": userAgent,
        accept: "application/atom+xml, application/json, text/plain, */*",
      },
    });
  } catch (error) {
    throw new PaperError(
      "BIB_FETCH_FAILED",
      `请求失败：${url}（${error?.name === "TimeoutError" ? "超时" : error?.message ?? error}）`,
    );
  }
  if (!response.ok) {
    throw new PaperError(
      "NOT_FOUND",
      `上游返回 HTTP ${response.status}：${url}`,
      { status: response.status },
    );
  }
  return response.text();
}

function firstDateParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const [year, month, day] = parts[0];
  return [year, month, day].filter((x) => x !== undefined && x !== null).join("-");
}

/** 按 arXiv id 取真实元数据。 */
export async function fetchArxivById(idInput, options) {
  const id = normalizeArxivId(idInput);
  if (!id) throw new PaperError("NO_IDENTIFIER", "arXiv id 为空");
  const url = `${ARXIV_API}?id_list=${encodeURIComponent(id)}&max_results=1`;
  const xml = await fetchText(url, options);
  const entryMatch = xml.match(/<entry>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) throw new PaperError("NOT_FOUND", `arXiv 无此条目：${id}`);
  const entry = entryMatch[1];
  const title = tag(entry, "title");
  if (!title) throw new PaperError("NOT_FOUND", `arXiv 条目缺少标题：${id}`);

  const authors = [];
  for (const match of entry.matchAll(/<author[^>]*>([\s\S]*?)<\/author>/gi)) {
    const name = tag(match[1], "name");
    if (name) authors.push(name);
  }
  const published = tag(entry, "published");
  const year = published ? published.slice(0, 4) : "";
  const summary = tag(entry, "summary");
  const absUrl = tag(entry, "id");
  const doi = tag(entry, "arxiv:doi");
  const journalRef = tag(entry, "arxiv:journal_ref");
  const primary = entry.match(/<arxiv:primary_category[^>]*term="([^"]+)"/i);
  const comment = tag(entry, "arxiv:comment");

  return {
    kind: "arxiv",
    arxivId: id,
    doi: doi || "",
    title,
    authors,
    year,
    month: "",
    summary,
    journal: journalRef || "arXiv preprint",
    volume: "",
    issue: "",
    pages: "",
    publisher: "arXiv",
    url: absUrl || `https://arxiv.org/abs/${id}`,
    primaryClass: primary ? primary[1] : "",
    comment,
    type: "article",
  };
}

/** arXiv 关键词搜索，返回候选（不写入 bib）。 */
export async function searchArxiv(query, options) {
  const q = String(query ?? "").trim();
  if (!q) throw new PaperError("NO_IDENTIFIER", "查询词为空");
  const limit = Math.max(1, Math.min(30, options.queryLimit ?? 8));
  const url = `${ARXIV_API}?search_query=${encodeURIComponent(`all:${q}`)}&start=0&max_results=${limit}&sortBy=relevance`;
  const xml = await fetchText(url, options);
  const results = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    const title = tag(entry, "title");
    if (!title) continue;
    const absUrl = tag(entry, "id");
    const arxivId = normalizeArxivId(absUrl);
    const authors = [];
    for (const a of entry.matchAll(/<author[^>]*>([\s\S]*?)<\/author>/gi)) {
      const name = tag(a[1], "name");
      if (name) authors.push(name);
    }
    const published = tag(entry, "published");
    results.push({
      arxivId,
      title,
      authors,
      year: published ? published.slice(0, 4) : "",
      summary: tag(entry, "summary").slice(0, 400),
      url: absUrl,
    });
  }
  if (results.length === 0) throw new PaperError("NOT_FOUND", `arXiv 无匹配结果：${q}`);
  return results;
}

/** 按 DOI 取 Crossref 元数据。 */
export async function fetchCrossrefByDoi(doiInput, options) {
  const doi = normalizeDoi(doiInput);
  if (!doi) throw new PaperError("NO_IDENTIFIER", "DOI 为空");
  const url = `${CROSSREF_API}/${encodeURIComponent(doi)}`;
  const text = await fetchText(url, options);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new PaperError("BIB_FETCH_FAILED", `Crossref 返回非 JSON：${doi}`);
  }
  const message = payload?.message;
  if (!message) throw new PaperError("NOT_FOUND", `Crossref 无此 DOI：${doi}`);

  const titles = Array.isArray(message.title) ? message.title : [];
  const title = stripTags(titles[0] ?? "");
  if (!title) throw new PaperError("NOT_FOUND", `Crossref 条目缺少标题：${doi}`);

  const authors = (Array.isArray(message.author) ? message.author : [])
    .map((a) => [a.family, a.given].filter(Boolean).join(", ") || a.name || "")
    .filter(Boolean);

  const container = Array.isArray(message["container-title"]) ? message["container-title"] : [];
  const published = firstDateParts(message.published?.["date-parts"]) ||
    firstDateParts(message["published-print"]?.["date-parts"]) ||
    firstDateParts(message["published-online"]?.["date-parts"]) ||
    firstDateParts(message.issued?.["date-parts"]);

  const typeMap = {
    "journal-article": "article",
    "proceedings-article": "inproceedings",
    "book-chapter": "incollection",
    book: "book",
    monograph: "book",
    "posted-content": "misc",
    "report": "techreport",
    "dissertation": "phdthesis",
  };

  return {
    kind: "doi",
    arxivId: "",
    doi,
    title,
    authors,
    year: published ? published.slice(0, 4) : "",
    month: "",
    summary: stripTags(message.abstract ?? ""),
    journal: container[0] ?? "",
    booktitle: message.type === "proceedings-article" ? container[0] ?? "" : "",
    volume: message.volume ?? "",
    issue: message.issue ?? "",
    pages: message.page ?? "",
    publisher: message.publisher ?? "",
    url: message.URL ?? `https://doi.org/${doi}`,
    primaryClass: "",
    comment: "",
    type: typeMap[message.type] ?? "misc",
    citationCount: message["is-referenced-by-count"] ?? null,
  };
}

function bibEscape(value) {
  // 花括号保留：BibTeX 用 {} 保护大小写（如 {NumPy}），转义反而会把花括号印出来。
  return String(value ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

function bibField(name, value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return `  ${name} = {${bibEscape(text)}}`;
}

/** 生成 citation key：family+year+title word，冲突由调用方处理。 */
export function makeCitationKey(meta) {
  const firstAuthor = (meta.authors?.[0] ?? "").split(",")[0].trim();
  const family = firstAuthor
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase() || "anon";
  const year = String(meta.year ?? "").replace(/[^0-9]/g, "") || "nd";
  const stop = new Set(["a", "an", "the", "of", "on", "in", "for", "and", "to", "with", "by"]);
  const word = String(meta.title ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .find((w) => w.length > 2 && !stop.has(w)) ?? "paper";
  return `${family}${year}${word}`.slice(0, 48);
}

export function parseBibKeys(content) {
  const keys = new Map();
  const text = String(content ?? "");
  const re = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,/g;
  for (const match of text.matchAll(re)) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    keys.set(match[2], { type });
  }
  return keys;
}

/** 稳定的条目指纹：优先 DOI/arXiv；两者都缺时退回标题+年份，避免不同文献被误判为重复。 */
function entryFingerprint(doi, eprint, title, year) {
  const d = String(doi ?? "").trim().toLowerCase();
  const e = String(eprint ?? "").trim().toLowerCase();
  if (d || e) return `${d}|${e}`;
  return `title:${String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase()}|${String(year ?? "").trim()}`;
}

/** 每条 bib 条目的 DOI/arXiv 指纹，用于识别重复。 */
export function bibFingerprints(content) {
  const text = String(content ?? "");
  const out = new Map();
  const entryRe = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  for (const match of text.matchAll(entryRe)) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const body = match[3];
    const doi = body.match(/doi\s*=\s*\{([^}]*)\}/i)?.[1] ?? "";
    const eprint = body.match(/eprint\s*=\s*\{([^}]*)\}/i)?.[1] ?? "";
    const title = body.match(/title\s*=\s*\{([\s\S]*?)\}\s*,\n/i)?.[1] ?? "";
    const year = body.match(/year\s*=\s*\{([^}]*)\}/i)?.[1] ?? "";
    out.set(match[2], entryFingerprint(doi, eprint, title, year));
  }
  return out;
}

/** 唯一 key：同 DOI/arXiv（或缺 ID 时的同标题+年份）视为重复，不同条目加后缀。 */
export function uniqueKey(base, meta, fingerprints) {
  if (!fingerprints.has(base)) return { key: base, duplicate: false };
  const fingerprint = entryFingerprint(meta.doi, meta.arxivId, meta.title, meta.year);
  if (fingerprints.get(base) === fingerprint) return { key: base, duplicate: true };
  for (const suffix of "abcdefghijklmnopqrstuvwxyz") {
    const candidate = `${base}${suffix}`;
    if (!fingerprints.has(candidate)) return { key: candidate, duplicate: false };
  }
  const hash = createHash("sha1").update(fingerprint).digest("hex").slice(0, 6);
  return { key: `${base}-${hash}`, duplicate: false };
}

export function toBibtex(meta, key) {
  const fields = [];
  const push = (name, value) => {
    const line = bibField(name, value);
    if (line) fields.push(line);
  };

  push("title", meta.title);
  push("author", (meta.authors ?? []).join(" and "));

  const type = meta.type || "article";
  if (type === "inproceedings" || type === "incollection") {
    push("booktitle", meta.booktitle || meta.journal);
  } else if (type === "book") {
    push("publisher", meta.publisher);
  } else {
    push("journal", meta.journal);
  }
  push("year", meta.year);
  push("volume", meta.volume);
  push("number", meta.issue);
  push("pages", meta.pages);
  push("publisher", type === "book" ? "" : meta.publisher);
  if (meta.arxivId) {
    push("eprint", meta.arxivId);
    push("archivePrefix", "arXiv");
    push("primaryClass", meta.primaryClass);
  }
  push("doi", meta.doi);

  const url = String(meta.url ?? "").trim();
  const urlLine = url && !/[\s{}]/.test(url) ? `  url = {${url}}` : null;
  if (urlLine) fields.push(urlLine);

  return `@${type}{${key},\n${fields.join(",\n")}\n}\n`;
}

export function appendBibtex(content, block) {
  const base = String(content ?? "").trimEnd();
  const separator = base ? "\n\n" : "";
  return `${base}${separator}${block.trimEnd()}\n`;
}

export function bibKeyCount(content) {
  return parseBibKeys(content).size;
}

/** 供审计与状态展示的指纹表。 */
export function bibIndex(content) {
  const map = parseBibKeys(content);
  const out = new Map();
  for (const [key] of map) out.set(key, { key });
  return out;
}
