/**
 * Production data predates `operational_state`.  A missing or null value is
 * therefore a readable legacy record, not a claim that the record was
 * verified by the authoritative-import workflow.  Explicitly quarantined and
 * archived records stay out of operational directory reads; unknown BSON enum
 * values are also excluded before Prisma attempts to materialise them.
 */
export const currentOperationalRecordWhere = () => ({
  OR: [
    { operationalState: 'CURRENT' as const },
    { operationalState: null },
    { operationalState: { isSet: false } }
  ]
});

export const operationalRecordClassification = (state: string | null | undefined): 'CURRENT' | 'LEGACY_UNCLASSIFIED' =>
  state === 'CURRENT' ? 'CURRENT' : 'LEGACY_UNCLASSIFIED';
