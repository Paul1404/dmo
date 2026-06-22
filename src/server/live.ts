export type LiveEventType = "jobs" | "orchestrator-runs";

type LiveEvent = {
  type: LiveEventType;
  id: string;
  at: string;
};

type Listener = (event: LiveEvent) => void;

const listenersByUser = new Map<string, Set<Listener>>();

export function subscribeToUserEvents(userId: string, listener: Listener): () => void {
  const listeners = listenersByUser.get(userId) ?? new Set<Listener>();
  listeners.add(listener);
  listenersByUser.set(userId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) listenersByUser.delete(userId);
  };
}

export function publishUserEvent(userId: string, type: LiveEventType): void {
  const listeners = listenersByUser.get(userId);
  if (!listeners || listeners.size === 0) return;
  const event = { type, id: crypto.randomUUID(), at: new Date().toISOString() };
  for (const listener of listeners) listener(event);
}
