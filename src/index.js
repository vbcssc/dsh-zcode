/**
 * dsh-zcode-mode — the bundle's Node-side entry.
 *
 * Most of the bundle is declarative: `cordis.patch.yml` carries the `zcode` preset
 * (persona text, the restated standard base, the named subagent rows) and points one
 * row at this package's `./situation` subpath export. This module exists so `main`
 * resolves and so the plugin module is reachable for programmatic consumers; the
 * preset references the subpath directly.
 *
 * @module dsh-zcode-mode
 */

export * as situation from './situation.js'
