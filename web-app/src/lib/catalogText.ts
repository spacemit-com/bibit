/**
 * Localized labels for the parameter catalogs.
 *
 * `predefined.ts` / `predefinedParams.ts` stay language-agnostic (their text is
 * also persisted into model settings), so the UI resolves visible strings here:
 * `common:paramDefs.<key>.*` for sampler params, `common:modelParamDefs.<key>.*`
 * for model settings. Keys the catalogs don't own (settings a backend injects)
 * keep whatever text they carry.
 */
import { modelSettings } from './predefined'
import { paramsSettings } from './predefinedParams'

type Translate = (key: string, options?: Record<string, unknown>) => string

export type CatalogTextField = 'title' | 'description' | 'effectHint'

const PARAM_KEYS = new Set(Object.keys(paramsSettings))
const MODEL_PARAM_KEYS = new Set(Object.keys(modelSettings))

/** Sampler-param label; unknown keys keep their own text. */
export const paramText = (
  t: Translate,
  key: string,
  field: CatalogTextField,
  fallback: string
): string =>
  PARAM_KEYS.has(key) ? t(`common:paramDefs.${key}.${field}`) : fallback

/** Model-setting label; unknown keys keep their own text. */
export const modelParamText = (
  t: Translate,
  key: string,
  field: CatalogTextField,
  fallback: string
): string =>
  MODEL_PARAM_KEYS.has(key)
    ? t(`common:modelParamDefs.${key}.${field}`)
    : fallback
