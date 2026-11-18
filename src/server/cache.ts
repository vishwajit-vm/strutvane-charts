/**
 * Caching chart results: an optional hook, off unless the app turns it on.
 *
 * A cached chart is only safe when it can never be served to someone who would see different
 * rows. So the key covers **everything that decides the rows**: the tenant, the actor (id, type,
 * roles), the actor's row filter as the PermissionProvider returned it, the metric and every
 * request parameter, plus a generation number that {@link clearChartsCache} bumps. Two users
 * never share an entry, even with identical roles: a policy may depend on who they are
 * (`owner_id = $actor.id`). The key is a SHA-256, so no tenant or user id is readable in the
 * cache store.
 *
 * Any store with `get` and `put` works; the framework's cache store (`CacheManagerToken`) fits
 * as is. A cache that fails is treated as a miss (the chart is computed), and logged by the
 * handler: a broken cache must never break a dashboard.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import type { Actor, QueryFilter } from '@strutvane/framework/contracts'
import type { MetricResult } from '../shared/contract.ts'

/**
 * Where results are kept: the framework's `CacheStore` satisfies it.
 *
 * @example
 * const cache: ChartsCache = app.make(CacheManagerToken).store()
 */
export interface ChartsCache {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown, ttlSeconds?: number): Promise<void>
}

/** The key of the generation counter that {@link clearChartsCache} bumps. */
export const GENERATION_KEY = 'strutvane:charts:generation'

/**
 * What a cache key is made of.
 *
 * @example
 * cacheKey({ generation: 0, metric: 'invoices.revenue', params: 'interval=month', tenant: 't1', actor, filter })
 */
export interface CacheKeyParts {
  readonly generation: number
  readonly metric: string
  /** The request's query string, normalised (sorted). */
  readonly params: string
  readonly tenant: string | undefined
  readonly actor: Actor | null
  readonly filter: QueryFilter
}

/**
 * The cache key for one chart request.
 *
 * @example
 * const key = cacheKey(parts) // 'strutvane:charts:3f2a…'
 */
export function cacheKey(parts: CacheKeyParts): string {
  const actor =
    parts.actor === null
      ? null
      : {
          id: parts.actor.id,
          type: parts.actor.type,
          tenantId: parts.actor.tenantId ?? null,
          roles: [...parts.actor.roles].sort(),
          permissions: [...(parts.actor.permissions ?? [])].sort(),
        }
  const material = JSON.stringify([
    1,
    parts.generation,
    parts.metric,
    parts.params,
    parts.tenant ?? null,
    actor,
    parts.filter,
  ])
  return `strutvane:charts:${createHash('sha256').update(material).digest('hex')}`
}

/**
 * Sort a query string's parameters, so `a=1&b=2` and `b=2&a=1` share an entry.
 *
 * @example
 * normaliseParams(new URLSearchParams('to=2026-02-01&from=2026-01-01')) // 'from=2026-01-01&to=2026-02-01'
 */
export function normaliseParams(params: URLSearchParams): string {
  const copy = new URLSearchParams(params)
  copy.sort()
  return copy.toString()
}

/**
 * The current generation (0 when unset or unreadable).
 *
 * @example
 * const generation = await cacheGeneration(cache)
 */
export async function cacheGeneration(cache: ChartsCache): Promise<number> {
  const value = await cache.get(GENERATION_KEY)
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
}

/**
 * Invalidate every cached chart at once by moving to the next generation (old entries expire on
 * their own TTL). Use it after imports or bulk edits; `charts:cache:clear` calls it.
 *
 * @example
 * await clearChartsCache(app.make(CacheManagerToken).store())
 */
export async function clearChartsCache(cache: ChartsCache): Promise<number> {
  const next = (await cacheGeneration(cache)) + 1
  await cache.put(GENERATION_KEY, next)
  return next
}

/**
 * Is a cached value a well-formed result? Anything else (a store shared with other code, a
 * truncated write) is a miss, never a response.
 *
 * @example
 * if (isMetricResult(cached)) return cached
 */
export function isMetricResult(value: unknown): value is MetricResult {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Readonly<Record<string, unknown>>
  return (
    Array.isArray(candidate['data']) &&
    Array.isArray(candidate['series']) &&
    typeof candidate['meta'] === 'object' &&
    candidate['meta'] !== null
  )
}
