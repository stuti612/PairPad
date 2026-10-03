import { FallbackLlm } from './fallback.js'
import type { LlmClient, ModelRole } from './llm.js'
import { MockLlm } from './mock.js'
import { OpenAiCompatibleLlm, type JsonMode, type ProviderSettings } from './openaiCompatible.js'

interface Preset {
  label: string
  baseURL: string
  /** Environment variable holding the key. */
  keyVar: string
  models: Record<ModelRole, string>
  jsonMode: JsonMode
}

/**
 * Free-tier providers with OpenAI-compatible APIs. Model defaults were picked
 * from each provider's free catalog in October 2026; free catalogs change, so
 * every value can be overridden (see providerFromEnv).
 */
export const PRESETS: Record<string, Preset> = {
  // Free plan, no card: 30 requests/min, 1,000/day, 8K tokens/min per model.
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    keyVar: 'GROQ_API_KEY',
    models: { generate: 'openai/gpt-oss-120b', judge: 'openai/gpt-oss-20b' },
    jsonMode: 'json_schema',
  },
  // Free with any GitHub account (personal access token, no card).
  github: {
    label: 'GitHub Models',
    baseURL: 'https://models.github.ai/inference',
    keyVar: 'GITHUB_TOKEN',
    models: { generate: 'openai/gpt-4.1', judge: 'openai/gpt-4.1-mini' },
    jsonMode: 'json_schema',
  },
  // Only models whose ID ends in ":free"; 50 requests/day without credits.
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    keyVar: 'OPENROUTER_API_KEY',
    models: {
      generate: 'nvidia/nemotron-3-super-120b-a12b:free',
      judge: 'google/gemma-4-26b-a4b-it:free',
    },
    jsonMode: 'json_object',
  },
  // Note: since 2026 Cerebras needs a payment method on file for its trial
  // credits, so it is supported but not used unless chosen explicitly.
  cerebras: {
    label: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    keyVar: 'CEREBRAS_API_KEY',
    models: { generate: 'gpt-oss-120b', judge: 'qwen-3.8-27b' },
    jsonMode: 'json_schema',
  },
}

export const DEFAULT_PRIMARY = 'groq'
export const DEFAULT_FALLBACK = 'github'

export interface AiChoice {
  llm: LlmClient | null
  /** For the startup log. Never includes a key. */
  description: string
}

/**
 * Builds the AI provider chain from the environment.
 *
 * AI_PROVIDER            primary provider: groq (default), github, openrouter,
 *                        cerebras, custom, mock, or off
 * AI_FALLBACK_PROVIDER   tried once when the primary is rate limited or out of
 *                        quota: github by default, or none
 *
 * Per provider, with its name upper-cased as the prefix (GROQ_, GITHUB_,
 * OPENROUTER_, CEREBRAS_, CUSTOM_):
 *   <P>_API_KEY      the key (GitHub uses GITHUB_TOKEN)
 *   <P>_BASE_URL     overrides the preset's address (required for custom)
 *   <P>_MODEL        model that writes suggestions
 *   <P>_JUDGE_MODEL  smaller model that scores them
 *   <P>_JSON_MODE    json_schema or json_object
 *
 * A provider without a key is skipped, so with only a fallback key set, the
 * fallback is used alone. Keys are read here on the server and never sent
 * to browsers.
 */
export function aiFromEnv(env: NodeJS.ProcessEnv = process.env): AiChoice {
  const primaryId = (env.AI_PROVIDER || DEFAULT_PRIMARY).trim().toLowerCase()
  if (primaryId === 'off') return { llm: null, description: 'off (AI_PROVIDER=off)' }
  if (primaryId === 'mock') {
    return { llm: new MockLlm(), description: 'mock (canned suggestions for tests and demos)' }
  }

  const fallbackId = (env.AI_FALLBACK_PROVIDER || DEFAULT_FALLBACK).trim().toLowerCase()
  const primary = providerFromEnv(primaryId, env)
  const fallback =
    fallbackId === 'none' || fallbackId === primaryId ? null : providerFromEnv(fallbackId, env)

  const chain = [primary, fallback].filter((settings): settings is ProviderSettings => !!settings)
  if (chain.length === 0) {
    const keyVar = PRESETS[primaryId]?.keyVar ?? 'the provider API key'
    return {
      llm: null,
      description: `off (set ${keyVar} to enable; see "AI collaborator" in the README)`,
    }
  }
  const [first, second] = chain.map((settings) => new OpenAiCompatibleLlm(settings))
  const describe = (settings: ProviderSettings) =>
    `${settings.label} (${settings.models.generate}, judged by ${settings.models.judge})`
  return {
    llm: new FallbackLlm(first!, second ?? null),
    description: chain.map(describe).join(', falling back to '),
  }
}

/** Settings for one provider, or null when it has no key. Throws on invalid settings. */
export function providerFromEnv(id: string, env: NodeJS.ProcessEnv): ProviderSettings | null {
  const preset = PRESETS[id]
  if (!preset && id !== 'custom') {
    throw new Error(
      `Unknown AI provider "${id}". Use one of: ${[...Object.keys(PRESETS), 'custom'].join(', ')}.`,
    )
  }
  const prefix = id.toUpperCase()
  const apiKey = env[preset?.keyVar ?? `${prefix}_API_KEY`] || env[`${prefix}_API_KEY`]
  if (!apiKey) return null

  const baseURL = env[`${prefix}_BASE_URL`] || preset?.baseURL
  const generate = env[`${prefix}_MODEL`] || preset?.models.generate
  const judge = env[`${prefix}_JUDGE_MODEL`] || preset?.models.judge
  if (!baseURL || !generate || !judge) {
    throw new Error(
      `The ${id} AI provider needs ${prefix}_BASE_URL, ${prefix}_MODEL and ${prefix}_JUDGE_MODEL.`,
    )
  }
  // Keeps the "costs nothing" promise: OpenRouter only bills non-free models.
  if (id === 'openrouter' && !(generate.endsWith(':free') && judge.endsWith(':free'))) {
    throw new Error('OpenRouter models must be free variants (IDs ending in ":free").')
  }
  const jsonMode = (env[`${prefix}_JSON_MODE`] || preset?.jsonMode || 'json_object') as JsonMode
  if (jsonMode !== 'json_schema' && jsonMode !== 'json_object') {
    throw new Error(`${prefix}_JSON_MODE must be json_schema or json_object.`)
  }
  return {
    id,
    label: preset?.label ?? (env.CUSTOM_LABEL || 'Custom provider'),
    baseURL,
    apiKey,
    models: { generate, judge },
    jsonMode,
  }
}
