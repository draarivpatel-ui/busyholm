import type { Snapshot } from '../../../../contracts/ts/src/types.ts';

/** Install the live stream and fill the initial state from the core. */
export async function connectSnapshots(
  listen: (receive: (s: Snapshot) => void) => Promise<unknown>,
  get: () => Promise<Snapshot | null>,
  apply: (s: Snapshot) => void,
): Promise<void> {
  let streamed = false;
  await listen((s) => {
    streamed = true;
    apply(s);
  });
  const initial = await get();
  // Delivery order is the authority, including when the system clock moves backwards.
  if (initial && !streamed) apply(initial);
}
