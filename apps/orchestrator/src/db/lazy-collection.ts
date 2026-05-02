/**
 * lazyCollection — Proxy-based deferred TanStack DB collection.
 *
 * Why this exists: every `*-collection.ts` module used to top-level-await
 * `dbReady` so `createSyncedCollection({ persistence })` could be called
 * at module-eval time. Hermes (the React Native engine on Android
 * release builds) cannot compile bundles containing top-level await, so
 * the native bundle was wedged. See GH#164.
 *
 * The bootstrap-order invariant that makes this safe: both
 * `entry-client.tsx` and `entry-rn.tsx` `await dbReady` BEFORE mounting
 * React. So no consumer ever touches a collection until persistence is
 * resolved. We can therefore defer the construction synchronously to
 * first property access without races.
 *
 * Each collection module now exports:
 *
 *   const sessionsCollection = lazyCollection(() => buildSessionsCollection())
 *
 * where `buildSessionsCollection` reads `getResolvedPersistence()` and
 * builds the real collection. The Proxy forwards every access to the
 * resolved instance.
 *
 * Why this works with TanStack DB internals:
 *
 * - `instanceof CollectionImpl` (used by @tanstack/db's query-builder
 *   `q.from({ alias: c })` path) walks the prototype chain. The
 *   `getPrototypeOf` trap returns the real collection's prototype, so
 *   `proxy instanceof CollectionImpl` resolves correctly.
 *
 * - `useLiveQuery` duck-types via `subscribeChanges` / `startSyncImmediate`
 *   / `id` presence — the Proxy forwards property reads, so duck-typing
 *   passes.
 *
 * - Methods are `.bind`-ed to the real instance inside the `get` trap so
 *   `this`-keyed internal state (private fields, internal WeakMap keys)
 *   resolves to the real collection, not the Proxy.
 *
 * - `Object.create(null)` is used as the proxy target so the
 *   `getPrototypeOf` trap can return any prototype without violating the
 *   "non-extensible target must match" invariant. The target is
 *   extensible by default and has zero own properties, so the `ownKeys`
 *   / `getOwnPropertyDescriptor` traps can forge configurable
 *   descriptors for every property of the underlying without invariant
 *   violations.
 */
export function lazyCollection<T extends object>(thunk: () => T): T {
  let resolved: T | null = null
  const get = (): T => {
    if (resolved === null) resolved = thunk()
    return resolved
  }

  // Object.create(null) — extensible target with null prototype so the
  // getPrototypeOf trap can return any prototype without invariant
  // violations.
  const target = Object.create(null) as object

  return new Proxy(target, {
    get(_t, prop, _receiver) {
      const real = get() as Record<PropertyKey, unknown>
      const value = real[prop]
      // Bind methods to the real instance so `this`-keyed internal state
      // (private fields, WeakMap keys) resolves correctly.
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(real)
        : value
    },
    has(_t, prop) {
      return prop in (get() as Record<PropertyKey, unknown>)
    },
    set(_t, prop, value) {
      ;(get() as Record<PropertyKey, unknown>)[prop] = value
      return true
    },
    deleteProperty(_t, prop) {
      return Reflect.deleteProperty(get(), prop)
    },
    ownKeys() {
      return Reflect.ownKeys(get())
    },
    getOwnPropertyDescriptor(_t, prop) {
      const desc = Reflect.getOwnPropertyDescriptor(get(), prop)
      if (desc) {
        // Proxy invariant: any descriptor reported for a property the
        // target doesn't own MUST be configurable. Our target
        // (Object.create(null)) has no own properties, so we forge
        // configurable=true on every forwarded descriptor.
        desc.configurable = true
      }
      return desc
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(get())
    },
  }) as T
}
