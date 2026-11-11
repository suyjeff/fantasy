// A shared trade, as both sides read it: the deal a link carries, how big it may be, and the words its preview says.
// The app writes them (lib/tradeShare) and the worker checks and prints them (trade.ts), so the two can never disagree
// about what fits in a link or what its title is. Free of imports so the app's bundle and the worker's can both take it.

/** The most teams a deal has: the trade builder's limit (components/TradeBuilder `MAX_TEAMS`). */
export const MAX_DEAL_TEAMS = 4
/** The most players and FAAB payments one link carries, all told. */
export const MAX_DEAL_PARTS = 30
/** The longest deal a link carries: every part at its longest (`from.to.player`, four-digit roster ids, 24-character ids). */
export const MAX_TRADE_CHARS = MAX_DEAL_PARTS * (4 + 1 + 4 + 1 + 24) + (MAX_DEAL_PARTS - 1)

/**
 * The facts a link stores, as JSON, at most. The largest legal set (four sides, every player of a full deal, eight
 * figures, a strip of twenty weeks, every name at its cap and every character one JSON doubles) comes to about 17,500
 * characters; lib/__tests__/tradeWorker.test.ts builds it and holds this bound to it.
 */
export const MAX_TRADE_META = 18_000

const PART = /^(\d{1,4})\.(\d{1,4})\.(\$?)([A-Za-z0-9_-]{1,24})$/

export type LinkDeal = { teams: number[]; moves: { player: string; from: number; to: number }[]; faab: { from: number; to: number; dollars: number }[] }

/** The deal a link carries, or null when it is not one (bad shape, too big, or moving nothing). */
export const parseTrade = (s: string | null | undefined): LinkDeal | null => {
  if (!s || s.length > MAX_TRADE_CHARS) return null
  const parts = s.split(',')
  if (parts.length > MAX_DEAL_PARTS) return null
  const deal: LinkDeal = { teams: [], moves: [], faab: [] }
  const team = (t: number) => {
    if (!deal.teams.includes(t)) deal.teams.push(t)
  }
  for (const part of parts) {
    const m = PART.exec(part)
    if (!m) return null
    const from = Number(m[1])
    const to = Number(m[2])
    if (from === to) return null
    if (m[3]) {
      if (!/^\d{1,4}$/.test(m[4])) return null
      const dollars = Number(m[4])
      if (dollars <= 0 || deal.faab.some((x) => x.from === from)) return null
      deal.faab.push({ from, to, dollars })
    } else {
      if (deal.moves.some((x) => x.player === m[4])) return null
      deal.moves.push({ player: m[4], from, to })
    }
    team(from)
    team(to)
  }
  if (deal.teams.length < 2 || deal.teams.length > MAX_DEAL_TEAMS || (!deal.moves.length && !deal.faab.length)) return null
  return deal
}

/** What the words of a preview are made from: the card's own fields. */
export type TradeTextInput = {
  kind: 'pitch' | 'league'
  league: string
  to: string | null
  from: string | null
  sides: { head: string; faab: number; players: { name: string }[] }[]
  stats: { label: string; value: string; unit: string | null }[]
}

/** The words a link preview carries besides the picture: its title, and the trade and figures in one line. */
export const tradeText = (card: TradeTextInput) => {
  const gets = (s: TradeTextInput['sides'][number]) => [...s.players.map((p) => p.name), s.faab ? `$${s.faab} FAAB` : ''].filter(Boolean).join(', ') || 'nothing'
  const title = card.kind === 'pitch' ? `Trade idea for ${card.to}${card.from ? ` from ${card.from}` : ''}` : `Trade · ${card.league}`
  const lines = card.sides.map((s) => `${s.head}: ${gets(s)}`)
  const stats = card.stats.map((s) => `${s.label} ${s.value}${s.unit ? (s.unit.startsWith('/') ? s.unit : ` ${s.unit}`) : ''}`)
  return { title: title.slice(0, 120), description: [...lines, ...stats].join(' · ').slice(0, 300) }
}
