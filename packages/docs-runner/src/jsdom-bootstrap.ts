// MUST be the FIRST import in any module that touches @blocknote/* — see B7 / spec gotcha.
//
// Side-effect-only module. Patches `globalThis` with the DOM constructors that
// `@blocknote/server-util` (and its `@blocknote/core` dependency) expect at
// import-time when they evaluate under Bun/Node. Without this shim, importing
// `@blocknote/server-util` throws because `window`/`document` are undefined.
//
// Idempotent — guarded by a sentinel symbol so re-importing the module from
// multiple entry points (bridge, tests, runner main) is safe.

import { JSDOM } from 'jsdom'

const SENTINEL = Symbol.for('@duraclaw/docs-runner/jsdom-bootstrap')

type Bootstrappable = typeof globalThis & { [SENTINEL]?: true }

const g = globalThis as Bootstrappable

if (!g[SENTINEL]) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })

  const { window } = dom

  // Core DOM globals @blocknote needs at module-eval time.
  const patches: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLDivElement: window.HTMLDivElement,
    HTMLSpanElement: window.HTMLSpanElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLImageElement: window.HTMLImageElement,
    HTMLBodyElement: window.HTMLBodyElement,
    HTMLHtmlElement: window.HTMLHtmlElement,
    HTMLHeadElement: window.HTMLHeadElement,
    HTMLDocument: (window as unknown as { HTMLDocument: unknown }).HTMLDocument,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    Text: window.Text,
    Comment: window.Comment,
    Range: window.Range,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    DOMParser: window.DOMParser,
    XMLSerializer: window.XMLSerializer,
    getSelection: window.getSelection?.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
  }

  for (const [key, value] of Object.entries(patches)) {
    if (value === undefined) continue
    if (key in g) continue
    Object.defineProperty(g, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  Object.defineProperty(g, SENTINEL, {
    value: true,
    writable: false,
    configurable: false,
    enumerable: false,
  })
}
