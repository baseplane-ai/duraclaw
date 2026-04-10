import { useCallback, useRef, useState } from 'react'

/**
 * A hook for managing controllable state.
 * Replaces @radix-ui/react-use-controllable-state.
 *
 * When `prop` is defined, the component is controlled.
 * When `prop` is undefined, the component manages its own state with `defaultProp`.
 */
export function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop?: T
  defaultProp?: T
  onChange?: (value: T) => void
}): [T, (value: T | ((prev: T) => T)) => void] {
  const [internalValue, setInternalValue] = useState<T>(defaultProp as T)
  const isControlled = prop !== undefined
  const value = isControlled ? prop : internalValue
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const setValue = useCallback(
    (nextValue: T | ((prev: T) => T)) => {
      const resolvedValue =
        typeof nextValue === 'function' ? (nextValue as (prev: T) => T)(value as T) : nextValue

      if (!isControlled) {
        setInternalValue(resolvedValue)
      }
      onChangeRef.current?.(resolvedValue)
    },
    [isControlled, value],
  )

  return [value as T, setValue]
}
