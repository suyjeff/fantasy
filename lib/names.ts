const SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

/**
 * A player's name reduced to what two sources agree on: lower case, no
 * accents, no punctuation (hyphens join: "Amon-Ra" is "amonra"), no
 * generational suffix. "Kenneth Walker III" and "Kenneth Walker" meet at
 * "kenneth walker". Used wherever an outside list (FantasyPros, ESPN) is
 * matched onto Sleeper's players.
 */
export const normName = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’`-]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !SUFFIX.has(w))
    .join(' ')

/** A player's surname for short copy: "Burden" for Luther Burden III, "Cooper" for Omar Cooper Jr. */
export const lastName = (name: string) => {
  const parts = name.split(' ').filter(Boolean)
  while (parts.length > 1 && /^(jr|sr|ii|iii|iv|v)\.?$/i.test(parts[parts.length - 1])) parts.pop()
  return parts.length > 1 ? parts[parts.length - 1] : name
}
