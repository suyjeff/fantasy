// Who a question is about. Managers type the way they talk: "puka", "jjeff", "JSN", "ARSB", "nacau", "the wolves",
// "manager 6", "Fourth & Long's RB1". This reads players, teams and depth labels ("my RB2", "<team>'s WR1") out of free
// text against the league already loaded. It only commits to a match it is sure of: an ambiguous first name, an
// everyday word or a typo that fits two players finds nobody, and the model (or the manager) names him properly.
import { lastName, normName } from '../names'
import type { AsgmLeague } from './league'
import { depthLabels, memo } from './resolve'

/** Everyday words that are also names somewhere in a player list: never a player unless written as a full name. */
const COMMON = new Set(
  (
    'a about above after again against all also am an and any are as at away back bad be because been before being below best better between big both bring but buy by ' +
    'call can cash catch check close could cut day did do does doing done down drop each easy end even every face fair fall far fast few fill find first five flex for ' +
    'four free from full game get give go going good got great had half hand has have he help her here high him his hold home how if in into is it its just keep kind ' +
    'king know last late lead least left less let like line little long look lose lot love low made make man many march mark may me might mine miss more most move much ' +
    'must my need never new next nice no not now of off old on once one only open or other our out over own pass pay pick play point power price pull put rather read ' +
    'real rest rich right round run safe same say season see sell send set shall she short should show side sit six so some start stay still stop such sure swap take ' +
    'team than that the their them then there these they thing think this those three through time to too top trade try turn two under up upon us use very want was ' +
    'way we week well were what when where which while who whole why will win with without won worth would yes yet you young your yours ' +
    'bench waiver waivers wire roster lineup record matchup schedule playoffs playoff odds trade trades offer deal value values rank ranks ranking rankings proj projected ' +
    'projection points pts starter starters starting player players team teams league manager managers owner owns owned whos whose' +
    ' second third fourth fifth sixth seventh eighth ninth tenth chase hill swift white brown green gray grant hunter rice moore hall cook mack love allen davis harris ' +
    'jones smith johnson williams wilson price young brooks mayer jordan cooper rico trey chris josh mike tank will drake'
  ).split(/\s+/),
)

/** Words a name follows or precedes ("who has ___", "___ or ___"): where a misspelt name is read as one. */
const SLOT = new Set('has have owns own owned got about is on start sit bench drop add get trade for with and or vs versus over than of rostered owner keep cut sell buy bid'.split(' '))

/** Nicknames that no rule derives: the short form → the player's full name (normalised). */
const NICKS: Record<string, string> = {
  cmc: 'christian mccaffrey',
  jj: 'justin jefferson',
  jt: 'jonathan taylor',
  tmac: 'terry mclaurin',
  scary: 'terry mclaurin',
  jamo: 'jameson williams',
  kw3: 'kenneth walker',
  ajb: 'aj brown',
  hollywood: 'marquise brown',
  amonra: 'amon ra st brown',
  'amon ra': 'amon ra st brown',
  etn: 'travis etienne',
  ekeler: 'austin ekeler',
  bijan: 'bijan robinson',
  saquon: 'saquon barkley',
  ceedee: 'ceedee lamb',
  cd: 'ceedee lamb',
  dk: 'dk metcalf',
  deebo: 'deebo samuel',
  kupp: 'cooper kupp',
  tyreek: 'tyreek hill',
  kittle: 'george kittle',
  mahomes: 'patrick mahomes',
  lamar: 'lamar jackson',
  hurts: 'jalen hurts',
  burrow: 'joe burrow',
  gibbs: 'jahmyr gibbs',
  sauce: 'ahmad gardner',
}

type Tok = { raw: string; norm: string; cap: boolean; poss: boolean }
type Idx = {
  full: Map<string, string[]>
  last: Map<string, string[]>
  first: Map<string, string[]>
  initials: Map<string, string[]>
  /** Every relevant player, for the initial+surname-prefix and typo rules. */
  ids: string[]
  maxWords: number
}

const SKILL = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
const push = (m: Map<string, string[]>, k: string, id: string) => {
  if (!k) return
  const xs = m.get(k)
  if (!xs) m.set(k, [id])
  else if (!xs.includes(id)) xs.push(id)
}

