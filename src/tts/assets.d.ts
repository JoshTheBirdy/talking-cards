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
