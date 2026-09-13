/**
 * amsgFirePerspective — 主动消息 fire 链的「透视窗」工具声明。
 *
 * 前台的透视窗走 [[TOKEN]] 正文协议（见 chatPrompts 5.11 节 / aPost 二段处理），
 * worker 的 fire 轮次里没有文本协议解析（那边只认 native function calling），
 * 所以这里给两枚工具声明，参数语义与前台 [[PERSPECTIVE_QUERY]] / [[PERSPECTIVE_SUMMARY]]
 * 一致；执行统一落在 dispatchAgenticTool 的 perspective_query / perspective_summary
 * （utils/agenticTools.ts），凭据经 per-char tool_pack 的角色只读令牌透传。
 *
 * 只在 pack.perspectiveEnabled 且 tool_config 带 Worker 端点时由 worker 注入 tools，
 * 关闭的角色连声明都看不到，不会凭空多出「我去看了一眼」的幻觉。
 */

export const PERSPECTIVE_QUERY_FIRE_TOOL = 'perspective_query';
export const PERSPECTIVE_SUMMARY_FIRE_TOOL = 'perspective_summary';

export interface PerspectiveFireToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export const buildPerspectiveFireTools = (): PerspectiveFireToolDef[] => [
  {
    type: 'function',
    function: {
      name: PERSPECTIVE_QUERY_FIRE_TOOL,
      description: [
        '查看用户（机主）最近使用过哪些应用、每个应用大概停留多久：应用身份与会话时长。',
        '没有聊天内容，没有窗口标题与网址。仅在当下对话有真实需要时才调用（机主问起、聊到作息等）；不要定期例行查看，两次调用之间也有冷却间隔。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '想看最近几天（默认与上限按机主配置走）。' },
          appKey: { type: 'string', description: '可选，只看某个应用（包名/进程名/应用名子串匹配）。' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: PERSPECTIVE_SUMMARY_FIRE_TOOL,
      description: [
        '看用户近几天的应用使用总结：常用应用、深夜活跃、单日峰值等统计要点。',
        '数据量大时比 perspective_query 更合适（返回的是提炼过的总结而不是原始会话）。同样只在有真实理由时调用，不要例行查看。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: '总结最近几天。' },
        },
      },
    },
  },
];