/** "Jaxon Smith-Njigba" → jsn, "Amon-Ra St. Brown" → arsb, "Marvin Harrison Jr." → mhj. */
const initialsOf = (name: string) => {
  const parts = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[\s-]+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
  const all = parts.map((w) => w[0]).join('')
  const bare = parts.filter((w) => !['jr', 'sr', 'ii', 'iii', 'iv', 'v'].includes(w)).map((w) => w[0]).join('')
  return [...new Set([all, bare])].filter((x) => x.length >= 3)
}

/** Players worth matching by name: rostered, projected, or ranked. */
const index = (lg: AsgmLeague): Idx =>
  memo(lg, 'find:index', () => {
    const { data, analysis } = lg
    const out: Idx = { full: new Map(), last: new Map(), first: new Map(), initials: new Map(), ids: [], maxWords: 1 }
    for (const p of Object.values(data.players)) {
      const relevant = analysis.rosteredBy[p.id] != null || (analysis.horizon.perWeek[p.id] ?? 0) > 1 || data.consensus?.byId[p.id] != null
      if (!relevant || !SKILL.includes(p.pos)) continue
      out.ids.push(p.id)
      const f = normName(p.name)
      push(out.full, f, p.id)
      out.maxWords = Math.max(out.maxWords, f.split(' ').length)
      if (p.pos === 'DEF') continue
      const words = f.split(' ')
      const l = normName(lastName(p.name))
      if (l.length >= 4) push(out.last, l, p.id)
      if (words.length >= 2 && words[0].length >= 4) push(out.first, words[0], p.id)
      for (const ini of initialsOf(p.name)) push(out.initials, ini, p.id)
    }
    for (const [nick, full] of Object.entries(NICKS)) for (const id of out.full.get(full) ?? []) push(out.full, nick, id)
    return out
  })

const tokens = (text: string): Tok[] =>
  text
    .split(/[\s,;:!?()"/]+/)
    .filter(Boolean)
    .flatMap((raw) => {
      const poss = /['’]s?$/i.test(raw) && !/^[a-z]['’]s$/i.test(raw)
      const bare = raw.replace(/['’]s$/i, '').replace(/['’]$/, '')
      const norm = normName(bare)
      // "Smith-Njigba" stays one word; "&" and "." between words fall away.
      return norm ? norm.split(' ').map((n, i, xs) => ({ raw: bare, norm: n, cap: /^[A-Z]/.test(bare), poss: poss && i === xs.length - 1 })) : []
    })

/** Edit distance with swapped neighbours counting once ("nacau" is one off "nacua"), stopping early past `max`. */
const near = (a: string, b: string, max: number) => {
  if (Math.abs(a.length - b.length) > max) return false
  let prev2: number[] = []
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1)
      best = Math.min(best, cur[j])
    }
    if (best > max) return false
    prev2 = prev
    prev = cur
  }
  return prev[b.length] <= max
}

/** One player out of several with the same name: the asker's, else a rostered one, else the most valuable. */
const prefer = (lg: AsgmLeague, ids: string[]) => {
  const { analysis } = lg
  const mine = ids.find((id) => analysis.rosteredBy[id] === lg.myRosterId)
  if (mine) return mine
  return [...ids].sort((a, b) => (analysis.rosteredBy[b] != null ? 1 : 0) - (analysis.rosteredBy[a] != null ? 1 : 0) || (analysis.market[b] ?? 0) - (analysis.market[a] ?? 0))[0]
}

/** A single candidate, or the only rostered one of a few: otherwise nobody (the name is ambiguous). */
const sure = (lg: AsgmLeague, ids: string[] | undefined): string | null => {
  if (!ids?.length) return null
  if (ids.length === 1) return ids[0]
  const rostered = ids.filter((id) => lg.analysis.rosteredBy[id] != null)
  return rostered.length === 1 ? rostered[0] : null
}

type TeamIdx = { rid: number; name: string[]; owner: string[]; user: string[]; words: string[] }
const teamIndex = (lg: AsgmLeague): TeamIdx[] =>
  memo(lg, 'find:teams', () => {
    const teams = lg.analysis.teams.map((t) => {
      const u = lg.data.users.find((x) => x.user_id === t.userId)
      const name = normName(t.name).split(' ').filter(Boolean)
      return { rid: t.rosterId, name, owner: normName(t.owner ?? '').split(' ').filter(Boolean), user: normName(u?.username ?? '').split(' ').filter(Boolean), words: [] as string[] }
    })
    // Distinctive words: in one team's name only, long enough, not everyday words.
    const count = new Map<string, number>()
    for (const t of teams) for (const w of new Set(t.name)) count.set(w, (count.get(w) ?? 0) + 1)
    for (const t of teams) t.words = t.name.filter((w) => w.length >= 4 && count.get(w) === 1 && !COMMON.has(w))
    return teams
  })

