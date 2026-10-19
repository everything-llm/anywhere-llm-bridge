// A .txt file imported as its text: esbuild inlines it (build.mjs), so the bundle reads no file.
declare module "*.txt" {
  const text: string;
  export default text;
}
