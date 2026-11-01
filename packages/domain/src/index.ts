import { CHANNEL_MODE } from '@zutrade/channels';
import type { AIExecutionMode } from '@zutrade/ai';
import type { RuntimeModes } from '@zutrade/contracts';

export function runtimeModes(config: {
  AI_MODE: AIExecutionMode;
  PROSPECTING_MODE: RuntimeModes['prospecting'];
}): RuntimeModes {
  return { channel: CHANNEL_MODE, ai: config.AI_MODE, prospecting: config.PROSPECTING_MODE };
}

export * from './inbox.js';
export * from './inbound.js';
export * from './delivery.js';
export * from './supply.js';
export * from './quote-calculator.js';
export * from './quoting.js';
export * from './quote-pdf.js';

export * from './approval.js';
export * from './outbound-canonical.js';
export * from './prospecting.js';
export * from './outreach.js';

export * from './ai.js';
export * from './outbound.js';
