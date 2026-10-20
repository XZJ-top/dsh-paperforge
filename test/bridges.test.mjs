import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { createProject, loadProject } from "../lib/project.js";
import { readText, writeFileAtomic } from "../lib/fsutil.js";
import { registerTools } from "../lib/tools.js";

let workRoot;
let tools;
let calls;

const config = () => ({
  papersRoot: workRoot,
  latex: { engine: "auto", latexmk: "", timeoutMs: 60000 },
  bib: { timeoutMs: 5000, queryLimit: 4, userAgent: "test" },
  reviewer: { provider: "spawn", timeoutMs: 60000 },
  export: { zip: false },
});

/** 构造一个最小 cordis ctx：捕获注册的工具，并按名字返回 mock 定义。 */
function makeCtx(mocks) {
  const registered = new Map();
  return {
    registered,
    tools: {
      register(definition) {
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
      get(name) {
        return mocks[name];
      },
    },
    effect() {
      return () => {};
    },
  };
}

const mock = (execute) => ({ execute });

before(async () => {
  workRoot = await mkdtemp(join(tmpdir(), "paperforge-bridges-"));
});

after(async () => {
  if (workRoot) await rm(workRoot, { recursive: true, force: true }).catch(() => {});
});

function setupMocks({ selectedName = "我的论文集合", collections = [], saveStatus = "saved" } = {}) {
  calls = [];
  return makeCtx({
    zotero_status: mock(async () => ({
      ok: true,
      backend: "local",
      selected: { name: selectedName, key: "CUR", expectedTarget: "C2", editable: true },
    })),
    zotero_collections: mock(async () => ({
      ok: true,
      collections: collections.map((name, i) => ({ key: `K${i + 1}`, name })),
    })),
    zotero_save: mock(async (args) => {
      calls.push(["zotero_save", args]);
      return {
        ok: true,
        results: (args.identifiers ?? []).map((doi) => ({ status: saveStatus, paper: { doi, title: `T ${doi}` } })),
        saved: saveStatus === "saved" ? (args.identifiers ?? []).length : 0,
      };
    }),
    obsidian_read: mock(async ({ path }) => {
      calls.push(["obsidian_read", path]);
      return { ok: true, path, sha256: "abc123", content: "old" };
    }),
    obsidian_write: mock(async (args) => {
      calls.push(["obsidian_write", args.path, args.mode]);
      return { ok: true, path: args.path, mode: args.mode, sha256: `sha-${args.path}` };
    }),
  });
}

async function makeProject(slug) {
  const { project, paths } = await createProject(config(), { slug, title: `测试论文 ${slug}`, lang: "zh" });
  await writeFileAtomic(
    paths.bib,
    `@article{a2020one,
  title = {One},
  author = {A, A.},
  journal = {J},
  year = {2020},
  doi = {10.1000/one}
}

@article{b2021two,
  title = {Two},
  author = {B, B.},
  journal = {J},
  year = {2021},
  doi = {10.1000/two}
}
`,
  );
  return { project, paths };
}

describe("paper_zotero_sync", () => {
  it("reports NEED_COLLECTION when the target collection does not exist", async () => {
    const ctx = setupMocks({ selectedName: "其他集合", collections: ["其他集合"] });
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_zotero_sync");
    assert.ok(tool, "tool registered");
    await makeProject("z-need-collection");
    const result = await tool.execute({ slug: "z-need-collection" }, {});
    assert.equal(result.ok, false);
    assert.equal(result.decision, "need_collection");
    assert.match(result.hint, /新建集合/);
    assert.equal(calls.filter((c) => c[0] === "zotero_save").length, 0);
  });

  it("saves when the current selection matches the target collection", async () => {
    const ctx = setupMocks({ selectedName: "我的论文集合", collections: ["我的论文集合"] });
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_zotero_sync");
    await makeProject("z-match");
    const result = await tool.execute({ slug: "z-match", collection: "我的论文集合" }, {});
    assert.equal(result.total, 2);
    assert.equal(result.saved, 2);
    assert.equal(result.duplicates, 0);
    assert.equal(result.failed, 0);
    const payload = calls.find((c) => c[0] === "zotero_save")[1];
    assert.equal(payload.expectedTarget, "C2");
    assert.deepEqual(payload.identifiers.sort(), ["10.1000/one", "10.1000/two"]);
  });

  it("asks for confirmation before creating a collection", async () => {
    const ctx = setupMocks({ selectedName: "其他集合", collections: ["其他集合"] });
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_zotero_sync");
    await makeProject("z-confirm");
    const result = await tool.execute({ slug: "z-confirm", collection: "新集合", create_collection: true }, {});
    assert.equal(result.ok, false);
    assert.equal(result.decision, "confirm_create");
    assert.match(result.hint, /确认/);
    assert.equal(calls.filter((c) => c[0] === "zotero_save").length, 0);
  });

  it("force saves into the current collection with a warning", async () => {
    const ctx = setupMocks({ selectedName: "别的集合", collections: ["别的集合"] });
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_zotero_sync");
    await makeProject("z-force");
    const result = await tool.execute({ slug: "z-force", collection: "论文目标集合", force: true }, {});
    assert.equal(result.saved, 2);
    assert.match(result.warning, /force/);
    assert.equal(result.coerced, true);
  });

  it("dry_run does not write", async () => {
    const ctx = setupMocks({ selectedName: "我的论文集合", collections: ["我的论文集合"] });
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_zotero_sync");
    await makeProject("z-dry");
    const result = await tool.execute({ slug: "z-dry", dry_run: true }, {});
    assert.equal(result.dryRun, true);
    assert.equal(result.decision, "need_collection");
    assert.equal(calls.filter((c) => c[0] === "zotero_save").length, 0);
  });
});

describe("paper_obsidian_archive", () => {
  it("writes five notes into the default directory", async () => {
    const ctx = setupMocks();
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_obsidian_archive");
    assert.ok(tool, "tool registered");
    await makeProject("obs-default");
    const result = await tool.execute({ slug: "obs-default" }, {});
    assert.equal(result.dir, "Paperforge/obs-default");
    assert.equal(result.count, 5);
    const writes = calls.filter((c) => c[0] === "obsidian_write");
    assert.equal(writes.length, 5);
    assert.ok(writes.every((w) => w[1].startsWith("Paperforge/obs-default/")));
    // 目标已存在（mock read 返回 sha）→ replace
    assert.ok(writes.every((w) => w[2] === "replace"));
  });

  it("uses a custom directory and create mode", async () => {
    const ctx = setupMocks();
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_obsidian_archive");
    await makeProject("obs-custom");
    const result = await tool.execute({ slug: "obs-custom", dir: "科研/线粒体", mode: "create" }, {});
    assert.equal(result.dir, "科研/线粒体");
    const writes = calls.filter((c) => c[0] === "obsidian_write");
    assert.ok(writes.every((w) => w[1].startsWith("科研/线粒体/") && w[2] === "create"));
  });

  it("fails clearly when the bridge plugin is absent", async () => {
    const ctx = makeCtx({});
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_obsidian_archive");
    await makeProject("obs-missing");
    const result = await tool.execute({ slug: "obs-missing" }, {});
    assert.equal(result.error?.code, "OBSIDIAN_UNAVAILABLE");
  });
});

describe("paper_review", () => {
  it("uses the injected subagents service and records the verdict", async () => {
    const ctx = setupMocks();
    let called = null;
    const fakeSubagents = {
      getProvider(name) {
        return name === "spawn"
          ? { label: "spawn", capabilities: { outputSchema: true }, inheritsParentContext: false }
          : undefined;
      },
      providers: {},
      async startActivation(request) {
        called = request;
        return {
          result: Promise.resolve({
            stopReason: "completed",
            structured: {
              verdict: "WARN",
              issues: [{ severity: "minor", location: "sections/00-abstract.tex", problem: "摘要过长", suggestion: "压缩到 300 字" }],
              integrity: { fabricatedCitations: false, unsupportedClaims: false, missingDataProvenance: false, notes: "" },
              summary: "结构完整，局部需修",
            },
          }),
          dispose: async () => {},
        };
      },
    };
    registerTools(ctx, { config: config(), getSubagents: () => fakeSubagents });
    const tool = ctx.registered.get("paper_review");
    assert.ok(tool, "paper_review registered");
    await makeProject("review-ok");
    const result = await tool.execute({ slug: "review-ok" }, {});
    assert.equal(result.verdict, "WARN");
    assert.equal(result.issues.length, 1);
    assert.ok(called, "startActivation called");
    assert.equal(called.request.outputSchema.type, "object");
    assert.ok(!("persona" in called.request), "spawn 不支持 persona，不应传");
    const project = await loadProject(config(), "review-ok");
    assert.equal(project.review.at(-1).verdict, "WARN");
  });

  it("returns REVIEWER_UNAVAILABLE when subagents is absent", async () => {
    const ctx = makeCtx({});
    registerTools(ctx, { config: config(), getSubagents: () => null });
    const tool = ctx.registered.get("paper_review");
    await makeProject("review-missing");
    const result = await tool.execute({ slug: "review-missing" }, {});
    assert.equal(result.error?.code, "REVIEWER_UNAVAILABLE");
  });
});

describe("paper_outline", () => {
  it("keeps section text when the order changes", async () => {
    const ctx = makeCtx({});
    registerTools(ctx, { config: config() });
    const tool = ctx.registered.get("paper_outline");
    const { paths } = await makeProject("outline-order");

    await tool.execute({ slug: "outline-order", sections: [{ title: "引言" }, { title: "方法" }] }, {});
    const first = await loadProject(config(), "outline-order");
    const intro = first.outline.find((s) => s.title === "引言");
    assert.ok(intro, "introduction created");
    assert.equal(intro.id, "introduction");
    await writeFileAtomic(join(paths.root, intro.file), "引言正文");

    // 交换顺序后，正文必须跟着 section 走，而不是留在旧文件名里。
    await tool.execute({ slug: "outline-order", sections: [{ title: "方法" }, { title: "引言" }] }, {});
    const second = await loadProject(config(), "outline-order");
    const intro2 = second.outline.find((s) => s.title === "引言");
    assert.notEqual(intro2.file, intro.file);
    assert.equal(await readText(join(paths.root, intro2.file), ""), "引言正文");
  });
});
