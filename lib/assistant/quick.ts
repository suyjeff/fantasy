// Plain lookups answered straight from the league, with no model: who has a player, a team's record, who a team plays,
// a player's projection, another team's lineup or roster. Instant, free, and nothing to hallucinate. Anything with a
// judgment in it ("should", "better", "worth", a trade, a bid) is left to the model: a template never makes a call.
import { optimalLineup } from '../lineup'
import { nameOf, teamName, type AsgmLeague } from './league'
import { namesShared } from './find'
import { readQuestion } from './pack'
import { currentWeek, depthLabels, matchupText, pct, r1, rangeOf, statusText } from './resolve'
import { matchupOf, ordinal, standingOf, standingRows, recordOf, weekPts } from './tools'
import type { AsgmAction, AsgmCard, AsgmContext } from './types'

export type Quick = { kind: string; label: string; text: string; cards: AsgmCard[]; actions: AsgmAction[] }

/** Words that make a question a judgment call, or more than one lookup: those go to the model. */
const JUDGE =
  /\b(should|would|could|shall|worth|better|best|worst|trade|trading|offer|accept|sit|bench|drop|add|pick ?up|bid|faab|sell|buy|value|why|how good|good|bad|compare|vs\.?|versus|or|odds|chances?|likely|lose|beat|need|needs|help|upgrade|keep|cut|target|recommend|think|rate|grade|thoughts?|stash|stream|play him|outlook|ros|rest of|playoffs?|if|and|also|but|then)\b/i

const POS_WORD: [RegExp, string][] = [
  [/\b(qbs?|quarterbacks?)\b/i, 'QB'],
  [/\b(rbs?|running ?backs?)\b/i, 'RB'],
  [/\b(wrs?|wide ?receivers?|receivers?)\b/i, 'WR'],
  [/\b(tes?|tight ?ends?)\b/i, 'TE'],
  [/\b(k|kickers?)\b/i, 'K'],
  [/\b(def|dst|d\/st|defen[cs]es?)\b/i, 'DEF'],
  [/\bflex\b/i, 'FLEX'],
]
const posIn = (text: string) => POS_WORD.find(([re]) => re.test(text))?.[1] ?? null

