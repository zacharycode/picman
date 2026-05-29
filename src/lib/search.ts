export function normalizeSearchText(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase()
}
