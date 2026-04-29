// GH#131 P2 — empty stub used by metro.config.cjs to short-circuit
// Capacitor-only dependencies that use non-statically-analysable
// dynamic imports (which Metro's babel transform rejects). The
// orchestrator's web bundle never loads these — they are only
// active under Capacitor — but Metro tries to bundle them anyway
// when walking the source tree from entry-rn.tsx.
module.exports = {}
