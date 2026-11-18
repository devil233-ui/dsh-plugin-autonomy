/**
 * Package entry. Cordis resolves the plugin through `exports["."]`, so the
 * public surface is re-exported here and the implementation stays under
 * `host/`.
 */

export { name, inject, apply } from './host/index.js';
