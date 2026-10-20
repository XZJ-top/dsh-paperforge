import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { auditCitations, extractCiteKeys, parseBibEntries } from "../lib/audit.js";
import {
  appendBibtex,
  bibFingerprints,
  makeCitationKey,
  normalizeArxivId,
  normalizeDoi,
  parseBibKeys,
  toBibtex,
  uniqueKey,
} from "../lib/bibtex.js";
import { parseLatexLog } from "../lib/compile.js";
import { exportProject } from "../lib/export.js";
import { readText, writeFileAtomic } from "../lib/fsutil.js";
import {
  countChars,
  countCites,
  createProject,
  escapeLatex,
  findSection,
  loadProject,
  projectPaths,
  renderMainTex,
  saveProject,
  slugify,
  validateSlug,
} from "../lib/project.js";
import { compileProject, detectEngine } from "../lib/compile.js";

let workRoot;

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "paperforge-test-"));
});

after(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

const config = () => ({
  papersRoot: workRoot,
  latex: { engine: "auto", latexmk: "", timeoutMs: 240000 },
  bib: { timeoutMs: 30000, queryLimit: 8, userAgent: "dsh-paperforge-test" },
  reviewer: { provider: "spawn", timeoutMs: 60000 },
  export: { zip: false },
});

describe("slug / latex helpers", () => {
  it("slugifies ASCII and keeps CJK", () => {
    assert.equal(slugify("Attention Is All You Need"), "attention-is-all-you-need");
    assert.match(slugify("基于 RefSeq 的密码子偏好分析"), /密码子偏好分析/);
  });

  it("rejects traversal and illegal names", () => {
    assert.equal(validateSlug("../etc").ok, false);
    assert.equal(validateSlug("a/b").ok, false);
    assert.equal(validateSlug("CON").ok, false);
    assert.equal(validateSlug("good-slug").ok, true);
  });

  it("escapes backslash without corrupting the generated command", () => {
    assert.equal(escapeLatex("a\\b"), "a\\textbackslash{}b");
    assert.equal(escapeLatex("{NumPy}"), "\\{NumPy\\}");
  });

  it("escapes LaTeX specials", () => {
    assert.equal(escapeLatex("A & B 100% #1 _x_"), "A \\& B 100\\% \\#1 \\_x\\_");
  });

  it("counts CJK chars and citations", () => {
    assert.ok(countChars("本文提出一种方法。") >= 7);
    assert.equal(countCites("见 \\cite{a,b} 与 \\citep[p.~1]{c}"), 3);
  });
});

describe("project lifecycle", () => {
  it("creates a Chinese ctexart project", async () => {
    const { created, project, paths } = await createProject(config(), {
      slug: "zh-demo",
      title: "测试论文：方法与应用",
      lang: "zh",
    });
    assert.equal(created, true);
    assert.equal(project.template, "ctexart");
    const main = await readFile(paths.main, "utf8");
    assert.match(main, /\\documentclass\[UTF8,a4paper,11pt,fontset=windows\]\{ctexart\}/);
    assert.match(main, /gbt7714/);
    assert.match(main, /\\input\{sections\/00-abstract\}/);
  });

  it("does not overwrite an existing project", async () => {
    const { created } = await createProject(config(), { slug: "zh-demo", title: "另一个标题" });
    assert.equal(created, false);
    const project = await loadProject(config(), "zh-demo");
    assert.equal(project.title, "测试论文：方法与应用");
  });

  it("renders outline order into main.tex", async () => {
    const cfg = config();
    const { project, paths } = await createProject(cfg, { slug: "outline-demo", title: "Outline Demo", lang: "zh" });
    const sections = [
      { title: "引言" },
      { title: "材料与方法" },
      { title: "结果" },
    ];
    const used = new Set(["abstract"]);
    project.outline = [
      project.outline[0],
      ...sections.map((s, index) => ({
        id: ["intro", "methods", "results"][index],
        title: s.title,
        level: 1,
        file: `sections/0${index + 1}-${["intro", "methods", "results"][index]}.tex`,
        status: "todo",
        chars: 0,
        cites: 0,
      })),
    ];
    used.clear();
    await saveProject(cfg, project);
    for (const section of project.outline.slice(1)) {
      await writeFileAtomic(join(paths.root, section.file), "");
    }
    await writeFileAtomic(paths.main, renderMainTex(project));
    const main = await readFile(paths.main, "utf8");
    const order = [...main.matchAll(/\\input\{sections\/([^}]+)\}/g)].map((m) => m[1]);
    assert.deepEqual(order, ["00-abstract", "01-intro", "02-methods", "03-results"]);
    assert.match(main, /\\section\{引言\}/);
    assert.equal(findSection(project, "methods")?.title, "材料与方法");
  });
});

