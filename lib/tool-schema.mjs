/**
 * 把「参数说明书」编译成 JSON Schema —— 本插件**不 import** `@deepseek-ai/dsh-tools`。
 *
 * 为什么：dsh-tools 里 `TOOL_RUNTIME_SCHEDULER` 是模块内 `Symbol(...)`。只要进程里出现
 * 第二份物理副本（插件把它当依赖装了、或旧版本残留在 profile 的 node_modules 里），
 * 模块身份就对不上，宿主 agent-loop 的 `ctx.tools[symbol]` 变成 undefined，
 * 第一次工具调用就抛 `Cannot read properties of undefined (reading 'prepare')`，
 * 还会在会话里留下孤儿 tool_calls，之后每轮 400。
 * 见 deepseek-harness#1486 / #3033，官方建议正是"插件不要依赖框架内部包"。
 *
 * 自己产出的工具对象是纯数据（name/description/parameters/output/execute），宿主照样消费，
 * 完全不碰那份 Symbol，也就没有副本问题。
 *
 * 约束：空参数也必须产出 `{ type:'object', properties:{} }`；缺了 `type` 会被 API 以
 * `Invalid schema for function` 拒掉整轮请求。
 *//** 本地编译：{ 参数名: { type, required, description } } → { type:'object', properties, required } */
export function localDefineTool(spec) {
  const map = spec.parameters || {};
  const properties = {};
  const required = [];
  for (const [name, desc] of Object.entries(map)) {
    const { required: isRequired, ...schema } = desc || {};
    properties[name] = schema;
    if (isRequired) required.push(name);
  }
  return {
    ...spec,
    parameters: { type: 'object', properties, ...(required.length ? { required } : {}) },
  };
}

/** 是否是一份可接受的 function 参数 schema。 */
export function isUsableSchema(tool) {
  const p = tool && tool.parameters;
  return !!p && p.type === 'object' && typeof p.properties === 'object' && p.properties !== null;
}

/**
 * 用宿主的 defineTool（若提供且产物合规），否则用本地编译。
 * @param {Function|null|undefined} hostDefineTool
 */
export function defineToolWith(hostDefineTool) {
  return (spec) => {
    if (typeof hostDefineTool === 'function') {
      try {
        const out = hostDefineTool(spec);
        if (isUsableSchema(out)) return out;
      } catch { /* 退回本地编译 */ }
    }
    return localDefineTool(spec);
  };
}
