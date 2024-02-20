import { getDeployStore } from '@netlify/blobs'
import type { Span, Tracer } from '@opentelemetry/api'
import type { NextConfigComplete } from 'next/dist/server/config-shared.js'

import { encodeBlobKey } from '../shared/blobkey.js'

import type { TagsManifest } from './config.js'
import type { RequestContext } from './handlers/request-context.cjs'

interface NetlifyVaryValues {
  headers: string[]
  languages: string[]
  cookies: string[]
}

const generateNetlifyVaryValues = ({ headers, languages, cookies }: NetlifyVaryValues): string => {
  const values: string[] = []
  if (headers.length !== 0) {
    values.push(`header=${headers.join(`|`)}`)
  }
  if (languages.length !== 0) {
    values.push(`language=${languages.join(`|`)}`)
  }
  if (cookies.length !== 0) {
    values.push(`cookie=${cookies.join(`|`)}`)
  }
  return values.join(',')
}

const getHeaderValueArray = (header: string): string[] => {
  return header.split(',').map((value) => value.trim())
}

const omitHeaderValues = (header: string, values: string[]): string => {
  const headerValues = getHeaderValueArray(header)
  const filteredValues = headerValues.filter(
    (value) => !values.some((val) => value.startsWith(val)),
  )
  return filteredValues.join(', ')
}

const mapHeaderValues = (header: string, callback: (value: string) => string): string => {
  const headerValues = getHeaderValueArray(header)
  const mappedValues = headerValues.map(callback)
  return mappedValues.join(', ')
}

/**
 * Ensure the Netlify CDN varies on things that Next.js varies on,
 * e.g. i18n, preview mode, etc.
 */
export const setVaryHeaders = (
  headers: Headers,
  request: Request,
  { basePath, i18n }: Pick<NextConfigComplete, 'basePath' | 'i18n'>,
) => {
  const netlifyVaryValues: NetlifyVaryValues = {
    headers: ['x-nextjs-data'],
    languages: [],
    cookies: ['__prerender_bypass', '__next_preview_data'],
  }

  const vary = headers.get('vary')
  if (vary !== null) {
    netlifyVaryValues.headers.push(...getHeaderValueArray(vary))
  }

  const path = new URL(request.url).pathname
  const locales = i18n && i18n.localeDetection !== false ? i18n.locales : []

  if (locales.length > 1 && (path === '/' || path === basePath)) {
    netlifyVaryValues.languages.push(...locales)
    netlifyVaryValues.cookies.push(`NEXT_LOCALE`)
  }

  headers.set(`netlify-vary`, generateNetlifyVaryValues(netlifyVaryValues))
}

const fetchBeforeNextPatchedIt = globalThis.fetch

/**
 * Change the date header to be the last-modified date of the blob. This means the CDN
 * will use the correct expiry time for the response. e.g. if the blob was last modified
 * 5 seconds ago and is sent with a maxage of 10, the CDN will cache it for 5 seconds.
 * By default, Next.js sets the date header to the current time, even if it's served
 * from the cache, meaning that the CDN will cache it for 10 seconds, which is incorrect.
 */
export const adjustDateHeader = async ({
  headers,
  request,
  span,
  tracer,
  requestContext,
}: {
  headers: Headers
  request: Request
  span: Span
  tracer: Tracer
  requestContext: RequestContext
}) => {
  const cacheState = headers.get('x-nextjs-cache')
  const isServedFromCache = cacheState === 'HIT' || cacheState === 'STALE'

  span.setAttributes({
    'x-nextjs-cache': cacheState ?? undefined,
    isServedFromCache,
  })

  if (!isServedFromCache) {
    return
  }
  const key = new URL(request.url).pathname

  let lastModified: number | undefined
  if (requestContext.responseCacheGetLastModified) {
    lastModified = requestContext.responseCacheGetLastModified
  } else {
    // this is fallback in case requestContext doesn't contain lastModified
    // using fallback indicate problem in the setup as assumption is that for cached responses
    // request context would contain lastModified value
    // this is not fatal as we have fallback,
    // but we want to know about it happening
    span.recordException(
      new Error('lastModified not found in requestContext, falling back to trying blobs'),
    )
    span.setAttributes({
      severity: 'alert',
      warning: true,
    })

    const blobKey = await encodeBlobKey(key)
    const blobStore = getDeployStore({ fetch: fetchBeforeNextPatchedIt, consistency: 'strong' })

    // TODO: use metadata for this
    lastModified = await tracer.startActiveSpan(
      'get cache to calculate date header',
      async (getBlobForDateSpan) => {
        getBlobForDateSpan.setAttributes({
          key,
          blobKey,
        })
        const blob = (await blobStore.get(blobKey, { type: 'json' })) ?? {}

        getBlobForDateSpan.addEvent(blob ? 'Cache hit' : 'Cache miss')
        getBlobForDateSpan.end()
        return blob.lastModified
      },
    )
  }

  if (!lastModified) {
    // this should never happen as we only execute this code path for cached responses
    // and those should always have lastModified value
    span.recordException(
      new Error(
        'lastModified not found in either requestContext or blobs, date header for cached response is not set',
      ),
    )
    span.setAttributes({
      severity: 'alert',
      warning: true,
    })
    return
  }

  const lastModifiedDate = new Date(lastModified)
  // Show actual date of the function call in the date header
  headers.set('x-nextjs-date', headers.get('date') ?? lastModifiedDate.toUTCString())
  // Setting Age also would work, but we already have the lastModified time so will use that.
  headers.set('date', lastModifiedDate.toUTCString())
}

