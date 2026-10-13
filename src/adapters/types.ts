import type { AdapterConfig, ModelConfig } from '../config.ts';
import type { VideoStatus } from '../protocol.ts';

export interface VideoInput {
  model: string;
  prompt: string;
  /** http(s) or data: URLs; the first one is the starting frame. */
  images: string[];
  /** https URLs of videos to edit, extend or take from (the first one is the source video). */
  videos?: string[];
  /** https URLs of audio to follow (music, a voice). */
  audios?: string[];
  /** With a reference video: what to do with it (BytePlus omni_reference_task_type). edit/extend keep the source ratio and length. */
  task?: 'auto' | 'reference' | 'edit' | 'extend';
  resolution: string;
  seconds: number;
  ratio?: string;
}
export interface VideoState {
  status: VideoStatus;
  progress?: number;
  /** Where the finished file is, if the upstream hands out a URL (kept server-side). */
  ref?: string;
  error?: string;
  /** Upstream tokens the job used (BytePlus reports them), for the price floor. */
  usageTokens?: number;
}
export interface Adapter {
  /** Send an OpenAI-shaped request upstream and hand the raw response back. */
  forward(path: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit | null; signal?: AbortSignal }): Promise<Response>;
  video?: {
    create(input: VideoInput): Promise<{ id: string }>;
    status(id: string): Promise<VideoState>;
    /** The finished file as a byte stream. */
    content(id: string, ref: string | undefined): Promise<Response>;
  };
}
export interface AdapterDeps {
  config: AdapterConfig;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
}
export class UpstreamError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'upstream_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function upstreamKey(deps: AdapterDeps): string {
  const name = deps.config.apiKeyEnv;
  const key = name ? deps.env[name] : undefined;
  if (!key) throw new UpstreamError(`the server has no upstream key yet (${name || 'apiKeyEnv is not set'})`, 503, 'upstream_not_configured');
  return key;
}
export const upstreamModel = (m: ModelConfig) => m.upstreamModel || m.id;