const you = (lg: AsgmLeague, rid: number) => rid === lg.myRosterId
/** "Pocket Passers'" and "Gridiron Gang's". */
const poss = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`)
const theirs = (lg: AsgmLeague, rid: number) => (you(lg, rid) ? 'your' : 'their')
const nfl = (lg: AsgmLeague, id: string) => `${lg.data.players[id]?.pos ?? '?'}, ${lg.data.players[id]?.team ?? 'no NFL team'}`
const hasWeekData = (lg: AsgmLeague, week: number) => lg.data.horizon.length > 0 && Object.values(lg.analysis.teamById).some((t) => t.players.some((id) => weekPts(lg, week)(id) > 0))

/** "12.3 projected this week (vs SF), 11.0/wk rest of season" as far as the app has numbers. */
const outlook = (lg: AsgmLeague, id: string, week: number) => {
  const bits: string[] = []
  if (hasWeekData(lg, week)) {
    const p = weekPts(lg, week)(id)
    const m = matchupText(lg, id, week)
    bits.push(m === 'BYE' ? `on bye in week ${week}` : `${r1(p)} projected in week ${week}${m ? ` (${m.replace(/ \(#.*\)$/, '')})` : ''}`)
  }
  const ros = lg.analysis.horizon.perWeek[id]
  if (ros != null) bits.push(`${r1(ros)} pts/wk rest of season`)
  return bits.join(', ')
}

const ownerLine = (lg: AsgmLeague, id: string, week: number) => {
  const name = nameOf(lg, id)
  const rid = lg.analysis.rosteredBy[id]
  const st = statusText(lg, id)
  const look = outlook(lg, id, week)
  const tail = `${look ? ` ${look[0].toUpperCase()}${look.slice(1)}.` : ''}${st ? ` Status: ${st}.` : ''}`
  if (rid == null) return `Nobody: ${name} (${nfl(lg, id)}) is a free agent.${tail}`
  const label = depthLabels(lg, rid)[id]
  if (you(lg, rid)) return `You do. ${name} (${nfl(lg, id)}) is your ${label ?? lg.data.players[id]?.pos}.${tail}`
  return `${teamName(lg, rid)} has ${name} (${nfl(lg, id)}), their ${label ?? lg.data.players[id]?.pos}.${tail}`
}

const owner = (lg: AsgmLeague, ids: string[]): Quick => {
  const week = currentWeek(lg)
  const text = ids.map((id) => ownerLine(lg, id, week)).join('\n')
  const rows = ids.map((id) => {
    const rid = lg.analysis.rosteredBy[id]
    return { id, note: rid == null ? 'free agent' : you(lg, rid) ? 'yours' : teamName(lg, rid) }
  })
  const actions: AsgmAction[] = ids.map((id) => {
    const rid = lg.analysis.rosteredBy[id]
    return rid != null && !you(lg, rid) ? ({ kind: 'openTeam', rosterId: rid, label: `Open ${teamName(lg, rid)}` } as AsgmAction) : ({ kind: 'openPlayer', id, label: `Open ${nameOf(lg, id)}` } as AsgmAction)
  })
  return { kind: 'owner', label: `Looking up who has ${ids.map((id) => nameOf(lg, id)).join(' and ')}`, text, cards: [{ kind: 'players', title: ids.length === 1 ? 'Owner' : 'Owners', rows }], actions }
}

const record = (lg: AsgmLeague, rid: number): Quick => {
  const s = lg.analysis.seasonById[rid]
  const p = lg.analysis.powerById[rid]
  const sim = lg.models.forecast?.sim[rid]
  const n = lg.analysis.teams.length
  const who = you(lg, rid) ? "You're" : `${teamName(lg, rid)} is`
  const lines = [`${who} ${recordOf(lg, rid)}, ${ordinal(standingOf(lg, rid))} of ${n}${s ? ` (PF ${r1(s.pf)}, PA ${r1(s.pa)})` : ''}.`]
  const more = [p ? `Power #${p.rank}` : '', sim ? `playoffs ${pct(sim.playoffs)}, title ${pct(sim.title)}` : '', s?.streak ? `streak ${s.streak}` : ''].filter(Boolean)
  if (more.length) lines.push(`${more.join('; ')}.`)
  return { kind: 'record', label: `Reading ${you(lg, rid) ? 'your' : poss(teamName(lg, rid))} record`, text: lines.join(' '), cards: [], actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${teamName(lg, rid)}` }] }
}

const standings = (lg: AsgmLeague): Quick => {
  const sim = lg.models.forecast?.sim
  const rows = standingRows(lg).map((s, i) => `${i + 1}. ${teamName(lg, s.rosterId)}${you(lg, s.rosterId) ? ' (you)' : ''} ${recordOf(lg, s.rosterId)} · PF ${r1(s.pf)}${sim ? ` · playoffs ${pct(sim[s.rosterId]?.playoffs)}` : ''}`)
  return { kind: 'standings', label: 'Reading the standings', text: `Standings after week ${Math.max(0, ...lg.data.regularWeeks)}:\n${rows.join('\n')}`, cards: [], actions: [{ kind: 'goto', view: 'power', label: 'Open power ranks' }] }
}

const opponent = (lg: AsgmLeague, rid: number, week: number): Quick | null => {
  let m
  try {
    m = matchupOf(lg, rid, week)
  } catch {
    return null
  }
  const a = teamName(lg, rid)
  const b = teamName(lg, m.opp)
  const lead = you(lg, rid) ? `You play ${b} in week ${week}.` : `${a} plays ${b}${you(lg, m.opp) ? ' (you)' : ''} in week ${week}.`
  const nums = `Best lineups project ${r1(m.A.total)} to ${r1(m.B.total)}; ${you(lg, rid) ? 'you win' : `${a} wins`} ${pct(m.pWin)}.`
  return { kind: 'opponent', label: `Previewing ${you(lg, rid) ? 'your' : poss(a)} week ${week} matchup`, text: `${lead} ${nums}`, cards: [], actions: [{ kind: 'openTeam', rosterId: m.opp, label: `Open ${b}` }] }
}

const projection = (lg: AsgmLeague, id: string, week: number): Quick | null => {
  if (!hasWeekData(lg, week)) return null
  const name = nameOf(lg, id)
  const p = weekPts(lg, week)(id)
  const m = matchupText(lg, id, week)
  const { low, high } = rangeOf(lg, id, p)
  const st = statusText(lg, id, week)
  const ros = lg.analysis.horizon.perWeek[id]
  const lead = m === 'BYE' ? `${name} is on bye in week ${week}: 0 projected.` : `${name} projects ${r1(p)} in week ${week}${m ? `, ${m}` : ''}.`
  const lines = [lead]
  if (m !== 'BYE' && p > 0) lines.push(`Range ${r1(low)}–${r1(high)} (a 20th to 80th percentile game).`)
  if (ros != null) lines.push(`Rest of season: ${r1(ros)} pts/wk.`)
  if (st) lines.push(`Status: ${st}.`)
  return { kind: 'projection', label: `Reading ${poss(name)} week ${week} projection`, text: lines.join(' '), cards: [{ kind: 'players', title: `Week ${week}`, rows: [{ id, value: `${r1(p)} proj`, note: m || undefined }] }], actions: [{ kind: 'openPlayer', id, label: `Open ${name}` }] }
}

const slotLabel = (s: string) => s.replace('SUPER_FLEX', 'SF')

const lineup = (lg: AsgmLeague, rid: number, week: number, pos: string | null): Quick | null => {
  if (!hasWeekData(lg, week)) return null
  const team = lg.analysis.teamById[rid]
  const slots = lg.analysis.slots
  const pts = weekPts(lg, week)
  const set = (team.roster.starters ?? []).map((id) => (id && id !== '0' && lg.data.players[id] ? id : null))
  const name = teamName(lg, rid)
  const line = (id: string) => `${nameOf(lg, id)} ${r1(pts(id))}${(() => {
    const m = matchupText(lg, id, week)
    return m ? ` (${m.replace(/ \(#.*\)$/, '')})` : ''
  })()}`
  const best = optimalLineup(slots, team.players.filter((id) => lg.data.players[id]).map((id) => ({ id, fpos: lg.data.players[id].fpos?.length ? lg.data.players[id].fpos : [lg.data.players[id].pos], pts: pts(id) })))
  const bestIds = new Set(best.assignments.filter(Boolean).map((p) => p!.id))
  const setTotal = set.reduce((a, id) => a + (id ? pts(id) : 0), 0)
  if (pos) {
    const idx = slots.map((s, i) => i).filter((i) => (pos === 'FLEX' ? /FLEX/.test(slots[i].name) : slots[i].name === pos || (set[i] && lg.data.players[set[i]!]?.pos === pos && !/FLEX/.test(slots[i].name))))
    const ids = idx.map((i) => set[i]).filter((x): x is string => !!x)
    const flexers = pos !== 'FLEX' ? slots.map((s, i) => (/FLEX/.test(s.name) && set[i] && lg.data.players[set[i]!]?.pos === pos ? set[i]! : null)).filter((x): x is string => !!x) : []
    if (!idx.length) return null
    const lead = ids.length ? `${name} starts ${ids.map(line).join(' and ')} at ${pos}${flexers.length ? `, plus ${flexers.map(line).join(', ')} at FLEX` : ''} in week ${week}.` : `${name} has nobody set at ${pos} for week ${week}.`
    // Who the app would start there instead, when that differs: a fact about their lineup, not advice to them.
    const better = team.players.filter((id) => bestIds.has(id) && !set.includes(id) && lg.data.players[id]?.pos === pos)
    const extra = better.length ? ` Their best lineup would start ${better.map(line).join(', ')} instead.` : ''
    return { kind: 'lineup', label: `Reading ${poss(name)} week ${week} lineup`, text: `${lead}${extra}`, cards: [{ kind: 'players', title: `${name} ${pos}`, rows: ids.map((id) => ({ id, value: `${r1(pts(id))} proj` })) }], actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${name}` }] }
  }
  const rows = set.map((id, i) => `${slotLabel(slots[i]?.name ?? '?')} ${id ? line(id) : 'EMPTY'}`)
  const gap = best.total - setTotal
  const text = `${poss(name)} week ${week} lineup as set, ${r1(setTotal)} projected:\n${rows.join('\n')}${gap >= 0.5 ? `\nTheir best lineup would project ${r1(best.total)} (+${r1(gap)}).` : ''}`
  return { kind: 'lineup', label: `Reading ${poss(name)} week ${week} lineup`, text, cards: [{ kind: 'players', title: `${name} week ${week}`, rows: set.filter((x): x is string => !!x).slice(0, 10).map((id) => ({ id, value: `${r1(pts(id))} proj` })) }], actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${name}` }] }
}

const roster = (lg: AsgmLeague, rid: number, pos: string | null): Quick => {
  const team = lg.analysis.teamById[rid]
  const name = teamName(lg, rid)
  const starters = new Set((team.roster.starters ?? []).filter((x) => x && x !== '0'))
  const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
  const ros = (id: string) => lg.analysis.horizon.perWeek[id] ?? 0
  const by: Record<string, string[]> = {}
  for (const id of team.players) {
    const p = lg.data.players[id]
    if (p && (!pos || pos === 'FLEX' || p.pos === pos)) (by[p.pos] ??= []).push(id)
  }
  const lines = order.filter((p) => by[p]?.length).map((p) => `${p}: ${by[p].sort((a, b) => ros(b) - ros(a)).map((id) => `${starters.has(id) ? '*' : ''}${nameOf(lg, id)} ${r1(ros(id))}${lg.data.players[id].injury ? ` (${lg.data.players[id].injury})` : ''}`).join(', ')}`)
  const head = `${you(lg, rid) ? 'Your' : poss(name)} roster${pos && pos !== 'FLEX' ? ` at ${pos}` : ''} (pts/wk rest of season; * = in ${theirs(lg, rid)} set lineup):`
  return { kind: 'roster', label: `Reading ${you(lg, rid) ? 'your' : poss(name)} roster`, text: `${head}\n${lines.join('\n') || 'Nobody there.'}`, cards: [], actions: [{ kind: 'openTeam', rosterId: rid, label: `Open ${name}` }] }
}

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The question with every team and manager name taken out, as whole words only: a manager "sho" never eats "should". */
export const withoutTeams = (lg: AsgmLeague, text: string) => {
  let out = text
  for (const t of lg.analysis.teams)
    for (const n of [t.name, t.owner].filter((x) => x && x.trim().length >= 3)) {
      const body = esc(n.trim()).replace(/\s*&\s*/g, '\\s*(?:&|and)\\s*')
      out = out.replace(new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'gi'), ' TEAM ')
    }
  return out
}

/** Past tense: a result, not this week's game ("who did I play last week"). The model reads the schedule. */
const PAST = /\b(last (week|year|season|game)|did|played|yesterday|was|were|ago|previous(ly)?|lost|won|had|got beat|scored)\b/i
/** A lineup sense: "who do I start against the Ravens", "who do I play at flex". Never the opponent template. */
const LINEUPISH = /\b(start(s|ing|er|ers)?|sit|bench|flex|lineup|line-up|slot)\b/i
/** Two sides compared: head-to-head, "my record against them". */
const VERSUS = /\b(against|vs\.?|versus|head[- ]to[- ]head|h2h|compared?)\b/i

/** A lookup answered from the app's data, or null when the question wants the model. */
export const quickAnswer = (lg: AsgmLeague, text: string, context?: AsgmContext): Quick | null => {
  try {
    return quick(lg, text, context)
  } catch {
    return null
  }
}

const quick = (lg: AsgmLeague, raw: string, context?: AsgmContext): Quick | null => {
  const text = raw.trim()
  const words = text.split(/\s+/).filter(Boolean).length
  if (!text || words > 14 || /\n/.test(text)) return null
  // A judgment, or a second clause: the model's job. Team names go first ("Fourth & Long" is not a second clause).
  const r = readQuestion(lg, text, context)
  // "Who has Jefferson and St. Brown?" is still one lookup.
  const plain = r.intents.includes('owner') ? text.replace(/\band\b/gi, ' ') : text
  const bare = withoutTeams(lg, plain)
  if (JUDGE.test(bare)) return null
  // Past tense, a name several players share, or a schedule question: not a lookup this path can be sure of.
  if (PAST.test(bare) || namesShared(lg, text)) return null
  const players = r.players
  const teams = [...r.teams, ...(r.mineNamed ? [lg.myRosterId!] : [])]
  const has = (i: string) => r.intents.includes(i as never)
  if (has('schedule') || has('moves') || has('needs') || has('leaders')) return null
  const self = /\b(my|me|i|i'm|im|am i|mine|us|we|our)\b/i.test(bare)
  // "My record against Fourth & Long", "is Fourth & Long my opponent": two sides at once.
  if (self && r.teams.length) return null
  const me = self && lg.myRosterId != null ? lg.myRosterId : null
  const week = r.week ?? currentWeek(lg)

  if (has('owner') && players.length >= 1 && players.length <= 3) return owner(lg, players)
  // "Who has Puka?" also reads as the player's own question; the plain "who has X" shape is ownership.
  if (players.length && /^(who|which team|what team|whose)\b/i.test(text) && /\b(has|have|owns?|got)\b/i.test(text) && !teams.length) return owner(lg, players)

  const team = teams.length === 1 ? teams[0] : teams.length === 0 ? me : null
  if (!players.length && team != null) {
    // Only a pure "who do they play": no lineup sense, no position, nothing else asked.
    if (has('opponent')) return !LINEUPISH.test(bare) && !posIn(bare) && r.intents.every((i) => i === 'opponent' || i === 'matchup') ? opponent(lg, team, week) : null
    if (/\brecord\b|\bwhat place\b|\bin (first|last) place\b|\bstanding\b/i.test(text)) return VERSUS.test(bare) ? null : record(lg, team)
    if (has('roster')) return roster(lg, team, posIn(text))
    // Another team's lineup as it is set: a lookup. Your own lineup is a judgment (who should start): the model.
    if (teams.length === 1 && !you(lg, team) && /\b(start(s|ing|ers?)?|lineup|line-up)\b/i.test(text) && !/\b(i|me|my)\b/i.test(text)) return lineup(lg, team, week, posIn(text))
  }
  if (!players.length && !teams.length && /^(what are |show( me)? |the )?(the )?(league )?standings\??$/i.test(text)) return standings(lg)
  if (players.length === 1 && !teams.length && /\bproject(ed|ion|ions|s)?\b|\bproj\b|\bhow many points\b/i.test(text)) return projection(lg, players[0], week)
  return null
}
