import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Adversarial M2 Verification: Rigorous Empirical Stress Harness', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  let unit1: any;
  let unit2: any;
  let plantU1: any;
  let buildingU1: any;
  let floor1U1: any;
  let floor2U1: any;
  let floor1U2: any;

  let getCookie: (email: string) => Promise<string>;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    getCookie = async (email: string) => {
      const password = email === DEFAULT_ADMIN.email ? DEFAULT_ADMIN.password : DEMO_PASSWORD;
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password }
      });
      expect(res.statusCode).toBe(200);
      return res.headers['set-cookie'] as string;
    };

    const units = await mockPrisma.unit.findMany();
    unit1 = units.find((u: any) => u.code === 'UNIT-1');
    unit2 = units.find((u: any) => u.code === 'UNIT-2');

    plantU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Assembly Plant', code: 'PLT-U1-ADV', unitId: unit1.id }
    });
    buildingU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Tech Tower', code: 'BLD-U1-ADV', plantId: plantU1.id }
    });
    floor1U1 = await mockPrisma.floor.create({
      data: { name: 'Floor 1', floorNumber: 1, buildingId: buildingU1.id }
    });
    floor2U1 = await mockPrisma.floor.create({
      data: { name: 'Floor 2', floorNumber: 2, buildingId: buildingU1.id }
    });

    const unit2Plant = (await mockPrisma.plant.findMany({ where: { unitId: unit2.id } }))[0];
    const unit2Building = (await mockPrisma.building.findMany({ where: { plantId: unit2Plant.id } }))[0];
    floor1U2 = (await mockPrisma.floor.findMany({ where: { buildingId: unit2Building.id } }))[0];
  });

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // 1. FLOOR-WISE DEPARTMENT FILTER & SCOPE EMPIRICAL TESTS (Issue 2.5)
  // =========================================================================
  describe('Floor-Wise Department Filter & Multi-Floor Seat Scoping', () => {
    it('Floor query accurately filters departments and strictly scopes seat and occupied counts', async () => {
      const cookie = await getCookie('superadmin@shaktiman.com');

      // Department A: has seats on Floor 1 AND Floor 2
      const deptA = await mockPrisma.department.create({
        data: { name: 'Adv Dept A (Multi-floor)', code: 'ADV-A', unitId: unit1.id, colorHex: '#10B981' }
      });
      // Department B: has seats ONLY on Floor 2
      const deptB = await mockPrisma.department.create({
        data: { name: 'Adv Dept B (Floor 2 only)', code: 'ADV-B', unitId: unit1.id, colorHex: '#EF4444' }
      });
      // Department C: has 0 seats, but floorId set directly on department
      const deptC = await mockPrisma.department.create({
        data: { name: 'Adv Dept C (Floor 1 anchored)', code: 'ADV-C', unitId: unit1.id, floorId: floor1U1.id, colorHex: '#F59E0B' }
      });
      // Department D: has 0 seats anywhere, unit department
      const deptD = await mockPrisma.department.create({
        data: { name: 'Adv Dept D (Empty Unit Dept)', code: 'ADV-D', unitId: unit1.id, colorHex: '#6B7280' }
      });

      // Employee for occupied seats
      const emp1 = await mockPrisma.employee.create({
        data: { fullName: 'Emp 1', employeeCode: 'EMP-F1-1', email: 'emp1@f1.com', departmentId: deptA.id }
      });
      const emp2 = await mockPrisma.employee.create({
        data: { fullName: 'Emp 2', employeeCode: 'EMP-F1-2', email: 'emp2@f1.com', departmentId: deptA.id }
      });
      const emp3 = await mockPrisma.employee.create({
        data: { fullName: 'Emp 3', employeeCode: 'EMP-F2-3', email: 'emp3@f2.com', departmentId: deptB.id }
      });

      // Floor 1 Seats for Dept A: 3 total (2 occupied, 1 available)
      await mockPrisma.seat.create({
        data: { label: 'F1-A-1', floorId: floor1U1.id, departmentId: deptA.id, employeeId: emp1.id, status: 'AVAILABLE' }
      });
      await mockPrisma.seat.create({
        data: { label: 'F1-A-2', floorId: floor1U1.id, departmentId: deptA.id, employeeId: emp2.id, status: 'AVAILABLE' }
      });
      await mockPrisma.seat.create({
        data: { label: 'F1-A-3', floorId: floor1U1.id, departmentId: deptA.id, employeeId: null, status: 'AVAILABLE' }
      });

      // Floor 2 Seats for Dept A: 4 total (0 occupied)
      for (let i = 1; i <= 4; i++) {
        await mockPrisma.seat.create({
          data: { label: `F2-A-${i}`, floorId: floor2U1.id, departmentId: deptA.id, employeeId: null, status: 'AVAILABLE' }
        });
      }

      // Floor 2 Seats for Dept B: 2 total (1 occupied)
      await mockPrisma.seat.create({
        data: { label: 'F2-B-1', floorId: floor2U1.id, departmentId: deptB.id, employeeId: emp3.id, status: 'AVAILABLE' }
      });
      await mockPrisma.seat.create({
        data: { label: 'F2-B-2', floorId: floor2U1.id, departmentId: deptB.id, employeeId: null, status: 'AVAILABLE' }
      });

      // 1. Query Floor 1
      const resF1 = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floor1U1.id}`,
        headers: { cookie }
      });
      expect(resF1.statusCode).toBe(200);
      const listF1 = JSON.parse(resF1.body);

      // Dept A MUST be present on Floor 1
      const foundA1 = listF1.find((d: any) => d.id === deptA.id);
      expect(foundA1).toBeDefined();
      expect(foundA1.floorAllocatedSeats).toBe(3);
      expect(foundA1.floorOccupiedSeats).toBe(2);
      expect(foundA1._count.seats).toBe(3);
      expect(foundA1._count.employees).toBe(2);

      // Dept B MUST NOT be present on Floor 1
      const foundB1 = listF1.find((d: any) => d.id === deptB.id);
      expect(foundB1).toBeUndefined();

      // Dept C MUST be present on Floor 1 (anchored floorId) with 0 seats
      const foundC1 = listF1.find((d: any) => d.id === deptC.id);
      expect(foundC1).toBeDefined();
      expect(foundC1.floorAllocatedSeats).toBe(0);
      expect(foundC1.floorOccupiedSeats).toBe(0);

      // Dept D MUST NOT be present on Floor 1
      const foundD1 = listF1.find((d: any) => d.id === deptD.id);
      expect(foundD1).toBeUndefined();

      // 2. Query Floor 2
      const resF2 = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floor2U1.id}`,
        headers: { cookie }
      });
      expect(resF2.statusCode).toBe(200);
      const listF2 = JSON.parse(resF2.body);

      // Dept A on Floor 2: 4 allocated, 0 occupied
      const foundA2 = listF2.find((d: any) => d.id === deptA.id);
      expect(foundA2).toBeDefined();
      expect(foundA2.floorAllocatedSeats).toBe(4);
      expect(foundA2.floorOccupiedSeats).toBe(0);

      // Dept B on Floor 2: 2 allocated, 1 occupied
      const foundB2 = listF2.find((d: any) => d.id === deptB.id);
      expect(foundB2).toBeDefined();
      expect(foundB2.floorAllocatedSeats).toBe(2);
      expect(foundB2.floorOccupiedSeats).toBe(1);

      // Dept C MUST NOT be present on Floor 2
      const foundC2 = listF2.find((d: any) => d.id === deptC.id);
      expect(foundC2).toBeUndefined();

      // 3. Query Floor 1 with scope=unit
      const resUnit = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floor1U1.id}&scope=unit`,
        headers: { cookie }
      });
      expect(resUnit.statusCode).toBe(200);
      const listUnit = JSON.parse(resUnit.body);

      // All departments in unit1 must be returned
      expect(listUnit.some((d: any) => d.id === deptA.id)).toBe(true);
      expect(listUnit.some((d: any) => d.id === deptB.id)).toBe(true);
      expect(listUnit.some((d: any) => d.id === deptC.id)).toBe(true);
      expect(listUnit.some((d: any) => d.id === deptD.id)).toBe(true);
    });
  });

  // =========================================================================
  // 2. CONCURRENT DUPLICATE TRANSFER REQUESTS ACROSS ALL STAGES (Issue 2.1)
  // =========================================================================
  describe('Concurrent Duplicate Transfer Requests Across Lifecycle', () => {
    it('Blocks duplicate requests for the same employee at PENDING_TARGET_ADMIN', async () => {
      const cookie = await getCookie('unit2.admin@shaktiman.com');

      const sourceDept = await mockPrisma.department.create({
        data: { name: 'Stage Source', code: 'STAGE-SRC', unitId: unit2.id, colorHex: '#2563EB' }
      });

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Adv Emp Stages', employeeCode: 'EMP-STG-1', email: 'emp.stg@company.com', departmentId: sourceDept.id }
      });

      const seat1 = await mockPrisma.seat.create({
        data: { label: 'S1-ADV', floorId: floor1U1.id, status: 'AVAILABLE' }
      });
      const seat2 = await mockPrisma.seat.create({
        data: { label: 'S2-ADV', floorId: floor1U1.id, status: 'AVAILABLE' }
      });
      await mockPrisma.seat.create({
        data: { label: 'SRC-S1-ADV', floorId: floor1U2.id, status: 'AVAILABLE', employeeId: emp.id, departmentId: sourceDept.id }
      });

      // Create request 1 (cross-unit)
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          targetSeatId: seat1.id,
          reason: 'Stage testing'
        }
      });
      expect(res1.statusCode).toBe(201);
      const req1 = JSON.parse(res1.body);
      expect(req1.status).toBe('PENDING_TARGET_ADMIN');
      expect(req1.targetSeatId).toBeNull();

      // Attempt duplicate for same employee
      const dupRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          reason: 'Duplicate at PENDING_TARGET_ADMIN'
        }
      });
      expect(dupRes.statusCode).toBe(409);

      // Once marked APPROVED, employee can submit a new request
      await mockPrisma.seatTransferRequest.update({
        where: { id: req1.id },
        data: { status: 'APPROVED' }
      });

      const allowedRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          targetSeatId: seat2.id,
          reason: 'Allowed after approval'
        }
      });
      expect(allowedRes.statusCode).toBe(201);
    });
  });

  // =========================================================================
  // 3. SEPARATION OF DUTIES ADVERSARIAL CASES (Issue 2.2)
  // =========================================================================
  describe('Separation of Duties Robustness', () => {
    it('Blocks admin self-approval when email matches case-insensitively or with whitespace', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      // Create employee with mixed case email of unit1 admin
      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Admin As Employee',
          employeeCode: 'U1-ADM-EMP',
          email: 'Unit1.Admin@Shaktiman.Com',
          departmentId: (await mockPrisma.department.create({ data: { name: 'SOD Source', code: 'SOD-SRC', unitId: unit2.id, colorHex: '#2563EB' } })).id
        }
      });
      await mockPrisma.seat.create({
        data: { label: 'SOD-SOURCE', floorId: floor1U2.id, status: 'AVAILABLE', employeeId: adminEmp.id, departmentId: adminEmp.departmentId }
      });

      const targetSeat = await mockPrisma.seat.create({
        data: { label: 'S-U1-SOD', floorId: floor1U1.id, status: 'AVAILABLE' }
      });

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: adminEmp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          reason: 'Mixed case email self approval test'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: { action: 'APPROVE', comment: 'Attempting stealth self-approval', assignedTargetSeatId: targetSeat.id }
      });

      expect(approveRes.statusCode).toBe(403);
      expect(JSON.parse(approveRes.body).message).toBe(
        'Separation of duties violation: Cannot approve your own transfer request'
      );
    });
  });

  // =========================================================================
  // 4. HISTORICAL TRANSFER INTEGRITY ON EMPLOYEE DELETE (Issue 2.4)
  // =========================================================================
  describe('Historical Transfer Requests on Employee Delete', () => {
    it('Cancels only active pending requests without overwriting past APPROVED requests', async () => {
      const cookie = await getCookie('superadmin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Emp History Test', employeeCode: 'EMP-HIST-1', email: 'hist@company.com' }
      });

      // 1. Past historical request already APPROVED
      const pastReq = await mockPrisma.seatTransferRequest.create({
        data: {
          requestNumber: 'REQ-PAST-001',
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          status: 'APPROVED'
        }
      });

      // 2. Active pending request
      const activeReq = await mockPrisma.seatTransferRequest.create({
        data: {
          requestNumber: 'REQ-ACT-002',
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          status: 'PENDING_TARGET_ADMIN'
        }
      });

      // Delete employee
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/employees/${emp.id}`,
        headers: { cookie }
      });
      expect(delRes.statusCode).toBe(200);

      // Verify active request is CANCELLED
      const checkActive = await mockPrisma.seatTransferRequest.findUnique({ where: { id: activeReq.id } });
      expect(checkActive.status).toBe('CANCELLED');
      expect(checkActive.rejectionReason).toBe('Employee record was deleted');

      // Verify historical past request remains APPROVED
      const checkPast = await mockPrisma.seatTransferRequest.findUnique({ where: { id: pastReq.id } });
      expect(checkPast.status).toBe('APPROVED');

      // Verify GET /api/transfer-requests still returns both cleanly with 'Deleted Employee'
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/transfer-requests',
        headers: { cookie }
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);

      const foundPast = list.find((r: any) => r.id === pastReq.id);
      expect(foundPast.employee.fullName).toBe('Deleted Employee');

      const foundActive = list.find((r: any) => r.id === activeReq.id);
      expect(foundActive.employee.fullName).toBe('Deleted Employee');
    });
  });

  // =========================================================================
  // 5. CROSS-UNIT DEPARTMENT RESOLUTION BY SISTER CODE (Issue 2.3)
  // =========================================================================
  describe('Cross-Unit Destination Allocation', () => {
    it('Requires the receiving admin to select an existing destination department', async () => {
      const cookie = await getCookie('unit2.admin@shaktiman.com');

      const srcDept = await mockPrisma.department.create({
        data: { name: 'Finance & Operations', code: 'FIN-OPS', unitId: unit2.id, colorHex: '#3B82F6' }
      });

      const targetDept = await mockPrisma.department.create({
        data: { name: 'Financial Operations', code: 'FIN-OPS', unitId: unit1.id, colorHex: '#3B82F6' }
      });

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Finance Analyst', employeeCode: 'FIN-01', email: 'fin@company.com', departmentId: srcDept.id }
      });
      await mockPrisma.seat.create({
        data: { label: 'SRC-FIN-1', floorId: floor1U2.id, status: 'AVAILABLE', employeeId: emp.id, departmentId: srcDept.id }
      });

      const targetSeat = await mockPrisma.seat.create({
        data: { label: 'TGT-FIN-1', floorId: floor1U1.id, status: 'AVAILABLE' }
      });

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          reason: 'Cross-unit by code match'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: await getCookie('unit1.admin@shaktiman.com') },
        payload: {
          action: 'APPROVE',
          assignedTargetSeatId: targetSeat.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floor1U1.id,
          departmentId: targetDept.id
        }
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify employee was assigned to existing targetDept in Unit 1 (not creating duplicate)
      const updatedEmp = await mockPrisma.employee.findUnique({ where: { id: emp.id } });
      expect(updatedEmp.departmentId).toBe(targetDept.id);

      // Ensure no duplicate department was created
      const matchingDepts = await mockPrisma.department.findMany({
        where: { unitId: unit1.id, code: 'FIN-OPS' }
      });
      expect(matchingDepts.length).toBe(1);
    });
  });
});
