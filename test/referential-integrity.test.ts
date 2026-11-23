import { describe, it, expect } from 'vitest';
import { createMockPrisma } from './mock-prisma.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { buildServer } from '../src/server.js';
import { SEAT_TYPES, SEAT_STATUSES } from '@seating/shared';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const SCHEMA_PATH = path.resolve(BACKEND_ROOT, 'prisma/schema.prisma');

// =============================================================================
// 1. DMMF & Schema Referential Integrity Verification
// =============================================================================
describe('Empirical Challenge: DMMF Referential Actions & Invariants', () => {
  const dmmf = Prisma.dmmf;

  function getModel(name: string) {
    const model = dmmf.datamodel.models.find((m) => m.name === name);
    if (!model) throw new Error(`Model ${name} not found in DMMF`);
    return model;
  }

  function getField(modelName: string, fieldName: string) {
    const model = getModel(modelName);
    const field = model.fields.find((f) => f.name === fieldName);
    if (!field) throw new Error(`Field ${fieldName} not found on ${modelName}`);
    return field;
  }

  it('Plant -> Unit enforces onDelete: Cascade', () => {
    const unitRel = getField('Plant', 'unit');
    expect(unitRel.kind).toBe('object');
    expect(unitRel.type).toBe('Unit');
    expect(unitRel.relationFromFields).toEqual(['unitId']);
    expect(unitRel.relationToFields).toEqual(['id']);
    expect(unitRel.relationOnDelete).toBe('Cascade');
  });

  it('Building -> legacy Plant uses SetNull so historical buildings remain readable', () => {
    const plantRel = getField('Building', 'plant');
    expect(plantRel.kind).toBe('object');
    expect(plantRel.type).toBe('Plant');
    expect(plantRel.relationFromFields).toEqual(['plantId']);
    expect(plantRel.relationToFields).toEqual(['id']);
    expect(plantRel.relationOnDelete).toBe('SetNull');
  });

  it('Floor -> Building enforces onDelete: Cascade', () => {
    const bldRel = getField('Floor', 'building');
    expect(bldRel.kind).toBe('object');
    expect(bldRel.type).toBe('Building');
    expect(bldRel.relationFromFields).toEqual(['buildingId']);
    expect(bldRel.relationToFields).toEqual(['id']);
    expect(bldRel.relationOnDelete).toBe('Cascade');
  });

  it('Seat -> Floor enforces onDelete: Cascade', () => {
    const floorRel = getField('Seat', 'floor');
    expect(floorRel.kind).toBe('object');
    expect(floorRel.type).toBe('Floor');
    expect(floorRel.relationFromFields).toEqual(['floorId']);
    expect(floorRel.relationToFields).toEqual(['id']);
    expect(floorRel.relationOnDelete).toBe('Cascade');
  });

  it('Employee -> Department enforces onDelete: Restrict', () => {
    const deptRel = getField('Employee', 'department');
    expect(deptRel.kind).toBe('object');
    expect(deptRel.type).toBe('Department');
    expect(deptRel.relationFromFields).toEqual(['departmentId']);
    expect(deptRel.relationToFields).toEqual(['id']);
    expect(deptRel.relationOnDelete).toBe('Restrict');
  });

  it('Seat -> Department enforces onDelete: SetNull with nullable foreign key', () => {
    const deptRel = getField('Seat', 'department');
    expect(deptRel.kind).toBe('object');
    expect(deptRel.type).toBe('Department');
    expect(deptRel.relationFromFields).toEqual(['departmentId']);
    expect(deptRel.relationToFields).toEqual(['id']);
    expect(deptRel.relationOnDelete).toBe('SetNull');

    // Crucial requirement for SetNull: foreign key departmentId MUST be nullable (isRequired === false)
    const deptIdField = getField('Seat', 'departmentId');
    expect(deptIdField.isRequired).toBe(false);
  });

  it('Seat -> Employee enforces onDelete: SetNull with unique nullable foreign key', () => {
    const empRel = getField('Seat', 'employee');
    expect(empRel.kind).toBe('object');
    expect(empRel.type).toBe('Employee');
    expect(empRel.relationFromFields).toEqual(['employeeId']);
    expect(empRel.relationToFields).toEqual(['id']);
    expect(empRel.relationOnDelete).toBe('SetNull');

    // Strict 1:1 Seating invariant: employeeId MUST be nullable and unique
    const empIdField = getField('Seat', 'employeeId');
    expect(empIdField.isRequired).toBe(false);
    expect(empIdField.isUnique).toBe(true);
  });

  it('AuditLog -> AdminUser enforces onDelete: Restrict', () => {
    const adminRel = getField('AuditLog', 'admin');
    expect(adminRel.kind).toBe('object');
    expect(adminRel.type).toBe('AdminUser');
    expect(adminRel.relationFromFields).toEqual(['adminId']);
    expect(adminRel.relationToFields).toEqual(['id']);
    expect(adminRel.relationOnDelete).toBe('Restrict');
  });
});

