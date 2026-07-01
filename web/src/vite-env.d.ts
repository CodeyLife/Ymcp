/// <reference types="vite/client" />

declare module "*.worker.ts?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
