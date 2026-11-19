export function toggleConversationSelection(selected: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(selected);
  const remove = ids.every((id) => next.has(id));
  for (const id of ids) {
    if (remove) next.delete(id);
    else next.add(id);
  }
  return next;
}

export async function runConversationBatch<T extends { id: string; title: string }>(
  items: readonly T[],
  action: (id: string) => Promise<void>,
) {
  const failures: Array<{ id: string; title: string; message: string }> = [];
  for (const item of items) {
    try {
      await action(item.id);
    } catch (error) {
      failures.push({ id: item.id, title: item.title, message: error instanceof Error ? error.message : "操作失败" });
    }
  }
  return failures;
}
