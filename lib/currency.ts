// What players are worth in a trade conversation, as people actually price
// them, rather than the points they add.
//
// The lineup model is right that a better defense adds a point or two a week.
// But nobody in a league hands over a receiver they drafted for a defense and
// a streaming quarterback, and an offer built that way reads as a joke. Two
// human habits are priced here:
//
//   Streamable positions. Kickers and defenses are picked up and dropped
//   weekly, so they carry almost no trade value; they are also left out of
//   the trade search entirely. Quarterbacks past the league's starting demand
//   (QB13 and down in a 12-team, one-QB league) are streamers too, easing to
//   about a third of their points by QB18. The rank is the consensus one, since
//   reputation is what people trade on: an injured franchise quarterback
//   whose rest-of-season points have dipped is still nobody's streamer.
//
//   Attachment. Managers hold the players they drafted above what they would
//   pay for them (the endowment effect), and hold this season's waiver pickups
//   loosely. Prying away a drafted player costs a modest premium. The size is
//   a judgement, not a measurement: a fifth over the points, small enough
//   that a clearly better offer still clears it.
//
// And two more habits shape what a player is worth in the room, before any of
// the above:
//
//   Reputation. Nobody prices a second-round pick by his last three games. The
//   room reads the consensus rankings and remembers where a player went in the
//   draft, so a star in a slump, or hurt, still fetches far more than his
//   projection says. The price is the model's value blended with both (see
//   `tradeMarket`); without that blend the search happily "buys" such a player
//   for a bench body, since by points alone he is one.
//
//   Stars are scarce. Two 4-point players are not worth one 8-point player,
//   because the second roster spot is not worth the first. Value is convex in
//   points (`starValue`), so a package of parts adds up to less than the whole.

import { valueAtRank, valueCurve, perceivedValues, type Consensus } from './consensus'
import { starterDemand } from './lineup'
import { lastName } from './names'
import type { DraftBoard, PlayerMap, SleeperTransaction } from './types'

/** Positions nobody trades for: left out of the trade search. */
export const UNTRADED_POSITIONS = new Set(['K', 'DEF'])
/** Trade value per point for a streaming-tier player at each position. */
export const STREAM_FACTOR: Record<string, number> = { K: 0.1, DEF: 0.1, QB: 0.35 }
/** What a manager's own drafted (or kept) player costs, over his points. */
export const ATTACHMENT = 1.2
/**
 * How much each opinion counts toward a player's price. Judgement, not a fit: the model has the points, the
 * consensus has what the room believes, and the draft has what each manager paid and still remembers. The
 * draft's share fades as the season gives them something else to look at (`draftShare`).
 */
export const REPUTATION = { model: 0.5, consensus: 0.35, draft: 0.2 }
/**
 * Version of the trade-value scale. Anything stored in its units (a grade's recorded ask) is stamped with it, and
 * is read only against the same scale. 2: convex star value and reputation-blended prices.
 */
export const PRICING_VERSION = 2
/** Shape of the star premium: value = scale · (points / scale)^exp. Five points a week is worth five; ten, about twelve. */
export const STAR = { scale: 5, exp: 1.25 }

/** Convex trade value of a player worth `v` points a week above replacement: a star counts for more than his points. */
export const starValue = (v: number) => (v <= 0 ? 0 : STAR.scale * (v / STAR.scale) ** STAR.exp)

/** The draft's share of a price after `weeksPlayed` weeks: full at the start, a quarter of that by midseason. */
export const draftShare = (weeksPlayed: number) => Math.max(REPUTATION.draft * 0.25, REPUTATION.draft - 0.015 * Math.max(0, weeksPlayed))

/** Where each drafted player's slot in the order sits on the market curve: what that pick would be worth if the draft had been right. */
export const draftValues = (draft: DraftBoard, market: Record<string, number>): Record<string, number> => {
  const curve = valueCurve(market)
  if (!curve.length) return {}
  const out: Record<string, number> = {}
  for (const [id, rank] of Object.entries(draft.rank)) out[id] = valueAtRank(curve, rank)
  return out
}