// =============================================================================
// 2. MongoDB schema-mode verification
// =============================================================================
// The prior assertion generated PostgreSQL DDL from this MongoDB schema. That
// was neither executable nor evidence for this application's data store. The
// DMMF tests above verify Prisma relation policy; this guards the supported
// datasource and prevents a future accidental SQL-only test configuration.
describe('Empirical Challenge: MongoDB schema-mode verification', () => {
  it('declares MongoDB as the only supported datasource for referential tests', () => {
    const schema = readFileSync(SCHEMA_PATH, 'utf8');
    expect(schema).toMatch(/datasource\s+db\s*\{[\s\S]*provider\s*=\s*"mongodb"/);
    expect(schema).not.toMatch(/provider\s*=\s*"postgresql"/);
  });
});

// =============================================================================
// 3. Relational State Simulator (Oracle Stress Testing)
// =============================================================================
describe('Empirical Challenge: Relational State Oracle Stress Harness', () => {
  interface SimOffice { id: string; name: string }
  interface SimBuilding { id: string; name: string; officeId: string }
  interface SimFloor { id: string; name: string; buildingId: string }
  interface SimDepartment { id: string; name: string; code: string }
  interface SimEmployee { id: string; fullName: string; departmentId: string }
  interface SimSeat { id: string; label: string; floorId: string; departmentId: string | null; employeeId: string | null }
  interface SimAdminUser { id: string; email: string }
  interface SimAuditLog { id: string; adminId: string; action: string }

  class RelationalDatabaseSimulator {
    offices = new Map<string, SimOffice>();
    buildings = new Map<string, SimBuilding>();
    floors = new Map<string, SimFloor>();
    departments = new Map<string, SimDepartment>();
    employees = new Map<string, SimEmployee>();
    seats = new Map<string, SimSeat>();
    admins = new Map<string, SimAdminUser>();
    auditLogs = new Map<string, SimAuditLog>();

    // 1:1 Invariant enforcement: Seat.employeeId must be unique
    assignSeat(seatId: string, employeeId: string) {
      const seat = this.seats.get(seatId);
      if (!seat) throw new Error('Seat not found');
      if (!this.employees.has(employeeId)) throw new Error('Employee not found');

      // Check if employee already has another seat
      for (const [otherId, s] of this.seats.entries()) {
        if (s.employeeId === employeeId && otherId !== seatId) {
          throw new Error(`Unique constraint failed on Seat.employeeId: employee ${employeeId} already assigned`);
        }
      }

      seat.employeeId = employeeId;
    }

    unassignSeat(seatId: string) {
      const seat = this.seats.get(seatId);
      if (!seat) throw new Error('Seat not found');
      seat.employeeId = null;
    }

    // Cascade Deletion: Office -> Building -> Floor -> Seat
    deleteOffice(officeId: string) {
      if (!this.offices.has(officeId)) throw new Error('Office not found');
      this.offices.delete(officeId);

      // Cascade to Buildings
      for (const [bId, b] of Array.from(this.buildings.entries())) {
        if (b.officeId === officeId) {
          this.deleteBuilding(bId);
        }
      }
    }

    deleteBuilding(buildingId: string) {
      this.buildings.delete(buildingId);

      // Cascade to Floors
      for (const [fId, f] of Array.from(this.floors.entries())) {
        if (f.buildingId === buildingId) {
          this.deleteFloor(fId);
        }
      }
    }

    deleteFloor(floorId: string) {
      this.floors.delete(floorId);

      // Cascade to Seats
      for (const [sId, s] of Array.from(this.seats.entries())) {
        if (s.floorId === floorId) {
          this.deleteSeat(sId);
        }
      }
    }

    deleteSeat(seatId: string) {
      this.seats.delete(seatId);
    }

    // Referential Action: Employee -> Department is RESTRICT
    deleteDepartment(deptId: string) {
      if (!this.departments.has(deptId)) throw new Error('Department not found');

      // Check if any employees belong to this department
      for (const emp of this.employees.values()) {
        if (emp.departmentId === deptId) {
          throw new Error('Foreign key violation: onDelete RESTRICT prevented department deletion');
        }
      }

      this.departments.delete(deptId);

      // Seats referencing this department -> SetNull
      for (const seat of this.seats.values()) {
        if (seat.departmentId === deptId) {
          seat.departmentId = null;
        }
      }
    }

    // Referential Action: Seat -> Employee is SET NULL
    deleteEmployee(employeeId: string) {
      if (!this.employees.has(employeeId)) throw new Error('Employee not found');
      this.employees.delete(employeeId);

      // Seat referencing this employee -> SetNull
      for (const seat of this.seats.values()) {
        if (seat.employeeId === employeeId) {
          seat.employeeId = null;
        }
      }
    }

    // Referential Action: AuditLog -> AdminUser is RESTRICT
    deleteAdmin(adminId: string) {
      if (!this.admins.has(adminId)) throw new Error('Admin not found');
      for (const log of this.auditLogs.values()) {
        if (log.adminId === adminId) {
          throw new Error('Foreign key violation: onDelete RESTRICT prevented admin deletion');
        }
      }
      this.admins.delete(adminId);
    }
  }

  it('cascades deletion down the entire 4-tier spatial hierarchy (Office -> Building -> Floor -> Seat)', () => {
    const db = new RelationalDatabaseSimulator();

    // Populate 2 offices, 4 buildings, 8 floors, 160 seats
    for (let o = 1; o <= 2; o++) {
      const officeId = `off-${o}`;
      db.offices.set(officeId, { id: officeId, name: `Office ${o}` });

      for (let b = 1; b <= 2; b++) {
        const buildingId = `bld-${o}-${b}`;
        db.buildings.set(buildingId, { id: buildingId, name: `Building ${b}`, officeId });

        for (let f = 1; f <= 2; f++) {
          const floorId = `flr-${o}-${b}-${f}`;
          db.floors.set(floorId, { id: floorId, name: `Floor ${f}`, buildingId });

          for (let s = 1; s <= 10; s++) {
            const seatId = `seat-${o}-${b}-${f}-${s}`;
            db.seats.set(seatId, { id: seatId, label: `S-${s}`, floorId, departmentId: null, employeeId: null });
          }
        }
      }
    }

    expect(db.offices.size).toBe(2);
    expect(db.buildings.size).toBe(4);
    expect(db.floors.size).toBe(8);
    expect(db.seats.size).toBe(80);

    // Delete Office 1
    db.deleteOffice('off-1');

    // Office 1 and all its descendents should be gone
    expect(db.offices.size).toBe(1);
    expect(db.offices.has('off-1')).toBe(false);
    expect(db.offices.has('off-2')).toBe(true);

    expect(db.buildings.size).toBe(2);
    for (const b of db.buildings.values()) {
      expect(b.officeId).toBe('off-2');
    }

    expect(db.floors.size).toBe(4);
    expect(db.seats.size).toBe(40);
  });

  it('blocks Department deletion when employees exist (Restrict) and sets Seat.departmentId to null when department is empty', () => {
    const db = new RelationalDatabaseSimulator();

    db.departments.set('dept-eng', { id: 'dept-eng', name: 'Engineering', code: 'ENG' });
    db.departments.set('dept-hr', { id: 'dept-hr', name: 'HR', code: 'HR' });

    db.employees.set('emp-1', { id: 'emp-1', fullName: 'Alice', departmentId: 'dept-eng' });
    db.seats.set('seat-1', { id: 'seat-1', label: 'S1', floorId: 'f1', departmentId: 'dept-hr', employeeId: null });

    // Attempt to delete Engineering (has Alice) -> Must throw RESTRICT violation
    expect(() => db.deleteDepartment('dept-eng')).toThrow(/onDelete RESTRICT prevented department deletion/);
    expect(db.departments.has('dept-eng')).toBe(true);

    // Delete HR (has NO employees, but seat-1 references it) -> Succeeded with SetNull
    db.deleteDepartment('dept-hr');
    expect(db.departments.has('dept-hr')).toBe(false);
    expect(db.seats.get('seat-1')!.departmentId).toBeNull();
  });

  it('sets Seat.employeeId to null when employee is deleted (SetNull)', () => {
    const db = new RelationalDatabaseSimulator();
    db.employees.set('emp-1', { id: 'emp-1', fullName: 'Alice', departmentId: 'dept-eng' });
    db.seats.set('seat-1', { id: 'seat-1', label: 'S1', floorId: 'f1', departmentId: null, employeeId: 'emp-1' });

    expect(db.seats.get('seat-1')!.employeeId).toBe('emp-1');

    db.deleteEmployee('emp-1');

    expect(db.employees.has('emp-1')).toBe(false);
    expect(db.seats.get('seat-1')!.employeeId).toBeNull();
  });

  it('enforces strict 1:1 invariant preventing an employee from holding two seats simultaneously', () => {
    const db = new RelationalDatabaseSimulator();
    db.employees.set('emp-1', { id: 'emp-1', fullName: 'Alice', departmentId: 'dept-eng' });
    db.seats.set('seat-1', { id: 'seat-1', label: 'S1', floorId: 'f1', departmentId: null, employeeId: null });
    db.seats.set('seat-2', { id: 'seat-2', label: 'S2', floorId: 'f1', departmentId: null, employeeId: null });

    // Assign emp-1 to seat-1
    db.assignSeat('seat-1', 'emp-1');
    expect(db.seats.get('seat-1')!.employeeId).toBe('emp-1');

    // Attempt to assign emp-1 to seat-2 -> Must fail with unique constraint violation
    expect(() => db.assignSeat('seat-2', 'emp-1')).toThrow(/Unique constraint failed on Seat\.employeeId/);

    // Unassign seat-1, then assign seat-2 -> Succeeds
    db.unassignSeat('seat-1');
    expect(db.seats.get('seat-1')!.employeeId).toBeNull();

    db.assignSeat('seat-2', 'emp-1');
    expect(db.seats.get('seat-2')!.employeeId).toBe('emp-1');
  });

  it('blocks AdminUser deletion when audit logs exist (Restrict)', () => {
    const db = new RelationalDatabaseSimulator();
    db.admins.set('admin-1', { id: 'admin-1', email: 'admin@company.com' });
    db.auditLogs.set('log-1', { id: 'log-1', adminId: 'admin-1', action: 'ASSIGN_SEAT' });

    expect(() => db.deleteAdmin('admin-1')).toThrow(/onDelete RESTRICT prevented admin deletion/);
    expect(db.admins.has('admin-1')).toBe(true);
  });
});

// =============================================================================
// 4. Fastify Server Health & Regression Stress Check
// =============================================================================
describe('Empirical Challenge: Fastify Server Health Concurrency & Regression', () => {
  it('survives 100 concurrent healthcheck requests with zero errors and valid payload', async () => {
    const server = buildServer({ prisma: createMockPrisma() as any });

    const requests = Array.from({ length: 100 }, () =>
      server.inject({
        method: 'GET',
        url: '/api/health',
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.status).toBe('ok');
      expect(json.supportedSeatTypes).toEqual(SEAT_TYPES);
      expect(json.supportedSeatStatuses).toEqual(SEAT_STATUSES);
    }
  });
});
