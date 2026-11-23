import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Step 4 Dedicated Security & Remediation Invariant Test Suite', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  // Hierarchy entities
  let unit1: any;
  let unit2: any;
  let plantU1: any;
  let buildingU1: any;
  let floorU1: any;
  let seat1UnderU1: any;

  let plantU2: any;
  let buildingU2: any;
  let floorU2: any;
  let seatUnderU2: any;

  let engDept: any;
  let hrDept: any;

  // Authentication cookies
  let superAdminCookie: string;
  let unit1AdminCookie: string;
  let unit2AdminCookie: string;
  

  const getCookie = async (email: string): Promise<string> => {
    const password = email === DEFAULT_ADMIN.email ? DEFAULT_ADMIN.password : DEMO_PASSWORD;
    const res = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password }
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.headers['set-cookie'];
    return Array.isArray(cookie) ? cookie[0] : (cookie as string);
  };

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate test personas
    superAdminCookie = await getCookie('superadmin@shaktiman.com');
    unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');
    unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    

    // Retrieve units
    const units = await mockPrisma.unit.findMany();
    unit1 = units.find((u: any) => u.code === 'UNIT-1');
    unit2 = units.find((u: any) => u.code === 'UNIT-2');

    // Seed departments
    const depts = await mockPrisma.department.findMany();
    engDept = depts.find((d: any) => d.code === 'ENG') || depts[0];
    hrDept = depts.find((d: any) => d.code === 'HR') || depts[1];

    // Seed Unit 1 hierarchy
    plantU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Heavy Machining Plant', code: 'PLT-U1-SEC', unitId: unit1.id }
    });
    buildingU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Operations Block', code: 'BLD-U1-SEC', plantId: plantU1.id }
    });
    floorU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor 1', floorNumber: 1, buildingId: buildingU1.id }
    });
    seat1UnderU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-SEC-001',
        floorId: floorU1.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    // Resolve Unit 2 hierarchy from seed
    plantU2 = await mockPrisma.plant.findFirst({ where: { unitId: unit2.id } });
    buildingU2 = await mockPrisma.building.findFirst({ where: { plantId: plantU2.id } });
    floorU2 = await mockPrisma.floor.findFirst({ where: { buildingId: buildingU2.id } });
    seatUnderU2 = await mockPrisma.seat.create({
      data: {
        label: 'U2-SEC-SOURCE',
        floorId: floorU2.id,
        x: 200,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });
  }, 30000);

  afterEach(async () => {
    await server.close();
  });

  // =========================================================================
  // Invariant 1: SEC-01
  // MANAGER and HOD attempting DELETE /api/units/:id or DELETE /api/plants/:id
  // receives 403 Forbidden.
  // =========================================================================
  describe('SEC-01: Hierarchy Deletion Role Guard Invariant', () => {
    it('UNIT_ADMIN is strictly forbidden from deleting units or cross-unit plants (403)', async () => {
      // 1. UNIT_ADMIN attempting DELETE /api/units/:id
      const delUnit = await server.inject({
        method: 'DELETE',
        url: `/api/units/${unit1.id}`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(delUnit.statusCode).toBe(403);
      expect(delUnit.json().error).toBe('Forbidden');

      // 2. Unit 2 Admin attempting DELETE /api/plants/:id of Unit 1
      const delPlant = await server.inject({
        method: 'DELETE',
        url: `/api/plants/${plantU1.id}`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(delPlant.statusCode).toBe(403);
      expect(delPlant.json().error).toBe('Forbidden');

      // Verify records remain intact in database
      const existingUnit = await mockPrisma.unit.findUnique({ where: { id: unit1.id } });
      expect(existingUnit).toBeDefined();
      const existingPlant = await mockPrisma.plant.findUnique({ where: { id: plantU1.id } });
      expect(existingPlant).toBeDefined();
    });
  }, 30000);

  describe('SEC-02: Cross-Unit BOLA Seat Assignment Invariant', () => {
    it('UNIT_ADMIN of Unit 2 attempting to assign or unassign seats in Unit 1 receives 403 Forbidden', async () => {
      // Make the positive control deterministic even when the shared fixture
      // already contains an occupied seat from an earlier seeded scenario.
      await mockPrisma.seat.update({
        where: { id: seat1UnderU1.id },
        data: { employeeId: null, departmentId: null, status: 'AVAILABLE' }
      });

      const unit1TestDept = await mockPrisma.department.create({
        data: {
          name: 'Unit 1 Security Test Engineering',
          code: 'SEC-ENG-U1',
          unitId: unit1.id,
          floorId: floorU1.id
        }
      });

      // Create a test employee
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Security Test Worker',
          employeeCode: 'SEC-EMP-01',
          email: 'sec.worker@shaktiman.com',
          departmentId: unit1TestDept.id,
          isActive: true
        }
      });

      // 1. Unit 2 Admin attempts to assign seat in Unit 1
      const assignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit2AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(assignRes.statusCode).toBe(403);
      expect(assignRes.json().message).toMatch(/within your assigned unit/i);

      // 2. Unit 2 Admin attempts quick-assign on seat in Unit 1
      const quickAssignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/quick-assign`,
        headers: { cookie: unit2AdminCookie },
        payload: {
          fullName: 'Intruder Candidate',
          employeeCode: 'INT-999',
          departmentId: engDept.id
        }
      });
      expect(quickAssignRes.statusCode).toBe(403);
      expect(quickAssignRes.json().message).toMatch(/within your assigned unit/i);

      // Seat employee in Unit 1 using Unit 1 Admin (authorized control)
      const authorizedAssign = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/assign`,
        headers: { cookie: unit1AdminCookie },
        payload: { employeeId: emp.id }
      });
      expect(authorizedAssign.statusCode).toBe(200);

      // 3. Unit 2 Admin attempts to unassign seat in Unit 1
      const unassignRes = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit2AdminCookie }
      });
      expect(unassignRes.statusCode).toBe(403);
      expect(unassignRes.json().message).toMatch(/within your assigned unit/i);

      // Positive check: Unit 1 Admin CAN unassign the seat in Unit 1
      const authorizedUnassign = await server.inject({
        method: 'POST',
        url: `/api/seats/${seat1UnderU1.id}/unassign`,
        headers: { cookie: unit1AdminCookie }
      });
      expect(authorizedUnassign.statusCode).toBe(200);
    });
  }, 30000);

  // =========================================================================
  // Invariant 3: SEC-03
  // Duplicate concurrent transfer request for the same employee returns 409.
  // =========================================================================
  describe('SEC-03: Duplicate Concurrent Transfer Request Invariant', () => {
    it('Submitting duplicate concurrent transfer request for the same employee returns 409 Conflict', async () => {
      // Create test employees
      const empA = await mockPrisma.employee.create({
        data: {
          fullName: 'Concurrent Applicant A',
          employeeCode: 'APP-CONC-A',
          email: 'app.a@shaktiman.com',
          departmentId: engDept.id
        }
      });
      await mockPrisma.seat.update({
        where: { id: seatUnderU2.id },
        data: { employeeId: empA.id }
      });

      // 1. Submit initial transfer request for employee A
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: unit2AdminCookie },
        payload: {
          employeeId: empA.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Initial desk relocation'
        }
      });
      expect(res1.statusCode).toBe(201);
      const req1 = res1.json();
      expect(req1.status).toBe('PENDING_TARGET_ADMIN');

      // Attempt second transfer request for same employee A while first is pending
      const resDupEmp = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: unit2AdminCookie },
        payload: {
          employeeId: empA.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Duplicate request for employee A'
        }
      });
      expect(resDupEmp.statusCode).toBe(409);
      expect(resDupEmp.json().error).toBe('Conflict');
      expect(resDupEmp.json().message).toContain('already has an active transfer request');

    });
  }, 30000);

  // =========================================================================
  // Invariant 4: SEC-04
  // Deleting an employee cancels active transfer requests and GET /api/transfer-requests
  // safely returns "Deleted Employee" without crashing.
  // =========================================================================
  describe('SEC-04: Orphaned Transfer Request & Safe Employee Deletion Invariant', () => {
    it('Deleting an employee cancels active transfer requests and GET /api/transfer-requests handles deleted employees safely', async () => {
      // Create employee with an active transfer request
      const departingEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Departing Staff Member',
          employeeCode: 'DEP-999',
          email: 'departing@shaktiman.com',
          departmentId: engDept.id
        }
      });
      await mockPrisma.seat.update({
        where: { id: seatUnderU2.id },
        data: { employeeId: departingEmp.id }
      });

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: unit2AdminCookie },
        payload: {
          employeeId: departingEmp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Transfer before departure'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = reqRes.json();
      expect(reqData.status).toBe('PENDING_TARGET_ADMIN');

      // Delete the employee
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/employees/${departingEmp.id}`,
        headers: { cookie: superAdminCookie }
      });
      expect(delRes.statusCode).toBe(200);

      // Verify in DB that request was cancelled with rejectionReason
      const cancelledReq = await mockPrisma.seatTransferRequest.findUnique({
        where: { id: reqData.id }
      });
      expect(cancelledReq.status).toBe('CANCELLED');
      expect(cancelledReq.rejectionReason).toBe('Employee record was deleted');

      // GET /api/transfer-requests must not crash and must safely return "Deleted Employee"
      const listRes = await server.inject({
        method: 'GET',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie }
      });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json();
      const targetReq = list.find((r: any) => r.id === reqData.id);
      expect(targetReq).toBeDefined();
      expect(targetReq.status).toBe('CANCELLED');
      expect(targetReq.employee).toBeDefined();
      expect(targetReq.employee.fullName).toBe('Deleted Employee');
      expect(targetReq.employee.employeeCode).toBe('N/A');

      // GET /api/transfer-requests/:id must also return 200 with "Deleted Employee"
      const detailRes = await server.inject({
        method: 'GET',
        url: `/api/transfer-requests/${reqData.id}`,
        headers: { cookie: superAdminCookie }
      });
      expect(detailRes.statusCode).toBe(200);
      const detail = detailRes.json();
      expect(detail.employee).toBeDefined();
      expect(detail.employee.fullName).toBe('Deleted Employee');
      expect(detail.employee.employeeCode).toBe('N/A');
    });
  }, 30000);

  // =========================================================================
  // Invariant 5: SEC-05
  // GET /api/departments?floorId=<id> returns only floor-active departments
  // with accurate floor-scoped seat counts.
  // =========================================================================
  describe('SEC-05: Floor-Wise Department Filter & Scoped Seat Counts Invariant', () => {
    it('GET /api/departments?floorId=<id> returns only floor-active departments with floor-scoped seat counts', async () => {
      // Create dedicated floor in Unit 1
      const floorTest = await mockPrisma.floor.create({
        data: { name: 'Unit 1 Floor 2', floorNumber: 2, buildingId: buildingU1.id }
      });

      // Create Department A in Unit 1
      const deptA = await mockPrisma.department.create({
        data: {
          name: 'Floor Active Department',
          code: 'FAD-01',
          colorHex: '#3B82F6',
          unitId: unit1.id
        }
      });

      // Create Department B in Unit 1 with NO seats on floorTest
      const deptB = await mockPrisma.department.create({
        data: {
          name: 'Floor Inactive Department',
          code: 'FID-01',
          colorHex: '#EF4444',
          unitId: unit1.id
        }
      });

      // Create Department C pinned to floorTest directly via floorId
      const deptC = await mockPrisma.department.create({
        data: {
          name: 'Direct Floor Pod Department',
          code: 'DFP-01',
          colorHex: '#10B981',
          unitId: unit1.id,
          floorId: floorTest.id
        }
      });

      // Create an employee in Department A
      const empA = await mockPrisma.employee.create({
        data: {
          fullName: 'Active Dept Seated Employee',
          employeeCode: 'SEAT-EMP-01',
          email: 'seated@shaktiman.com',
          departmentId: deptA.id
        }
      });

      // Create 2 seats on floorTest:
      // Seat 1: Allocated to Dept A, occupied by empA
      await mockPrisma.seat.create({
        data: {
          label: 'F2-SEAT-01',
          floorId: floorTest.id,
          status: 'AVAILABLE',
          employeeId: empA.id,
          departmentId: deptA.id,
          x: 50,
          y: 50
        }
      });

      // Seat 2: Allocated to Dept A, vacant
      await mockPrisma.seat.create({
        data: {
          label: 'F2-SEAT-02',
          floorId: floorTest.id,
          status: 'AVAILABLE',
          employeeId: null,
          departmentId: deptA.id,
          x: 100,
          y: 50
        }
      });

      // 1. Query departments with floorId filter
      const res = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floorTest.id}`,
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(Array.isArray(list)).toBe(true);

      // Dept A must be included because it has seats on floorTest
      const foundA = list.find((d: any) => d.id === deptA.id);
      expect(foundA).toBeDefined();
      expect(foundA.floorAllocatedSeats).toBe(2);
      expect(foundA.floorOccupiedSeats).toBe(1);
      expect(foundA._count.seats).toBe(2);
      expect(foundA._count.employees).toBe(1);

      // Dept C must be included because floorId === floorTest.id
      const foundC = list.find((d: any) => d.id === deptC.id);
      expect(foundC).toBeDefined();

      // Dept B must NOT be included (has no seats on this floor and floorId is null)
      const foundB = list.find((d: any) => d.id === deptB.id);
      expect(foundB).toBeUndefined();

      // 2. Query with scope=unit must return all unit departments including Dept B
      const resScopeUnit = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floorTest.id}&scope=unit`,
        headers: { cookie: superAdminCookie }
      });
      expect(resScopeUnit.statusCode).toBe(200);
      const listScopeUnit = resScopeUnit.json();
      expect(listScopeUnit.some((d: any) => d.id === deptB.id)).toBe(true);
    });
  }, 30000);
});