describe("citation audit", () => {
  const bib = `@article{alpha2020one,
  title = {One},
  author = {Alpha, A.},
  year = {2020},
  doi = {10.1000/one}
}

@article{beta2021two,
  title = {Two},
  author = {Beta, B.},
  year = {2021},
  doi = {10.1000/two}
}
`;

  it("extracts cite-family keys", () => {
    const { keys } = extractCiteKeys(["\\cite{a} \\citep{b,c} \\textcite{d}"]);
    assert.deepEqual(keys, ["a", "b", "c", "d"]);
  });

  it("reports missing / uncited", () => {
    const audit = auditCitations(["\\cite{alpha2020one} \\cite{ghost2024}"], bib);
    assert.deepEqual(audit.missingInBib, ["ghost2024"]);
    assert.deepEqual(audit.uncited, ["beta2021two"]);
    assert.equal(audit.bibEntryCount, 2);
  });

  it("detects duplicate bib keys", () => {
    const duplicated = `${bib}\n@article{alpha2020one,\n  title = {Dup}\n}\n`;
    const audit = auditCitations(["\\cite{alpha2020one}"], duplicated);
    assert.deepEqual(audit.duplicateKeys, ["alpha2020one"]);
    assert.equal(parseBibEntries(duplicated).length, 3);
  });

  it("treats \\nocite{*} as all cited", () => {
    const audit = auditCitations(["\\nocite{*}"], bib);
    assert.deepEqual(audit.uncited, []);
    assert.equal(audit.nociteAll, true);
  });
});

