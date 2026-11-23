export const TRANSFER_DESTINATION_CONFLICT_CODES = {
  OCCUPIED: 'TRANSFER_DESTINATION_ALREADY_OCCUPIED',
  UNAVAILABLE: 'TRANSFER_DESTINATION_NOT_AVAILABLE',
  RACE_LOST: 'TRANSFER_DESTINATION_RACE_LOST'
} as const;

export interface DestinationConflictContext {
  seatId?: string;
  employeeId?: string | null;
  status?: string | null;
  phase?: 'validation' | 'claim';
  claimCount?: number;
}

export function destinationConflict(
  code: keyof typeof TRANSFER_DESTINATION_CONFLICT_CODES,
  message: string,
  context: DestinationConflictContext = {}
): Error {
  const error = new Error(message);
  error.name = TRANSFER_DESTINATION_CONFLICT_CODES[code];
  Object.assign(error, { destinationContext: context });
  return error;
}

export function destinationConflictResponse(error: any): { error: string; message: string } | null {
  switch (error?.name) {
    case TRANSFER_DESTINATION_CONFLICT_CODES.OCCUPIED:
      return { error: error.name, message: 'This workstation is already occupied.' };
    case TRANSFER_DESTINATION_CONFLICT_CODES.UNAVAILABLE:
      return { error: error.name, message: 'This workstation is no longer available.' };
    case TRANSFER_DESTINATION_CONFLICT_CODES.RACE_LOST:
      return { error: error.name, message: 'Another approval claimed this workstation first.' };
    default:
      return null;
  }
}
