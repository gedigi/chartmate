// Minimal typing for js-yaml 4 (no @types package in the workspace): only what the desktop app uses.
declare module 'js-yaml' {
  export function load(text: string, opts?: { json?: boolean }): unknown;
}