describe("bibtex", () => {
  it("normalizes identifiers", () => {
    assert.equal(normalizeArxivId("arXiv:2401.00001v2"), "2401.00001");
    assert.equal(normalizeArxivId("https://arxiv.org/abs/2401.00001"), "2401.00001");
    assert.equal(normalizeDoi("https://doi.org/10.1038/x"), "10.1038/x");
    assert.equal(normalizeDoi("doi: 10.1038/x"), "10.1038/x");
  });

  it("builds a stable citation key", () => {
    const key = makeCitationKey({ authors: ["Vaswani, Ashish"], year: "2017", title: "Attention is All you Need" });
    assert.equal(key, "vaswani2017attention");
  });

  it("deduplicates by DOI/eprint and suffixes different works", () => {
    const meta = { doi: "10.1000/one", arxivId: "" };
    const prints = new Map([["alpha2020one", "10.1000/one|"]]);
    assert.deepEqual(uniqueKey("alpha2020one", meta, prints), { key: "alpha2020one", duplicate: true });
    const other = uniqueKey("alpha2020one", { doi: "10.1000/other" }, prints);
    assert.equal(other.key, "alpha2020onea");
  });

  it("falls back to title+year when DOI and arXiv are both absent", () => {
    const prints = bibFingerprints("@article{x,\n  title = {Same Title},\n  year = {2020}\n}\n");
    assert.equal(prints.get("x"), "title:same title|2020");
    assert.deepEqual(uniqueKey("x", { title: "Same Title", year: "2020" }, prints), { key: "x", duplicate: true });
    assert.equal(uniqueKey("x", { title: "Other", year: "2020" }, prints).duplicate, false);
  });

  it("renders arXiv entries with eprint fields", () => {
    const block = toBibtex(
      {
        type: "article",
        title: "Attention Is All You Need",
        authors: ["Vaswani, Ashish", "Shazeer, Noam"],
        journal: "arXiv preprint",
        year: "2017",
        volume: "",
        issue: "",
        pages: "",
        publisher: "arXiv",
        arxivId: "1706.03762",
        primaryClass: "cs.CL",
        doi: "",
        url: "https://arxiv.org/abs/1706.03762",
      },
      "vaswani2017attention",
    );
    assert.match(block, /@article\{vaswani2017attention,/);
    assert.match(block, /eprint = \{1706\.03762\}/);
    assert.match(block, /archivePrefix = \{arXiv\}/);
    assert.match(block, /author = \{Vaswani, Ashish and Shazeer, Noam\}/);
    assert.equal(parseBibKeys(appendBibtex("", block)).size, 1);
    assert.equal(bibFingerprints(block).get("vaswani2017attention"), "|1706.03762");
  });
});

describe("latex log parsing", () => {
  it("extracts errors, undefined citations and overfull boxes", () => {
    const log = [
      "This is XeTeX, Version 3.141592653",
      "! Undefined control sequence.",
      "l.42 \\badcommand",
      "LaTeX Warning: Citation `ghost2024' on page 1 undefined on input line 12.",
      "LaTeX Warning: Reference `fig:x' on page 2 undefined on input line 30.",
      "Overfull \\hbox (12.3pt too wide) in paragraph at lines 5--6",
      "! Emergency stop.",
    ].join("\n");
    const parsed = parseLatexLog(log);
    assert.equal(parsed.errors.length, 2);
    assert.equal(parsed.errors[0].line, 42);
    assert.deepEqual(parsed.undefinedCitations, ["ghost2024"]);
    assert.deepEqual(parsed.undefinedReferences, ["fig:x"]);
    assert.equal(parsed.overfullCount, 1);
    assert.equal(parsed.fatal, true);
  });
});

describe("end-to-end compile + export (offline fixture)", () => {
  it("compiles a Chinese paper and exports it", async () => {
    const cfg = config();
    const { project, paths } = await createProject(cfg, {
      slug: "e2e-zh",
      title: "端到端测试：中文论文",
      lang: "zh",
      authors: ["测试作者"],
    });

    project.outline = [
      { id: "abstract", title: "摘要", level: 1, file: "sections/00-abstract.tex", status: "todo", chars: 0, cites: 0 },
      { id: "introduction", title: "引言", level: 1, file: "sections/01-introduction.tex", status: "todo", chars: 0, cites: 0 },
      { id: "methods", title: "方法", level: 1, file: "sections/02-methods.tex", status: "todo", chars: 0, cites: 0 },
    ];
    for (const section of project.outline.slice(1)) {
      await writeFileAtomic(join(paths.root, section.file), "");
    }

    await writeFileAtomic(
      join(paths.root, "sections", "00-abstract.tex"),
      "本文用于验证 paperforge 的编译、引用审计与导出链路。",
    );
    await writeFileAtomic(
      join(paths.root, "sections", "01-introduction.tex"),
      "流水线测试需要一条真实可解析的参考文献\\cite{harris2020array}。",
    );
    await writeFileAtomic(
      join(paths.root, "sections", "02-methods.tex"),
      "方法部分只包含可复现的文本。",
    );

    // fixture：真实 DOI（NumPy 论文），仅用于验证 BibTeX → bibtex → PDF 链路
    await writeFileAtomic(
      paths.bib,
      `@article{harris2020array,
  title = {Array programming with {NumPy}},
  author = {Harris, Charles R. and Millman, K. Jarrod},
  journal = {Nature},
  year = {2020},
  volume = {585},
  pages = {357--362},
  doi = {10.1038/s41586-020-2649-2}
}
`,
    );

    await saveProject(cfg, project);
    await writeFileAtomic(paths.main, renderMainTex(project));

    const engine = await detectEngine(paths.root, "main.tex", [await readText(paths.main)], "auto");
    assert.equal(engine, "xelatex");

    const result = await compileProject({
      root: paths.root,
      entry: "main.tex",
      engine,
      latexmk: cfg.latex.latexmk,
      timeoutMs: cfg.latex.timeoutMs,
    });
    if (result.status !== "passed") {
      console.error("DEBUG compile failed", result.exitCode, JSON.stringify(result.errors), result.stdoutTail);
    }

    assert.equal(
      result.status,
      "passed",
      `编译失败：exit=${result.exitCode} errors=${JSON.stringify(result.errors)} tail=${result.stdoutTail.slice(-800)}`,
    );
    assert.ok(result.pdfBytes > 1000);

    const audit = auditCitations(
      [
        await readText(join(paths.root, "sections", "01-introduction.tex")),
      ],
      await readText(paths.bib),
    );
    assert.deepEqual(audit.missingInBib, []);
    assert.equal(audit.citationCount, 1);

    const exported = await exportProject({ paths, project, zip: false });
    assert.ok(exported.files.includes("main.pdf"));
    assert.ok(exported.pdfBytes > 1000);
  });
});