/**
 * What each player is worth in a trade conversation, in points a week above replacement: the model's value
 * blended with the consensus reading and the draft slot, whichever of them exist for him. A player a source
 * does not cover is read at the other sources alone, never at zero, so a miss is not a bargain. (A model value of
 * zero or less is a reading, not a miss: it counts, as zero.)
 */
export const tradeMarket = (input: { market: Record<string, number>; consensus?: Consensus | null; draft?: DraftBoard | null; weeksPlayed?: number }): Record<string, number> => {
  const { market } = input
  const cons = input.consensus ? perceivedValues(input.consensus, market) : {}
  const drafted = input.draft ? draftValues(input.draft, market) : {}
  const draftWeight = draftShare(input.weeksPlayed ?? 0)
  const out: Record<string, number> = {}
  for (const id of new Set([...Object.keys(market), ...Object.keys(cons), ...Object.keys(drafted)])) {
    let num = 0
    let den = 0
    if (market[id] != null) {
      num += REPUTATION.model * Math.max(0, market[id])
      den += REPUTATION.model
    }
    if (cons[id] != null) {
      num += REPUTATION.consensus * cons[id]
      den += REPUTATION.consensus
    }
    if (drafted[id] != null) {
      num += draftWeight * drafted[id]
      den += draftWeight
    }
    out[id] = Math.round((num / den) * 100) / 100
  }
  return out
}

/**
 * What a player is to the room and to his own team, the way a manager sizes up an ask before any arithmetic:
 *
 *   star     near the top of his position (the top third of the league's starters there)
 *   starter  a league starter at his position, or one of his own team's starters
 *   useful   someone the consensus would roster in a league this size, or worth more than the wire
 *   scrub    none of these: a cut candidate
 *
 * Kickers and defenses are always scrubs: they are streamed, not held.
 */
export type Role = 'star' | 'starter' | 'useful' | 'scrub'
export type Standing = {
  name: string
  pos: string
  /** Rank at his position: the consensus rank where there is one, else his rank by trade value. */
  posRank: number
  role: Role
  /** Starts for the team holding him: in its lineup this week, or within its starting count at his position. */
  starts: boolean
}

export type Currency = {
  /** Trade value per point of market value, by player. */
  factor: Record<string, number>
  /** Players their manager did not pick up off waivers this season. */
  attached: Set<string>
  /** Each rostered player's standing (see `Standing`), when the league's rosters were read. */
  standing?: Record<string, Standing>
}

export const ROLE_ORDER: Record<Role, number> = { scrub: 0, useful: 1, starter: 2, star: 3 }

/**
 * Every rostered player's standing. Ranks are the consensus's where it has the player (that is what the room
 * reads), else his rank by trade value. "Starts for them" is this week's lineup when known, else whether he is
 * inside his team's starting count at his position, so a starter on bye still counts as one.
 */
