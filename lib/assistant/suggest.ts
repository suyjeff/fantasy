// Starter questions for wherever the assistant is opened: three or four, with this league's own names in them.
import { nameOf, teamName, type AsgmLeague } from './league'
import { currentWeek, depthLabels, gameOf, opponentIn } from './resolve'
import type { AsgmContext } from './types'

const first = (name: string) => name

export const suggestions = (context: AsgmContext | undefined, lg: AsgmLeague): string[] => {
  try {
    return build(context, lg).filter(Boolean).slice(0, 4)
  } catch {
    return ['Who should I start this week?', 'What trade should I make?', 'Who should I pick up?', 'What are my playoff odds?']
  }
}

const build = (context: AsgmContext | undefined, lg: AsgmLeague): string[] => {
  const { data, analysis } = lg
  const me = lg.myRosterId
  const week = currentWeek(lg)
  const f = context?.focus
  const need = me != null ? analysis.needs[me]?.worstPos : null
  const labels = me != null ? depthLabels(lg, me) : {}
  const label = (want: string) => Object.keys(labels).find((id) => labels[id] === want)
  const rb2 = label('RB2')
  const rb2Opp = rb2 ? gameOf(lg, data.players[rb2]?.team, week).opp : null
  const topFa = Object.keys(analysis.horizon.perWeek)
    .filter((id) => analysis.rosteredBy[id] == null && ['RB', 'WR', 'TE', 'QB'].includes(data.players[id]?.pos ?? ''))
    .sort((a, b) => analysis.horizon.perWeek[b] - analysis.horizon.perWeek[a])[0]
  const myWrs = me != null ? Object.keys(labels).filter((id) => /^WR/.test(labels[id])) : []
  const opp = me != null ? opponentIn(lg, me, week) : null
  const faab = !!lg.models.faab && me != null ? lg.models.faab.remaining[me] : null
  const po = data.playoffWeeks.length ? 'playoff' : 'remaining'
  const wr1 = label('WR1')
  const wr2 = label('WR2')

  if (f?.kind === 'player') {
    const owner = analysis.rosteredBy[f.id]
    const n = first(nameOf(lg, f.id))
    if (owner === me) return [`Should I start ${n} this week?`, `Is ${n} a sell-high?`, `How does ${n}'s ${po} schedule look?`, `What could ${n} get me in a trade?`]
    if (owner == null) return [`How much FAAB should I bid on ${n}${faab != null ? ` with $${faab} left` : ''}?`, `Would ${n} start for me?`, `Who should I drop for ${n}?`]
    return [`What would it take to get ${n}?`, `Is ${n} worth trading for?`, `How does ${n}'s ${po} schedule look?`]
  }
  if (f?.kind === 'trade') return ['Would they accept this?', 'Does this trade help my playoff odds?', 'How do I make this fair for them?', 'Is there a better version of this deal?']
  if (f?.kind === 'matchup') return ['Can I win this week?', 'Who is the biggest swing in this matchup?', 'What lineup change gives me the best shot?']
  if (f?.kind === 'team' && f.rosterId !== me) return [`What does ${f.label} need?`, `What trade works with ${f.label}?`, `Is ${f.label} a playoff threat?`]
  if (f?.kind === 'waivers') return ['Who should I pick up this week?', topFa ? `How much should I bid on ${nameOf(lg, topFa)}?` : 'How much FAAB should I spend?', 'Which defense should I stream?']

  const view = context?.view ?? ''
  if (/^waivers?/.test(view))
    return ['Who should I pick up this week?', topFa ? `How much should I bid on ${nameOf(lg, topFa)}${faab != null ? ` with $${faab} left` : ''}?` : 'How should I spend my FAAB?', 'Which defense should I stream this week?', need ? `Best ${need} on the wire rest of season?` : 'Who is the best stash on the wire?']
  if (/^trades?/.test(view))
    return [need ? `Find me a ${need} upgrade` : 'What trade should I make?', myWrs.length >= 2 ? 'Which of my WRs is the sell-high?' : 'Who on my team is a sell-high?', opp != null ? `What trade works with ${teamName(lg, opp)}?` : 'Who is most likely to accept a trade?', 'Who is a buy-low target?']
  if (/^playoffs?/.test(view))
    return ['What are my playoff odds?', 'What if I win out?', wr1 && wr2 ? `Who has the softer playoff schedule, ${nameOf(lg, wr1)} or ${nameOf(lg, wr2)}?` : 'Who on my roster has the best playoff schedule?', 'How much does this week matter?']
  if (/^(power|teams|standings)/.test(view)) return ['Who is the best team in the league?', 'Where do I rank and why?', 'Who has the easiest schedule left?']
  return [
    'Who should I start this week?',
    rb2 && rb2Opp ? `Should I bench ${nameOf(lg, rb2)} against ${rb2Opp}?` : 'What is my closest start/sit call?',
    need ? `Find me a ${need} upgrade` : 'What trade should I make?',
    data.playoffWeeks.length ? 'What are my playoff odds?' : 'Who should I pick up?',
  ]
}
