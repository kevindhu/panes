// Large history opens must not fan out dozens of simultaneous SQLite/IPC reads.
let active = 0;
const waiting: Array<() => void> = [];
export async function readTranscript<T>(read: () => Promise<T>, priority = false): Promise<T> {
  await new Promise<void>(resolve => {
    const start = () => { active++; resolve(); };
    if (active < 2) start(); else if (priority) waiting.unshift(start); else waiting.push(start);
  });
  try { return await read(); }
  finally { active--; waiting.shift()?.(); }
}
