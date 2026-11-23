// apps/backend/src/utils/rbac.ts
import { PrismaClient } from '@prisma/client';

export interface AdminUserContext {
  id: string;
  email: string;
  name?: string;
  role: 'TECH_ADMIN' | 'SUPER_ADMIN' | 'UNIT_ADMIN' | string;
  assignedUnitId?: string | null;
  departmentId?: string | null;
  employeeId?: string | null;
}

export interface AuthorizedUnitScope {
  unitIds: string[];
  isRestricted: boolean;
  lockedUnitId: string | null;
  assignedUnitName?: string | null;
}

export type ScopeResolution =
  | { authorized: true; scope: AuthorizedUnitScope }
  | { authorized: false; error: string; statusCode: number };

/**
 * Normalizes role string to canonical enum UserRole value.
 * Handles both underscored and non-underscored variants (e.g. SUPERADMIN -> SUPER_ADMIN).
 */
export function normalizeUserRole(rawRole?: string | null): 'TECH_ADMIN' | 'SUPER_ADMIN' | 'UNIT_ADMIN' | string {
  if (!rawRole) return 'UNIT_ADMIN';
  const clean = rawRole.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (clean === 'SUPERADMIN' || clean === 'SUPER_ADMIN') return 'SUPER_ADMIN';
  if (clean === 'TECHADMIN' || clean === 'TECH_ADMIN') return 'TECH_ADMIN';
  if (clean === 'UNITADMIN' || clean === 'UNIT_ADMIN') return 'UNIT_ADMIN';
  return clean;
}

/** TECH_ADMIN is the highest authority and may execute all business operations. */
export function isBusinessAdminRole(role?: string | null): role is 'TECH_ADMIN' | 'SUPER_ADMIN' | 'UNIT_ADMIN' {
  const normalized = normalizeUserRole(role);
  return normalized === 'TECH_ADMIN' || normalized === 'SUPER_ADMIN' || normalized === 'UNIT_ADMIN';
}

/**
 * Enforces server-side unit-scoping according to administrative role.
 * NEVER trusts frontend-supplied unitId.
 * Rejects unauthorized cross-unit requests with 403 Forbidden.
 */
export async function resolveAuthorizedUnitScope(
  prisma: PrismaClient,
  admin: AdminUserContext | undefined,
  requestedUnitId?: string | null
): Promise<ScopeResolution> {
  if (!admin || !admin.id) {
    return {
      authorized: false,
      statusCode: 401,
      error: 'Unauthorized: Authentication required.'
    };
  }

  const role = normalizeUserRole(admin.role);
  const cleanRequestedUnitId = requestedUnitId && requestedUnitId.trim() !== '' && requestedUnitId.toUpperCase() !== 'ALL'
    ? requestedUnitId.trim()
    : null;

  // SUPER_ADMIN and TECH_ADMIN retain global read/write system scope.
  if (role === 'SUPER_ADMIN' || role === 'TECH_ADMIN') {
    if (cleanRequestedUnitId) {
      // Validate requested unit existence
      const targetUnit = await prisma.unit.findUnique({
        where: { id: cleanRequestedUnitId },
        select: { id: true, name: true, code: true }
      });

      if (!targetUnit) {
        // If query sent code instead of ID
        const unitByCode = await prisma.unit.findUnique({
          where: { code: cleanRequestedUnitId },
          select: { id: true, name: true, code: true }
        });
        if (unitByCode) {
          return {
            authorized: true,
            scope: {
              unitIds: [unitByCode.id],
              isRestricted: false,
              lockedUnitId: null,
              assignedUnitName: unitByCode.name
            }
          };
        }

        return {
          authorized: false,
          statusCode: 404,
          error: `Unit not found for parameter '${cleanRequestedUnitId}'`
        };
      }

      return {
        authorized: true,
        scope: {
          unitIds: [targetUnit.id],
          isRestricted: false,
          lockedUnitId: null,
          assignedUnitName: targetUnit.name
        }
      };
    }

    return {
      authorized: true,
      scope: {
        unitIds: [],
        isRestricted: false,
        lockedUnitId: null,
        assignedUnitName: null
      }
    };
  }

  // 2. UNIT_ADMIN: Strictly constrained to their assignedUnitId
  if (role === 'UNIT_ADMIN') {
    if (!admin.assignedUnitId) {
      return {
        authorized: false,
        statusCode: 403,
        error: 'Forbidden: No unit assigned to this Unit Administrator.'
      };
    }

    // Explicit security enforcement: Reject unauthorized unitId requests with 403 Forbidden
    if (cleanRequestedUnitId) {
      const isMatch =
        cleanRequestedUnitId === admin.assignedUnitId ||
        cleanRequestedUnitId.toLowerCase() === admin.assignedUnitId.toLowerCase();

      if (!isMatch) {
        return {
          authorized: false,
          statusCode: 403,
          error: `Forbidden: You are not authorized to access unit '${cleanRequestedUnitId}'. Access is strictly restricted to your assigned facility.`
        };
      }
    }

    // Resolve unit details
    const assignedUnit = await prisma.unit.findUnique({
      where: { id: admin.assignedUnitId },
      select: { id: true, name: true, code: true }
    });

    return {
      authorized: true,
      scope: {
        unitIds: [admin.assignedUnitId],
        isRestricted: true,
        lockedUnitId: admin.assignedUnitId,
        assignedUnitName: assignedUnit?.name || 'Assigned Unit'
      }
    };
  }

  return {
    authorized: false,
    statusCode: 403,
    error: `Forbidden: Role '${role}' is not authorized for workstation administration.`
  };
}
