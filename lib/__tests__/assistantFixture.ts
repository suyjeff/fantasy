// The Assistant GM's fixture league: a real 10-team Sleeper league at week 11 of 2026, captured by
// scripts/asgm-capture.test.ts (anonymised: neutral names, remapped Sleeper ids; players trimmed to the ones the league touches).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { buildAsgmLeague, type AsgmLeague } from '../assistant/league'
import type { LeagueData } from '../useLeagueData'

let cached: { data: LeagueData; capturedAt: number } | null = null

export const fixtureData = (): LeagueData => {
  if (!cached) cached = JSON.parse(gunzipSync(readFileSync(join(__dirname, 'fixtures', 'asgm-league.json.gz'))).toString())
  // A fresh copy each time, so no test sees another's edits.
  return structuredClone(cached!.data)
}

/** When the fixture was captured: tools that read the clock are pinned to it. */
export const fixtureNow = () => {
  fixtureData()
  return cached!.capturedAt
}

let league: AsgmLeague | null = null
/** The fixture as the assistant reads it; built once per test file (the season simulation takes a moment). */
export const fixtureLeague = (): AsgmLeague => {
  if (!league) league = buildAsgmLeague(fixtureData())
  return { ...league, memo: new Map() }
}
