import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEFAULT_ADMIN, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Milestone 2: Transfer State Machine, Data Integrity & Hierarchy Scoping (Issues 2.1 - 2.5)', () => {
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

  let plantU2: any;
  let buildingU2: any;
  let floorU2: any;
  let seatB1: any;

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

    // Fetch existing Unit 2 hierarchy from seed
    const plants = await mockPrisma.plant.findMany({ where: { unitId: unit2.id } });
    plantU2 = plants[0];
    const buildings = await mockPrisma.building.findMany({ where: { plantId: plantU2.id } });
    buildingU2 = buildings[0];
    const floors = await mockPrisma.floor.findMany({ where: { buildingId: buildingU2.id } });
    floorU2 = floors.find((f: any) => f.floorNumber === 2) || floors[0];
    const seatsU2 = await mockPrisma.seat.findMany({ where: { floorId: floorU2.id } });
    seatB1 = seatsU2.find((s: any) => s.status === 'AVAILABLE') || seatsU2[0];
  });

  afterEach(async () => {
    await server.close();
  });

  const seatEmployeeInUnit2 = async (employee: any, label: string) => mockPrisma.seat.create({
    data: {
      label,
      floorId: floorU2.id,
      status: 'AVAILABLE',
      employeeId: employee.id,
      departmentId: employee.departmentId
    }
  });

  // =========================================================================
  // Issue 2.1: Block Duplicate Concurrent Transfer Requests
  // =========================================================================
  describe('Issue 2.1: Block Duplicate Concurrent Transfer Requests', () => {
    it('2.1A: Blocks duplicate concurrent transfer request for the same employee with 409 Conflict', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      // Create a test employee
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Alice Concurrency',
          employeeCode: 'EMP-CONC-01',
          email: 'alice.conc@company.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(emp, 'SRC-CONC-01');

      // Submit first transfer request
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Initial transfer request'
        }
      });
      expect(res1.statusCode).toBe(201);
      const req1 = JSON.parse(res1.body);
      expect(req1.status).toBe('PENDING_TARGET_ADMIN');

      // Attempt concurrent duplicate request for same employee
      const res2 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Duplicate transfer attempt'
        }
      });

      expect(res2.statusCode).toBe(409);
      const err = JSON.parse(res2.body);
      expect(err.error).toBe('Conflict');
      expect(err.message).toContain('already has an active transfer request');
    });

    it('2.1B: Source submissions do not reserve a destination seat; approval arbitrates occupancy', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      // Create two distinct employees
      const emp1 = await mockPrisma.employee.create({
        data: {
          fullName: 'Bob Competitor 1',
          employeeCode: 'EMP-COMP-01',
          email: 'bob1@company.com',
          departmentId: engDept.id
        }
      });
      const emp2 = await mockPrisma.employee.create({
        data: {
          fullName: 'Charlie Competitor 2',
          employeeCode: 'EMP-COMP-02',
          email: 'charlie2@company.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(emp1, 'SRC-COMP-01');
      await seatEmployeeInUnit2(emp2, 'SRC-COMP-02');

      // Employee 1 submits transfer request requesting seatA1
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp1.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA1.id,
          reason: 'Preferred desk request'
        }
      });
      expect(res1.statusCode).toBe(201);
      const req1 = JSON.parse(res1.body);

      // Employee 2 attempts concurrent transfer requesting the EXACT same seatA1
      const res2 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp2.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA1.id,
          reason: 'Competing desk request'
        }
      });

      expect(res2.statusCode).toBe(201);
      const req2 = JSON.parse(res2.body);
      expect(req1.targetSeatId).toBeNull();
      expect(req2.targetSeatId).toBeNull();

      const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');
      const approve1 = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req1.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id, departmentId: engDept.id }
      });
      expect(approve1.statusCode).toBe(200);

      const approve2 = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req2.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id, departmentId: engDept.id }
      });
      expect(approve2.statusCode).toBe(409);
    });

    it('2.1C: Allows new transfer request once previous request is CANCELLED or REJECTED', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Dave Recycled',
          employeeCode: 'EMP-RECYC-01',
          email: 'dave@company.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(emp, 'SRC-RECYC-01');

      // Submit request 1
      const res1 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Initial transfer request'
        }
      });
      expect(res1.statusCode).toBe(201);
      const req1 = JSON.parse(res1.body);

      // Reject request 1
      const rejectRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${req1.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: { action: 'REJECT', comment: 'Rejected by admin' }
      });
      expect(rejectRes.statusCode).toBe(200);

      // New request should now succeed cleanly
      const res2 = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'New request after rejection'
        }
      });
      expect(res2.statusCode).toBe(201);
    });
  });

  // =========================================================================
  // Issue 2.2: Prevent Self-Approval by Manager / HOD
  // =========================================================================
  describe('Issue 2.2: Prevent Self-Approval by Admin', () => {
    it('2.2A: Returns 403 Forbidden when Unit Admin attempts to approve their own transfer request', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const adminUser = await mockPrisma.adminUser.findUnique({
        where: { email: 'unit1.admin@shaktiman.com' }
      });
      expect(adminUser).toBeDefined();

      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: adminUser.name,
          employeeCode: 'ADM-EMP-01',
          email: adminUser.email,
          departmentId: engDept.id
        }
      });

      await mockPrisma.adminUser.update({
        where: { id: adminUser.id },
        data: { employeeId: adminEmp.id }
      });
      await seatEmployeeInUnit2(adminEmp, 'SRC-ADM-01');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: adminEmp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Admin office relocation'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      const unitAdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: unitAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id, comment: 'Self approving my own transfer' }
      });

      expect(approveRes.statusCode).toBe(403);
      const err = JSON.parse(approveRes.body);
      expect(err.error).toBe('Forbidden');
      expect(err.message).toBe('Separation of duties violation: Cannot approve your own transfer request');
    });

    it('2.2B: Returns 403 Forbidden when Admin attempts to approve request with matching email', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');

      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Unit 1 Admin Persona',
          employeeCode: 'ADM-EMP-02',
          email: 'unit1.admin@shaktiman.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(adminEmp, 'SRC-ADM-02');

      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: adminEmp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          reason: 'Matching email test'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      const unitAdminCookie = await getCookie('unit1.admin@shaktiman.com');

      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: unitAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id }
      });

      expect(approveRes.statusCode).toBe(403);
      const err = JSON.parse(approveRes.body);
      expect(err.error).toBe('Forbidden');
      expect(err.message).toBe('Separation of duties violation: Cannot approve your own transfer request');
    });

    it('2.2C: SUPER_ADMIN can approve a pending cross-Unit transfer', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const adminEmp = await mockPrisma.employee.create({
        data: {
          fullName: 'Jane Unit Admin',
          employeeCode: 'ADM-ENG-99',
          email: 'jane.admin@shaktiman.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(adminEmp, 'SRC-ADM-03');

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
          reason: 'Relocation for admin'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      // Super Admin has explicit global transfer authority under the approved policy.
      const approveRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: superAdminCookie },
        payload: { action: 'APPROVE', assignedTargetSeatId: seatA1.id, departmentId: engDept.id, comment: 'Super Admin override for admin' }
      });
      expect(approveRes.statusCode).toBe(200);
      const approved = JSON.parse(approveRes.body);
      expect(approved.status).toBe('APPROVED');
      expect(approved.targetAdminApproval.adminRole).toBe('SUPER_ADMIN');
    });
  });

  describe('Issues 2.3 & 2.4: Safe Cross-Unit Department Mapping & Missing Source Seat Guard', () => {
    it('2.3A: Deleted source seat is treated as a stale request and cannot finalize', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

      // Seat employee in Unit 2
      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Ghost Seat User',
          employeeCode: 'GHOST-01',
          email: 'ghost@company.com',
          departmentId: engDept.id
        }
      });

      const tempSourceSeat = await mockPrisma.seat.create({
        data: {
          label: 'TEMP-U2-SRC',
          floorId: floorU2.id,
          status: 'AVAILABLE',
          employeeId: emp.id,
          departmentId: engDept.id
        }
      });

      // Create transfer request from Unit 2 to Unit 1
      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA1.id,
          reason: 'Source seat deletion test'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.sourceSeatId).toBe(tempSourceSeat.id);

      // Delete the source seat completely to simulate out-of-band desk removal
      await mockPrisma.seat.delete({ where: { id: tempSourceSeat.id } });

      // Finalization must reject the stale source snapshot without mutating the destination.
      const forceRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          action: 'APPROVE',
          assignedTargetSeatId: seatA1.id,
          comment: 'Approved despite missing source seat'
        }
      });

      expect(forceRes.statusCode).toBe(409);
      expect(JSON.parse(forceRes.body).message).toContain('workstation changed');

      // Verify employee is seated in target seat
      const targetDesk = await mockPrisma.seat.findUnique({ where: { id: seatA1.id } });
      expect(targetDesk.employeeId).toBeNull();
    });

    it('2.3B: Cross-unit transfer requires an existing destination department', async () => {
      const superAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

      // Create a unique department in Unit 2 with NO sister in Unit 1
      const u2CustomDept = await mockPrisma.department.create({
        data: {
          name: 'Robotics Automation',
          code: 'ROBOT',
          colorHex: '#06B6D4',
          unitId: unit2.id
        }
      });

      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Robotics Engineer',
          employeeCode: 'ROB-001',
          email: 'rob@company.com',
          departmentId: u2CustomDept.id
        }
      });
      await seatEmployeeInUnit2(emp, 'SRC-ROBOT-01');

      // Submit transfer request from Unit 2 to Unit 1
      const reqRes = await server.inject({
        method: 'POST',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie },
        payload: {
          employeeId: emp.id,
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          targetSeatId: seatA2.id,
          reason: 'Tier 3 sister dept test'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);

      // Execute final transfer approval through the Target Unit Admin.
      const forceRes = await server.inject({
        method: 'POST',
        url: `/api/transfer-requests/${reqData.id}/action`,
        headers: { cookie: unit1AdminCookie },
        payload: {
          action: 'APPROVE',
          assignedTargetSeatId: seatA2.id
        }
      });
      expect(forceRes.statusCode).toBe(400);
      expect(JSON.parse(forceRes.body).message).toContain('existing Department in the target Unit is required');

      // No sister department is created implicitly.
      const sisterDept = await mockPrisma.department.findFirst({
        where: { unitId: unit1.id, name: 'Robotics Automation' }
      });
      expect(sisterDept).toBeNull();

      // The employee and destination seat remain unchanged after the rejected approval.
      const updatedEmp = await mockPrisma.employee.findUnique({ where: { id: emp.id } });
      expect(updatedEmp.departmentId).toBe(u2CustomDept.id);

      const targetDesk = await mockPrisma.seat.findUnique({ where: { id: seatA2.id } });
      expect(targetDesk.employeeId).toBeNull();
    });
  });

  // =========================================================================
  // Issue 2.4: Prevent Orphaned Transfer Requests & Frontend Null Fallback
  // =========================================================================
  describe('Issue 2.4: Prevent Orphaned Transfer Requests & Null Employee Enrichment', () => {
    it('2.4A: Deleting an employee automatically cancels active pending transfer requests with reason', async () => {
      const sourceAdminCookie = await getCookie('unit2.admin@shaktiman.com');
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const emp = await mockPrisma.employee.create({
        data: {
          fullName: 'Mark Leaving',
          employeeCode: 'MARK-01',
          email: 'mark@company.com',
          departmentId: engDept.id
        }
      });
      await seatEmployeeInUnit2(emp, 'SRC-MARK-01');

      // Submit transfer request
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
          reason: 'Leaving employee request'
        }
      });
      expect(reqRes.statusCode).toBe(201);
      const reqData = JSON.parse(reqRes.body);
      expect(reqData.status).toBe('PENDING_TARGET_ADMIN');

      // Delete employee via DELETE /api/employees/:id
      const delRes = await server.inject({
        method: 'DELETE',
        url: `/api/employees/${emp.id}`,
        headers: { cookie: superAdminCookie }
      });
      expect(delRes.statusCode).toBe(200);

      // Verify transfer request status was cancelled
      const updatedReq = await mockPrisma.seatTransferRequest.findUnique({
        where: { id: reqData.id }
      });
      expect(updatedReq.status).toBe('CANCELLED');
      expect(updatedReq.rejectionReason).toBe('Employee record was deleted');

      // DELETE is quarantine-safe: the employee shell remains inactive so
      // transfer and audit history cannot be lost to a cascading delete.
      const preservedEmployee = await mockPrisma.employee.findUnique({ where: { id: emp.id } });
      expect(preservedEmployee).toBeDefined();
      expect(preservedEmployee.isActive).toBe(false);
    });

    it('2.4B: GET /api/transfer-requests defensively fallbacks to Deleted Employee placeholder if employee is null', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      // Create an orphaned transfer request directly in database
      const orphanReq = await mockPrisma.seatTransferRequest.create({
        data: {
          requestNumber: 'REQ-2026-99999',
          employeeId: 'non-existent-employee-id',
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          status: 'CANCELLED',
          rejectionReason: 'Employee record was deleted'
        }
      });

      const res = await server.inject({
        method: 'GET',
        url: '/api/transfer-requests',
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const found = body.find((r: any) => r.id === orphanReq.id);
      expect(found).toBeDefined();
      expect(found.employee).toBeDefined();
      expect(found.employee.fullName).toBe('Deleted Employee');
      expect(found.employee.employeeCode).toBe('N/A');
    });

    it('2.4C: GET /api/transfer-requests/:id defensively fallbacks to Deleted Employee placeholder', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      const orphanReq = await mockPrisma.seatTransferRequest.create({
        data: {
          requestNumber: 'REQ-2026-88888',
          employeeId: 'deleted-emp-id-88',
          targetUnitId: unit1.id,
          targetPlantId: plantU1.id,
          targetBuildingId: buildingU1.id,
          targetFloorId: floorU1.id,
          status: 'CANCELLED'
        }
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/transfer-requests/${orphanReq.id}`,
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.employee).toBeDefined();
      expect(body.employee.fullName).toBe('Deleted Employee');
      expect(body.employee.employeeCode).toBe('N/A');
    });
  });

  // =========================================================================
  // Issue 2.5: Floor-Wise Department Filter & Scope Invariant
  // =========================================================================
  describe('Issue 2.5: Floor-Wise Department Filter & Seat Counts', () => {
    it('2.5A: GET /api/departments?floorId=<id> returns only departments present on that floor', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      // Create a dedicated department on floorU1
      const floorOnlyDept = await mockPrisma.department.create({
        data: {
          name: 'Precision Tooling',
          code: 'TOOL',
          colorHex: '#10B981',
          floorId: floorU1.id,
          unitId: unit1.id
        }
      });

      // Allocate seatA1 to floorOnlyDept
      await mockPrisma.seat.update({
        where: { id: seatA1.id },
        data: { departmentId: floorOnlyDept.id }
      });

      // Query departments for floorU1
      const res = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floorU1.id}`,
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);

      const foundTool = body.find((d: any) => d.id === floorOnlyDept.id);
      expect(foundTool).toBeDefined();
      expect(foundTool._count.seats).toBe(1);
      expect(foundTool.floorAllocatedSeats).toBe(1);
    });

    it('2.5B: GET /api/departments?floorId=<id>&scope=unit returns all unit departments', async () => {
      const superAdminCookie = await getCookie('superadmin@shaktiman.com');

      // Create a unit department in Unit 2
      const unit2Dept = await mockPrisma.department.create({
        data: {
          name: 'Unit 2 Operations',
          code: 'U2-OPS',
          colorHex: '#3B82F6',
          unitId: unit2.id
        }
      });

      const res = await server.inject({
        method: 'GET',
        url: `/api/departments?floorId=${floorU2.id}&scope=unit`,
        headers: { cookie: superAdminCookie }
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      const found = body.find((d: any) => d.id === unit2Dept.id);
      expect(found).toBeDefined();
      expect(found.unitId).toBe(unit2.id);
    });
  });
});
