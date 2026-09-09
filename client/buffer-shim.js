// Injected by esbuild into every entry point (tools/build-client.js).
//
// tlock-js reaches for Node's Buffer. In the browser it has to come from the `buffer`
// package, which esbuild resolves. This lives in its own module rather than inline in
// the entry point because ES module bodies run only after all imports have been
// evaluated — assigned inline, the global would land too late for anything that wants
// globalThis.Buffer at load time.
import { Buffer as NodeBuffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = NodeBuffer;
export { NodeBuffer };
