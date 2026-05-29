export function formatMb(kb: number) {
  if (kb < 1024) return `${Math.max(0, Math.round(kb))} KB`

  return `${(kb / 1024).toFixed(1)} MB`
}