/**
 * Ensure stale-while-revalidate and s-maxage don't leak to the client, but
 * assume the user knows what they are doing if CDN cache controls are set
 */
export const setCacheControlHeaders = (
  headers: Headers,
  request: Request,
  requestContext: RequestContext,
) => {
  const cacheControl = headers.get('cache-control')
  if (
    cacheControl !== null &&
    ['GET', 'HEAD'].includes(request.method) &&
    !headers.has('cdn-cache-control') &&
    !headers.has('netlify-cdn-cache-control')
  ) {
    const browserCacheControl = omitHeaderValues(cacheControl, [
      's-maxage',
      'stale-while-revalidate',
    ])
    const cdnCacheControl =
      // if we are serving already stale response, instruct edge to not attempt to cache that response
      headers.get('x-nextjs-cache') === 'STALE'
        ? 'public, max-age=0, must-revalidate'
        : mapHeaderValues(cacheControl, (value) =>
            value === 'stale-while-revalidate' ? 'stale-while-revalidate=31536000' : value,
          )

    headers.set('cache-control', browserCacheControl || 'public, max-age=0, must-revalidate')
    headers.set('netlify-cdn-cache-control', cdnCacheControl)
  }

  if (
    cacheControl === null &&
    !headers.has('cdn-cache-control') &&
    !headers.has('netlify-cdn-cache-control') &&
    requestContext.usedFsRead
  ) {
    headers.set('cache-control', 'public, max-age=0, must-revalidate')
    headers.set('netlify-cdn-cache-control', `max-age=31536000`)
  }
}

function getCanonicalPathFromCacheKey(cacheKey: string | undefined): string | undefined {
  return cacheKey === '/index' ? '/' : cacheKey
}

export const setCacheTagsHeaders = (
  headers: Headers,
  request: Request,
  manifest: TagsManifest,
  requestContext: RequestContext,
) => {
  const path =
    getCanonicalPathFromCacheKey(requestContext.responseCacheKey) ?? new URL(request.url).pathname
  const tags = manifest[path]
  if (tags !== undefined) {
    headers.set('netlify-cache-tag', tags)
  }
}

/**
 * https://httpwg.org/specs/rfc9211.html
 *
 * We get HIT, MISS, STALE statuses from Next cache.
 * We will ignore other statuses and will not set Cache-Status header in those cases.
 */
const NEXT_CACHE_TO_CACHE_STATUS: Record<string, string> = {
  HIT: `hit`,
  MISS: `fwd=miss`,
  STALE: `hit; fwd=stale`,
}

/**
 * x-nextjs-cache header will be confusing to users as very often it will be MISS
 * even when the CDN serves cached the response. So we'll remove it and instead add
 * a Cache-Status header for Next cache so users inspect that together with CDN cache status
 * and not on its own.
 */
export const setCacheStatusHeader = (headers: Headers) => {
  const nextCache = headers.get('x-nextjs-cache')
  if (typeof nextCache === 'string') {
    if (nextCache in NEXT_CACHE_TO_CACHE_STATUS) {
      const cacheStatus = NEXT_CACHE_TO_CACHE_STATUS[nextCache]
      headers.set('cache-status', `"Next.js"; ${cacheStatus}`)
    }

    headers.delete('x-nextjs-cache')
  }
}
