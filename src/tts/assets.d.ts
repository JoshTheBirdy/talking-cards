declare module "*.glue.js" {
  const text: string;
  export default text;
}
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
declare module "tts-worker-source" {
  const source: string;
  export default source;
}
declare module "ort-wasm-gz" {
  /** onnxruntime's engine (.wasm), gzipped, base64. */
  const base64: string;
  export default base64;
}
