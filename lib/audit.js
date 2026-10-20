/**
 * 引用审计：正文 \cite 系列 ↔ references.bib。
 */
const CITE_COMMAND_RE =
  /\\(?:cite|citep|citet|citealp|citealt|Citep|Citet|parencite|textcite|autocite|footcite|supercite|nocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g;

/** 从若干 tex 源文本里抽取被引 key（保持首次出现顺序）。 */
export function extractCiteKeys(sources) {
  const order = [];
  const counts = new Map();
  let nociteAll = false;
  for (const source of sources) {
    const text = String(source ?? "");
    for (const match of text.matchAll(CITE_COMMAND_RE)) {
      for (const raw of match[1].split(",")) {
        const key = raw.trim();
        if (!key) continue;
        if (key === "*") {
          nociteAll = true;
          continue;
        }
        if (!counts.has(key)) order.push(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return { keys: order, counts, nociteAll };
}

/** 解析 bib 条目，保留重复 key 信息。 */
export function parseBibEntries(content) {
  const text = String(content ?? "");
  const entries = [];
  const re = /@([a-zA-Z]+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  for (const match of text.matchAll(re)) {
    const type = match[1].toLowerCase();
    if (type === "comment" || type === "string" || type === "preamble") continue;
    const body = match[3];
    entries.push({
      key: match[2],
      type,
      doi: (body.match(/doi\s*=\s*\{([^}]*)\}/i)?.[1] ?? "").trim(),
      eprint: (body.match(/eprint\s*=\s*\{([^}]*)\}/i)?.[1] ?? "").trim(),
      year: (body.match(/year\s*=\s*\{([^}]*)\}/i)?.[1] ?? "").trim(),
      title: (body.match(/title\s*=\s*\{([\s\S]*?)\}\s*,\n/i)?.[1] ?? "").trim(),
    });
  }
  return entries;
}

/**
 * 审计：返回缺失/未引用/重复。
 * @param sources 正文 tex 源（main + sections）
 * @param bibContent references.bib 内容
 */
export function auditCitations(sources, bibContent) {
  const { keys, counts, nociteAll } = extractCiteKeys(sources);
  const entries = parseBibEntries(bibContent);
  const bibKeys = [];
  const duplicates = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.key)) duplicates.push(entry.key);
    else {
      seen.add(entry.key);
      bibKeys.push(entry.key);
    }
  }

  const missingInBib = keys.filter((key) => !seen.has(key));
  const uncited = nociteAll ? [] : bibKeys.filter((key) => !counts.has(key));
  const perKey = {};
  for (const key of keys) {
    perKey[key] = { count: counts.get(key) ?? 0, inBib: seen.has(key) };
  }

  return {
    missingInBib,
    uncited,
    duplicateKeys: [...new Set(duplicates)],
    citationCount: keys.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0),
    uniqueCitationCount: keys.length,
    bibEntryCount: bibKeys.length,
    nociteAll,
    perKey,
  };
}
