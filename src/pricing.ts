/** Turning a request, and then what the model reported, into wallet tokens. */
import type { ModelConfig } from './config.ts';

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  total: number;
}
/** Read the usage block of a Chat Completions or Responses answer. */
export function readChatUsage(usage: unknown): ChatUsage | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, any>;
  const input = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
  const output = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
  const cacheRead = Number(u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0) || 0;
  const total = Number(u.total_tokens ?? 0) || input + output;
  if (!input && !output && !total) return null;
  return { input, output, cacheRead, total };
}
export function chargeForChat(model: ModelConfig, usage: ChatUsage): number {
  const p = model.price ?? {};
  const fresh = Math.max(0, usage.input - usage.cacheRead);
  // A provider that reports only a total (no split) is charged on the total.
  if (!usage.input && !usage.output) return Math.ceil(usage.total * (p.output ?? 1));
  return Math.ceil(fresh * (p.input ?? 1) + usage.cacheRead * (p.cacheRead ?? p.input ?? 1) + usage.output * (p.output ?? 1));
}
/** About four characters per token: only for a reply cut off before the model reported usage. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);
export function holdForChat(model: ModelConfig, body: Record<string, any>, promptChars: number): number {
  const p = model.price ?? {};
  const max = Number(body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens ?? 0) || (p.defaultHold ?? 16_000);
  return Math.ceil(estimateTokens(promptChars) * (p.input ?? 1) + max * (p.output ?? 1));
}
export function tokensForImages(model: ModelConfig, quality: string | undefined, count: number, isEdit: boolean): number {
  const p = model.price ?? {};
  const table = p.quality ?? { low: 1, medium: 1, high: 4, auto: 1 };
  const each = table[quality || 'auto'] ?? table.medium ?? table.auto ?? 1;
  return Math.max(1, Math.ceil(count * (each + (isEdit ? (p.edit ?? 0) : 0))));
}
export function videoSeconds(model: ModelConfig, wanted: unknown): number {
  const p = model.price ?? {};
  const min = p.minSeconds ?? 4;
  const max = p.maxSeconds ?? 12;
  const n = Math.round(Number(wanted) || (p.defaultSeconds ?? 5));
  return Math.min(max, Math.max(min, n));
}
export function tokensForVideo(model: ModelConfig, resolution: string | undefined, seconds: number): number {
  const table = model.price?.resolution ?? { '480p': 1, '720p': 2, '1080p': 4 };
  const perSecond = table[resolution || '720p'] ?? table['720p'] ?? 2;
  return Math.max(1, Math.ceil(perSecond * seconds));
}
export const tokensForSpeech = (model: ModelConfig, chars: number) => Math.max(1, Math.ceil((chars / 1000) * (model.price?.per1kChars ?? 1)));
export const tokensPerRequest = (model: ModelConfig) => Math.max(1, Math.ceil(model.price?.perRequest ?? 1));
