// Minimal runtime stubs for the `obsidian` module, which is types-only.
// Unit tests never exercise Obsidian APIs; these classes only need to exist
// so that named imports in source modules resolve in the Node test env.
export class App {}
export class Component {}
export class MarkdownRenderer {}
export class TFile {}
