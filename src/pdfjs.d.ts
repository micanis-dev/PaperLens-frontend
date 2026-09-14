declare module "pdfjs-dist/build/pdf.mjs" {
  export const getDocument: any;
  export const GlobalWorkerOptions: { workerSrc: string };
}

declare module "pdfjs-dist/build/pdf.worker.mjs?url" {
  const url: string;
  export default url;
}
