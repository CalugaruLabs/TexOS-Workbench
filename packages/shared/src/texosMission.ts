const MISSION_THREAD_DOMAIN = "texos.mission.v1";
const MAX_MISSION_ID_BYTES = 128;

export function isTexosMissionId(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    new TextEncoder().encode(value).byteLength <= MAX_MISSION_ID_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

// TexOS keys one T3 thread per (task, attempt). Both sides derive the ID, so nothing has to look
// it up: SHA-256 over domain, task and attempt separated by NUL, first 16 bytes as a v8 UUID.
export async function texosMissionThreadId(taskId: string, attemptId: string): Promise<string> {
  if (!isTexosMissionId(taskId) || !isTexosMissionId(attemptId)) {
    throw new Error("Invalid TexOS mission identity.");
  }
  const input = new TextEncoder().encode(`${MISSION_THREAD_DOMAIN}\0${taskId}\0${attemptId}`);
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input)).slice(
    0,
    16,
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const MISSION_EMBED_PATH = /^\/embed\/missions\/([^/?#\\]+)\/([^/?#\\]+)$/u;

/** The Mission panel path TexOS may ask sign-in to land on, or null: nothing else may follow it. */
export function texosMissionEmbedPath(value: unknown): string | null {
  // Each part is a whole decoded Mission ID, so an encoded `/` or `.` can't leave the route.
  if (typeof value !== "string" || value.length > 1024) return null;
  const match = MISSION_EMBED_PATH.exec(value);
  if (!match) return null;
  for (const segment of [match[1]!, match[2]!]) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (decoded === "." || decoded === ".." || !isTexosMissionId(decoded)) return null;
  }
  return value;
}
