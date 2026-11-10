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
