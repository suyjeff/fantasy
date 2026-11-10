import React from 'react'
import { ELO, LINEUP_PRIOR_GAMES, SIM } from '../lib/forecast'
import { RESULTS_PRIOR_GAMES } from '../lib/power'
import { Disclosure } from './Disclosure'
import { N } from './ui'

export type RankingModel = 'forecast' | 'composite' | 'elo'

const TEXT: Record<RankingModel, { title: string; body: React.ReactNode }> = {
  forecast: {
    title: 'How the forecast works',
    body: (
      <>
        <p>
          Rating = each week&apos;s best projected lineup, plus the manager&apos;s lineup habit: how many projected points a week the starters they actually use fall
          short of it, empty slots and players left on bye included. The habit is shrunk toward the league&apos;s as if every manager had <N>{LINEUP_PRIOR_GAMES}</N>{' '}
          average game behind them, since it repeats week after week.
        </p>
        <p>
          Playoff odds replay the season <N>{SIM.sims.toLocaleString()}</N> times, carrying <N>{Math.round(SIM.persistence * 100)}%</N> of each team&apos;s edge forward. Both
          settings were fitted on <N>688</N> finished Sleeper league-seasons and checked on <N>352</N> more. It predicts single games best of the three models.
        </p>
      </>
    ),
  },
  composite: {
    title: 'How the composite works',
    body: (
      <>
        <p>
          Five signals, each against the league: all-play record, points per game, form, roster strength and lineup efficiency. Early results count as if mixed with{' '}
          <N>{RESULTS_PRIOR_GAMES}</N> average games, since a few weeks are mostly luck.
        </p>
        <p>
          The score is the chance to beat an average team in a week: <N>50</N> is average. Weights are in Tuning.
        </p>
      </>
    ),
  },
  elo: {
    title: 'How Elo works',
    body: (
      <>
        <p>
          Who beat whom and by how much, judged against the lineups each side had. Teams start at <N>{ELO.base}</N>, or last season&apos;s rating pulled{' '}
          <N>{Math.round(ELO.regress * 100)}%</N> back. Each game is expected to go the way the ratings and the two projected lineups point, and a win takes points from the
          loser, more for upsets and blowouts (538&apos;s NFL formula, <N>K={ELO.k}</N>). Losing with your starters out costs less than losing at full strength.
        </p>
        <p>
          The rating shown adds <N>{Math.round(ELO.lineupShare * 100)}%</N> of each team&apos;s projected-lineup edge over an average lineup, converted at the odds that points edge would give, after 538&apos;s ELWAY. A <N>100</N>-point gap wins about <N>64%</N> of the time.
        </p>
      </>
    ),
  },
}

/** A quiet "how this works" under a ranking: closed by default, there for the curious. */
const ModelExplainer = ({ model }: { model: RankingModel }) => (
  // Sits on the panel above it: the overlap makes one hairline of the two borders.
  <div className="-mt-px">
    <Disclosure summary={TEXT[model].title} className="max-w-[72ch] space-y-2 text-[12.5px] leading-relaxed text-ff-text2">
      {TEXT[model].body}
    </Disclosure>
  </div>
)

export default ModelExplainer
