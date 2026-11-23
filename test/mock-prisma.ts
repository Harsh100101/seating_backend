import { PrismaClient, Prisma, SeatStatus } from '@prisma/client';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ADMIN, DEFAULT_DEPARTMENTS, TECH_ADMIN_EMAIL, TECH_ADMIN_PASSWORD } from '../prisma/seed.js';

function assertValidSeatStatus(status: unknown) {
  if (status !== undefined && !Object.values(SeatStatus).includes(status as SeatStatus)) {
    throw new Error(`Invalid SeatStatus: ${String(status)}`);
  }
}

function matchContains(value: string | undefined | null, pattern: string | undefined | null): boolean {
  if (value == null || pattern == null) return false;
  try {
    return new RegExp(pattern, 'i').test(value);
  } catch {
    return value.toLowerCase().includes(pattern.toLowerCase());
  }
}

export async function createMockPrisma(): Promise<PrismaClient> {
  const adminHash = await argon2.hash(DEFAULT_ADMIN.password, { type: argon2.argon2id });

  const adminUsers = new Map<string, any>();
  const defaultAdminId = randomUUID();
  adminUsers.set(defaultAdminId, {
    id: defaultAdminId,
    email: DEFAULT_ADMIN.email.toLowerCase(),
    passwordHash: adminHash,
    name: DEFAULT_ADMIN.name,
    role: 'SUPER_ADMIN',
    isActive: true,
    assignedUnitId: null,
    departmentId: null,
    employeeId: null,
    createdAt: new Date('2026-10-29T00:00:00.000Z'),
    updatedAt: new Date('2026-10-29T00:00:00.000Z')
  });

  const techAdminId = randomUUID();
  adminUsers.set(techAdminId, {
    id: techAdminId,
    email: TECH_ADMIN_EMAIL.toLowerCase(),
    passwordHash: await argon2.hash(TECH_ADMIN_PASSWORD, { type: argon2.argon2id }),
    name: 'Technology Administrator (Global Control)',
    role: 'TECH_ADMIN',
    isActive: true,
    assignedUnitId: null,
    departmentId: null,
    employeeId: null,
    createdAt: new Date('2026-10-29T00:00:00.000Z'),
    updatedAt: new Date('2026-10-29T00:00:00.000Z')
  });

  const units = new Map<string, any>();
  const plants = new Map<string, any>();
  const offices = new Map<string, any>();
  const buildings = new Map<string, any>();
  const floors = new Map<string, any>();
  const departments = new Map<string, any>();
  const areas = new Map<string, any>();
  const sections = new Map<string, any>();
  const orgFunctions = new Map<string, any>();
  const employees = new Map<string, any>();
  const seats = new Map<string, any>();
  const auditLogs = new Map<string, any>();
  const seatTransferRequests = new Map<string, any>();
  const notifications = new Map<string, any>();
  let transactionTail = Promise.resolve();

  const throwP2002 = (target: string[]) => {
    throw new Prisma.PrismaClientKnownRequestError(
      `Unique constraint failed on the fields: (${target.join(', ')})`,
      { code: 'P2002', clientVersion: '5.22.0', meta: { target } }
    );
  };

  const matchesBuildingWhere = (building: any, where: any): boolean => {
    if (!where) return true;
    if (where.AND && !where.AND.every((condition: any) => matchesBuildingWhere(building, condition))) return false;
    if (where.OR && !where.OR.some((condition: any) => matchesBuildingWhere(building, condition))) return false;
    if (where.id && (typeof where.id === 'string' ? building.id !== where.id : !where.id.in?.includes(building.id))) return false;
    if (where.code && building.code?.toUpperCase() !== where.code.toUpperCase()) return false;
    if (where.plantId && (typeof where.plantId === 'string' ? building.plantId !== where.plantId : !where.plantId.in?.includes(building.plantId))) return false;
    if (where.unitId) {
      if (where.unitId.isSet === false && building.unitId != null) return false;
      if (where.unitId === null && building.unitId != null) return false;
      if (where.unitId.in && !where.unitId.in.includes(building.unitId)) return false;
      if (typeof where.unitId === 'string' && building.unitId !== where.unitId) return false;
    }
    if (where.plant?.unitId) {
      const plant = plants.get(building.plantId);
      const plantUnitIds = where.plant.unitId.in || [where.plant.unitId];
      if (!plant || !plantUnitIds.includes(plant.unitId)) return false;
    }
    return true;
  };

  // Seed sample departments
  for (const dept of DEFAULT_DEPARTMENTS) {
    const id = randomUUID();
    departments.set(id, {
      id,
      name: dept.name,
      code: dept.code.toUpperCase(),
      colorHex: dept.colorHex,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  const matchEmployeeRecord = (e: any, cond: any): boolean => {
    if (!cond) return true;
    if (cond.id) {
      if (typeof cond.id === 'string' && e.id !== cond.id) return false;
      if (cond.id.in && Array.isArray(cond.id.in) && !cond.id.in.includes(e.id)) return false;
      if (cond.id.notIn && Array.isArray(cond.id.notIn) && cond.id.notIn.includes(e.id)) return false;
    }
    if (cond.departmentId?.in) {
      if (!cond.departmentId.in.includes(e.departmentId)) return false;
    } else if (cond.departmentId) {
      if (e.departmentId !== cond.departmentId) return false;
    }
    if (cond.sectionId?.in) {
      if (!cond.sectionId.in.includes(e.sectionId)) return false;
    } else if (cond.sectionId) {
      if (e.sectionId !== cond.sectionId) return false;
    }
    if (cond.functionId?.in) {
      if (!cond.functionId.in.includes(e.functionId)) return false;
    } else if (cond.functionId) {
      if (e.functionId !== cond.functionId) return false;
    }
    if (cond.employeeCode) {
      if (cond.employeeCode.contains && !matchContains(e.employeeCode, cond.employeeCode.contains)) return false;
      if (cond.employeeCode.equals && e.employeeCode?.toLowerCase() !== cond.employeeCode.equals.toLowerCase()) return false;
      if (typeof cond.employeeCode === 'string' && e.employeeCode !== cond.employeeCode) return false;
    }
    if (cond.fullName) {
      if (cond.fullName.contains && !matchContains(e.fullName, cond.fullName.contains)) return false;
      if (cond.fullName.equals && e.fullName?.toLowerCase() !== cond.fullName.equals.toLowerCase()) return false;
    }
    if (cond.email) {
      if (cond.email.contains && !matchContains(e.email, cond.email.contains)) return false;
      if (cond.email.equals && e.email?.toLowerCase() !== cond.email.equals.toLowerCase()) return false;
    }
    if (cond.designation) {
      if (cond.designation.contains && !matchContains(e.designation, cond.designation.contains)) return false;
      if (cond.designation.equals && e.designation?.toLowerCase() !== cond.designation.equals.toLowerCase()) return false;
    }
    if (cond.phone) {
      if (cond.phone.contains && !matchContains(e.phone, cond.phone.contains)) return false;
      if (cond.phone.equals && e.phone?.toLowerCase() !== cond.phone.equals.toLowerCase()) return false;
    }
    if (cond.ext) {
      const extTarget = (typeof cond.ext === 'string' ? cond.ext : (cond.ext.equals || cond.ext.contains))?.toLowerCase();
      if (!e.ext || e.ext.toLowerCase() !== extTarget) return false;
    }
    if (cond.section) {
      if (cond.section.not === null) {
        if (e.section == null) return false;
      } else {
        const secTarget = (typeof cond.section === 'string' ? cond.section : (cond.section.equals || cond.section.contains))?.toLowerCase();
        if (!e.section || e.section.toLowerCase() !== secTarget) return false;
      }
    }
    if (cond.functionName) {
      if (cond.functionName.not === null) {
        if (e.functionName == null) return false;
      } else {
        const fnTarget = (typeof cond.functionName === 'string' ? cond.functionName : (cond.functionName.equals || cond.functionName.contains))?.toLowerCase();
        if (!e.functionName || e.functionName.toLowerCase() !== fnTarget) return false;
      }
    }
    if (cond.reportingTo) {
      const repTarget = (typeof cond.reportingTo === 'string' ? cond.reportingTo : (cond.reportingTo.equals || cond.reportingTo.contains))?.toLowerCase();
      const val = (e.reportingTo || e.reportingManager)?.toLowerCase();
      if (!val || val !== repTarget) return false;
    }
    if (cond.reportingManager) {
      const repTarget = (typeof cond.reportingManager === 'string' ? cond.reportingManager : (cond.reportingManager.equals || cond.reportingManager.contains))?.toLowerCase();
      const val = (e.reportingManager || e.reportingTo)?.toLowerCase();
      if (!val || val !== repTarget) return false;
    }
    if (cond.hod) {
      const hodTarget = (typeof cond.hod === 'string' ? cond.hod : (cond.hod.equals || cond.hod.contains))?.toLowerCase();
      if (!e.hod || e.hod.toLowerCase() !== hodTarget) return false;
    }
    if (cond.isActive !== undefined) {
      if (e.isActive !== cond.isActive) return false;
    }
    if (cond.operationalState !== undefined) {
      if (typeof cond.operationalState === 'string' && e.operationalState !== cond.operationalState) return false;
      if (cond.operationalState === null && e.operationalState != null) return false;
      if (cond.operationalState?.isSet === false && e.operationalState !== undefined) return false;
    }
    if (cond.officeArea) {
      const areaTarget = (typeof cond.officeArea === 'string' ? cond.officeArea : (cond.officeArea.equals || cond.officeArea.contains))?.toLowerCase();
      const empSeat = Array.from(seats.values()).find((s) => s.employeeId === e.id);
      const empArea = e.officeArea?.toLowerCase();
      const seatArea = empSeat?.officeArea?.toLowerCase();
      if (empArea !== areaTarget && seatArea !== areaTarget) return false;
    }
    if (cond.subLocation) {
      const subTarget = (typeof cond.subLocation === 'string' ? cond.subLocation : (cond.subLocation.equals || cond.subLocation.contains))?.toLowerCase();
      if (!e.subLocation || e.subLocation.toLowerCase() !== subTarget) return false;
    }
    if (cond.pcNumber) {
      const pcTarget = typeof cond.pcNumber === 'string' ? cond.pcNumber : (cond.pcNumber.contains || cond.pcNumber.equals);
      const empSeat = Array.from(seats.values()).find((s) => s.employeeId === e.id);
      const matchesEmp = matchContains(e.pcNumber, pcTarget);
      const matchesSeat = matchContains(empSeat?.pcNumber, pcTarget);
      if (!matchesEmp && !matchesSeat) return false;
    }
    if (cond.department?.unitId) {
      const dept = departments.get(e.departmentId);
      if (!dept || dept.unitId !== cond.department.unitId) return false;
    }
    if (cond.seat) {
      const empSeat = Array.from(seats.values()).find((s) => s.employeeId === e.id);
      if (cond.seat.isNot === null) {
        if (!empSeat) return false;
      } else if (cond.seat === null) {
        if (empSeat) return false;
      } else {
        if (!empSeat) return false;
        if (cond.seat.officeArea) {
          const areaTarget = (typeof cond.seat.officeArea === 'string' ? cond.seat.officeArea : (cond.seat.officeArea.equals || cond.seat.officeArea.contains))?.toLowerCase();
          if (!empSeat.officeArea || empSeat.officeArea.toLowerCase() !== areaTarget) return false;
        }
        if (cond.seat.label?.contains) {
          if (!matchContains(empSeat.label, cond.seat.label.contains)) return false;
        }
        if (cond.seat.floorId) {
          if (empSeat.floorId !== cond.seat.floorId) return false;
        }
        if (cond.seat.floor?.buildingId) {
          const fl = floors.get(empSeat.floorId);
          if (!fl || fl.buildingId !== cond.seat.floor.buildingId) return false;
        }
        if (cond.seat.floor?.building?.plantId) {
          const fl = floors.get(empSeat.floorId);
          const bld = fl ? buildings.get(fl.buildingId) : null;
          if (!bld || bld.plantId !== cond.seat.floor.building.plantId) return false;
        }
        if (cond.seat.floor?.building?.plant?.unitId) {
          const fl = floors.get(empSeat.floorId);
          const bld = fl ? buildings.get(fl.buildingId) : null;
          const p = bld ? plants.get(bld.plantId) : null;
          if (!p || p.unitId !== cond.seat.floor.building.plant.unitId) return false;
        }
        if (cond.seat.areaId) {
          if (empSeat?.areaId !== cond.seat.areaId) return false;
        }
      }
    }
    if (cond.OR && Array.isArray(cond.OR)) {
      const matchesOr = cond.OR.some((orSubCond: any) => matchEmployeeRecord(e, orSubCond));
      if (!matchesOr) return false;
    }
    if (cond.AND && Array.isArray(cond.AND)) {
      const matchesAnd = cond.AND.every((andSubCond: any) => matchEmployeeRecord(e, andSubCond));
      if (!matchesAnd) return false;
    }
    return true;
  };

  const matchSeatCond = (s: any, cond: any): boolean => {
    if (!cond) return true;
    if (cond.AND && Array.isArray(cond.AND)) {
      return cond.AND.every((c: any) => matchSeatCond(s, c));
    }
    if (cond.OR && Array.isArray(cond.OR)) {
      return cond.OR.some((c: any) => matchSeatCond(s, c));
    }
    if (cond.id) {
      if (typeof cond.id === 'string' && s.id !== cond.id) return false;
      if (cond.id.in && Array.isArray(cond.id.in) && !cond.id.in.includes(s.id)) return false;
      if (cond.id.notIn && Array.isArray(cond.id.notIn) && cond.id.notIn.includes(s.id)) return false;
    }
    if (cond.floorId) {
      if (typeof cond.floorId === 'string' && s.floorId !== cond.floorId) return false;
      if (cond.floorId.in && Array.isArray(cond.floorId.in) && !cond.floorId.in.includes(s.floorId)) return false;
    }
    if (cond.label) {
      if (typeof cond.label === 'string' && s.label !== cond.label) return false;
      if (cond.label.contains && !matchContains(s.label, cond.label.contains)) return false;
    }
    if (cond.employeeId !== undefined) {
      if (cond.employeeId === null && s.employeeId) return false;
      if (cond.employeeId?.not !== undefined && (s.employeeId === null || s.employeeId === undefined)) return false;
      if (typeof cond.employeeId === 'string' && s.employeeId !== cond.employeeId) return false;
      if (cond.employeeId?.in && Array.isArray(cond.employeeId.in) && !cond.employeeId.in.includes(s.employeeId)) return false;
    }
    if (cond.status && (s.status || 'AVAILABLE') !== cond.status) return false;
    if (cond.departmentId) {
      if (typeof cond.departmentId === 'string' && s.departmentId !== cond.departmentId) return false;
      if (cond.departmentId.in && !cond.departmentId.in.includes(s.departmentId)) return false;
    }
    if (cond.officeArea) {
      if (typeof cond.officeArea === 'string' && s.officeArea !== cond.officeArea) return false;
      if (cond.officeArea.contains && !matchContains(s.officeArea, cond.officeArea.contains)) return false;
    }
    if (cond.pcNumber) {
      if (typeof cond.pcNumber === 'string' && s.pcNumber !== cond.pcNumber) return false;
      if (cond.pcNumber.contains && !matchContains(s.pcNumber, cond.pcNumber.contains)) return false;
    }
    return true;
  };

  const client: any = {
    adminUser: {
      findMany: async (args: any = {}) => {
        let list = Array.from(adminUsers.values());
        const where = args?.where;
        if (where?.role) list = list.filter((u) => u.role === where.role);
        if (where?.assignedUnitId) list = list.filter((u) => u.assignedUnitId === where.assignedUnitId);
        if (where?.OR && Array.isArray(where.OR)) {
          list = list.filter((u) => {
            return where.OR.some((cond: any) => {
              if (cond.email?.contains && matchContains(u.email, cond.email.contains)) return true;
              if (cond.name?.contains && matchContains(u.name, cond.name.contains)) return true;
              return false;
            });
          });
        }
        return list;
      },
      count: async (args: any = {}) => {
        let list = Array.from(adminUsers.values());
        const where = args?.where;
        if (where?.role) list = list.filter((u) => u.role === where.role);
          if (where?.assignedUnitId !== undefined) {
            list = list.filter((u) => u.assignedUnitId === where.assignedUnitId);
          }
          if (where?.deletedAt === null) list = list.filter((u) => !u.deletedAt);
        if (where?.isActive?.not !== undefined) list = list.filter((u) => u.isActive !== where.isActive.not);
        return list.length;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return adminUsers.get(where.id) || null;
        if (where.email) {
          const target = where.email.toLowerCase();
          for (const u of adminUsers.values()) {
            if (u.email === target) return u;
          }
        }
        return null;
      },
      findFirst: async (args: any = {}) => {
        const where = args?.where;
        for (const u of adminUsers.values()) {
          if (where?.email && u.email === where.email.toLowerCase()) return u;
        }
        return null;
      },
      create: async ({ data }: any) => {
        if (data.email) {
          for (const u of adminUsers.values()) {
            if (u.email === data.email.toLowerCase()) {
              throwP2002(['email']);
            }
          }
        }
        const id = data.id || randomUUID();
        const record = {
          role: 'SUPER_ADMIN',
          assignedUnitId: null,
          departmentId: null,
          employeeId: null,
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        adminUsers.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        let existing: any = null;
        if (where.id) existing = adminUsers.get(where.id);
        if (!existing && where.email) {
          for (const u of adminUsers.values()) {
            if (u.email === where.email.toLowerCase()) { existing = u; break; }
          }
        }
        if (!existing) throw new Error('AdminUser record not found');
        const nextUpdatedAt = data.updatedAt ?? new Date(Math.max(Date.now(), existing.updatedAt?.getTime() ?? 0) + 1);
        Object.assign(existing, data, { updatedAt: nextUpdatedAt });
        return existing;
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const u of adminUsers.values()) {
          if (where?.email && u.email === where.email.toLowerCase()) {
            Object.assign(u, data, { updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.id) existing = adminUsers.get(where.id);
        if (!existing && where.email) {
          for (const u of adminUsers.values()) {
            if (u.email === where.email.toLowerCase()) { existing = u; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = {
          role: 'SUPER_ADMIN',
          assignedUnitId: null,
          departmentId: null,
          employeeId: null,
          ...create,
          id,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        adminUsers.set(id, record);
        return record;
      },
      deleteMany: async (args: any = {}) => {
        let count = 0;
        const where = args?.where;
        for (const [id, u] of Array.from(adminUsers.entries())) {
          let match = true;
          if (where?.role && u.role !== where.role) match = false;
          if (where?.assignedUnitId && u.assignedUnitId !== where.assignedUnitId) match = false;
          if (where?.email?.in && !where.email.in.includes(u.email)) match = false;
          if (where?.email && typeof where.email === 'string' && u.email !== where.email.toLowerCase()) match = false;
          if (match) {
            adminUsers.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    unit: {
      findMany: async (args: any = {}) => {
        let list = Array.from(units.values());
        if (args?.where?.id) {
          list = list.filter((u) => u.id === args.where.id);
        }
        if (args.include?._count?.select?.plants) {
          list = list.map((u) => ({
            ...u,
            _count: {
              plants: Array.from(plants.values()).filter((p) => p.unitId === u.id).length
            }
          }));
        }
        return list.sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: any) => {
        for (const u of units.values()) {
          if (where?.id?.not && u.id === where.id.not) continue;
          if (where?.name?.equals && u.name.toLowerCase() === where.name.equals.toLowerCase()) return u;
          if (where?.code && u.code === where.code) return u;
        }
        return null;
      },
      findUnique: async ({ where, include, select }: any) => {
        let record = null;
        if (where.id) record = units.get(where.id);
        if (!record && where.code) {
          for (const u of units.values()) {
            if (u.code === where.code) { record = u; break; }
          }
        }
        if (!record && where.name) {
          for (const u of units.values()) {
            if (u.name.toLowerCase() === where.name.toLowerCase()) { record = u; break; }
          }
        }
        if (!record) return null;
        const res = { ...record };
        if (include?.plants) {
          res.plants = Array.from(plants.values())
            .filter((p) => p.unitId === record.id)
            .map((p) => ({
              ...p,
              _count: {
                buildings: Array.from(buildings.values()).filter((b) => b.plantId === p.id).length
              }
            }));
        }
        if (include?._count?.select?.plants) {
          res._count = { plants: Array.from(plants.values()).filter((p) => p.unitId === record.id).length };
        }
        return res;
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = { ...data, id, lifecycleStatus: data.lifecycleStatus ?? 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
        units.set(id, record);
        // Also sync to offices map for legacy compatibility
        offices.set(id, { id, name: record.name, city: record.location || 'HQ', address: null, createdAt: record.createdAt });
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = units.get(where.id);
        if (!existing) throw new Error('Unit not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        units.set(where.id, updated);
        if (offices.has(where.id)) {
          const off = offices.get(where.id);
          offices.set(where.id, { ...off, name: updated.name });
        }
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.code) {
          for (const u of units.values()) {
            if (u.code === where.code) { existing = u; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, lifecycleStatus: create.lifecycleStatus ?? 'ACTIVE', createdAt: new Date(), updatedAt: new Date() };
        units.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = units.get(where.id);
        if (!existing) throw new Error('Unit not found');
        // Cascading deletion
        for (const [pId, p] of Array.from(plants.entries())) {
          if (p.unitId === where.id) {
            for (const [bId, b] of Array.from(buildings.entries())) {
              if (b.plantId === pId) {
                for (const [fId, f] of Array.from(floors.entries())) {
                  if (f.buildingId === bId) {
                    for (const [sId, s] of Array.from(seats.entries())) {
                      if (s.floorId === fId) seats.delete(sId);
                    }
                    floors.delete(fId);
                  }
                }
                buildings.delete(bId);
              }
            }
            plants.delete(pId);
          }
        }
        units.delete(where.id);
        offices.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = units.size;
          units.clear();
          offices.clear();
          return { count };
        }
        for (const [id, u] of Array.from(units.entries())) {
          let match = true;
          if (where.id) {
            if (typeof where.id === 'string' && u.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(u.id)) match = false;
          }
          if (where.code) {
            if (typeof where.code === 'string' && u.code !== where.code) match = false;
            else if (where.code.in && Array.isArray(where.code.in) && !where.code.in.includes(u.code)) match = false;
          }
          if (match) {
            units.delete(id);
            offices.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    plant: {
      findMany: async (args: any = {}) => {
        let list = Array.from(plants.values());
        if (args.where?.id) {
          if (typeof args.where.id === 'string') {
            list = list.filter((p) => p.id === args.where.id);
          } else if (args.where.id.in && Array.isArray(args.where.id.in)) {
            list = list.filter((p) => args.where.id.in.includes(p.id));
          }
        }
        if (args.where?.unitId) {
          if (typeof args.where.unitId === 'string') {
            list = list.filter((p) => p.unitId === args.where.unitId);
          } else if (args.where.unitId.in && Array.isArray(args.where.unitId.in)) {
            list = list.filter((p) => args.where.unitId.in.includes(p.unitId));
          }
        }
        return list.map((p) => ({
          ...p,
          unit: units.get(p.unitId) || null,
          _count: {
            buildings: Array.from(buildings.values()).filter((b) => b.plantId === p.id).length
          }
        })).sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: any) => {
        for (const p of plants.values()) {
          if (where?.unitId && p.unitId !== where.unitId) continue;
          if (where?.code && p.code !== where.code) continue;
          return p;
        }
        return null;
      },
      findUnique: async ({ where, include }: any) => {
        let p: any = null;
        if (where.id) p = plants.get(where.id);
        if (!p && where.unitId_code) {
          const { unitId, code } = where.unitId_code;
          for (const pl of plants.values()) {
            if (pl.unitId === unitId && pl.code.toUpperCase() === code.toUpperCase()) {
              p = pl;
              break;
            }
          }
        }
        if (!p) return null;
        const res = { ...p };
        if (include?.unit) res.unit = units.get(p.unitId) || null;
        if (include?.buildings) {
          res.buildings = Array.from(buildings.values())
            .filter((b) => b.plantId === p.id)
            .map((b) => ({
              ...b,
              _count: {
                floors: Array.from(floors.values()).filter((f) => f.buildingId === b.id).length
              }
            }));
        }
        if (include?._count?.select?.buildings) {
          res._count = { buildings: Array.from(buildings.values()).filter((b) => b.plantId === p.id).length };
        }
        return res;
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        plants.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = plants.get(where.id);
        if (!existing) throw new Error('Plant not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        plants.set(where.id, updated);
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.unitId_code) {
          const { unitId, code } = where.unitId_code;
          for (const pl of plants.values()) {
            if (pl.unitId === unitId && pl.code === code) { existing = pl; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, createdAt: new Date(), updatedAt: new Date() };
        plants.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = plants.get(where.id);
        if (!existing) throw new Error('Plant not found');
        for (const [bId, b] of Array.from(buildings.entries())) {
          if (b.plantId === where.id) {
            for (const [fId, f] of Array.from(floors.entries())) {
              if (f.buildingId === bId) {
                for (const [sId, s] of Array.from(seats.entries())) {
                  if (s.floorId === fId) seats.delete(sId);
                }
                floors.delete(fId);
              }
            }
            buildings.delete(bId);
          }
        }
        plants.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = plants.size;
          plants.clear();
          return { count };
        }
        for (const [id, p] of Array.from(plants.entries())) {
          let match = true;
          if (where.id) {
            if (typeof where.id === 'string' && p.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(p.id)) match = false;
          }
          if (where.unitId) {
            if (typeof where.unitId === 'string' && p.unitId !== where.unitId) match = false;
            else if (where.unitId.in && Array.isArray(where.unitId.in) && !where.unitId.in.includes(p.unitId)) match = false;
          }
          if (match) {
            plants.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    office: {
      findMany: async (args: any = {}) => {
        let list = Array.from(units.values()).map((u) => ({
          id: u.id,
          name: u.name,
          city: u.location || 'HQ',
          address: null,
          createdAt: u.createdAt,
          _count: {
            buildings: Array.from(buildings.values()).filter((b) => b.officeId === u.id || b.plantId === u.id).length
          }
        }));
        if (list.length === 0) {
          list = Array.from(offices.values()).map((off) => ({
            ...off,
            _count: {
              buildings: Array.from(buildings.values()).filter((b) => b.officeId === off.id).length
            }
          }));
        }
        return list.sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: any) => {
        for (const u of units.values()) {
          if (where?.id?.not && u.id === where.id.not) continue;
          if (where?.name?.equals && u.name.toLowerCase() === where.name.equals.toLowerCase()) {
            return { id: u.id, name: u.name, city: u.location || 'HQ', address: null };
          }
        }
        for (const o of offices.values()) {
          if (where?.id?.not && o.id === where.id.not) continue;
          if (where?.name?.equals && o.name.toLowerCase() === where.name.equals.toLowerCase()) return o;
        }
        return null;
      },
      findUnique: async ({ where }: any) => {
        const u = units.get(where.id);
        if (u) return { id: u.id, name: u.name, city: u.location || 'HQ', address: null, createdAt: u.createdAt };
        return offices.get(where.id) || null;
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = { ...data, id, createdAt: new Date(), updatedAt: new Date() };
        offices.set(id, record);
        // Also register in units
        units.set(id, { id, name: data.name, code: `UNIT-${Date.now().toString().slice(-4)}`, location: data.city || null, createdAt: record.createdAt, updatedAt: record.updatedAt });
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = offices.get(where.id) || units.get(where.id);
        if (!existing) throw new Error('Office not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        offices.set(where.id, updated);
        if (units.has(where.id)) {
          const u = units.get(where.id);
          units.set(where.id, { ...u, name: data.name ?? u.name, location: data.city ?? u.location });
        }
        return updated;
      },
      delete: async ({ where }: any) => {
        const existing = offices.get(where.id) || units.get(where.id);
        if (!existing) throw new Error('Office not found');
        offices.delete(where.id);
        units.delete(where.id);
        return existing;
      }
    },

    building: {
      findMany: async (args: any = {}) => {
        let list = Array.from(buildings.values());
        if (args.where?.officeId) {
          const oVal = args.where.officeId;
          const officeIds = typeof oVal === 'string' ? [oVal] : oVal.in;
          list = list.filter((b) => officeIds.includes(b.officeId) || officeIds.includes(b.unitId) || officeIds.includes(b.plantId) || officeIds.includes(plants.get(b.plantId)?.unitId));
        } else {
          list = list.filter((b) => matchesBuildingWhere(b, args.where));
        }
        if (args.where?.isActive !== undefined) {
          list = list.filter((b) => (b.isActive ?? true) === args.where.isActive);
        }

        return list.map((b) => {
          const pl = plants.get(b.plantId);
          const un = pl ? units.get(pl.unitId) : null;
          return {
            ...b,
            plant: pl ? { ...pl, unit: un } : null,
            unit: units.get(b.unitId) || un,
            office: un ? { id: un.id, name: un.name } : (offices.get(b.officeId) || null),
            _count: {
              floors: Array.from(floors.values()).filter((f) => f.buildingId === b.id).length
            }
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: any) => {
        for (const b of buildings.values()) {
          if (where?.officeId) {
            const officeIds = typeof where.officeId === 'string' ? [where.officeId] : where.officeId.in;
            if (!officeIds.includes(b.officeId) && !officeIds.includes(b.unitId) && !officeIds.includes(b.plantId)) continue;
          } else if (!matchesBuildingWhere(b, where)) continue;
          return b;
        }
        return null;
      },
      findUnique: async ({ where }: any) => {
        let b: any = null;
        if (where.id) {
          b = buildings.get(where.id);
        } else if (where.plantId_code) {
          const { plantId, code } = where.plantId_code;
          for (const item of buildings.values()) {
            if (item.plantId === plantId && item.code.toUpperCase() === code.toUpperCase()) {
              b = item;
              break;
            }
          }
        } else if (where.officeId_code) {
          const { officeId, code } = where.officeId_code;
          for (const item of buildings.values()) {
            if ((item.officeId === officeId || item.plantId === officeId) && item.code.toUpperCase() === code.toUpperCase()) {
              b = item;
              break;
            }
          }
        }
        if (!b) return null;
        const pl = plants.get(b.plantId);
        const un = pl ? units.get(pl.unitId) : null;
        return {
          ...b,
          plant: pl ? { ...pl, unit: un } : null,
          unit: units.get(b.unitId) || un,
          office: un ? { id: un.id, name: un.name } : (offices.get(b.officeId) || null)
        };
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = {
          isActive: true,
          ...data,
          id,
          plantId: data.plantId,
          unitId: data.unitId || null,
          officeId: data.officeId || data.plantId,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        buildings.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = buildings.get(where.id);
        if (!existing) throw new Error('Building not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        buildings.set(where.id, updated);
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.plantId_code) {
          const { plantId, code } = where.plantId_code;
          for (const b of buildings.values()) {
            if (b.plantId === plantId && b.code === code) { existing = b; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, createdAt: new Date(), updatedAt: new Date() };
        buildings.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = buildings.get(where.id);
        if (!existing) throw new Error('Building not found');
        for (const [fId, f] of Array.from(floors.entries())) {
          if (f.buildingId === where.id) {
            for (const [sId, s] of Array.from(seats.entries())) {
              if (s.floorId === fId) seats.delete(sId);
            }
            floors.delete(fId);
          }
        }
        buildings.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = buildings.size;
          buildings.clear();
          return { count };
        }
        for (const [id, b] of Array.from(buildings.entries())) {
          let match = true;
          if (where.id) {
            if (typeof where.id === 'string' && b.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(b.id)) match = false;
          }
          if (where.plantId) {
            if (typeof where.plantId === 'string' && b.plantId !== where.plantId) match = false;
            else if (where.plantId.in && Array.isArray(where.plantId.in) && !where.plantId.in.includes(b.plantId)) match = false;
          }
          if (where.officeId) {
            const oMatch = (typeof where.officeId === 'string' && (b.officeId === where.officeId || b.plantId === where.officeId)) ||
                           (where.officeId.in && Array.isArray(where.officeId.in) && (where.officeId.in.includes(b.officeId) || where.officeId.in.includes(b.plantId)));
            if (!oMatch) match = false;
          }
          if (match) {
            buildings.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    floor: {
      findFirst: async (args: any = {}) => {
        let list = Array.from(floors.values());
        if (args?.where?.id) list = list.filter((f) => f.id === args.where.id);
        if (args?.where?.buildingId) list = list.filter((f) => f.buildingId === args.where.buildingId);
        const f = list[0];
        if (!f) return null;
        const res = { ...f };
        if (args?.include?.departments) {
          res.departments = Array.from(departments.values())
            .filter((d) => d.floorId === f.id)
            .map((d) => ({
              ...d,
              _count: {
                employees: Array.from(employees.values()).filter((e) => e.departmentId === d.id).length,
                seats: Array.from(seats.values()).filter((s) => s.departmentId === d.id).length
              }
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        return res;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(floors.values());
        if (args.where?.id) {
          if (typeof args.where.id === 'string') {
            list = list.filter((f) => f.id === args.where.id);
          } else if (args.where.id.in && Array.isArray(args.where.id.in)) {
            list = list.filter((f) => args.where.id.in.includes(f.id));
          }
        }
        if (args.where?.buildingId) {
          if (typeof args.where.buildingId === 'string') {
            list = list.filter((f) => f.buildingId === args.where.buildingId);
          } else if (args.where.buildingId.in && Array.isArray(args.where.buildingId.in)) {
            list = list.filter((f) => args.where.buildingId.in.includes(f.buildingId));
          }
        }
        if (args.where?.building) {
          list = list.filter((f) => matchesBuildingWhere(buildings.get(f.buildingId), args.where.building));
        }
        if (args.where?.building?.plant?.unitId) {
          const targetUnitId = args.where.building.plant.unitId;
          list = list.filter((f) => {
            const b = buildings.get(f.buildingId);
            if (!b) return false;
            const p = plants.get(b.plantId);
            return p && p.unitId === targetUnitId;
          });
        }
        if (args.where?.building?.plantId) {
          const targetPlantId = args.where.building.plantId;
          list = list.filter((f) => {
            const b = buildings.get(f.buildingId);
            return b && b.plantId === targetPlantId;
          });
        }
        if (args.where?.isActive !== undefined) {
          list = list.filter((f) => (f.isActive ?? true) === args.where.isActive);
        }
        return list.map((f) => ({
          ...f,
          _count: {
            seats: Array.from(seats.values()).filter((s) => s.floorId === f.id).length
          }
        })).sort((a, b) => a.floorNumber - b.floorNumber);
      },
      findUnique: async ({ where, include, select }: any) => {
        let f: any = null;
        if (where.id) {
          f = floors.get(where.id);
        } else if (where.buildingId_floorNumber) {
          const { buildingId, floorNumber } = where.buildingId_floorNumber;
          for (const fl of floors.values()) {
            if (fl.buildingId === buildingId && fl.floorNumber === floorNumber) {
              f = fl;
              break;
            }
          }
        }
        if (!f) return null;
        const res = { ...f };
        if (include?.building || select?.building) {
          const b = buildings.get(f.buildingId);
          if (b) {
            const pl = plants.get(b.plantId);
            const un = pl ? units.get(pl.unitId) : null;
            res.building = {
              ...b,
              plant: pl ? { ...pl, unit: un } : null,
                unit: units.get(b.unitId) || un,
              office: un ? { id: un.id, name: un.name } : (offices.get(b.officeId) || null)
            };
          } else {
            res.building = null;
          }
        }
        if (include?.seats) {
          res.seats = Array.from(seats.values())
            .filter((s) => s.floorId === f.id)
            .map((s) => {
              const emp = s.employeeId ? employees.get(s.employeeId) : null;
              const dept = emp ? departments.get(emp.departmentId) : null;
              return {
                ...s,
                employee: emp ? { ...emp, department: dept } : null
              };
            });
        }
        if (include?.departments) {
          res.departments = Array.from(departments.values())
            .filter((d) => d.floorId === f.id)
            .map((d) => ({
              ...d,
              _count: {
                employees: Array.from(employees.values()).filter((e) => e.departmentId === d.id).length,
                seats: Array.from(seats.values()).filter((s) => s.departmentId === d.id).length
              }
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
        }
        return res;
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        floors.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = floors.get(where.id);
        if (!existing) throw new Error('Floor not found');
        const updated = { ...existing, ...data, updatedAt: new Date() };
        floors.set(where.id, updated);
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.buildingId_floorNumber) {
          const { buildingId, floorNumber } = where.buildingId_floorNumber;
          for (const fl of floors.values()) {
            if (fl.buildingId === buildingId && fl.floorNumber === floorNumber) {
              existing = fl;
              break;
            }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, createdAt: new Date(), updatedAt: new Date() };
        floors.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = floors.get(where.id);
        if (!existing) throw new Error('Floor not found');
        for (const [sId, s] of Array.from(seats.entries())) {
          if (s.floorId === where.id) seats.delete(sId);
        }
        floors.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = floors.size;
          floors.clear();
          return { count };
        }
        for (const [id, f] of Array.from(floors.entries())) {
          let match = true;
          if (where.id) {
            if (typeof where.id === 'string' && f.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(f.id)) match = false;
          }
          if (where.buildingId) {
            if (typeof where.buildingId === 'string' && f.buildingId !== where.buildingId) match = false;
            else if (where.buildingId.in && Array.isArray(where.buildingId.in) && !where.buildingId.in.includes(f.buildingId)) match = false;
          }
          if (match) {
            floors.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    department: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(departments.values());
        if (where?.floorId) list = list.filter((d) => d.floorId === where.floorId);
        if (where?.unitId) list = list.filter((d) => d.unitId === where.unitId);
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(departments.values());

        const matchDeptCond = (d: any, cond: any): boolean => {
          if (!cond) return true;
          if (cond.id?.in && !cond.id.in.includes(d.id)) return false;
          if (cond.unitId !== undefined) {
            if (cond.unitId?.in && !cond.unitId.in.includes(d.unitId)) return false;
            if (!cond.unitId?.in && (d.unitId || null) !== (cond.unitId || null)) return false;
          }
          if (cond.code && d.code !== cond.code) return false;
          if (cond.floorId !== undefined) {
            return (d.floorId || null) === (cond.floorId || null);
          }
          if (cond.name?.equals) {
            return d.name.toLowerCase() === cond.name.equals.toLowerCase();
          }
          if (cond.OR && Array.isArray(cond.OR)) {
            return cond.OR.some((c: any) => matchDeptCond(d, c));
          }
          if (cond.AND && Array.isArray(cond.AND)) {
            return cond.AND.every((c: any) => matchDeptCond(d, c));
          }
          if (cond.seats?.some?.floorId !== undefined) {
            return Array.from(seats.values()).some(
              (s) => s.departmentId === d.id && s.floorId === cond.seats.some.floorId
            );
          }
          if (cond.seats?.some?.floor?.buildingId !== undefined) {
            return Array.from(seats.values()).some((s) => {
              if (s.departmentId !== d.id) return false;
              const fl = floors.get(s.floorId);
              return fl && fl.buildingId === cond.seats.some.floor.buildingId;
            });
          }
          if (cond.seats?.some?.floor?.building?.plantId !== undefined) {
            return Array.from(seats.values()).some((s) => {
              if (s.departmentId !== d.id) return false;
              const fl = floors.get(s.floorId);
              const b = fl ? buildings.get(fl.buildingId) : null;
              return b && b.plantId === cond.seats.some.floor.building.plantId;
            });
          }
          if (cond.seats?.some?.floor?.building?.plant?.unitId !== undefined) {
            return Array.from(seats.values()).some((s) => {
              if (s.departmentId !== d.id) return false;
              const fl = floors.get(s.floorId);
              const b = fl ? buildings.get(fl.buildingId) : null;
              const p = b ? plants.get(b.plantId) : null;
              return p && p.unitId === cond.seats.some.floor.building.plant.unitId;
            });
          }
          if (cond.floor?.buildingId !== undefined) {
            const fl = d.floorId ? floors.get(d.floorId) : null;
            return Boolean(fl && fl.buildingId === cond.floor.buildingId);
          }
          if (cond.floor?.building?.plantId !== undefined) {
            const fl = d.floorId ? floors.get(d.floorId) : null;
            const b = fl ? buildings.get(fl.buildingId) : null;
            return Boolean(b && b.plantId === cond.floor.building.plantId);
          }
          if (cond.floor?.building?.plant?.unitId !== undefined) {
            const fl = d.floorId ? floors.get(d.floorId) : null;
            const b = fl ? buildings.get(fl.buildingId) : null;
            const p = b ? plants.get(b.plantId) : null;
            return Boolean(p && p.unitId === cond.floor.building.plant.unitId);
          }
          return true;
        };

        if (args.where?.AND) {
          list = list.filter((d) => args.where.AND.every((cond: any) => matchDeptCond(d, cond)));
        } else if (args.where) {
          list = list.filter((d) => matchDeptCond(d, args.where));
        }
        if (args.include?._count) {
          list = list.map((d) => ({
            ...d,
            _count: {
              employees: Array.from(employees.values()).filter((e) => e.departmentId === d.id).length,
              seats: Array.from(seats.values()).filter((s) => s.departmentId === d.id).length
            }
          }));
        }
        if (args.include?.unit) {
          list = list.map((d) => ({
            ...d,
            unit: d.unitId ? units.get(d.unitId) || null : null
          }));
        }
        if (args.include?.floor) {
          list = list.map((d) => ({
            ...d,
            floor: d.floorId ? floors.get(d.floorId) || null : null
          }));
        }
        return list.sort((a, b) => a.name.localeCompare(b.name));
      },
      findFirst: async ({ where }: any) => {
        for (const d of departments.values()) {
          if (where?.id?.not && d.id === where.id.not) continue;
          if (where?.unitId !== undefined && (d.unitId || null) !== (where.unitId || null)) continue;
          if (where?.floorId !== undefined && (d.floorId || null) !== (where.floorId || null)) continue;
          if (where?.OR) {
            for (const orCond of where.OR) {
              const targetName = typeof orCond.name === 'string' ? orCond.name : orCond.name?.equals;
              if (targetName && d.name.toLowerCase() === targetName.toLowerCase()) return d;
              const targetCode = typeof orCond.code === 'string' ? orCond.code : orCond.code?.equals;
              if (targetCode && d.code.toUpperCase() === targetCode.toUpperCase()) return d;
            }
          } else {
            if (where?.name) {
              const targetName = typeof where.name === 'string' ? where.name : where.name.equals;
              if (targetName && d.name.toLowerCase() === targetName.toLowerCase()) return d;
            }
            if (where?.code) {
              const targetCode = typeof where.code === 'string' ? where.code : where.code.equals;
              if (targetCode && d.code.toUpperCase() === targetCode.toUpperCase()) return d;
            }
          }
        }
        return null;
      },
      findUnique: async ({ where }: any) => {
        if (where.id) return departments.get(where.id) || null;
        if (where.code) {
          const c = where.code.toUpperCase();
          for (const d of departments.values()) {
            if (d.code === c) return d;
          }
        }
        return null;
      },
      create: async ({ data }: any) => {
        if (data.unitId) {
          for (const d of departments.values()) {
            if (d.unitId === data.unitId) {
              if (data.code && d.code?.toUpperCase() === data.code.toUpperCase()) {
                throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`unitId`, `code`)', {
                  code: 'P2002',
                  clientVersion: '5.22.0',
                  meta: { target: ['unitId', 'code'] }
                });
              }
              if (data.name && d.name?.toLowerCase() === data.name.toLowerCase()) {
                throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`unitId`, `name`)', {
                  code: 'P2002',
                  clientVersion: '5.22.0',
                  meta: { target: ['unitId', 'name'] }
                });
              }
            }
          }
        }
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        departments.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = departments.get(where.id);
        if (!existing) throw new Error('Department not found');
        const unitId = data.unitId !== undefined ? data.unitId : existing.unitId;
        if (unitId) {
          for (const d of departments.values()) {
            if (d.id !== where.id && d.unitId === unitId) {
              if (data.code && d.code?.toUpperCase() === data.code.toUpperCase()) {
                throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`unitId`, `code`)', {
                  code: 'P2002',
                  clientVersion: '5.22.0',
                  meta: { target: ['unitId', 'code'] }
                });
              }
              if (data.name && d.name?.toLowerCase() === data.name.toLowerCase()) {
                throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`unitId`, `name`)', {
                  code: 'P2002',
                  clientVersion: '5.22.0',
                  meta: { target: ['unitId', 'name'] }
                });
              }
            }
          }
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        departments.set(where.id, updated);
        return updated;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.code) {
          for (const d of departments.values()) {
            if (d.code === where.code) { existing = d; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, createdAt: new Date(), updatedAt: new Date() };
        departments.set(id, record);
        return record;
      },
      delete: async ({ where }: any) => {
        const existing = departments.get(where.id);
        if (!existing) throw new Error('Department not found');
        for (const s of seats.values()) {
          if (s.departmentId === where.id) s.departmentId = null;
        }
        departments.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        for (const [id, d] of Array.from(departments.entries())) {
          let match = true;
          if (where?.floorId) {
            if (where.floorId.in && Array.isArray(where.floorId.in)) {
              if (!where.floorId.in.includes(d.floorId)) match = false;
            } else if (d.floorId !== where.floorId) {
              match = false;
            }
          }
          if (match) {
            for (const s of seats.values()) {
              if (s.departmentId === id) s.departmentId = null;
            }
            departments.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    employee: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(employees.values());
        const conds = where?.AND ? where.AND : (where ? [where] : []);
        for (const c of conds) {
          if (!c) continue;
          list = list.filter((e) => matchEmployeeRecord(e, c));
        }
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(employees.values());
        const conds = args.where?.AND ? args.where.AND : (args.where ? [args.where] : []);
        for (const c of conds) {
          if (!c) continue;
          list = list.filter((e) => matchEmployeeRecord(e, c));
        }
        if (args.orderBy) {
          const order = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
          const [field, direction] = Object.entries(order)[0] || [];
          if (field) {
            list.sort((a, b) => String(a[field] ?? '').localeCompare(String(b[field] ?? '')) * (direction === 'desc' ? -1 : 1));
          }
        }
        const skip = args.skip || 0;
        const take = args.take || list.length;
        const paged = list.slice(skip, skip + take);

        return paged.map((e) => {
          const seat = Array.from(seats.values()).find((s) => s.employeeId === e.id) || null;
          return {
            ...e,
            department: departments.get(e.departmentId) || null,
            seat: seat ? {
              id: seat.id,
              label: seat.label,
              pcNumber: seat.pcNumber || null,
              officeArea: seat.officeArea || null,
              floorId: seat.floorId,
              floor: (() => {
                const fl = floors.get(seat.floorId);
                const bld = fl ? buildings.get(fl.buildingId) : null;
                const pl = bld ? plants.get(bld.plantId) : null;
                const un = pl ? units.get(pl.unitId) : null;
                return fl ? {
                  id: fl.id,
                  name: fl.name,
                  floorNumber: fl.floorNumber,
                  buildingId: fl.buildingId,
                  building: bld ? {
                    id: bld.id,
                    name: bld.name,
                    code: bld.code,
                    plantId: bld.plantId,
                    plant: pl ? { id: pl.id, name: pl.name, code: pl.code, unitId: pl.unitId, unit: un ? { id: un.id, name: un.name, code: un.code } : null } : null,
                    office: un ? { name: un.name } : null
                  } : null
                } : null;
              })()
            } : null
          };
        });
      },
      findFirst: async ({ where, include }: any = {}) => {
        for (const e of employees.values()) {
          if (where?.id && e.id !== where.id) continue;
          if (where?.email && (!e.email || e.email.toLowerCase() !== where.email.toLowerCase())) continue;
          if (where?.employeeCode && e.employeeCode !== where.employeeCode) continue;
          if (where?.departmentId && e.departmentId !== where.departmentId) continue;
          const res = { ...e };
          if (include?.department) {
            res.department = departments.get(e.departmentId) || null;
          }
          return res;
        }
        return null;
      },
      findUnique: async ({ where, include }: any) => {
        let emp: any = null;
        if (where.id) {
          emp = employees.get(where.id);
        } else if (where.employeeCode) {
          for (const e of employees.values()) {
            if (e.employeeCode === where.employeeCode) {
              emp = e;
              break;
            }
          }
        } else if (where.email) {
          for (const e of employees.values()) {
            if (e.email && e.email.toLowerCase() === where.email.toLowerCase()) {
              emp = e;
              break;
            }
          }
        }
        if (!emp) return null;
        const res = { ...emp };
        if (include?.department) {
          res.department = departments.get(emp.departmentId) || null;
        }
        if (include?.seat) {
          const seat = Array.from(seats.values()).find((s) => s.employeeId === emp.id) || null;
          res.seat = seat ? {
            id: seat.id,
            label: seat.label,
            pcNumber: seat.pcNumber || null,
            officeArea: seat.officeArea || null,
            floor: (() => {
              const fl = floors.get(seat.floorId);
              const bld = fl ? buildings.get(fl.buildingId) : null;
              const pl = bld ? plants.get(bld.plantId) : null;
              const un = pl ? units.get(pl.unitId) : null;
              return fl ? {
                id: fl.id,
                name: fl.name,
                building: bld ? {
                  name: bld.name,
                  plant: pl ? { name: pl.name, unit: un ? { name: un.name } : null } : null,
                  office: un ? { name: un.name } : null
                } : null
              } : null;
            })()
          } : null;
        }
        return res;
      },
      upsert: async ({ where, update, create }: any) => {
        let existing: any = null;
        if (where.id) existing = employees.get(where.id);
        if (!existing && where.employeeCode) {
          for (const e of employees.values()) {
            if (e.employeeCode === where.employeeCode) { existing = e; break; }
          }
        }
        if (!existing && where.email) {
          for (const e of employees.values()) {
            if (e.email && e.email.toLowerCase() === where.email.toLowerCase()) { existing = e; break; }
          }
        }
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, createdAt: new Date(), updatedAt: new Date() };
        employees.set(id, record);
        return record;
      },
      create: async ({ data, include }: any) => {
        if (data.employeeCode) {
          for (const e of employees.values()) {
            if (e.employeeCode?.toUpperCase() === data.employeeCode.toUpperCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`employee_code`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['employee_code'] }
              });
            }
          }
        }
        if (data.email && data.email.toLowerCase() !== 'employee@shaktiman.com') {
          for (const e of employees.values()) {
            if (e.email && e.email.toLowerCase() === data.email.toLowerCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['email'] }
              });
            }
          }
        }
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        employees.set(id, record);
        return {
          ...record,
          department: include?.department ? departments.get(data.departmentId) : undefined
        };
      },
      createMany: async ({ data }: any) => {
        for (const item of data) {
          const id = item.id || randomUUID();
          employees.set(id, { ...item, id, createdAt: new Date(), updatedAt: new Date() });
        }
        return { count: data.length };
      },
      update: async ({ where, data, include }: any) => {
        const existing = employees.get(where.id);
        if (!existing) throw new Error('Employee not found');
        if (data.employeeCode) {
          for (const e of employees.values()) {
            if (e.id !== where.id && e.employeeCode?.toUpperCase() === data.employeeCode.toUpperCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`employee_code`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['employee_code'] }
              });
            }
          }
        }
        if (data.email) {
          for (const e of employees.values()) {
            if (e.id !== where.id && e.email && e.email.toLowerCase() === data.email.toLowerCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`email`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['email'] }
              });
            }
          }
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        employees.set(where.id, updated);
        return {
          ...updated,
          department: include?.department ? departments.get(updated.departmentId) : undefined
        };
      },
      delete: async ({ where }: any) => {
        const existing = employees.get(where.id);
        if (!existing) throw new Error('Employee not found');
        employees.delete(where.id);
        return existing;
      }
    },

    seat: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(seats.values());
        if (where?.AND) {
          list = list.filter((s) => where.AND.every((cond: any) => matchSeatCond(s, cond)));
        }
        if (where?.departmentId) list = list.filter((s) => s.departmentId === where.departmentId);
        if (where?.floorId) {
          if (typeof where.floorId === 'string') list = list.filter((s) => s.floorId === where.floorId);
          else if (Array.isArray(where.floorId.in)) list = list.filter((s) => where.floorId.in.includes(s.floorId));
        }
        if (where?.status) list = list.filter((s) => s.status === where.status);
        if (where?.employeeId !== undefined) {
          if (where.employeeId === null) list = list.filter((s) => !s.employeeId);
          else list = list.filter((s) => s.employeeId === where.employeeId);
        }
        return list.length;
      },
      upsert: async ({ where, update, create }: any) => {
        assertValidSeatStatus(update.status);
        assertValidSeatStatus(create.status);
        let existing = null;
        if (where.id) {
          existing = seats.get(where.id);
        } else if (where.floorId_label) {
          for (const s of seats.values()) {
            if (s.floorId === where.floorId_label.floorId && s.label === where.floorId_label.label) {
              existing = s;
              break;
            }
          }
        }
        if (existing) {
          const updated = { ...existing, ...update, updatedAt: new Date() };
          seats.set(existing.id, updated);
          return updated;
        } else {
          const id = create.id || randomUUID();
          const record = {
            ...create,
            id,
            status: create.status || 'AVAILABLE',
            employeeId: create.employeeId || null,
            departmentId: create.departmentId || null,
            createdAt: new Date(),
            updatedAt: new Date()
          };
          seats.set(id, record);
          return record;
        }
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(seats.values());
        if (args.where?.AND) {
          list = list.filter((s) => args.where.AND.every((cond: any) => matchSeatCond(s, cond)));
        }
        if (args.where?.OR) {
          list = list.filter((s) => matchSeatCond(s, args.where));
        }
        if (args.where?.id) {
          if (typeof args.where.id === 'string') {
            list = list.filter((s) => s.id === args.where.id);
          } else if (args.where.id.in && Array.isArray(args.where.id.in)) {
            list = list.filter((s) => args.where.id.in.includes(s.id));
          }
        }
        if (args.where?.floorId) {
          if (typeof args.where.floorId === 'string') {
            list = list.filter((s) => s.floorId === args.where.floorId);
          } else if (args.where.floorId.in && Array.isArray(args.where.floorId.in)) {
            list = list.filter((s) => args.where.floorId.in.includes(s.floorId));
          }
        }
        if (args.where?.employeeId !== undefined) {
          if (args.where.employeeId === null) {
            list = list.filter((s) => !s.employeeId);
          } else if (args.where.employeeId?.not !== undefined) {
            list = list.filter((s) => s.employeeId !== null && s.employeeId !== undefined);
          } else if (args.where.employeeId?.in && Array.isArray(args.where.employeeId.in)) {
            list = list.filter((s) => args.where.employeeId.in.includes(s.employeeId));
          } else {
            list = list.filter((s) => s.employeeId === args.where.employeeId);
          }
        }
        if (args.where?.departmentId) {
          list = list.filter((s) => typeof args.where.departmentId === 'string'
            ? s.departmentId === args.where.departmentId
            : args.where.departmentId.in?.includes(s.departmentId));
        }
        if (args.where?.status) {
          list = list.filter((s) => (s.status || 'AVAILABLE') === args.where.status);
        }
        if (args.where?.floor?.building?.plant?.unitId) {
          const targetUnitId = args.where.floor.building.plant.unitId;
          list = list.filter((s) => {
            const fl = floors.get(s.floorId);
            const bld = fl ? buildings.get(fl.buildingId) : null;
            const pl = bld ? plants.get(bld.plantId) : null;
            return pl && pl.unitId === targetUnitId;
          });
        }
        if (args.where?.floor?.building?.plantId) {
          const targetPlantId = args.where.floor.building.plantId;
          list = list.filter((s) => {
            const fl = floors.get(s.floorId);
            const bld = fl ? buildings.get(fl.buildingId) : null;
            return bld && bld.plantId === targetPlantId;
          });
        }
        if (args.where?.floor?.buildingId) {
          const targetBuildingId = args.where.floor.buildingId;
          list = list.filter((s) => {
            const fl = floors.get(s.floorId);
            return fl && (typeof targetBuildingId === 'string'
              ? fl.buildingId === targetBuildingId
              : targetBuildingId.in?.includes(fl.buildingId));
          });
        }
        if (args.where?.type) {
          list = list.filter((s) => s.type === args.where.type);
        }
        if (args.where?.officeArea) {
          if (args.where.officeArea.not === null) {
            list = list.filter((s) => s.officeArea != null);
          } else {
            const expected = typeof args.where.officeArea === 'string'
              ? args.where.officeArea
              : args.where.officeArea.equals;
            list = list.filter((s) => s.officeArea?.toLowerCase() === expected?.toLowerCase());
          }
        }
        if (args.where?.areaId) {
          list = list.filter((s) => s.areaId === args.where.areaId);
        }
        if (args.where?.label) {
          const expected = typeof args.where.label === 'string' ? args.where.label : args.where.label.contains;
          list = list.filter((s) => matchContains(s.label, expected));
        }
        if (args.select?.employee) {
          list = list.map((s) => ({
            ...s,
            employee: s.employeeId ? employees.get(s.employeeId) || null : null
          }));
        }
        if (args.include?.employee || args.include?.department || args.include?.floor) {
          list = list.map((s) => {
            const res = { ...s };
            if (args.include?.floor) {
              const fl = floors.get(s.floorId);
              const bld = fl ? buildings.get(fl.buildingId) : null;
              const pl = bld ? plants.get(bld.plantId) : null;
              const un = pl ? units.get(pl.unitId) : null;
              res.floor = fl ? {
                ...fl,
                building: bld ? {
                  ...bld,
                  plant: pl ? {
                    ...pl,
                    unit: un || null
                  } : null
                } : null
              } : null;
            }
            if (args.include?.employee) {
              const emp = s.employeeId ? employees.get(s.employeeId) : null;
              if (emp) {
                const dept = emp.departmentId ? departments.get(emp.departmentId) : null;
                res.employee = { ...emp, department: dept || null };
              } else {
                res.employee = null;
              }
            }
            if (args.include?.department) {
              res.department = s.departmentId ? departments.get(s.departmentId) : null;
            }
            return res;
          });
        }
        const skip = args.skip || 0;
        const take = args.take !== undefined ? args.take : list.length;
        return list.slice(skip, skip + take);
      },
      findFirst: async (args: any = {}) => {
        const where = args?.where;
        for (const s of seats.values()) {
          if (where?.id?.not && s.id === where.id.not) continue;
          if (where?.floorId && s.floorId !== where.floorId) continue;
          if (where?.employeeId !== undefined && s.employeeId !== where.employeeId) continue;
          if (where?.departmentId) {
            if (where.departmentId.not !== undefined && (s.departmentId === null || s.departmentId === undefined)) continue;
            if (typeof where.departmentId === 'string' && s.departmentId !== where.departmentId) continue;
          }
          const sStatus = s.status || 'AVAILABLE';
          if (where?.status && sStatus !== where.status) continue;

          const res = { ...s };
          if (args?.include?.floor) {
            const fl = floors.get(s.floorId);
            const bld = fl ? buildings.get(fl.buildingId) : null;
            const pl = bld ? plants.get(bld.plantId) : null;
            const un = pl ? units.get(pl.unitId) : null;
            res.floor = fl ? {
              ...fl,
              building: bld ? {
                ...bld,
                plant: pl ? {
                  ...pl,
                  unit: un || null
                } : null
              } : null
            } : null;
          }
          if (args?.include?.employee) {
            const emp = s.employeeId ? employees.get(s.employeeId) : null;
            res.employee = emp ? {
              ...emp,
              department: departments.get(emp.departmentId) || null
            } : null;
          }
          return res;
        }
        return null;
      },
      findUnique: async ({ where, include }: any) => {
        let s: any = null;
        if (where.id) s = seats.get(where.id) || null;
        if (!s && where.floorId_label) {
          for (const item of seats.values()) {
            if (item.floorId === where.floorId_label.floorId && item.label === where.floorId_label.label) {
              s = item;
              break;
            }
          }
        }
        if (!s) return null;
        const res = { ...s };
        if (include?.floor) {
          const fl = floors.get(s.floorId);
          const bld = fl ? buildings.get(fl.buildingId) : null;
          const pl = bld ? plants.get(bld.plantId) : null;
          const un = pl ? units.get(pl.unitId) : null;
          res.floor = fl ? {
            ...fl,
            building: bld ? {
              ...bld,
              plant: pl ? {
                ...pl,
                unit: un || null
              } : null
            } : null
          } : null;
        }
        if (include?.employee) {
          const emp = s.employeeId ? employees.get(s.employeeId) : null;
          if (emp) {
            const dept = emp.departmentId ? departments.get(emp.departmentId) : null;
            res.employee = { ...emp, department: dept || null };
          } else {
            res.employee = null;
          }
        }
        if (include?.department) {
          res.department = s.departmentId ? departments.get(s.departmentId) : null;
        }
        return res;
      },
      create: async ({ data, include }: any) => {
        assertValidSeatStatus(data.status);
        if (data.floorId && data.label) {
          for (const s of seats.values()) {
            if (s.floorId === data.floorId && s.label?.toLowerCase() === data.label.toLowerCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`floor_id`, `label`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['floorId', 'label'] }
              });
            }
          }
        }
        const id = data.id || randomUUID();
        const record = {
          ...data,
          id,
          status: data.status || 'AVAILABLE',
          employeeId: data.employeeId || null,
          departmentId: data.departmentId || null,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        seats.set(id, record);
        const res = { ...record };
        if (include?.floor) {
          const fl = floors.get(record.floorId);
          const bld = fl ? buildings.get(fl.buildingId) : null;
          const pl = bld ? plants.get(bld.plantId) : null;
          const un = pl ? units.get(pl.unitId) : null;
          res.floor = fl ? {
            ...fl,
            building: bld ? {
              ...bld,
              plant: pl ? {
                ...pl,
                unit: un || null
              } : null
            } : null
          } : null;
        }
        if (include?.employee) {
          const emp = record.employeeId ? employees.get(record.employeeId) : null;
          res.employee = emp ? {
            ...emp,
            department: emp.departmentId ? (departments.get(emp.departmentId) || null) : null
          } : null;
        }
        if (include?.department) {
          res.department = record.departmentId ? (departments.get(record.departmentId) || null) : null;
        }
        return res;
      },
      update: async ({ where, data, include }: any) => {
        assertValidSeatStatus(data.status);
        const existing = seats.get(where.id);
        if (!existing) throw new Error('Seat not found');

        // Check @@unique([floorId, label])
        if (data.label) {
          const targetFloorId = data.floorId || existing.floorId;
          for (const s of seats.values()) {
            if (s.id !== where.id && s.floorId === targetFloorId && s.label?.toLowerCase() === data.label.toLowerCase()) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`floor_id`, `label`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['floorId', 'label'] }
              });
            }
          }
        }

        // Check @unique constraint on employeeId
        if (data.employeeId) {
          for (const s of seats.values()) {
            if (s.id !== where.id && s.employeeId === data.employeeId) {
              throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`employee_id`)', {
                code: 'P2002',
                clientVersion: '5.22.0',
                meta: { target: ['employee_id'] }
              });
            }
          }
        }

        const cleanData: any = {};
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && (value as any).unset === true) {
            // Prisma's MongoDB unset operator removes the field; represent the
            // resulting nullable value as null in the in-memory test adapter.
            cleanData[key] = null;
          } else if (value !== undefined) cleanData[key] = value;
        }
        const updated = { ...existing, ...cleanData, updatedAt: new Date() };
        seats.set(where.id, updated);

        if (include?.employee) {
          const emp = updated.employeeId ? employees.get(updated.employeeId) : null;
          return {
            ...updated,
            employee: emp ? { ...emp, department: departments.get(emp.departmentId) } : null
          };
        }
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        assertValidSeatStatus(data.status);
        let count = 0;
        for (const s of seats.values()) {
          let match = true;
          if (where?.employeeId) {
            if (typeof where.employeeId === 'string' && s.employeeId !== where.employeeId) match = false;
            else if (where.employeeId.in && Array.isArray(where.employeeId.in) && !where.employeeId.in.includes(s.employeeId)) match = false;
          }
          if (where?.floorId) {
            if (typeof where.floorId === 'string' && s.floorId !== where.floorId) match = false;
            else if (where.floorId.in && Array.isArray(where.floorId.in) && !where.floorId.in.includes(s.floorId)) match = false;
          }
          if (where?.id) {
            if (typeof where.id === 'string' && s.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(s.id)) match = false;
          }
          if (match) {
            if ((data.employeeId === null || data.employeeId?.unset === true) && s.employeeId) {
              const emp = employees.get(s.employeeId);
              if (emp && emp.seat) {
                emp.seat = null;
              }
            }
            Object.assign(s, data, { updatedAt: new Date() });
            if (data.employeeId?.unset === true) s.employeeId = null; // Prisma returns null for a missing optional Mongo field.
            count++;
          }
        }
        return { count };
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = seats.size;
          seats.clear();
          return { count };
        }
        for (const [id, s] of Array.from(seats.entries())) {
          let match = true;
          if (where.id) {
            if (typeof where.id === 'string' && s.id !== where.id) match = false;
            else if (where.id.in && Array.isArray(where.id.in) && !where.id.in.includes(s.id)) match = false;
          }
          if (where.floorId) {
            if (typeof where.floorId === 'string' && s.floorId !== where.floorId) match = false;
            else if (where.floorId.in && Array.isArray(where.floorId.in) && !where.floorId.in.includes(s.floorId)) match = false;
          }
          if (where.employeeId) {
            if (typeof where.employeeId === 'string' && s.employeeId !== where.employeeId) match = false;
            else if (where.employeeId.in && Array.isArray(where.employeeId.in) && !where.employeeId.in.includes(s.employeeId)) match = false;
          }
          if (match) {
            seats.delete(id);
            count++;
          }
        }
        return { count };
      },
      delete: async ({ where }: any) => {
        const existing = seats.get(where.id);
        if (!existing) throw new Error('Seat not found');
        seats.delete(where.id);
        return existing;
      }
    },

    auditLog: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(auditLogs.values());
        if (where?.action) {
          if (typeof where.action === 'string') {
            list = list.filter((l) => l.action === where.action);
          } else if (where.action.in) {
            list = list.filter((l) => where.action.in.includes(l.action));
          }
        }
        if (where?.entityType) {
          if (typeof where.entityType === 'string') {
            list = list.filter((l) => l.entityType.toUpperCase() === where.entityType.toUpperCase());
          } else if (where.entityType.in) {
            const inList = where.entityType.in.map((x: string) => x.toUpperCase());
            list = list.filter((l) => inList.includes(l.entityType.toUpperCase()));
          }
        }
        if (where?.adminId) {
          if (typeof where.adminId === 'string') {
            list = list.filter((l) => l.adminId === where.adminId);
          } else if (where.adminId.in) {
            list = list.filter((l) => where.adminId.in.includes(l.adminId));
          }
        }
        if (where?.OR && Array.isArray(where.OR)) {
          list = list.filter((l) => {
            return where.OR.some((cond: any) => {
              if (cond.action?.contains) return matchContains(l.action, cond.action.contains);
              if (cond.entityType?.contains) return matchContains(l.entityType, cond.entityType.contains);
              if (cond.entityId?.contains) return matchContains(l.entityId, cond.entityId.contains);
              if (cond.adminId?.in) return cond.adminId.in.includes(l.adminId);
              return false;
            });
          });
        }
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(auditLogs.values());
        const where = args.where;
        if (where?.action) {
          if (typeof where.action === 'string') {
            list = list.filter((l) => l.action === where.action);
          } else if (where.action.in) {
            list = list.filter((l) => where.action.in.includes(l.action));
          }
        }
        if (where?.entityType) {
          if (typeof where.entityType === 'string') {
            list = list.filter((l) => l.entityType.toUpperCase() === where.entityType.toUpperCase());
          } else if (where.entityType.in) {
            const inList = where.entityType.in.map((x: string) => x.toUpperCase());
            list = list.filter((l) => inList.includes(l.entityType.toUpperCase()));
          }
        }
        if (where?.adminId) {
          if (typeof where.adminId === 'string') {
            list = list.filter((l) => l.adminId === where.adminId);
          } else if (where.adminId.in) {
            list = list.filter((l) => where.adminId.in.includes(l.adminId));
          }
        }
        if (where?.OR && Array.isArray(where.OR)) {
          list = list.filter((l) => {
            return where.OR.some((cond: any) => {
              if (cond.action?.contains) return matchContains(l.action, cond.action.contains);
              if (cond.entityType?.contains) return matchContains(l.entityType, cond.entityType.contains);
              if (cond.entityId?.contains) return matchContains(l.entityId, cond.entityId.contains);
              if (cond.adminId?.in) return cond.adminId.in.includes(l.adminId);
              return false;
            });
          });
        }
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        const skip = args.skip || 0;
        const take = args.take || list.length;
        const paged = list.slice(skip, skip + take);

        return paged.map((l) => {
          const admin = adminUsers.get(l.adminId);
          return {
            ...l,
            createdAt: l.createdAt.toISOString(),
            admin: admin ? { id: admin.id, name: admin.name, email: admin.email } : null
          };
        });
      },
      create: async ({ data }: any) => {
        const id = data.id || randomUUID();
        const record = {
          ...data,
          id,
          createdAt: new Date()
        };
        auditLogs.set(id, record);
        return record;
      }
    },

    seatTransferRequest: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(seatTransferRequests.values());
        if (where?.status) {
          if (typeof where.status === 'string') list = list.filter((r) => r.status === where.status);
          else if (where.status.in && Array.isArray(where.status.in)) list = list.filter((r) => where.status.in.includes(r.status));
        }
        if (where?.employeeId) list = list.filter((r) => r.employeeId === where.employeeId);
        if (where?.sourceUnitId) list = list.filter((r) => r.sourceUnitId === where.sourceUnitId);
        if (where?.targetUnitId) list = list.filter((r) => r.targetUnitId === where.targetUnitId);
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(seatTransferRequests.values());
        const where = args.where;
        if (where?.status) {
          if (typeof where.status === 'string') list = list.filter((r) => r.status === where.status);
          else if (where.status.in && Array.isArray(where.status.in)) list = list.filter((r) => where.status.in.includes(r.status));
        }
        if (where?.sourceUnitId) list = list.filter((r) => r.sourceUnitId === where.sourceUnitId);
        if (where?.targetUnitId) list = list.filter((r) => r.targetUnitId === where.targetUnitId);
        if (where?.employeeId) list = list.filter((r) => r.employeeId === where.employeeId);
        if (where?.employee?.departmentId) {
          list = list.filter((r) => {
            const emp = employees.get(r.employeeId);
            return emp && emp.departmentId === where.employee.departmentId;
          });
        }
        if (where?.employee?.email) {
          list = list.filter((r) => {
            const emp = employees.get(r.employeeId);
            return emp && emp.email && emp.email.toLowerCase() === where.employee.email.toLowerCase();
          });
        }
        if (where?.OR && Array.isArray(where.OR)) {
          list = list.filter((r) => {
            return where.OR.some((clause: any) => {
              if (clause.sourceUnitId && r.sourceUnitId === clause.sourceUnitId) return true;
              if (clause.targetUnitId && r.targetUnitId === clause.targetUnitId) return true;
              return false;
            });
          });
        }

        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

        if (args.include?.employee) {
          return list.map((r) => {
            const emp = employees.get(r.employeeId);
            return {
              ...r,
              employee: emp ? {
                ...emp,
                department: departments.get(emp.departmentId) || null
              } : null
            };
          });
        }

        return list;
      },
      findUnique: async ({ where, include }: any) => {
        let req = null;
        if (where.id) req = seatTransferRequests.get(where.id);
        if (!req && where.requestNumber) {
          for (const r of seatTransferRequests.values()) {
            if (r.requestNumber === where.requestNumber) { req = r; break; }
          }
        }
        if (!req) return null;
        const res = { ...req };
        if (include?.employee) {
          const emp = employees.get(req.employeeId);
          res.employee = emp ? {
            ...emp,
            department: departments.get(emp.departmentId) || null
          } : null;
        }
        return res;
      },
      findFirst: async ({ where, include, orderBy }: any = {}) => {
        const list = Array.from(seatTransferRequests.values());
        if (orderBy?.requestNumber === 'desc') {
          list.sort((a, b) => (b.requestNumber || '').localeCompare(a.requestNumber || ''));
        }
        for (const req of list) {
          if (where?.id && req.id !== where.id) continue;
          if (where?.requestNumber) {
            if (typeof where.requestNumber === 'string' && req.requestNumber !== where.requestNumber) continue;
            if (where.requestNumber.startsWith && !req.requestNumber?.startsWith(where.requestNumber.startsWith)) continue;
          }
          if (where?.employeeId && req.employeeId !== where.employeeId) continue;
          if (where?.targetSeatId && req.targetSeatId !== where.targetSeatId) continue;
          if (where?.status) {
            if (typeof where.status === 'string' && req.status !== where.status) continue;
            if (where.status.in && Array.isArray(where.status.in) && !where.status.in.includes(req.status)) continue;
          }
          const res = { ...req };
          if (include?.employee) {
            const emp = employees.get(req.employeeId);
            res.employee = emp ? {
              ...emp,
              department: departments.get(emp.departmentId) || null
            } : null;
          }
          return res;
        }
        return null;
      },
      create: async ({ data, include }: any) => {
        const id = data.id || randomUUID();
        const record = {
          ...data,
          id,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        seatTransferRequests.set(id, record);
        if (include?.employee) {
          const emp = employees.get(record.employeeId);
          return {
            ...record,
            employee: emp ? {
              ...emp,
              department: departments.get(emp.departmentId) || null
            } : null
          };
        }
        return record;
      },
      update: async ({ where, data, include }: any) => {
        const existing = seatTransferRequests.get(where.id);
        if (!existing) throw new Error('SeatTransferRequest not found');
        const cleanData: any = {};
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && (value as any).unset === true) {
            cleanData[key] = null;
          } else if (value !== undefined) cleanData[key] = value;
        }
        const updated = { ...existing, ...cleanData, updatedAt: new Date() };
        seatTransferRequests.set(where.id, updated);
        if (include?.employee) {
          const emp = employees.get(updated.employeeId);
          return {
            ...updated,
            employee: emp ? {
              ...emp,
              department: departments.get(emp.departmentId) || null
            } : null
          };
        }
        return updated;
      },
      updateMany: async ({ where, data }: any = {}) => {
        let count = 0;
        const cleanData: any = {};
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === 'object' && (value as any).unset === true) {
            cleanData[key] = null;
          } else if (value !== undefined) cleanData[key] = value;
        }
        for (const [id, req] of Array.from(seatTransferRequests.entries())) {
          let match = true;
          if (where?.employeeId && req.employeeId !== where.employeeId) match = false;
          if (where?.targetSeatId && req.targetSeatId !== where.targetSeatId) match = false;
          if (where?.status) {
            if (typeof where.status === 'string' && req.status !== where.status) match = false;
            if (where.status.in && Array.isArray(where.status.in) && !where.status.in.includes(req.status)) match = false;
          }
          if (match) {
            seatTransferRequests.set(id, { ...req, ...cleanData, updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      },
      delete: async ({ where }: any) => {
        const existing = seatTransferRequests.get(where.id);
        if (!existing) throw new Error('SeatTransferRequest not found');
        seatTransferRequests.delete(where.id);
        return existing;
      },
      deleteMany: async ({ where }: any = {}) => {
        let count = 0;
        if (!where || Object.keys(where).length === 0) {
          count = seatTransferRequests.size;
          seatTransferRequests.clear();
          return { count };
        }
        for (const [id, r] of Array.from(seatTransferRequests.entries())) {
          let match = true;
          if (where.employeeId && r.employeeId !== where.employeeId) match = false;
          if (match) {
            seatTransferRequests.delete(id);
            count++;
          }
        }
        return { count };
      }
    },

    notification: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(notifications.values());
        if (where?.recipientAdminId) list = list.filter((n) => n.recipientAdminId === where.recipientAdminId);
        if (where?.transferRequestId) {
          if (typeof where.transferRequestId === 'string') {
            list = list.filter((n) => n.transferRequestId === where.transferRequestId);
          } else if (where.transferRequestId?.in && Array.isArray(where.transferRequestId.in)) {
            list = list.filter((n) => where.transferRequestId.in.includes(n.transferRequestId));
          }
        }
        if (where?.type) {
          if (typeof where.type === 'string') {
            list = list.filter((n) => n.type === where.type);
          } else if (where.type?.in && Array.isArray(where.type.in)) {
            list = list.filter((n) => where.type.in.includes(n.type));
          }
        }
        if (where?.readAt === null || where?.OR?.some((clause: any) => clause?.readAt === null || clause?.readAt?.isSet === false)) {
          list = list.filter((n) => n.readAt === null || n.readAt === undefined);
        }
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(notifications.values());
        if (args.where?.recipientAdminId) list = list.filter((n) => n.recipientAdminId === args.where.recipientAdminId);
        if (args.where?.transferRequestId) {
          if (typeof args.where.transferRequestId === 'string') {
            list = list.filter((n) => n.transferRequestId === args.where.transferRequestId);
          } else if (args.where.transferRequestId?.in && Array.isArray(args.where.transferRequestId.in)) {
            list = list.filter((n) => args.where.transferRequestId.in.includes(n.transferRequestId));
          }
        }
        if (args.where?.type) {
          if (typeof args.where.type === 'string') {
            list = list.filter((n) => n.type === args.where.type);
          } else if (args.where.type?.in && Array.isArray(args.where.type.in)) {
            list = list.filter((n) => args.where.type.in.includes(n.type));
          }
        }
        if (args.where?.readAt === null || args.where?.OR?.some((clause: any) => clause?.readAt === null || clause?.readAt?.isSet === false)) {
          list = list.filter((n) => n.readAt === null || n.readAt === undefined);
        }
        list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const skip = args.skip || 0;
        const take = args.take || list.length;
        return list.slice(skip, skip + take).map((n) => ({
          ...n,
          transferRequest: n.transferRequestId
            ? (() => {
                const request = seatTransferRequests.get(n.transferRequestId);
                return request ? { id: request.id, requestNumber: request.requestNumber, status: request.status } : null;
              })()
            : null
        }));
      },
      findUnique: async ({ where }: any) => notifications.get(where.id) || null,
      upsert: async ({ where, update, create }: any) => {
        const existing = Array.from(notifications.values()).find((n) => n.dedupeKey === where.dedupeKey);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const id = create.id || randomUUID();
        const record = { ...create, id, readAt: create.readAt ?? null, createdAt: new Date() };
        notifications.set(id, record);
        return record;
      },
      updateMany: async ({ where, data }: any = {}) => {
        let count = 0;
        for (const [id, notification] of notifications.entries()) {
          if (where?.id && notification.id !== where.id) continue;
          if (where?.recipientAdminId && notification.recipientAdminId !== where.recipientAdminId) continue;
          if (where?.transferRequestId) {
            if (typeof where.transferRequestId === 'string' && notification.transferRequestId !== where.transferRequestId) {
              continue;
            } else if (where.transferRequestId?.in && Array.isArray(where.transferRequestId.in) && !where.transferRequestId.in.includes(notification.transferRequestId)) {
              continue;
            }
          }
          if (where?.type) {
            if (typeof where.type === 'string' && notification.type !== where.type) {
              continue;
            } else if (where.type?.in && Array.isArray(where.type.in) && !where.type.in.includes(notification.type)) {
              continue;
            }
          }
          if ((where?.readAt === null || where?.OR?.some((clause: any) => clause?.readAt === null || clause?.readAt?.isSet === false)) && notification.readAt !== null && notification.readAt !== undefined) continue;
          notifications.set(id, { ...notification, ...data });
          count++;
        }
        return { count };
      }
    },

    area: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(areas.values());
        if (where?.floorId) list = list.filter((a) => a.floorId === where.floorId);
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(areas.values());
        if (args.where?.isActive !== undefined) {
          list = list.filter((a) => (a.isActive ?? true) === args.where.isActive);
        }
        if (args.where?.floorId) {
          list = list.filter((a) => Array.isArray(args.where.floorId.in)
            ? args.where.floorId.in.includes(a.floorId)
            : a.floorId === args.where.floorId);
        }
        if (args.where?.floor?.building?.plant?.unitId) {
          const targetUnitId = args.where.floor.building.plant.unitId;
          list = list.filter((a) => {
            const fl = floors.get(a.floorId);
            const b = fl ? buildings.get(fl.buildingId) : null;
            const p = b ? plants.get(b.plantId) : null;
            return p && p.unitId === targetUnitId;
          });
        }
        return list.map((a) => {
          const fl = floors.get(a.floorId);
          const b = fl ? buildings.get(fl.buildingId) : null;
          return {
            ...a,
            ...(args.include?.floor ? { floor: fl ? { ...fl, building: b || null } : null } : {}),
            ...(args.include?._count ? { _count: { seats: Array.from(seats.values()).filter((s) => s.areaId === a.id).length } } : {})
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      },
      findUnique: async ({ where, include }: any) => {
        const record = where.id ? areas.get(where.id) : null;
        if (!record) return null;
        return {
          ...record,
          ...(include?._count ? { _count: { seats: Array.from(seats.values()).filter((s) => s.areaId === record.id).length } } : {})
        };
      },
      create: async ({ data }: any) => {
        for (const a of areas.values()) {
          if (a.floorId === data.floorId && a.normalizedName === data.normalizedName) {
            throwP2002(['floorId', 'normalizedName']);
          }
        }
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        areas.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = areas.get(where.id);
        if (!existing) throw new Error('Area not found');
        const nextNorm = data.normalizedName ?? existing.normalizedName;
        for (const a of areas.values()) {
          if (a.id !== where.id && a.floorId === existing.floorId && a.normalizedName === nextNorm) {
            throwP2002(['floorId', 'normalizedName']);
          }
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        areas.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: any) => {
        const existing = areas.get(where.id);
        if (!existing) throw new Error('Area not found');
        areas.delete(where.id);
        return existing;
      }
    },

    section: {
      count: async ({ where }: any = {}) => {
        let list = Array.from(sections.values());
        if (where?.departmentId) list = list.filter((s) => s.departmentId === where.departmentId);
        return list.length;
      },
      findMany: async (args: any = {}) => {
        let list = Array.from(sections.values());
        if (args.where?.isActive !== undefined) {
          list = list.filter((s) => (s.isActive ?? true) === args.where.isActive);
        }
        if (args.where?.departmentId) {
          list = list.filter((s) => Array.isArray(args.where.departmentId.in)
            ? args.where.departmentId.in.includes(s.departmentId)
            : s.departmentId === args.where.departmentId);
        }
        if (args.where?.department?.unitId) {
          const targetUnitId = args.where.department.unitId;
          list = list.filter((s) => {
            const d = departments.get(s.departmentId);
            return d && d.unitId === targetUnitId;
          });
        }
        return list.map((s) => ({
          ...s,
          ...(args.include?.department ? { department: departments.get(s.departmentId) || null } : {}),
          ...(args.include?._count ? {
            _count: {
              employees: Array.from(employees.values()).filter((e) => e.sectionId === s.id).length,
              functions: Array.from(orgFunctions.values()).filter((fn) => fn.sectionId === s.id).length
            }
          } : {})
        })).sort((a, b) => a.name.localeCompare(b.name));
      },
      findUnique: async ({ where, include }: any) => {
        const record = where.id ? sections.get(where.id) : null;
        if (!record) return null;
        return {
          ...record,
          ...(include?.department ? { department: departments.get(record.departmentId) || null } : {}),
          ...(include?._count ? {
            _count: {
              employees: Array.from(employees.values()).filter((e) => e.sectionId === record.id).length,
              functions: Array.from(orgFunctions.values()).filter((fn) => fn.sectionId === record.id).length
            }
          } : {})
        };
      },
      create: async ({ data }: any) => {
        for (const s of sections.values()) {
          if (s.departmentId === data.departmentId && s.normalizedName === data.normalizedName) {
            throwP2002(['departmentId', 'normalizedName']);
          }
        }
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        sections.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = sections.get(where.id);
        if (!existing) throw new Error('Section not found');
        const nextNorm = data.normalizedName ?? existing.normalizedName;
        for (const s of sections.values()) {
          if (s.id !== where.id && s.departmentId === existing.departmentId && s.normalizedName === nextNorm) {
            throwP2002(['departmentId', 'normalizedName']);
          }
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        sections.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: any) => {
        const existing = sections.get(where.id);
        if (!existing) throw new Error('Section not found');
        sections.delete(where.id);
        return existing;
      }
    },

    orgFunction: {
      findMany: async (args: any = {}) => {
        let list = Array.from(orgFunctions.values());
        if (args.where?.isActive !== undefined) {
          list = list.filter((fn) => (fn.isActive ?? true) === args.where.isActive);
        }
        if (args.where?.sectionId) {
          list = list.filter((fn) => Array.isArray(args.where.sectionId.in)
            ? args.where.sectionId.in.includes(fn.sectionId)
            : fn.sectionId === args.where.sectionId);
        }
        if (args.where?.section?.departmentId) {
          const targetDeptId = args.where.section.departmentId;
          list = list.filter((fn) => {
            const sec = sections.get(fn.sectionId);
            return sec && sec.departmentId === targetDeptId;
          });
        }
        if (args.where?.section?.department?.unitId) {
          const targetUnitId = args.where.section.department.unitId;
          list = list.filter((fn) => {
            const sec = sections.get(fn.sectionId);
            const d = sec ? departments.get(sec.departmentId) : null;
            return d && d.unitId === targetUnitId;
          });
        }
        return list.map((fn) => {
          const sec = sections.get(fn.sectionId);
          return {
            ...fn,
            ...(args.include?.section ? { section: sec ? { ...sec, department: departments.get(sec.departmentId) || null } : null } : {}),
            ...(args.include?._count ? { _count: { employees: Array.from(employees.values()).filter((e) => e.functionId === fn.id).length } } : {})
          };
        }).sort((a, b) => a.name.localeCompare(b.name));
      },
      findUnique: async ({ where, include, select }: any) => {
        const record = where.id ? orgFunctions.get(where.id) : null;
        if (!record) return null;
        const sec = sections.get(record.sectionId);
        return {
          ...record,
          ...(include?.section ? { section: sec ? { ...sec, department: departments.get(sec.departmentId) || null } : null } : {}),
          ...(select?.section ? { section: sec ? { name: sec.name } : null } : {}),
          ...(include?._count ? { _count: { employees: Array.from(employees.values()).filter((e) => e.functionId === record.id).length } } : {})
        };
      },
      create: async ({ data }: any) => {
        for (const fn of orgFunctions.values()) {
          if (fn.sectionId === data.sectionId && fn.normalizedName === data.normalizedName) {
            throwP2002(['sectionId', 'normalizedName']);
          }
        }
        const id = data.id || randomUUID();
        const record = { isActive: true, ...data, id, createdAt: new Date(), updatedAt: new Date() };
        orgFunctions.set(id, record);
        return record;
      },
      update: async ({ where, data }: any) => {
        const existing = orgFunctions.get(where.id);
        if (!existing) throw new Error('Function not found');
        const nextNorm = data.normalizedName ?? existing.normalizedName;
        for (const fn of orgFunctions.values()) {
          if (fn.id !== where.id && fn.sectionId === existing.sectionId && fn.normalizedName === nextNorm) {
            throwP2002(['sectionId', 'normalizedName']);
          }
        }
        const updated = { ...existing, ...data, updatedAt: new Date() };
        orgFunctions.set(where.id, updated);
        return updated;
      },
      delete: async ({ where }: any) => {
        const existing = orgFunctions.get(where.id);
        if (!existing) throw new Error('Function not found');
        orgFunctions.delete(where.id);
        return existing;
      }
    },

    $runCommandRaw: async () => ({ cursor: { firstBatch: [] } }),

    $transaction: async (arg: any) => {
      if (typeof arg === 'function') {
        let release!: () => void;
        const previous = transactionTail;
        transactionTail = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;

        const collections = [adminUsers, units, plants, offices, buildings, floors, departments, areas, sections, orgFunctions, employees, seats, auditLogs, seatTransferRequests, notifications];
        const snapshots = collections.map((collection) => structuredClone(Array.from(collection.entries())));
        try {
          return await arg(client);
        } catch (error) {
          collections.forEach((collection, index) => {
            collection.clear();
            for (const [id, value] of snapshots[index]) collection.set(id, value);
          });
          throw error;
        } finally {
          release();
        }
      }
      return Promise.all(arg);
    },

    $disconnect: async () => {}
  };

  return client as PrismaClient;
}
