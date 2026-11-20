// Reading and writing the project file. No server: the file is read in the
// browser and written back either in place (browsers with the File System
// Access API, after the user approves it) or as a download.

import { normalizeProject, projectSchema, type Project } from "core";

type WritableHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

type PickerWindow = Window & {
  showOpenFilePicker?: (opts: {
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<WritableHandle[]>;
};

type HandleItem = DataTransferItem & { getAsFileSystemHandle?: () => Promise<(WritableHandle & { kind: string }) | null> };

export type OpenedFile = { text: string; name: string; handle: WritableHandle | null };
export type FileHandle = WritableHandle;

export const canSaveInPlace = () => typeof (window as PickerWindow).showOpenFilePicker === "function";

/** Open via the system picker where it can hand back a writable handle.
 * Returns null if the user cancels, or "unsupported" to fall back to an
 * `<input type="file">`. */
export async function pickFile(): Promise<OpenedFile | null | "unsupported"> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (!picker) return "unsupported";
  try {
    const [handle] = await picker({
      types: [{ description: "Project file", accept: { "application/json": [".json"] } }],
    });
    if (!handle) return null;
    const file = await handle.getFile();
    return { text: await file.text(), name: file.name, handle };
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    return "unsupported";
  }
}

/** A dropped file, with a writable handle where the browser offers one. */
export async function droppedFile(data: DataTransfer): Promise<OpenedFile | null> {
  const item = [...data.items].find((i) => i.kind === "file") as HandleItem | undefined;
  const file = item?.getAsFile() ?? data.files[0];
  if (!file) return null;
  // Ask for the handle before any await: the item is only valid during the event.
  const handlePromise = item?.getAsFileSystemHandle?.().catch(() => null);
  const text = await file.text();
  const handle = (await handlePromise) ?? null;
  return { text, name: file.name, handle: handle && handle.kind === "file" ? handle : null };
}

/** The document as it's written to disk: validated, dangling references
 * dropped, pretty-printed so it diffs well. Throws if it isn't a valid
 * project (which would mean a bug here, not a user error). */
export function serialize(project: Project): string {
  return JSON.stringify(projectSchema.parse(normalizeProject(project)), null, 2) + "\n";
}

export async function writeInPlace(handle: FileHandle, text: string): Promise<void> {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
