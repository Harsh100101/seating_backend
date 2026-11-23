import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Adversarial Stress Test: Milestone 2 Transfer Integrity & Edge Cases', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  // Hierarchy entities
  let unit1: any;
  let unit2: any;
  let plantU1: any;
  let buildingU1: any;
  let floorU1: any;
  let seatA1: any;
  let seatA2: any;
  let seatA3: any;

  let plantU2: any;
  let buildingU2: any;
  let floorU2: any;
  let seatB1: any;
  let seatB2: any;

  let engDept: any;
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

    const depts = await mockPrisma.department.findMany();
    engDept = depts.find((d: any) => d.code === 'ENG') || depts[0];

    // Build hierarchy in Unit 1
    plantU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Assembly Plant', code: 'PLT-U1-01', unitId: unit1.id }
    });
    buildingU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Main Building', code: 'BLD-U1-01', plantId: plantU1.id }
    });
    floorU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor 1', floorNumber: 1, buildingId: buildingU1.id }
    });
    seatA1 = await mockPrisma.seat.create({
      data: { label: 'U1-F1-001', floorId: floorU1.id, status: 'AVAILABLE', type: 'STANDARD' }
    });
    seatA2 = await mockPrisma.seat.create({
      data: { label: 'U1-F1-002', floorId: floorU1.id, status: 'AVAILABLE', type: 'STANDARD' }
    });
    seatA3 = await mockPrisma.seat.create({
      data: { label: 'U1-F1-003', floorId: floorU1.id, status: 'MAINTENANCE', type: 'STANDARD_DESK' }
    });

    // Fetch existing Unit 2 hierarchy from seed
    const plants = await mockPrisma.plant.findMany({ where: { unitId: unit2.id } });
    plantU2 = plants[0];
    const buildings = await mockPrisma.building.findMany({ where: { plantId: plantU2.id } });
    buildingU2 = buildings[0];
    const floors = await mockPrisma.floor.findMany({ where: { buildingId: buildingU2.id } });
    floorU2 = floors.find((f: any) => f.floorNumber === 2) || floors[0];
    const seatsU2 = await mockPrisma.seat.findMany({ where: { floorId: floorU2.id } });
    seatB1 = seatsU2.find((s: any) => s.status === 'AVAILABLE') || seatsU2[0];
    seatB2 = seatsU2.find((s: any) => s.id !== seatB1.id && s.status === 'AVAILABLE') || seatsU2[1];
  });

  afterEach(async () => {
    await server.close();
  });

  const assignSourceSeat = async (employee: any, label: string) => mockPrisma.seat.create({
    data: {
      label,
      floorId: floorU2.id,
      status: 'AVAILABLE',
      employeeId: employee.id,
      departmentId: employee.departmentId
    }
  });

  // =========================================================================
  // STRESS AREA 1: Concurrent & Duplicate Transfer Requests (Issue 2.1)
  // =========================================================================
  describe('STRESS AREA 1: Concurrency & Duplicate Request Guarding', () => {
    it('1.1: Blocks duplicate request at PENDING_TARGET_ADMIN status', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'MultiStage Employee', employeeCode: 'EMP-STAGE-01', email: 'stage@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'STAGE-SOURCE-01');

      const req1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: { employeeId: emp.id, targetUnitId: unit1.id, targetPlantId: plantU1.id, targetBuildingId: buildingU1.id, targetFloorId: floorU1.id, targetSeatId: seatA1.id, reason: 'Initial request' }
      });
      expect(req1.statusCode).toBe(201);
      expect(JSON.parse(req1.body).status).toBe('PENDING_TARGET_ADMIN');

      const dupEmp = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: { employeeId: emp.id, targetUnitId: unit1.id, targetPlantId: plantU1.id, targetBuildingId: buildingU1.id, targetFloorId: floorU1.id, reason: 'Duplicate emp' }
      });
      expect(dupEmp.statusCode).toBe(409);

      expect(JSON.parse(req1.body).targetSeatId).toBeNull();
    });

    it('1.2: Ignores source-provided maintenance-seat preferences until destination allocation', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Maintenance Tester', employeeCode: 'EMP-MAINT-01', email: 'maint@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'MAINT-SOURCE-01');

      // Target seat is in MAINTENANCE
      const res = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA3.id,
          reason: 'Try broken seat'
        }
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).status).toBe('PENDING_TARGET_ADMIN');
      expect(JSON.parse(res.body).targetSeatId).toBeNull();
    });

    it('1.3: Ignores source-provided floor/seat combinations until destination allocation', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Floor Mismatch User', employeeCode: 'EMP-MISMATCH-01', email: 'mismatch@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'MISMATCH-SOURCE-01');

      // Target seat seatB1 is on floorU2, but request specifies floorU1
      const res = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatB1.id,
          reason: 'Cross floor spoof'
        }
      });

      expect(res.statusCode).toBe(201);
      expect(JSON.parse(res.body).targetSeatId).toBeNull();
    });

    it('1.4: Source submissions do not reserve a destination seat', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp1 = await mockPrisma.employee.create({
        data: { fullName: 'Rival 1', employeeCode: 'RIVAL-01', email: 'rival1@company.com', departmentId: engDept.id }
      });
      const emp2 = await mockPrisma.employee.create({
        data: { fullName: 'Rival 2', employeeCode: 'RIVAL-02', email: 'rival2@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp1, 'RIVAL-SOURCE-01');
      await assignSourceSeat(emp2, 'RIVAL-SOURCE-02');

      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp1.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA2.id,
          reason: 'I want seat A2'
        }
      });
      expect(res1.statusCode).toBe(201);
      expect(JSON.parse(res1.body).targetSeatId).toBeNull();

      const res2 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp2.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA2.id,
          reason: 'I also want seat A2'
        }
      });
      expect(res2.statusCode).toBe(201);
      expect(JSON.parse(res2.body).targetSeatId).toBeNull();
    });
  });

  // =========================================================================
  // STRESS AREA 2: Separation of Duties & RBAC Bypass Attacks (Issue 2.2)
  // =========================================================================
  describe('STRESS AREA 2: Separation of Duties & Approver Tampering', () => {
    it('2.1: Case-insensitivity and whitespace trim check prevents Admin self-approval', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Admin Casing Test',
          employeeCode: 'EMP-U1-CASE',
          email: 'UNIT1.ADMIN@SHAKTIMAN.COM',
          departmentId: engDept.id
        }
      });
      await assignSourceSeat(adminEmp, 'ADMIN-CASE-SOURCE-01');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: adminEmp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Self approval attempt with casing trick'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const req = JSON.parse(reqRes.body);

      const unitAdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const actRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: unitAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id, comment: 'Bypassing with uppercase email' }
      });

      expect(actRes.statusCode).toBe(403);
      expect(JSON.parse(actRes.body).message).toBe('Separation of duties violation: Cannot approve your own transfer request');
    });

    it('2.2: Prevents Admin self-approval even when user.employeeId is null (email matching fallback)', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const adminUser = await mockPrisma.adminUser.findUnique({
        where: { email: 'unit1.admin@shaktiman.com' }
      });

      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Null EmployeeId Admin',
          employeeCode: 'EMP-ADM-NULLID',
          email: 'unit1.admin@shaktiman.com',
          departmentId: engDept.id
        }
      });
      await assignSourceSeat(adminEmp, 'ADMIN-NULL-SOURCE-01');

      await mockPrisma.adminUser.update({
        where: { id: adminUser.id },
        data: { employeeId: null }
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
          targetFloorId: floorU1.id,
          reason: 'Self approval with null employeeId'
        }
      });
      const req = JSON.parse(reqRes.body);

      const unitAdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const actRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: unitAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id }
      });

      expect(actRes.statusCode).toBe(403);
      expect(JSON.parse(actRes.body).message).toBe('Separation of duties violation: Cannot approve your own transfer request');
    });

    it('2.3: Rejects unauthenticated caller from calling approval action endpoint', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Regular Emp', employeeCode: 'REG-EMP-01', email: 'emp99@shaktiman.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'REG-SOURCE-01');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Unauthenticated test'
        }
      });
      const req = JSON.parse(reqRes.body);

      const actRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        payload: { action: 'APPROVE' }
      });

      expect(actRes.statusCode).toBe(401);
    });

    it('2.4: Legacy FORCE_APPROVE action is rejected by the two-stage API', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Force Tester', employeeCode: 'FORCE-01', email: 'forcetest@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'FORCE-SOURCE-01');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Force approval privilege check'
        }
      });
      const req = JSON.parse(reqRes.body);

      const unitAdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const forceRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: unitAdminCookie },
        payload: { action: 'FORCE_APPROVE', assignedTargetSeatId: seatA1.id }
      });

      expect(forceRes.statusCode).toBe(400);
      expect(JSON.parse(forceRes.body).message).toContain('Valid action (APPROVE or REJECT) is required');
    });
  });

  // =========================================================================
  // STRESS AREA 3: Cross-Unit Transfer & Missing Seat Resilience (Issues 2.3 & 2.4)
  // =========================================================================
  describe('STRESS AREA 3: Cross-Unit Transfer & Data Integrity', () => {
    it('3.1: Completing cross-unit transfer when source seat was deleted does not crash', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Ephemeral Seat User', employeeCode: 'EPH-01', email: 'eph@company.com', departmentId: engDept.id }
      });

      const volatileSeat = await mockPrisma.seat.create({
        data: { label: 'VOLATILE-01', floorId: floorU2.id, status: 'AVAILABLE', employeeId: emp.id, departmentId: engDept.id }
      });

      // Submit transfer request from Unit 2 to Unit 1
      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA1.id,
          reason: 'Volatile seat move'
        }
      });
      const req = JSON.parse(reqRes.body);
      expect(req.sourceSeatId).toBe(volatileSeat.id);

      // Now physically delete volatile seat
      await mockPrisma.seat.delete({ where: { id: volatileSeat.id } });

      const targetAdminCookie = await getCookie('unit1.admin@shaktiman.com');
      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: targetAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id }
      });

      expect(approveRes.statusCode).toBe(409);
      expect(JSON.parse(approveRes.body).message).toContain('Employee workstation changed after the request was created');

      // Stale-source rejection must not partially allocate the destination.
      const targetDesk = await mockPrisma.seat.findUnique({ where: { id: seatA1.id } });
      expect(targetDesk.employeeId).toBeNull();
      const unchangedEmp = await mockPrisma.employee.findUnique({ where: { id: emp.id } });
      expect(unchangedEmp.departmentId).toBe(engDept.id);
    });

    it('3.2: Source Unit Admin cannot submit an unseated employee without a trusted source Unit', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Unseated Fresh Joinee', employeeCode: 'FRESH-01', email: 'fresh@company.com', departmentId: engDept.id }
      });

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          reason: 'First time seating'
        }
      });
      expect(reqRes.statusCode).toBe(400);
      expect(JSON.parse(reqRes.body).message).toContain('source Unit could not be resolved');
    });

    it('3.3: Cross-unit allocation uses the explicitly selected existing destination department', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      // Create a department in Unit 1
      const targetDept = await mockPrisma.department.create({
        data: { name: 'Quality Assurance', code: 'QA', colorHex: '#8B5CF6', unitId: unit1.id }
      });

      // Target seat is allocated to QA department
      await mockPrisma.seat.update({
        where: { id: seatA2.id },
        data: { departmentId: targetDept.id }
      });

      // Employee currently in Engineering (Unit 2)
      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Dept Switcher', employeeCode: 'SWITCH-01', email: 'switcher@company.com', departmentId: engDept.id }
      });
      await assignSourceSeat(emp, 'SWITCH-SOURCE-01');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          reason: 'Switch to QA seat'
        }
      });
      const req = JSON.parse(reqRes.body);

      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: await getCookie('unit1.admin@shaktiman.com') },
        payload: {
          action: 'APPROVE',
          assignedTargetSeatId: seatA2.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          departmentId: targetDept.id
        }
      });
      expect(approveRes.statusCode).toBe(200);

      // Verify employee department was updated to target seat's department
      const updatedEmp = await mockPrisma.employee.findUnique({ where: { id: emp.id } });
      expect(updatedEmp.departmentId).toBe(targetDept.id);
    });
  });

  // =========================================================================
  // STRESS AREA 4: Employee Deletion & Defensive UI Serialization (Issue 2.4)
  // =========================================================================
  describe('STRESS AREA 4: Employee Deletion & Safe Read Fallbacks', () => {
    it('4.1: Deleting employee cancels request and unseats them cleanly', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'To Be Terminated', employeeCode: 'TERM-01', email: 'term@company.com', departmentId: engDept.id }
      });

      const mySeat = await mockPrisma.seat.create({
        data: { label: 'TERM-SEAT-01', floorId: floorU2.id, status: 'AVAILABLE', employeeId: emp.id, departmentId: engDept.id }
      });

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: sourceAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Pending request before termination'
        }
      });
      const req = JSON.parse(reqRes.body);

      // Delete employee
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/employees/${emp.id}`,
        headers: { cookie: superAdminCookie }
      });
      expect(delRes.statusCode).toBe(200);

      // 1. Seat is now AVAILABLE
      const seatCheck = await mockPrisma.seat.findUnique({ where: { id: mySeat.id } });
      expect(seatCheck.status).toBe('AVAILABLE');
      expect(seatCheck.employeeId).toBeNull();

      // 2. Transfer request is CANCELLED
      const reqCheck = await mockPrisma.seatTransferRequest.findUnique({ where: { id: req.id } });
      expect(reqCheck.status).toBe('CANCELLED');
      expect(reqCheck.rejectionReason).toBe('Employee record was deleted');

      // 3. GET /api/transfer-requests returns list safely without crashing
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie }
      });
      expect(listRes.statusCode).toBe(200);
      const list = JSON.parse(listRes.body);
      const found = list.find((r: any) => r.id === req.id);
      expect(found).toBeDefined();
      expect(found.employee.fullName).toBe('Deleted Employee');

      // 4. Cannot act on CANCELLED request
      const actRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req.id}/action`,
        headers: { cookie: superAdminCookie },
        payload: { action: 'APPROVE' }
      });
      expect(actRes.statusCode).toBe(400);
      expect(JSON.parse(actRes.body).message).toContain('Transfer request is already finalized with status: CANCELLED');
    });
  });

  // =========================================================================
  // STRESS AREA 5: Floor Department Filtering & Scope Integrity (Issue 2.5)
  // =========================================================================
  describe('STRESS AREA 5: Floor Department Filtering & Counts', () => {
    it('5.1: Floor filter accurately computes floorAllocatedSeats and floorOccupiedSeats', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const deptA = await mockPrisma.department.create({
        data: { name: 'Floor Dept Alpha', code: 'ALPHA', colorHex: '#EF4444', unitId: unit1.id }
      });

      const emp = await mockPrisma.employee.create({
        data: { fullName: 'Alpha Occupant', employeeCode: 'ALPHA-01', email: 'alpha@company.com', departmentId: deptA.id }
      });

      // 1 seat occupied on floorU1
      await mockPrisma.seat.create({
        data: { label: 'AL-01', floorId: floorU1.id, status: 'AVAILABLE', departmentId: deptA.id, employeeId: emp.id }
      });
      // 1 seat available on floorU1
      await mockPrisma.seat.create({
        data: { label: 'AL-02', floorId: floorU1.id, status: 'AVAILABLE', departmentId: deptA.id }
      });
      // 1 seat occupied on floorU2 (different floor)
      await mockPrisma.seat.create({
        data: { label: 'AL-03', floorId: floorU2.id, status: 'AVAILABLE', departmentId: deptA.id, employeeId: emp.id }
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floorU1.id}`,
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const depts = JSON.parse(res.body);
      const found = depts.find((d: any) => d.id === deptA.id);
      expect(found).toBeDefined();
      expect(found.floorAllocatedSeats).toBe(2); // Only AL-01 and AL-02 on floorU1
      expect(found.floorOccupiedSeats).toBe(1);  // Only AL-01 is occupied on floorU1
    });

    it('5.2: Querying non-existent floorId returns empty array without throwing 500', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const res = await server.inject({
        method: 'GET',
        url: '/api/departments?floorId=non-existent-floor-id',
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const depts = JSON.parse(res.body);
      expect(Array.isArray(depts)).toBe(true);
      expect(depts.length).toBe(0);
    });
  });
});
