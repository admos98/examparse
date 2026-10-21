/**
 * Content-Hash Caching for Pipeline Stages (§5.3)
 * Cache key = sha256(fileBytes) + parserVersion + promptVersion + provider + model + optionsHash
 */
import { sha256 } from '../utils/hash';
import { getPipelineCache, setPipelineCache } from '../store';
import { PARSER_VERSION, PROMPT_VERSION } from './prompts';

export interface StageCacheKeyParams {
  fileHash: string;
  stage: 'extract' | 'ocr' | 'cleanup' | 'structure' | 'vision' | 'repair';
  provider: string;
  model: string;
  options?: any;
}

export async function buildStageCacheKey(params: StageCacheKeyParams): Promise<string> {
  const optionsStr = params.options ? JSON.stringify(params.options) : '';
  const payload = `${params.fileHash}:${PARSER_VERSION}:${PROMPT_VERSION}:${params.stage}:${params.provider}:${params.model}:${optionsStr}`;
  return await sha256(payload);
}

export async function getCachedStageResult<T>(params: StageCacheKeyParams): Promise<T | undefined> {
  const key = await buildStageCacheKey(params);
  return await getPipelineCache<T>(key);
}

export async function setCachedStageResult<T>(params: StageCacheKeyParams, data: T): Promise<void> {
  const key = await buildStageCacheKey(params);
  await setPipelineCache<T>(key, data);
}
