/**
 * 跨插件工具桥：paperforge 通过宿主 tools registry 调用其它 dsh 插件注册的工具。
 *
 * 目的：论文文献归档走 dsh-zotero-paperbridge，方法与数据说明归档走
 * dsh-obsidian-vaultbridge，不重复实现这两套客户端。
 */
import { PaperError } from "./bibtex.js";

function pickDefinition(ctx, name) {
  try {
    const definition = ctx?.tools?.get?.(name);
    if (definition && typeof definition.execute === "function") return definition;
  } catch {
    /* registry 未就绪 */
  }
  return null;
}

/** 桥接器：探测与调用另一个插件注册的工具。 */
export function createBridge(ctx) {
  const call = async (name, args, exec) => {
    const definition = pickDefinition(ctx, name);
    if (!definition) {
      throw new PaperError(
        "TOOL_UNAVAILABLE",
        `工具 ${name} 不可用：请确认对应 dsh 插件已安装并在当前 profile 中启用。`,
      );
    }
    const value = await definition.execute(args ?? {}, {
      signal: exec?.signal,
      agent: exec?.agent,
      arguments: args ?? {},
    });
    return value;
  };

  return {
    has: (name) => Boolean(pickDefinition(ctx, name)),
    call,
    /** 调用并解包：插件工具统一返回 { ok, ... }。 */
    async callOk(name, args, exec) {
      const value = await call(name, args, exec);
      if (value && value.ok === false) {
        const code = value.error?.code ?? "TOOL_FAILED";
        const message = value.error?.message ?? `工具 ${name} 返回失败`;
        throw new PaperError(code, `${name}: ${message}`);
      }
      return value;
    },
  };
}
