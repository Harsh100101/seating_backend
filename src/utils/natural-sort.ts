const naturalCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export function compareNaturally(left: string | null | undefined, right: string | null | undefined): number {
  return naturalCollator.compare(String(left ?? ''), String(right ?? ''));
}

