/**
 * dsh-paperforge — Cordis 插件入口。
 *
 * 注册 11 个 paper_* 工具、7 个 /paper-* 命令、1 个 paper-writing skill。
 * 零 `@deepseek-ai/*` 运行时依赖：profile 插件无法解析宿主 workspace 包。
 */
import { Config, resolveConfig } from "./lib/config.js";
import { registerCommands } from "./lib/commands.js";
import { PAPER_WRITING_SKILL } from "./lib/skill.js";
import { registerTools } from "./lib/tools.js";

export { Config };

export const name = "paperforge";

/** `tools` / `commands` 必须在顶层声明；`skills` 用动态注入，缺失时不影响插件加载。 */
export const inject = ["tools", "commands"];

export function apply(ctx, config) {
  const resolved = resolveConfig(config);
  const disposers = [];

  // subagents 按需注入：没有它时 paper_review 返回 REVIEWER_UNAVAILABLE，其余工具不受影响。
  let subagents = null;
  try {
    ctx.inject(["subagents"], (subCtx) => {
      subagents = subCtx.subagents;
    });
  } catch (error) {
    console.error("[paperforge] subagents 注入失败（paper_review 将不可用）：", error?.message ?? error);
  }

  try {
    disposers.push(registerTools(ctx, { config: resolved, getSubagents: () => subagents }));
    console.log(`[paperforge] 已注册 11 个 paper_* 工具（papersRoot=${resolved.papersRoot}）`);
  } catch (error) {
    console.error("[paperforge] 工具注册失败：", error?.stack ?? error);
  }

  try {
    disposers.push(registerCommands(ctx, { config: resolved, getSubagents: () => subagents }));
    console.log("[paperforge] 已注册 7 个 /paper-* 命令");
  } catch (error) {
    console.error("[paperforge] 命令注册失败：", error?.stack ?? error);
  }

  try {
    ctx.inject(["skills"], (skillsCtx) => {
      skillsCtx.skills.register({
        name: PAPER_WRITING_SKILL.name,
        description: PAPER_WRITING_SKILL.description,
        whenToUse: PAPER_WRITING_SKILL.whenToUse,
        content: PAPER_WRITING_SKILL.content,
        source: "bundled",
      });
      console.log("[paperforge] 已注册 skill：paper-writing");
    });
  } catch (error) {
    console.error("[paperforge] skill 注册失败：", error?.stack ?? error);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* 已释放 */
      }
    }
  }, "paperforge.dispose");
}
