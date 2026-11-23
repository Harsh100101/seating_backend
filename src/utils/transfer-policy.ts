export interface TransferPrincipal {
  id?: string;
  role?: string | null;
  assignedUnitId?: string | null;
}

/**
 * Transfer workflow policy. Keep these checks centralized so the route cannot
 * accidentally grant an unrelated Unit Admin write access.
 */
export function canCreateTransfer(principal: TransferPrincipal, sourceUnitId: string | null | undefined): boolean {
  if (!sourceUnitId) return false;
  if (principal.role === 'SUPER_ADMIN' || principal.role === 'TECH_ADMIN') return true;
  return principal.role === 'UNIT_ADMIN' && principal.assignedUnitId === sourceUnitId;
}

export function canDecideTransfer(principal: TransferPrincipal, targetUnitId: string | null | undefined): boolean {
  if (!targetUnitId) return false;
  if (principal.role === 'SUPER_ADMIN' || principal.role === 'TECH_ADMIN') return true;
  return principal.role === 'UNIT_ADMIN' && principal.assignedUnitId === targetUnitId;
}

export function canViewTransfer(principal: TransferPrincipal, sourceUnitId: string | null | undefined, targetUnitId: string | null | undefined): boolean {
  if (principal.role === 'SUPER_ADMIN' || principal.role === 'TECH_ADMIN') return true;
  if (principal.role !== 'UNIT_ADMIN' || !principal.assignedUnitId) return false;
  return principal.assignedUnitId === sourceUnitId || principal.assignedUnitId === targetUnitId;
}

export function isTransferBusinessAdmin(role?: string | null): boolean {
  return role === 'TECH_ADMIN' || role === 'SUPER_ADMIN' || role === 'UNIT_ADMIN';
}
