/**
 * @duraclaw/router-client
 *
 * Zero-dependency TypeScript client for UncommonRoute — a local LLM router
 * that sits between a Claude Agent SDK / Anthropic SDK / OpenAI SDK caller
 * and the upstream API, routing prompts by difficulty to cut premium-model
 * spend without sacrificing quality.
 *
 * See ./README.md for usage patterns against the session-runner and each
 * of the supported SDKs.
 */

export { type RouterConfig, routerConfig } from './config.js'
export { wrapFetch } from './fetch.js'
export {
  type HeadersLike,
  hasRouteMetadata,
  parseRouteHeaders,
} from './headers.js'
export {
  type FetchLike,
  OPENCLAW_SESSION_HEADER,
  type RouteMetadata,
  type RouterOptions,
  SESSION_HEADER,
} from './types.js'