export const rosterStanding = (input: {
  players: PlayerMap
  market: Record<string, number>
  rosterPositions: string[]
  numTeams: number
  rosters: { rosterId: number; players: string[] }[]
  consensus?: Consensus | null
  starters?: Record<number, string[]>
}): Record<string, Standing> => {
  const { players, market, rosters } = input
  const demand = starterDemand(input.rosterPositions, input.numTeams)
  const posOf = (id: string) => players[id]?.pos
  // Rank by trade value at each position, for players the consensus does not rank.
  const byValue: Record<string, string[]> = {}
  for (const id of Object.keys(market)) {
    const pos = posOf(id)
    if (pos) (byValue[pos] ??= []).push(id)
  }
  const valueRank: Record<string, number> = {}
  for (const ids of Object.values(byValue)) ids.sort((a, b) => (market[b] ?? 0) - (market[a] ?? 0)).forEach((id, i) => (valueRank[id] = i + 1))
  const rankOf = (id: string) => input.consensus?.byId[id]?.posRank ?? valueRank[id] ?? Infinity
  // How deep the league rosters: at each position, and skill players in all.
  const rostered: Record<string, number> = {}
  let skill = 0
  for (const r of rosters)
    for (const id of r.players) {
      const pos = posOf(id)
      if (!pos) continue
      rostered[pos] = (rostered[pos] ?? 0) + 1
      if (!UNTRADED_POSITIONS.has(pos)) skill++
    }
  const out: Record<string, Standing> = {}
  for (const r of rosters) {
    const lineup = new Set(input.starters?.[r.rosterId] ?? [])
    const depth: Record<string, string[]> = {}
    for (const id of r.players) {
      const pos = posOf(id)
      if (pos) (depth[pos] ??= []).push(id)
    }
    for (const ids of Object.values(depth)) ids.sort((a, b) => rankOf(a) - rankOf(b))
    for (const id of r.players) {
      const p = players[id]
      if (!p) continue
      const pos = p.pos
      const d = demand[pos] ?? 0
      const rank = rankOf(id)
      const perTeam = Math.max(1, Math.round(d / Math.max(1, input.numTeams)))
      const starts = lineup.has(id) || (d > 0 && depth[pos].indexOf(id) < perTeam)
      const overall = input.consensus?.byId[id]?.rank
      let role: Role = 'scrub'
      if (UNTRADED_POSITIONS.has(pos)) role = 'scrub'
      // A third of the league's starters at the position, and never fewer than three: RB1–RB10 in a 12-team league.
      else if (d > 0 && rank <= Math.max(3, d / 3)) role = 'star'
      else if ((d > 0 && rank <= d) || starts) role = 'starter'
      else if ((overall != null && overall <= skill) || rank <= 0.85 * (rostered[pos] ?? 0) || (market[id] ?? 0) > 0.5) role = 'useful'
      out[id] = { name: p.name, pos, posRank: Number.isFinite(rank) ? Math.round(rank) : 999, role, starts }
    }
  }
  return out
}

/**
 * Per-player trade value factors for the league. Streaming tier is set by the
 * league's own starter demand: in a superflex league far more quarterbacks
 * are starters, and none of them stream.
 */
export const tradeCurrency = (input: {
  players: PlayerMap
  market: Record<string, number>
  rosterPositions: string[]
  numTeams: number
  rosters: { rosterId: number; players: string[] }[]
  transactions: SleeperTransaction[]
  consensus?: Consensus | null
  /** Each team's lineup this week, for who starts where (see `rosterStanding`). */
  starters?: Record<number, string[]>
}): Currency => {
  const { players, market } = input
  const demand = starterDemand(input.rosterPositions, input.numTeams)
  const factor: Record<string, number> = {}
  // Quarterbacks past starting demand are streamers: by consensus rank where
  // there is one, else by this model's rest-of-season value.
  const qbStarters = Math.round(demand.QB ?? input.numTeams)
  const byMarket = Object.keys(market)
    .filter((id) => players[id]?.pos === 'QB')
    .sort((a, b) => (market[b] ?? 0) - (market[a] ?? 0))
  // A ramp, not a cliff: full value through the starter line, easing to the
  // streamer price by half again past it (QB12 → QB18 in a 12-team league).
  byMarket.forEach((id, i) => {
    const ecr = input.consensus?.byId[id]?.posRank
    const rank = ecr != null ? ecr : i + 1
    const t = Math.min(1, Math.max(0, (rank - qbStarters) / (qbStarters / 2)))
    if (t > 0) factor[id] = 1 - t * (1 - STREAM_FACTOR.QB)
  })
  // Only players a trade can price: anyone with a market value, and anyone on a roster.
  const priced = new Set([...Object.keys(market), ...input.rosters.flatMap((r) => r.players)])
  for (const id of priced) {
    const pos = players[id]?.pos
    if (pos && UNTRADED_POSITIONS.has(pos)) factor[id] = STREAM_FACTOR[pos] ?? 0
  }

  // Who picked up whom this season: the last add of each player, by the roster that holds him now.
  const addedBy: Record<string, number> = {}
  const waiverAdd: Record<string, boolean> = {}
  for (const t of [...input.transactions].filter((x) => x.status === 'complete').sort((a, b) => a.created - b.created)) {
    for (const [id, rid] of Object.entries(t.adds ?? {})) {
      addedBy[id] = rid
      waiverAdd[id] = t.type === 'waiver' || t.type === 'free_agent'
    }
  }
  const attached = new Set<string>()
  for (const r of input.rosters) {
    for (const id of r.players) {
      const pickedUp = addedBy[id] === r.rosterId && waiverAdd[id]
      if (!pickedUp) attached.add(id)
    }
  }
  return { factor, attached, standing: rosterStanding(input) }
}

