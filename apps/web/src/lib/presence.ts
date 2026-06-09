/** Deterministic presence colors + small formatting helpers for the UI. */

const PALETTE: ReadonlyArray<{ color: string; light: string }> = [
  { color: '#2563eb', light: 'rgba(37, 99, 235, 0.2)' },
  { color: '#16a34a', light: 'rgba(22, 163, 74, 0.2)' },
  { color: '#d97706', light: 'rgba(217, 119, 6, 0.2)' },
  { color: '#dc2626', light: 'rgba(220, 38, 38, 0.2)' },
  { color: '#9333ea', light: 'rgba(147, 51, 234, 0.2)' },
  { color: '#0d9488', light: 'rgba(13, 148, 136, 0.2)' },
  { color: '#db2777', light: 'rgba(219, 39, 119, 0.2)' },
  { color: '#4f46e5', light: 'rgba(79, 70, 229, 0.2)' },
]

export function presenceColor(seed: string): { color: string; light: string } {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]!
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Replace `@[principalId]` mention markers with `@Name` for display. */
export function renderMentions(body: string, nameFor: (id: string) => string | undefined): string {
  return body.replace(/@\[([^\]]+)\]/g, (_, id: string) => `@${nameFor(id) ?? 'unknown'}`)
}
