/**
 * Zotero 本地 API 的写侧能力：建集合、把条目归入集合。
 *
 * 背景：dsh-zotero-paperbridge 的 local 后端只走 connector（保存到「当前选中
 * 集合」），没有建集合的工具；Zotero 本地 API 的写操作需要一次性授权
 * （`POST /api/local/authorize`，客户端弹窗由用户确认）。本模块复用那次授权
 * 得到的本地 key，补齐「新建目录 + 归档」这一步。
 *
 * 安全约束：建集合是显式动作，调用方必须已获得用户确认（confirmed=true）；
 * 本模块只负责执行，不自行决定。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PaperError } from "./bibtex.js";

const DEFAULT_BASE = "http://localhost:23119";

/** 优先环境变量，其次 DSH 凭据文件里的 refs。<ref>: <value>。 */
export async function resolveLocalKey(ref = "ZOTERO_LOCAL_API_KEY") {
  if (process.env[ref]) return process.env[ref];
  const file = join(homedir(), ".dsh", ".credentials.yaml");
  const text = await readFile(file, "utf8").catch(() => "");
  const match = text.match(new RegExp(`^\\s*${ref}:\\s*(.+)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function headersFor(key, extra = {}) {
  return {
    accept: "application/json",
    "Zotero-API-Version": "3",
    ...(key ? { "Zotero-API-Key": key } : {}),
    ...extra,
  };
}

export function createZoteroLocal(options = {}) {
  const baseUrl = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30000;
  const key = options.key ?? "";

  async function request(path, { method = "GET", body, extraHeaders = {} } = {}) {
    const url = `${baseUrl}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: headersFor(key, {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...extraHeaders,
        }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PaperError(
        "ZOTERO_LOCAL_UNAVAILABLE",
        `Zotero 本地 API 不可达（${url}）：${error?.message ?? error}。请确认 Zotero 正在运行。`,
      );
    }
    const text = await response.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = null;
    }
    return { status: response.status, ok: response.ok, headers: response.headers, value, text };
  }

  /** 拿 server id / 版本 / 集合列表（读操作不需要写权限）。 */
  async function status() {
    const probe = await request("/api/users/0/collections?limit=1");
    if (probe.status === 401 || probe.status === 403) {
      throw new PaperError("ZOTERO_LOCAL_UNAUTHORIZED", "Zotero 本地 API 拒绝了请求：请重新执行一次本地授权。");
    }
    const serverId = probe.headers.get("zotero-server-id") ?? "";
    const version = probe.headers.get("last-modified-version") ?? "";
    const list = await request("/api/users/0/collections?format=json&limit=100");
    const collections = Array.isArray(list.value)
      ? list.value.map((c) => ({ key: c.key, name: c.data?.name ?? c.name ?? "" }))
      : [];
    return { serverId, version, collections };
  }

  /** 创建集合（调用方必须先拿到用户确认）。 */
  async function createCollection(name, { confirmed = false, serverId, version } = {}) {
    if (!confirmed) {
      throw new PaperError(
        "CONFIRM_REQUIRED",
        `新建 Zotero 集合「${name}」需要用户确认：请先询问用户，得到同意后传 confirmed=true。`,
      );
    }
    if (!key) {
      throw new PaperError(
        "ZOTERO_LOCAL_KEY_MISSING",
        "缺少 Zotero 本地 API key：请先完成一次本地授权（Zotero 弹窗确认），并把 key 写入凭据 ZOTERO_LOCAL_API_KEY。",
      );
    }
    const state = serverId && version ? { serverId, version } : await status();
    const response = await request("/api/users/0/collections", {
      method: "POST",
      body: [{ name, parentCollection: false }],
      extraHeaders: {
        "Zotero-Server-ID": state.serverId,
        "If-Unmodified-Since-Version": state.version,
      },
    });
    if (!response.ok) {
      throw new PaperError(
        "ZOTERO_COLLECTION_CREATE_FAILED",
        `创建集合失败（HTTP ${response.status}）：${response.text.slice(0, 200)}`,
      );
    }
    const created = response.value?.successful?.["0"];
    if (!created?.key) {
      throw new PaperError("ZOTERO_COLLECTION_CREATE_FAILED", "Zotero 未返回新集合 key。");
    }
    return { key: created.key, name };
  }

  /** 把若干条目归入集合（保留原有集合归属）。 */
  async function assignItems(itemKeys, collectionKey, { fetchItem, titleHints = {} } = {}) {
    if (!key) {
      throw new PaperError("ZOTERO_LOCAL_KEY_MISSING", "缺少 Zotero 本地 API key。");
    }
    const updated = [];
    const failed = [];
    // 循环外取一次 server id，避免每个条目都多打一次 /collections。
    const serverId = (await status()).serverId;
    for (const itemKey of itemKeys) {
      try {
        const detail = await (fetchItem ? fetchItem(itemKey) : request(`/api/users/0/items/${itemKey}`));
        let data = detail?.value?.data ?? detail?.value ?? null;
        let version = detail?.value?.version ?? null;
        if (!data) {
          // 个别条目单条路由会 404（本地 API 的已知怪癖），退化为列表查询。
          const list = await request(`/api/users/0/items?itemKey=${encodeURIComponent(itemKey)}&format=json&limit=1`);
          let hit = Array.isArray(list.value) ? list.value[0] : null;
          if (!hit && titleHints[itemKey]) {
            const search = await request(
              `/api/users/0/items?q=${encodeURIComponent(titleHints[itemKey])}&format=json&limit=10`,
            );
            hit = Array.isArray(search.value) ? search.value.find((x) => x.key === itemKey) ?? null : null;
          }
          if (!hit) {
            const page = await request("/api/users/0/items/top?format=json&limit=100");
            hit = Array.isArray(page.value) ? page.value.find((x) => x.key === itemKey) ?? null : null;
          }
          if (!hit) {
            failed.push({ itemKey, reason: "条目不可读" });
            continue;
          }
          data = hit.data ?? hit;
          version = hit.version ?? data.version ?? null;
        }
        const current = Array.isArray(data.collections) ? data.collections : [];
        if (current.includes(collectionKey)) {
          updated.push({ itemKey, already: true });
          continue;
        }
        const patch = await request(`/api/users/0/items/${itemKey}`, {
          method: "PATCH",
          body: { collections: [...current, collectionKey] },
          extraHeaders: {
            "Zotero-Server-ID": serverId,
            "If-Unmodified-Since-Version": String(version ?? ""),
          },
        });
        if (patch.ok) updated.push({ itemKey });
        else failed.push({ itemKey, reason: `HTTP ${patch.status}` });
      } catch (error) {
        failed.push({ itemKey, reason: error?.message ?? String(error) });
      }
    }
    return { updated, failed };
  }

  return { status, createCollection, assignItems };
}
