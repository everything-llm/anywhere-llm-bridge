// A .txt file imported as its text: esbuild inlines it (build.mjs), so the bundle reads no file.
declare module "*.txt" {
  const text: string;
  export default text;
}

// control.cjs's text, inlined by build.mjs for `install --control` to write into AnythingLLM's storage.
declare const CONTROL_SOURCE: string;