/** A set's trade value: its market value, as people price it (stars dear, streamers cheap). `owned` adds the owner's attachment. */
export const tradeValue = (ids: string[], market: Record<string, number>, currency: Currency | undefined, owned: boolean) =>
  ids.reduce((a, id) => {
    const v = starValue(Math.max(0, market[id] ?? 0)) * (currency?.factor[id] ?? 1)
    return a + (owned && currency?.attached.has(id) ? v * ATTACHMENT : v)
  }, 0)

// ---- How lopsided a deal reads ----
//
// The overpay term in the trade read (lib/behavior) is linear: every point a manager gives away costs the same.
// People do not read offers that way. A small overpay is a negotiation; a big one is an insult; and some offers are
// not offers at all: a star for nothing, a starter for a deep bench body. Those get declined on sight however
// active or desperate the manager is, so the read sorts each deal into a tier first, judged from the side giving:
//
//   fair      within reach of even, or a slight overpay: the read's own terms decide
//   overpay   asks clearly more than it gives back, by share and by size
//   lopsided  gives back well under half, and a lot in absolute terms: no manager takes it
//   nonsense  something for nothing (no players and no FAAB worth counting), a star for spare parts, or a
//             starter for a bench scrap: it would never happen
//
// Values are what managers price (`tradeValue`), with each player's standing as a floor: a starter counts as at
// least a starter, however low the consensus ranks his position overall (a top-10 tight end ranks around 100th
// on the overall board, where his price is read). A cut candidate for nothing is only an overpay: managers do
// occasionally free a dead roster spot.

export type DealTier = 'fair' | 'overpay' | 'lopsided' | 'nonsense'

export const LOPSIDED = {
  /** The least a player counts for, by standing, in trade-value points. A starter is worth at least a low-end starter. */
  floor: { star: 5, starter: 1.5, useful: 0.5, scrub: 0 } as Record<Role, number>,
  /** Overpay: the gap at least this big, and what comes back under this share of what goes. */
  overpay: { gap: 2.5, share: 0.6 },
  /** Lopsided: a bigger gap and a smaller share; for a star, a big gap at a share that would pass for anyone else. */
  lopsided: { gap: 3, share: 0.4 },
  star: { gap: 6, share: 0.5 },
  /** Nonsense: a star back for under this share, or a starter for a scrub at under this share. */
  nonsense: { star: 0.25, starter: 0.3 },
  /** FAAB alone counts as something back once it covers this share of what goes. */
  faab: 0.5,
}

export type TierRead = {
  tier: DealTier
  /** What they give and what they get back, priced as they price it with standing as a floor, pts/wk. */
  gives: number
  gets: number
  /** No players back and no FAAB worth counting. */
  nothingBack: boolean
  /** The headline player they would give, when there is one. */
  headline: string | null
  /** The reason, in a short line, when the tier is not fair. */
  text: string | null
}

const BUCKETS = [3, 5, 10, 12, 15, 20, 24, 30, 36, 40, 50]
/** "the RB1", "a top-10 RB", "their starting TE", "WR62 depth": how the room would describe him. A star reads by his rank. */
export const describeStanding = (st: Standing) => {
  if (st.role === 'scrub') return 'a cut candidate'
  if (st.role === 'useful') return `${st.pos}${st.posRank} depth`
  if (st.posRank <= 1) return `the ${st.pos}1`
  if (st.role === 'starter' && st.starts) return `their starting ${st.pos}`
  const b = BUCKETS.find((x) => st.posRank <= x)
  return b ? `a top-${b} ${st.pos}` : `a starting ${st.pos}`
}

