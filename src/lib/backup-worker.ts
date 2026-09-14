import { AsyncZipDeflate, Zip } from "fflate";

type BackupRequest = { type: "zip"; files: Record<string, Uint8Array> } | { type: "cancel" };

let canceled = false;
let activeZip: Zip | undefined;

self.onmessage = (event: MessageEvent<BackupRequest>) => {
  if (event.data.type === "cancel") {
    canceled = true;
    activeZip?.terminate();
    return;
  }
  try {
    const files = event.data.files;
    const names = Object.keys(files);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let completed = 0;
    const archive = new Zip((error, chunk, final) => {
      if (error) {
        self.postMessage({ type: "error", message: "ZIPを生成できませんでした" });
        return;
      }
      chunks.push(chunk);
      total += chunk.byteLength;
      if (final) {
        const result = new Uint8Array(total);
        let offset = 0;
        for (const part of chunks) { result.set(part, offset); offset += part.byteLength; }
        self.postMessage({ type: "done", archive: result }, [result.buffer]);
      }
    });
    activeZip = archive;
    for (const name of names) {
      if (canceled) return;
      const stream = new AsyncZipDeflate(name, { level: 6 });
      archive.add(stream);
      stream.push(files[name], true);
      completed++;
      self.postMessage({ type: "progress", completed, total: names.length });
    }
    if (!canceled) archive.end();
    activeZip = undefined;
  } catch (error) {
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : "ZIPを生成できませんでした" });
  }
};

export {};
