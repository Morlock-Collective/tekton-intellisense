/** Groups items by `name`, keeping only names that occur more than once. */
export function findDuplicateGroups<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const byName = new Map<string, T[]>();
  for (const item of items) {
    const list = byName.get(item.name);
    if (list) list.push(item);
    else byName.set(item.name, [item]);
  }
  for (const [name, group] of byName) {
    if (group.length < 2) byName.delete(name);
  }
  return byName;
}