/**
 * Sort a deal into a tier, from the side of the team giving `gives` and getting `gets` (plus `faab`, in dollars and
 * its worth to them in pts/wk; negative when they pay it). `prices` are the values the read is on, or null to judge
 * on standing alone.
 */
export const dealTier = (input: {
  gives: string[]
  gets: string[]
  prices: Record<string, number> | null
  currency?: Currency
  faab?: { dollars: number; value: number } | null
}): TierRead => {
  const { gives, gets, prices, currency } = input
  const standing = currency?.standing ?? {}
  const price = (id: string, owned: boolean) => (prices ? tradeValue([id], prices, currency, owned) : 0)
  // Without a standing, a player is judged by his price alone: worth something, or a cut candidate.
  const roleOf = (id: string): Role => standing[id]?.role ?? (price(id, true) >= LOPSIDED.floor.useful ? 'useful' : 'scrub')
  const worth = (id: string, owned: boolean) => Math.max(price(id, owned), LOPSIDED.floor[roleOf(id)])
  const faabIn = Math.max(0, input.faab?.value ?? 0)
  const faabOut = Math.max(0, -(input.faab?.value ?? 0))
  const giveV = gives.reduce((a, id) => a + worth(id, true), 0) + faabOut
  const getV = gets.reduce((a, id) => a + worth(id, false), 0) + faabIn
  const nothingBack = gives.length > 0 && !gets.length && (faabIn <= 0 || faabIn < LOPSIDED.faab * giveV)
  const head = [...gives].sort((a, b) => ROLE_ORDER[roleOf(b)] - ROLE_ORDER[roleOf(a)] || worth(b, true) - worth(a, true))[0] ?? null
  const out = (tier: DealTier, text: string | null): TierRead => ({ tier, gives: Math.round(giveV * 100) / 100, gets: Math.round(getV * 100) / 100, nothingBack, headline: head, text })
  if (!head) return out('fair', null)
  const role = roleOf(head)
  const st = standing[head]
  const name = st ? lastName(st.name) : 'he'
  const who = st ? `${name}, ${describeStanding(st)},` : 'a player'
  const share = giveV > 0 ? getV / giveV : 1
  const gap = giveV - getV
  const back = gets.length ? 'spare parts' : `$${Math.max(0, input.faab?.dollars ?? 0)} FAAB`
  const bestBack = gets.reduce((a, id) => Math.max(a, ROLE_ORDER[roleOf(id)]), 0)

  if (nothingBack) {
    const none = (input.faab?.dollars ?? 0) > 0 ? `$${input.faab!.dollars} FAAB` : 'nothing'
    return role === 'scrub' ? out('overpay', st ? `nothing back for ${name}, a cut candidate` : 'nothing back') : out('nonsense', `would never happen: ${who} for ${none}`)
  }
  // A star for bench pieces, or a starter for a cut candidate.
  if (role === 'star' && bestBack <= ROLE_ORDER.useful && share < LOPSIDED.nonsense.star) return out('nonsense', `would never happen: ${who} for ${back}`)
  if (ROLE_ORDER[role] >= ROLE_ORDER.starter && (st?.starts ?? true) && bestBack === 0 && share < LOPSIDED.nonsense.starter)
    return out('nonsense', `would never happen: ${who} for ${gets.length ? 'a bench scrap' : back}`)
  // Lopsided only when nothing as good comes back: a star for a lesser star is a steep ask, not an insult.
  const { lopsided: lop, star, overpay } = LOPSIDED
  if (bestBack < ROLE_ORDER[role] && ((gap >= lop.gap && share < lop.share) || (role === 'star' && gap >= star.gap && share < star.share)))
    return out('lopsided', st && ROLE_ORDER[role] >= ROLE_ORDER.starter ? `no manager takes this: ${name} is ${describeStanding(st)} for little back` : 'no manager takes this: far less back than it asks')
  if (gap >= overpay.gap && share < overpay.share) return out('overpay', 'asks a lot more than it gives')
  return out('fair', null)
}
