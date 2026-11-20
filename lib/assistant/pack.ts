// The context pack: what the model sees before it has asked for anything. The league in a few lines, the asking
// manager's roster, what they are looking at, and the tools this question obviously needs, already run, so most
// questions are answered in one model call. A quick reading of the question decides which tools those are.
import type { Deal } from '../deal'
import { nameOf, teamName, type AsgmLeague } from './league'
import { findTeams, findPlayers } from './find'
import { currentWeek, depthLabels, expOf, gameOf, opponentIn, pct, projOf, r1 } from './resolve'
import { priceDeal, runTool, toolLabel, type Args, type ToolOut } from './tools'
import type { AsgmContext } from './types'

export type Intent =
  | 'faab'
  | 'waivers'
  | 'trade'
  | 'values'
  | 'playoffs'
  | 'matchup'
  | 'standings'
  | 'lineup'
  | 'compare'
  | 'news'
  | 'rankings'
  | 'team'
  | 'owner'
  | 'opponent'
  | 'roster'
  | 'leaders'
  | 'moves'
  | 'needs'
  | 'schedule'
  | 'player'
  | 'general'

export type PreRun = { tool: string; args: Args; deal?: Deal }

export type Reading = {
  intents: Intent[]
  /** Players the question names, in the order it names them. */
  players: string[]
  /** Teams it names (other than the asker's). */
  teams: number[]
  /** It names the asker's own team by name. */
  mineNamed: boolean
  week: number | null
  position: string | null
  budget: number | null
}

const POS = /\b(qbs?|rbs?|wrs?|tes?|kickers?|k|defen[cs]es?|dst|d\/st|def|flex|quarterbacks?|running ?backs?|receivers?|wide ?receivers?|tight ?ends?)\b/i
const POS_OF: [RegExp, string][] = [
  [/^(qb|quarterback)/i, 'QB'],
  [/^(rb|running ?back)/i, 'RB'],
  [/^(wr|receiver|wide ?receiver)/i, 'WR'],
  [/^(te|tight ?end)/i, 'TE'],
  [/^(k|kicker)/i, 'K'],
  [/^(def|dst|d\/st|defen)/i, 'DEF'],
  [/^flex/i, 'FLEX'],
]
/** Players a question names, in the order it names them: full names, surnames, first names, nicknames, initials,
 * typos, and "my RB2" / "<team>'s WR1" labels (lib/assistant/find.ts). */
export const playersIn = (lg: AsgmLeague, text: string): string[] => findPlayers(lg, text)