export type Mention =
  /** `shared`: the word fits several players (a surname like "Robinson"); the id is a guess the model may use, never an instant answer. */
  | { kind: 'player'; id: string; at: number; end: number; how: string; shared?: boolean }
  | { kind: 'team'; rid: number; at: number; end: number; how: string }

const seq = (toks: Tok[], i: number, words: string[]) => words.length > 0 && words.every((w, k) => toks[i + k]?.norm === w)

/** Everything a question names, in order: teams (by name, manager or a distinctive word) and players (every rule above). */
export const mentions = (lg: AsgmLeague, text: string): Mention[] => {
  const toks = tokens(text)
  const taken = new Array(toks.length).fill(false)
  const out: Mention[] = []
  const take = (m: Mention) => {
    for (let k = m.at; k < m.end; k++) taken[k] = true
    out.push(m)
  }
  const free = (i: number, n: number) => {
    for (let k = i; k < i + n; k++) if (k >= toks.length || taken[k]) return false
    return true
  }
  const teams = teamIndex(lg)
  // A one-word key that is an everyday word ("Will", "Chase") never names a team or a manager.
  const usable = (k: { words: string[] }) => k.words.length > 0 && k.words.join(' ').length >= 3 && !(k.words.length === 1 && COMMON.has(k.words[0]))
  const byLength = (a: { words: string[] }, b: { words: string[] }) => b.words.length - a.words.length
  const matchTeams = (keys: { rid: number; words: string[]; how: string }[]) => {
    for (const k of keys.filter(usable).sort(byLength)) for (let i = 0; i < toks.length; i++) if (free(i, k.words.length) && seq(toks, i, k.words)) take({ kind: 'team', rid: k.rid, at: i, end: i + k.words.length, how: k.how })
  }
  // 1. Whole team names (longest first), so "Hail Marys" is a team before "Marys" is anyone.
  matchTeams(
    teams.flatMap((t) => [
      { rid: t.rid, words: t.name, how: 'team name' },
      // "Fourth & Long" is also typed "fourth and long".
      ...(/&/.test(lg.analysis.teamById[t.rid]?.name ?? '') ? [{ rid: t.rid, words: normName(lg.analysis.teamById[t.rid].name.replace(/&/g, ' and ')).split(' '), how: 'team name' }] : []),
    ]),
  )

  const idx = index(lg)
  // 2. Full names and nicknames, longest first: before managers, so a manager called "Chase" never takes Ja'Marr Chase.
  for (let n = Math.min(idx.maxWords, 4); n >= 1; n--) {
    for (let i = 0; i + n <= toks.length; i++) {
      if (!free(i, n)) continue
      const key = toks.slice(i, i + n).map((t) => t.norm).join(' ')
      const ids = idx.full.get(key)
      if (!ids) continue
      if (n === 1 && COMMON.has(key)) continue
      take({ kind: 'player', id: prefer(lg, ids), at: i, end: i + n, how: 'full', ...(ids.length > 1 ? { shared: true } : {}) })
    }
  }
  // 2b. Managers, by display name or username.
  matchTeams(teams.flatMap((t) => [
    { rid: t.rid, words: t.owner, how: 'manager' },
    { rid: t.rid, words: t.user, how: 'manager' },
  ]))
  // 3. One word at a time: surname, first name, initials, initial + start of the surname, then a typo of a name.
  for (let i = 0; i < toks.length; i++) {
    if (!free(i, 1)) continue
    const t = toks[i]
    const w = t.norm
    if (w.length < 3 || /^\d/.test(w)) continue
    const common = COMMON.has(w)
    let id: string | null = null
    let how = ''
    let shared = false
    const lastIds = idx.last.get(w)
    if (lastIds && (!common || t.cap)) {
      // A surname several players share ("Robinson") is the asker's own player, or the only rostered one, or nobody;
      // either way it is a guess, flagged so no instant answer rests on it.
      const mine = lastIds.find((x) => lg.analysis.rosteredBy[x] === lg.myRosterId)
      id = lastIds.length === 1 ? lastIds[0] : (mine ?? (common ? null : sure(lg, lastIds)))
      // "Chase" is Ja'Marr Chase's surname and Chase Brown's first name: shared too.
      shared = new Set([...lastIds, ...(idx.first.get(w) ?? [])]).size > 1
      how = 'surname'
    }
    // First names and initials only when they fit one player: "jalen" is nobody in particular.
    if (!id && !common && idx.first.get(w)?.length === 1) {
      id = idx.first.get(w)![0]
      how = 'first name'
    }
    if (!id && !common && w.length <= 5 && idx.initials.get(w)?.length === 1) {
      id = idx.initials.get(w)![0]
      how = 'initials'
    }
    // "jjeff", "bhall", "tmclaurin": a first initial and the surname, or its first four letters or more.
    if (!id && !common && w.length >= 5) {
      const hits = idx.ids.filter((pid) => {
        const p = lg.data.players[pid]
        if (p.pos === 'DEF') return false
        const f = normName(p.name).split(' ')
        const l = normName(lastName(p.name)).replace(/ /g, '')
        return f.length >= 2 && f[0][0] === w[0] && w.length - 1 >= 4 && l.startsWith(w.slice(1))
      })
      id = sure(lg, hits)
      how = 'initial + surname'
    }
    // A typo: one letter off (two in a long name) from exactly one surname or first name, and only where a name
    // belongs ("who has nacau", "waddel or flowers"): "Write me a poem" is not Rachaad White.
    const slot = (k: number) => SLOT.has(toks[k]?.norm ?? '')
    if (!id && !common && w.length >= 5 && (slot(i - 1) || slot(i + 1) || idx.first.has(toks[i - 1]?.norm ?? ''))) {
      const max = w.length >= 8 ? 2 : 1
      const pool = new Set<string>()
      for (const m of [idx.last, idx.first]) for (const [k, ids] of m) if (k[0] === w[0] && near(w, k, max)) for (const x of ids) pool.add(x)
      const rostered = [...pool].filter((x) => lg.analysis.rosteredBy[x] != null)
      id = pool.size === 1 ? [...pool][0] : rostered.length === 1 ? rostered[0] : null
      how = 'typo'
    }
    if (id) take({ kind: 'player', id, at: i, end: i + 1, how, ...(shared ? { shared } : {}) })
    else if (shared) take({ kind: 'player', id: '', at: i, end: i + 1, how: 'ambiguous surname', shared })
  }
  // 4. Teams by a distinctive word of their name ("wolves", "capacitors"), once players have had their pick.
  for (let i = 0; i < toks.length; i++) {
    if (!free(i, 1)) continue
    const hits = teams.filter((t) => t.words.includes(toks[i].norm))
    if (hits.length === 1) take({ kind: 'team', rid: hits[0].rid, at: i, end: i + 1, how: 'team word' })
  }
  // 5. Depth labels: "my RB2", "Fourth & Long's RB1", "RB1 on the Wolves" is left to the tools.
  for (let i = 0; i < toks.length; i++) {
    if (!free(i, 1)) continue
    const m = /^(qb|rb|wr|te)(\d)$/.exec(toks[i].norm) ?? (/^(qb|rb|wr|te)$/.test(toks[i].norm) && /^\d$/.test(toks[i + 1]?.norm ?? '') ? [toks[i].norm + toks[i + 1].norm, toks[i].norm, toks[i + 1].norm] : null)
    if (!m) continue
    const prev = toks[i - 1]?.norm
    const owner = prev === 'my' ? lg.myRosterId : (out.find((x) => x.kind === 'team' && x.end === i) as { rid: number } | undefined)?.rid ?? null
    if (owner == null) continue
    const want = `${m[1].toUpperCase()}${m[2]}`
    const labels = depthLabels(lg, owner)
    const id = Object.keys(labels).find((k) => labels[k] === want)
    if (id) take({ kind: 'player', id, at: i, end: i + (m[0] === toks[i].norm ? 1 : 2), how: 'label' })
  }
  return out.sort((a, b) => a.at - b.at)
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)]

/** Players a question names, in the order it names them. */
export const findPlayers = (lg: AsgmLeague, text: string): string[] => uniq(mentions(lg, text).flatMap((m) => (m.kind === 'player' && m.id ? [m.id] : [])))

/** Whether a name in the question fits more than one player: no instant answer then. */
export const namesShared = (lg: AsgmLeague, text: string): boolean => mentions(lg, text).some((m) => m.kind === 'player' && m.shared)

/** Teams a question names, the asker's own included, in order. */
export const findTeams = (lg: AsgmLeague, text: string): number[] => uniq(mentions(lg, text).flatMap((m) => (m.kind === 'team' ? [m.rid] : [])))
