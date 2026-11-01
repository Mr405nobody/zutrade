import {
  aiInputSchema,
  aiOutputSchema,
  AI_SCENARIO_VERSION,
  AI_FAQ_VALUES,
} from '@zutrade/contracts';
import type { AIInput, AIOutput } from '@zutrade/contracts';
export type AIExecutionMode = 'mock' | 'preset';
export interface AIProvider {
  readonly provider: string;
  readonly modelId: string;
  generate(input: AIInput, signal?: AbortSignal): Promise<unknown>;
}
export const normalizeAIText = (text: string) =>
  text.normalize('NFC').replace(/\r\n?/g, '\n').trim().replace(/\s+/g, ' ').toLowerCase();
export const scenarios = [
  {
    id: 'material',
    input: 'What material is CT-01 made of?',
    description: '已确认材质；受控 FAQ 模板 v1',
  },
  {
    id: 'dimensions',
    input: 'What are the dimensions of CT-01?',
    description: '已确认尺寸；受控 FAQ 模板 v1',
  },
  {
    id: 'quote500',
    input: 'Please quote 500 CT-01 bags.',
    description: '500 件；需求建议→确定性报价→owner 审批',
  },
  {
    id: 'quantity800',
    input: 'Change the quantity to 800 CT-01 bags.',
    description: '800 件；新需求和新报价，旧版本重核',
  },
  { id: 'discount', input: 'Can you give a discount?', description: '折扣须正常商业审批' },
  {
    id: 'arrival',
    input: 'Can you guarantee arrival within six weeks?',
    description: '到货保证须 owner/工厂确认',
  },
  {
    id: 'sample',
    input: 'How much does a sample cost?',
    description: '不推测样品费，转确认与审批',
  },
  {
    id: 'retrieval',
    input: 'Please find confirmed CT-01 product documents.',
    description: '仅创建内部资料请求，不执行网络或工具',
  },
  {
    id: 'followup',
    input: 'Please suggest a follow-up for CT-01.',
    description: '固定业务时钟的提醒建议，不自动发送',
  },
] as const;
export function scenarioFor(text: string) {
  const n = normalizeAIText(text);
  return (
    scenarios.find((s) => normalizeAIText(s.input) === n)?.id ??
    (/ignore|bypass|绕过|忽略.*审批/.test(n) ? 'injection' : 'unsupported')
  );
}
export function faqBody(kind: 'material' | 'dimensions', ctx: AIInput['context']) {
  const s = ctx.facts[0]?.specifications;
  if (!s) return null;
  return kind === 'material'
    ? `The confirmed material of CT-01 is ${s.fabric}.`
    : `The confirmed dimensions of CT-01 are ${s.dimensions}.`;
}
/** No DB, networking, tools, approval or channel capabilities are passed to providers. */
export class MockAIProvider implements AIProvider {
  readonly provider = 'zutrade-mock';
  readonly modelId = 'ct01-presets-v1';
  async generate(raw: AIInput, signal?: AbortSignal): Promise<AIOutput> {
    signal?.throwIfAborted();
    const input = aiInputSchema.parse(raw),
      id = scenarioFor(input.text),
      ctx = input.context;
    const out: AIOutput = {
      schemaVersion: 'e-output.v1',
      scenarioId: id,
      scenarioVersion: AI_SCENARIO_VERSION,
      status: 'suggestion',
      task: input.task,
      summary: '',
      reason: null,
      evidence: [],
      faq: null,
      quantity: null,
      retrieval: null,
      followup: null,
      requiresApproval: false,
    };
    const human = (reason: string) => {
      out.status = 'needs_human';
      out.reason = reason;
      out.summary = reason;
      return aiOutputSchema.parse(out);
    };
    if (id === 'injection') return human('外部输入要求绕过权限或审批；不执行指令，请人工处理');
    if (id === 'unsupported' || ctx.sku !== 'CT-01')
      return human('输入超出 CT-01 v1 预设范围，需人工处理');
    if (ctx.controlMode === 'human' || ctx.paused)
      return human('会话已人工接管或暂停，停止自动路径');
    if (id === 'discount' || id === 'arrival' || id === 'sample') {
      out.requiresApproval = true;
      return human(
        id === 'arrival'
          ? '六周到货未获确认，需 owner/工厂确认并审批'
          : id === 'discount'
            ? '折扣须填写正式报价并由指定 owner 审批'
            : '样品费用未知，须工厂确认并走正常业务审批',
      );
    }
    if (id === 'retrieval' || input.task === 'retrieval') {
      out.retrieval = { request: '请工厂提供当前有效且允许对外披露的 CT-01 资料，并由 owner 确认' };
      return human('仅生成内部资料检索请求，不编造或发布事实');
    }
    if (!ctx.facts.length) {
      out.retrieval = { request: '确认 CT-01 资料的来源、有效期与披露范围' };
      return human('没有有效且允许披露的事实，需要工厂确认');
    }
    out.evidence = ctx.facts.flatMap((f) => f.evidence);
    if (new Set(ctx.facts.map((f) => JSON.stringify(f.specifications))).size !== 1)
      return human('资料相互冲突，需要人工核对来源');
    if (id === 'material' || id === 'dimensions') {
      const field =
        id === 'material'
          ? ctx.facts[0]!.specifications.fabric
          : ctx.facts[0]!.specifications.dimensions;
      if (!(AI_FAQ_VALUES[id] as readonly string[]).includes(field))
        return human('事实字段超出审核模板允许值，需要人工处理');
      if (input.task !== 'answer') return human('该场景仅支持普通问答建议');
      out.faq = { templateId: id, templateVersion: 1, body: faqBody(id, ctx)! };
      out.summary = out.faq.body;
    } else if (id === 'quote500' || id === 'quantity800') {
      if (!['requirements', 'quote_input'].includes(input.task))
        return human('数量场景仅支持需求提取或报价输入建议');
      out.quantity = id === 'quote500' ? '500' : '800';
      out.requiresApproval = true;
      out.summary = `建议数量 ${out.quantity} 件；采用后保存需求，金额由正常报价计算器生成，外发须 owner 审批`;
    } else if (id === 'followup') {
      if (input.task !== 'followup') return human('该场景仅支持跟进建议');
      out.followup = {
        purpose: '确认 CT-01 需求',
        suggestedAt: new Date(Date.parse(input.businessClock) + 86400000).toISOString(),
        internalDraft: '请核对当前需求及目的地后安排人工跟进。',
      };
      out.summary = '建议建立内部提醒；固定时钟日期仅作场景建议，采用时必须另选未来时间';
    }
    return aiOutputSchema.parse(out);
  }
}
