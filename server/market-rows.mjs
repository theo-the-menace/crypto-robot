export function mergeKlines(current, incoming) {
  return [...new Map([...current, ...incoming].map((row) => [Number(row[0]), row])).values()].sort((left, right) => Number(left[0]) - Number(right[0]));
}
