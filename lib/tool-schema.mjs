/**
 * 把「参数说明书」编译成 JSON Schema。
 *
 * 为什么需要这层：`@deepseek-ai/dsh-tools` 是 peerDependency，**从 npm 安装时插件解析不到**
 * （pnpm/npm 不替依赖装 peer），所以拿不到宿主的 defineTool。若原样把
 * `{ 参数名: { type, description } }` 下发，function schema 会缺少 `type`；
 * 空参数更是直接变成 `{"type": null}`。DeepSeek API 会以
 * `Invalid schema for function 'xxx'` 拒掉**整轮请求**——表现是对话彻底卡死，
 * 而不是单个工具不可用。
 *
 * 宿主提供了 defineTool 时优先用它，但会校验产物：不同 DSH 版本对空参数的处理不一致，
 * 产物不合规就退回本地编译。
 */

/** 本地编译：{ 参数名: { type, required, description } } → { type:'object', properties, required } */
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
