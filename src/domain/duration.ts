const DURATION = /^(\d{1,9})(s|m|h|d|w)$/;

const UNIT_MILLISECONDS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

type DurationUnit = keyof typeof UNIT_MILLISECONDS;

/**
 * Parse a whole-unit duration such as `45s`, `90m`, `12h`, `3d`, or `2w` into milliseconds. The
 * unit is mandatory: a bare number reads as seconds to one caller and as days to the next, and a
 * staleness or recency bound that silently means the wrong thing is worse than a rejected flag.
 */
export function parseDuration(value: string, flag: string): number {
  const match = DURATION.exec(value.trim());
  if (!match) {
    throw new Error(`${flag} expects a duration like 45s, 90m, 12h, 3d, or 2w.`);
  }
  const amount = Number(match[1] as string);
  if (amount <= 0) throw new Error(`${flag} expects a duration greater than zero.`);
  const milliseconds = amount * UNIT_MILLISECONDS[match[2] as DurationUnit];
  if (!Number.isSafeInteger(milliseconds)) throw new Error(`${flag} expects a shorter duration.`);
  return milliseconds;
}