/** A quick reading of the question: what it is about, and who. */
export const readQuestion = (lg: AsgmLeague, text: string, context?: AsgmContext): Reading => {
  const t = text.toLowerCase()
  const intents: Intent[] = []
  const add = (i: Intent, re: RegExp) => {
    if (re.test(t) && !intents.includes(i)) intents.push(i)
  }
  add('faab', /\bfaab\b|\bbid\b|\$\s?\d+|\bbudget\b/)
  add('values', /sell[- ]?high|buy[- ]?low|\bsell\b.*\bwhich\b|which .*\bsell\b|overvalued|undervalued/)
  add('trade', /\btrade|\boffer|\bdeal\b|\baccept|\bsell\b|\bbuy\b|\bacquire|\bpackage|\bfleece|\bsend\b|\bfor my\b|what would it take|\bwant for\b|\bpry\b|\b(take|give|swap|flip)\b.+\bfor\b|\bget\b.+\bfrom\b/)
  if (/\bupgrade|\bimprove\b|\bhelp at\b/.test(t)) {
    const view = context?.view ?? ''
    if (/^waivers?/.test(view)) add('waivers', /./)
    else if (/^trades?/.test(view)) add('trade', /./)
    else {
      add('trade', /./)
      add('waivers', /./)
    }
  }
  add('waivers', /waiver|pick ?up|pickup|free agent|\bthe wire\b|\badd\b|\bdrop\b|\bstream/)
  add('playoffs', /playoff(?!s? (schedule|weeks?|matchups?|slate|run))|\bodds\b|clinch|\bseed|\bmake it\b|\bbye\b(?! week)|win out|eliminat|\btitle\b|championship|what if|if i (win|lose)/)
  add('matchup', /matchup|opponent|\bwin this week|\bbeat\b|\bversus\b.*\bteam\b|who am i (playing|facing)/)
  add('standings', /standings|power rank|\brecord\b|best team|worst team|who'?s winning the league/)
  add('lineup', /\bstart\b|\bsit\b|\bbench\b|\bflex\b|lineup|\bplay\b.*\bover\b|\bstarting\b/)
  add('compare', /compare|\bvs\.?\b|\bversus\b|\bor\b|\bbetter\b|softer|easier|harder|schedule|rest of (the )?season|\bros\b/)
  add('news', /\bnews\b|injur|\bhurt\b|status|questionable|doubtful|what happened|\bout\b this week|\blatest\b|\bupdate\b/)
  add('rankings', /\bbest (available )?(qb|rb|wr|te|k|kicker|def|defense|dst|flex)|\btop \d+|\brank(ings?)?\b/)
  // League-wide lookups: who owns whom, any team's opponent, roster, the league's leaders, needs and moves.
  add('owner', /\bwho(?:'?s| is)? (?:has|have|owns?|got|rostered)\b(?! (?:the|a|an|more|most|better|best|softer|easier|harder|any)\b)|\b(?:which|what) team(?:'?s| is)? (?:has|have|owns?|got|rostered)\b|\bwhose (?:team|roster)\b|\bowner\b|\bwho owns\b|\bon (?:which|what|whose) (?:team|roster)\b|\b(?:is|are) \S+(?: \S+){0,3} (?:available|rostered|a free agent|taken|owned|on (?:the )?(?:wire|waivers))\b/)
  add('opponent', /\bwho (?:does|do|is|are|am|will|did)\b.*\b(?:play|playing|face|facing|against|matched)\b|\bopponent\b|\bwho(?:'s| is) .* (?:playing|facing)\b|\bplays? (?:this|next) week\b/)
  add('roster', /\broster\b|\bwho(?:'s| is| are) on\b|\bwhat (?:\w+ )?(?:does|do) .* have\b|\bwho (?:does|do) .* have\b|\bdepth\b/)
  add('leaders', /\bleads? the league\b|\bleaders?\b|\bmost (?:fantasy )?points\b|\btop[- ]scor|\bhighest[- ]scoring\b|\bscored the most\b/)
  add('moves', /\btransactions?\b|\brecent (?:moves|trades|adds|pickups|claims)\b|\bwho (?:traded|picked up|added|dropped|claimed)\b|\blast trade\b|\btrades? (?:this season|so far|in the league|happened)\b|\bwaiver (?:claims|history)\b|\bwhat trades\b/)
  add('needs', /\b(?:which|what) teams? (?:needs?|is (?:thin|weak)|could use|is desperate)\b|\bwho needs\b|\bneeds? (?:a |an )?(?:qb|rb|wr|te)s? (?:the )?most\b|\bevery team'?s needs?\b/)
  add('schedule', /\bhow did .* (?:do|score|play)\b|\blast week\b|\bhead[- ]to[- ]head\b|\bh2h\b|\bremaining (?:schedule|opponents)\b|\bwho(?:'s| is| do .*) (?:left|still to play)\b|\bschedule\b/)
  add('team', /my team|\broster\b|\bneeds?\b|weakness|strength|scout|\bbyes?\b/)
  const named = findTeams(lg, text)
  const players = findPlayers(lg, text)
  if (!intents.length) intents.push(players.length ? 'player' : 'general')
  const w = /\bweek\s*(\d{1,2})\b|\bw(\d{1,2})\b/i.exec(text)
  const pm = POS.exec(text)
  const position = pm ? (POS_OF.find(([re]) => re.test(pm[1]))?.[1] ?? null) : null
  const b = /\$\s?(\d{1,4})/.exec(text) ?? /(\d{1,4})\s?(?:dollars|bucks|faab)/i.exec(text)
  return { intents, players, teams: named.filter((r) => r !== lg.myRosterId), mineNamed: lg.myRosterId != null && named.includes(lg.myRosterId), week: w ? Number(w[1] ?? w[2]) : /next week/i.test(text) ? currentWeek(lg) + 1 : null, position, budget: b ? Number(b[1]) : null }
}

/** The tools to run before the model sees the question: from what is on screen, then from the question. At most two. */
export const planPreRuns = (lg: AsgmLeague, text: string, context: AsgmContext | undefined, r: Reading = readQuestion(lg, text, context)): PreRun[] => {
  const runs: PreRun[] = []
  const add = (tool: string, args: Args = {}, deal?: Deal) => {
    if (runs.length >= 2 || runs.some((x) => x.tool === tool && JSON.stringify(x.args) === JSON.stringify(args))) return
    runs.push({ tool, args, deal })
  }
  const me = lg.myRosterId
  const mine = r.players.filter((id) => lg.analysis.rosteredBy[id] === me)
  const theirs = r.players.filter((id) => lg.analysis.rosteredBy[id] != null && lg.analysis.rosteredBy[id] !== me)
  const free = r.players.filter((id) => lg.analysis.rosteredBy[id] == null)
  const week = r.week ?? undefined
  const span = /playoff/i.test(text) ? 'playoffs' : /this week|week \d/i.test(text) ? 'week' : /next (few|4|four)/i.test(text) ? 'next4' : 'ros'
  const has = (i: Intent) => r.intents.includes(i)
  const f = context?.focus

  const other = r.teams[0]
  const otherName = other != null ? teamName(lg, other) : undefined
  const meToo = /\b(my|me|i|us|we)\b/i.test(text)

  // League-wide lookups first: they name exactly what they need.
  if (has('owner') && r.players.length) for (const id of r.players.slice(0, 2)) add('player', { player: nameOf(lg, id) })
  if (has('needs')) add('league_needs', r.position && ['QB', 'RB', 'WR', 'TE'].includes(r.position) ? { position: r.position } : {})
  if (has('moves')) add('transactions', { ...(otherName ? { team: otherName } : {}), ...(/trade/i.test(text) ? { type: 'trade' } : /waiver|claim/i.test(text) ? { type: 'waiver' } : {}) })
  if (has('leaders') && r.position) add('rankings', { position: r.position, basis: 'season', pool: 'all' })
  if (has('opponent') && !has('trade')) add('matchup', { ...(week ? { week } : {}), ...(otherName && !/\bmy\b|\bi\b|\bam\b/i.test(text) ? { team: otherName } : {}) })
  if (has('schedule') && other != null && r.players.length < 2) {
    if (r.teams.length >= 2) add('schedule', { team: otherName, vs: teamName(lg, r.teams[1]) })
    else if (meToo && /head[- ]to[- ]head|h2h|\bvs\b|against|\bplayed\b/i.test(text)) add('schedule', { team: 'me', vs: otherName })
    else add('schedule', { team: otherName })
  }
  if (has('roster') && (other != null || r.mineNamed) && !has('trade')) add('team', { team: otherName ?? teamName(lg, me) })
  if (has('standings') && other != null) add('team', { team: otherName })

  // The question first: it says what is wanted; the screen says what it is about.
  if (has('faab') && free.length) add('faab_bid', { player: nameOf(lg, free[0]), ...(r.budget != null ? { budget: r.budget } : {}) })
  if (has('values')) add('trade_values', { team: /\b(buy|league|anyone|target)\b/i.test(text) && !/\bmy\b/i.test(text) ? 'league' : 'me', ...(r.position && r.position !== 'FLEX' ? { position: r.position } : {}) })
  if (has('trade') && !has('values') && !has('moves')) {
    if (f?.kind === 'trade') add('evaluate_trade', {}, f.deal)
    else if (mine.length && theirs.length) add('evaluate_trade', { give: mine.map((id) => nameOf(lg, id)), get: theirs.map((id) => nameOf(lg, id)) })
    else if (theirs.length) add('find_trades', { target: nameOf(lg, theirs[0]) })
    else if (mine.length) add('find_trades', { sell: nameOf(lg, mine[0]) })
    else add('find_trades', r.position && r.position !== 'FLEX' ? { position: r.position } : {})
  }
  if (has('waivers') && !has('faab')) add('waivers', r.position && r.position !== 'FLEX' ? { position: r.position } : {})
  if (has('faab') && !free.length) add('waivers', {})
  if (has('playoffs')) add('playoff_odds', /win out/i.test(text) ? { win_out: true } : {})
  if (has('lineup') && !has('trade')) {
    if (r.players.length >= 2 && !/playoff|rest of (the )?season|\bros\b/i.test(text)) add('start_sit', { players: r.players.slice(0, 4).map((id) => nameOf(lg, id)), ...(week ? { week } : {}) })
    else if (other != null && !(meToo && /\b(should|do) i\b/i.test(text))) add('lineup', { team: otherName, ...(week ? { week } : {}) })
    else add('lineup', week ? { week } : {})
  }
  if (has('compare') && r.players.length >= 2 && !runs.some((x) => x.tool === 'start_sit' || x.tool === 'evaluate_trade')) {
    if (span === 'week') add('start_sit', { players: r.players.slice(0, 4).map((id) => nameOf(lg, id)), ...(week ? { week } : {}) })
    else add('compare_players', { players: r.players.slice(0, 4).map((id) => nameOf(lg, id)), span })
  }
  if (has('matchup')) add('matchup', { ...(week ? { week } : {}), ...(r.teams.length && !/\bmy\b|\bi\b/i.test(text) ? { team: teamName(lg, r.teams[0]) } : {}) })
  if (has('standings')) add('standings')
  if (has('news') && r.players.length) {
    add('news', { players: r.players.slice(0, 3).map((id) => nameOf(lg, id)) })
    if (r.players.length === 1) add('player', { player: nameOf(lg, r.players[0]) })
  }
  if (has('rankings') && r.position) add('rankings', { position: r.position, pool: /available|wire|free agent|pick ?up/i.test(text) ? 'available' : 'all', basis: /rest of|ros\b|season/i.test(text) ? 'ros' : 'week', ...(week ? { week } : {}) })
  if (has('team') && !has('needs')) add('team', r.teams.length ? { team: teamName(lg, r.teams[0]) } : {})
  if (r.players.length === 1 && !runs.length) add('player', { player: nameOf(lg, r.players[0]) })
  if (other != null && !runs.length) add('team', { team: otherName })

  // What is on screen.
  if (f) {
    if (f.kind === 'player') add('player', { player: nameOf(lg, f.id) })
    if (f.kind === 'trade') add('evaluate_trade', {}, f.deal)
    if (f.kind === 'lineup') add('lineup', { team: teamName(lg, f.rosterId), week: f.week })
    if (f.kind === 'matchup') add('matchup', { team: teamName(lg, f.rosterIds[0]), week: f.week })
    if (f.kind === 'waivers') add('waivers', {})
    if (f.kind === 'team') add('team', { team: teamName(lg, f.rosterId) })
  }
  if (!runs.length && r.intents.includes('general')) {
    const view = context?.view ?? ''
    if (/^(me|lineup|dashboard)/.test(view)) add('lineup')
    else if (/^trades?/.test(view)) add('find_trades')
    else if (/^waivers?/.test(view)) add('waivers')
    else if (/^playoffs?/.test(view)) add('playoff_odds')
    else if (/^(power|teams)/.test(view)) add('standings')
  }
  return runs
}

/** Runs a planned tool, a deal on screen included (it may involve any two teams). */
export const runPre = async (lg: AsgmLeague, p: PreRun, signal?: AbortSignal): Promise<ToolOut & { ok: boolean }> => {
  if (p.deal) {
    const d = p.deal
    const two = d.teams.length === 2 && d.moves.length > 0
    if (!two) return { ok: false, text: 'The deal on screen has more than two teams or no players; ask about it piece by piece.' }
    const me = lg.myRosterId != null && d.teams.includes(lg.myRosterId) ? lg.myRosterId : d.teams[0]
    const partner = d.teams.find((t) => t !== me)!
    const give = d.moves.filter((m) => m.from === me).map((m) => m.player)
    const get = d.moves.filter((m) => m.to === me).map((m) => m.player)
    const dollars = d.faab.reduce((a, x) => a + (x.from === me ? x.dollars : x.to === me ? -x.dollars : 0), 0)
    try {
      return { ok: true, ...(await priceDeal(lg, me, partner, give, get, dollars, signal)) }
    } catch (e) {
      return { ok: false, text: `Error: ${(e as Error)?.message ?? e}` }
    }
  }
  return runTool(p.tool, p.args, lg, signal)
}

export const preLabel = (lg: AsgmLeague, p: PreRun) => (p.deal ? 'Pricing the trade on screen and running 4,000 season sims' : toolLabel(p.tool, p.args, lg))

const scoringName = (s: Record<string, number>) => {
  const rec = s.rec ?? 0
  const base = rec >= 1 ? 'PPR' : rec >= 0.5 ? 'half PPR' : rec > 0 ? `${rec} per catch` : 'standard (no PPR)'
  const extras = [
    (s.pass_td ?? 4) >= 6 ? '6-pt passing TDs' : '',
    (s.bonus_rec_te ?? 0) > 0 ? `TE premium +${s.bonus_rec_te}` : '',
    (s.pass_int ?? -1) <= -2 ? `INT ${s.pass_int}` : '',
  ].filter(Boolean)
  return [base, ...extras].join(', ')
}

const slotsText = (lg: AsgmLeague) => {
  const counts: Record<string, number> = {}
  for (const s of lg.data.league.roster_positions ?? []) counts[s] = (counts[s] ?? 0) + 1
  return Object.entries(counts)
    .map(([k, n]) => `${n > 1 ? `${n} ` : ''}${k.replace('SUPER_FLEX', 'SUPERFLEX').replace('BN', 'bench')}`)
    .join(', ')
}

/** The league and the asking team in a few lines: always in the pack. */
export const leagueBrief = (lg: AsgmLeague, context?: AsgmContext) => {
  const { data, analysis, models } = lg
  const L = data.league
  const s = L.settings ?? {}
  const week = currentWeek(lg)
  const out: string[] = []
  const deadline = Number(s.trade_deadline ?? 0)
  const closed = deadline && week > deadline
  out.push(
    `League: ${L.name} · ${analysis.teams.length} teams · ${scoringName(L.scoring_settings ?? {})} · lineup: ${slotsText(lg)} · ${s.waiver_type === 2 ? `FAAB $${s.waiver_budget ?? '?'}${data.tradeFaab ? ' (tradeable)' : ''}` : 'waiver priority, no FAAB'} · ${data.provider === 'espn' ? 'ESPN' : 'Sleeper'}.`,
  )
  out.push(
    `Calendar: NFL week ${week}${data.state.season_type !== 'regular' ? ` (${data.state.season_type})` : ''}; ${data.futureWeeks.length} regular-season weeks left; playoffs weeks ${data.playoffWeeks.join(', ') || '?'} (${s.playoff_teams ?? '?'} teams)${deadline ? `; trade deadline week ${deadline}${closed ? ' (passed: no trades)' : deadline === week ? ' (this week: last chance to trade)' : ''}` : ''}${(s.league_average_match ?? 0) ? '; plays the league median each week' : ''}.`,
  )
  if (data.horizonSource !== 'projections') out.push('Note: no projections for the weeks ahead are loaded; values come from results so far.')
  const rid = lg.myRosterId
  if (rid != null) {
    const t = analysis.teamById[rid]
    const se = analysis.seasonById[rid]
    const sim = models.forecast?.sim[rid]
    const opp = opponentIn(lg, rid, week)
    const nw = models.forecast?.nextWeek.find((g) => g.a === rid || g.b === rid)
    const pWin = nw ? (nw.a === rid ? nw.pA : 1 - nw.pA) : null
    out.push(
      `You: ${t.name} · ${se ? `${se.wins}-${se.losses}${se.ties ? `-${se.ties}` : ''}` : ''} · power #${analysis.powerById[rid]?.rank ?? '–'} of ${analysis.teams.length}${sim ? ` · playoffs ${pct(sim.playoffs)}, title ${pct(sim.title)}` : ''}${models.faab ? ` · FAAB $${models.faab.remaining[rid] ?? 0} left` : ''}${opp != null ? ` · week ${week} vs ${teamName(lg, opp)}${pWin != null ? ` (${pct(pWin)} to win)` : ''}` : ''}.`,
    )
    const labels = depthLabels(lg, rid, week)
    const starters = new Set((t.roster.starters ?? []).filter((x) => x && x !== '0'))
    const order = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
    const ids = t.players.filter((id) => data.players[id]).sort((a, b) => order.indexOf(data.players[a].pos) - order.indexOf(data.players[b].pos) || (labels[a] ?? '').localeCompare(labels[b] ?? '', 'en', { numeric: true }))
    out.push(`Your roster (label = rank at his position by expected points this week · player · NFL team · wk${week} proj · rest-of-season pts/wk · notes; * = in your set lineup):`)
    for (const id of ids) {
      const p = data.players[id]
      const g = gameOf(lg, p.team, week)
      const notes = [g.bye ? 'BYE' : g.opp ? `${g.home === false ? '@' : 'vs'} ${g.opp}` : '', p.injury ?? '', analysis.form[id]?.kind ?? ''].filter(Boolean).join(', ')
      out.push(`${starters.has(id) ? '*' : ' '}${labels[id] ?? p.pos} ${p.name} (${p.team ?? 'FA'}) ${r1(projOf(lg, id, week))} · ${r1(analysis.horizon.perWeek[id] ?? expOf(lg, id, week) ?? 0)}/wk${notes ? ` · ${notes}` : ''}`)
    }
  } else out.push('The asking manager has no team in this league (browsing). Ask which team when it matters.')
  if (context) out.push(`On screen: ${context.label} (${context.view})${context.focus ? `; focused on ${context.focus.label}` : ''}.`)
  return out.join('\n')
}

export const PACK_LIMIT = 11_000
const TOOL_LIMIT = 4_200

/** Trims a tool's text to fit, on a line boundary. */
export const clip = (s: string, max: number) => {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = cut.lastIndexOf('\n')
  return `${at > max * 0.6 ? cut.slice(0, at) : cut}\n[…trimmed]`
}

/** The pack itself, from the brief and the pre-run results. */
export const packText = (brief: string, pre: { label: string; tool: string; text: string }[]) => {
  const parts = [`CONTEXT (computed by the app just now; the only numbers you may use besides tool results):`, brief]
  for (const p of pre) parts.push(`[${p.tool}] ${p.label}\n${clip(p.text, TOOL_LIMIT)}`)
  // A pre-run that reached a verdict for the asking manager ("Call for <team> (you): …") says so; the model leads with it
  // however the question is worded. A Call line about another team is about that team, and says so in its own words.
  if (pre.some((p) => /Call for [^:\n]* \(you\):/.test(p.text))) parts.push('Answer with the app\'s verdict first: the line starting "Call for … (you)" above is the call for the asking manager.')
  return clip(parts.join('\n\n'), PACK_LIMIT)
}
