import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { seed, DEMO_PASSWORD } from '../prisma/seed.js';

describe('Admin-Driven Facility Transfer Workflows & State Machine', () => {
  let server: FastifyInstance;
  let mockPrisma: any;

  // Hierarchy and test data references
  let unit1: any;
  let unit2: any;
  let unit5: any;
  let plant1UnderU1: any;
  let building1UnderU1: any;
  let floor1UnderU1: any;
  let targetSeatInU1: any;
  let targetSeat2InU1: any;
  let sourceSeatInU2: any;
  let sampleEmployee: any;
  let engDept: any;
  let u2Floor: any;

  let getCookie: (email: string) => Promise<string>;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
    await seed(mockPrisma, { includeDemoAccounts: true });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Helper to log in on demand
    getCookie = async (email: string) => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: DEMO_PASSWORD }
      });
      expect(res.statusCode).toBe(200);
      return res.headers['set-cookie'] as string;
    };

    // Fetch hierarchy units
    const units = await mockPrisma.unit.findMany();
    unit1 = units.find((u: any) => u.code === 'UNIT-1');
    unit2 = units.find((u: any) => u.code === 'UNIT-2');
    unit5 = units.find((u: any) => u.code === 'UNIT-5');

    // Fetch department
    const depts = await mockPrisma.department.findMany();
    engDept = depts.find((d: any) => d.code === 'ENG') || depts[0];

    // Create target structure in Unit 1 (Plant -> Building -> Floor -> Seats)
    plant1UnderU1 = await mockPrisma.plant.create({
      data: { name: 'Unit 1 Assembly Plant', code: 'PLT-U1-01', unitId: unit1.id }
    });
    building1UnderU1 = await mockPrisma.building.create({
      data: { name: 'Unit 1 Engineering Block', code: 'BLD-U1-01', plantId: plant1UnderU1.id }
    });
    floor1UnderU1 = await mockPrisma.floor.create({
      data: { name: 'Unit 1 Floor 1', floorNumber: 1, buildingId: building1UnderU1.id }
    });
    targetSeatInU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-WS-101',
        floorId: floor1UnderU1.id,
        x: 100,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });
    targetSeat2InU1 = await mockPrisma.seat.create({
      data: {
        label: 'U1-WS-102',
        floorId: floor1UnderU1.id,
        x: 200,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    // Create seated employee in Unit 2
    u2Floor = await mockPrisma.floor.findFirst({ where: { floorNumber: 2 } });
    sampleEmployee = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-ENG-U2-01',
        fullName: 'Rahul Verma',
        email: 'rahul.verma@shaktiman.com',
        departmentId: engDept.id
      }
    });

    sourceSeatInU2 = await mockPrisma.seat.create({
      data: {
        label: 'WS-U2-204',
        floorId: u2Floor.id,
        employeeId: sampleEmployee.id,
        departmentId: engDept.id,
        status: 'AVAILABLE'
      }
    });
  });

  afterEach(async () => {
    await server.close();
  });

  it('WORKFLOW-01: Full End-to-End Cross-Unit Transfer (Source Admin initiates -> Target Admin approves & allocates seat)', async () => {
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com'); // Target Unit Admin
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com'); // Source Unit Admin

    // 1. Source Unit Admin (Unit 2 Admin) submits cross-unit transfer request to Unit 1
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Relocating operator to Unit 1 Assembly line'
      }
    });

    expect(createRes.statusCode).toBe(201);
    const createdReq = JSON.parse(createRes.body);
    expect(createdReq.status).toBe('PENDING_TARGET_ADMIN');
    expect(createdReq.sourceUnitId).toBe(unit2.id);
    expect(createdReq.sourceSeatId).toBe(sourceSeatInU2.id);
    expect(createdReq.targetUnitId).toBe(unit1.id);
    expect(createdReq.requestNumber).toMatch(/^REQ-\d{4}-\d+/);
    expect(createdReq.sourceAdminApproval).toBeDefined();

    const reqId = createdReq.id;

    // 2. Unauthorized role: Source Unit Admin cannot self-approve target unit allocation
    const unauthApprove = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${reqId}/action`,
      headers: { cookie: unit2AdminCookie },
      payload: { action: 'APPROVE', assignedTargetSeatId: targetSeatInU1.id }
    });
    expect(unauthApprove.statusCode).toBe(403);
    expect(JSON.parse(unauthApprove.body).message).toMatch(/Target Unit Admin/i);

    // 3. Target Unit Admin (Unit 1 Admin) approves & allocates vacant seat
    const targetApproveRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${reqId}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        action: 'APPROVE',
        assignedTargetSeatId: targetSeatInU1.id,
        departmentId: engDept.id,
        comment: 'Allocated desk U1-WS-101 in Assembly Plant'
      }
    });

    expect(targetApproveRes.statusCode).toBe(200);
    const finalData = JSON.parse(targetApproveRes.body);
    expect(finalData.status).toBe('APPROVED');
    expect(finalData.targetSeatId).toBe(targetSeatInU1.id);
    expect(finalData.targetAdminApproval).toBeDefined();

    // 4. ACID Invariants: source is unseated; target is occupied through employeeId while status remains AVAILABLE.
    const dbSourceSeat = await mockPrisma.seat.findUnique({ where: { id: sourceSeatInU2.id } });
    expect(dbSourceSeat.employeeId).toBeNull();
    expect(dbSourceSeat.status).toBe('AVAILABLE');

    const dbTargetSeat = await mockPrisma.seat.findUnique({ where: { id: targetSeatInU1.id } });
    expect(dbTargetSeat.employeeId).toBe(sampleEmployee.id);
    expect(dbTargetSeat.status).toBe('AVAILABLE');

    // 5. Audit Trail Verification
    const logs = await mockPrisma.auditLog.findMany({
      where: { entityType: 'SeatTransferRequest' }
    });
    const loggedActions = logs.map((l: any) => l.action);
    expect(loggedActions).toContain('TRANSFER_REQUEST_CREATED');
    expect(loggedActions).toContain('TARGET_ADMIN_APPROVED');
  });

  it('WORKFLOW-02: Same-Unit transfer is rejected by the cross-Unit workflow', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    // Create another vacant seat on Unit 2 Floor 2
    const u2VacantSeat = await mockPrisma.seat.create({
      data: {
        label: 'WS-U2-NEW-DESK',
        floorId: u2Floor.id,
        x: 300,
        y: 300,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE'
      }
    });

    const plant2 = await mockPrisma.plant.findFirst({ where: { unitId: unit2.id } });
    const bld2 = await mockPrisma.building.findFirst({ where: { plantId: plant2.id } });

    // Unit 2 Admin directly moves employee to new desk within Unit 2
    const moveRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit2.id,
        targetPlantId: plant2.id,
        targetBuildingId: bld2.id,
        targetFloorId: u2Floor.id,
        targetSeatId: u2VacantSeat.id,
        reason: 'Internal departmental desk realignment'
      }
    });

    expect(moveRes.statusCode).toBe(400);
    expect(JSON.parse(moveRes.body).error).toBe('SAME_UNIT_TRANSFER_NOT_ALLOWED');

    // Old source seat is released
    const oldSeat = await mockPrisma.seat.findUnique({ where: { id: sourceSeatInU2.id } });
    expect(oldSeat.employeeId).toBe(sampleEmployee.id);

    // Target seat is occupied
    const newSeat = await mockPrisma.seat.findUnique({ where: { id: u2VacantSeat.id } });
    expect(newSeat.employeeId).toBeNull();
    expect(newSeat.status).toBe('AVAILABLE');

    // Verify NO pending SeatTransferRequest was created
    const pendingReqs = await mockPrisma.seatTransferRequest.findMany({
      where: { employeeId: sampleEmployee.id, status: 'PENDING_TARGET_ADMIN' }
    });
    expect(pendingReqs.length).toBe(0);
  });

  it('WORKFLOW-03: Super Admin requires an explicit, resolvable source Unit', async () => {
    const superAdminCookie = await getCookie('superadmin@shaktiman.com');

    // Create an unseated employee
    const newJoinee = await mockPrisma.employee.create({
      data: {
        fullName: 'New Joinee Engineer',
        employeeCode: 'EMP-NEW-777',
        email: 'newjoinee@shaktiman.com',
        departmentId: engDept.id
      }
    });

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdminCookie },
      payload: {
        employeeId: newJoinee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Workstation provisioning for fresh joinee'
      }
    });

    expect(createRes.statusCode).toBe(400);
    expect(JSON.parse(createRes.body).error).toBe('SOURCE_UNIT_REQUIRED');
    expect(JSON.parse(createRes.body).message).toMatch(/source Unit/i);
  });

  it('WORKFLOW-04: SUPER_ADMIN can create and approve a valid cross-Unit transfer', async () => {
    const superAdminCookie = await getCookie('superadmin@shaktiman.com');

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: superAdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        sourceUnitId: unit2.id,
        targetUnitId: unit1.id,
        reason: 'Urgent transfer'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const req = JSON.parse(createRes.body);
    expect(req.status).toBe('PENDING_TARGET_ADMIN');

    const approveRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: superAdminCookie },
      payload: {
        action: 'APPROVE',
        comment: 'Executive priority allocation',
        assignedTargetSeatId: targetSeatInU1.id,
        departmentId: engDept.id
      }
    });

    expect(approveRes.statusCode).toBe(200);
    const approved = JSON.parse(approveRes.body);
    expect(approved.status).toBe('APPROVED');
    expect(approved.targetAdminApproval.adminRole).toBe('SUPER_ADMIN');
    expect(approved.targetAdminApproval.approverName).toMatch(/Super Admin/i);

    const checkTargetSeat = await mockPrisma.seat.findUnique({ where: { id: targetSeatInU1.id } });
    expect(checkTargetSeat.employeeId).toBe(sampleEmployee.id);
  });

  it('WORKFLOW-05: Target Admin Rejection marks status REJECTED and preserves existing source seat untouched', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Transfer request to be rejected'
      }
    });
    const req = JSON.parse(createRes.body);

    // Target Admin rejects
    const rejectRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        action: 'REJECT',
        comment: 'No vacant capacity available in Unit 1 assembly block'
      }
    });

    expect(rejectRes.statusCode).toBe(200);
    const rejected = JSON.parse(rejectRes.body);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('No vacant capacity available in Unit 1 assembly block');

    // Source seat remains occupied by the employee
    const checkSourceSeat = await mockPrisma.seat.findUnique({ where: { id: sourceSeatInU2.id } });
    expect(checkSourceSeat.employeeId).toBe(sampleEmployee.id);
  });

  it('WORKFLOW-06: Scoped Visibility: Super Admin sees all, Unit Admins see only their source/target requests', async () => {
    const superAdminCookie = await getCookie('superadmin@shaktiman.com');
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');
    const unit5AdminCookie = await getCookie('unit5.admin@shaktiman.com');
    // 1. Create request: Unit 2 -> Unit 1
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Visibility verification'
      }
    });
    const req = JSON.parse(createRes.body);

    // Super Admin sees it
    const saInbox = await server.inject({ method: 'GET', url: '/api/transfer-requests', headers: { cookie: superAdminCookie } });
    expect(saInbox.statusCode).toBe(200);
    expect(JSON.parse(saInbox.body).some((r: any) => r.id === req.id)).toBe(true);

    // Source Admin (Unit 2) sees it
    const u2Inbox = await server.inject({ method: 'GET', url: '/api/transfer-requests', headers: { cookie: unit2AdminCookie } });
    expect(u2Inbox.statusCode).toBe(200);
    expect(JSON.parse(u2Inbox.body).some((r: any) => r.id === req.id)).toBe(true);

    // Target Admin (Unit 1) sees it
    const u1Inbox = await server.inject({ method: 'GET', url: '/api/transfer-requests', headers: { cookie: unit1AdminCookie } });
    expect(u1Inbox.statusCode).toBe(200);
    expect(JSON.parse(u1Inbox.body).some((r: any) => r.id === req.id)).toBe(true);

    // Unit 5 Admin CANNOT see it (different unit)
    const u5Inbox = await server.inject({ method: 'GET', url: '/api/transfer-requests', headers: { cookie: unit5AdminCookie } });
    expect(u5Inbox.statusCode).toBe(200);
    expect(JSON.parse(u5Inbox.body).some((r: any) => r.id === req.id)).toBe(false);

    // Unit 5 Admin direct GET /:id receives 403 Forbidden
    const u5Detail = await server.inject({ method: 'GET', url: `/api/transfer-requests/${req.id}`, headers: { cookie: unit5AdminCookie } });
    expect(u5Detail.statusCode).toBe(403);
  });

  it('WORKFLOW-07: Concurrency & Conflict: Target Admin selecting occupied seat gets 409, selecting alternate vacant seat succeeds', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Concurrent test'
      }
    });
    const req = JSON.parse(createRes.body);

    // Another employee takes targetSeatInU1 concurrently
    await mockPrisma.seat.update({
      where: { id: targetSeatInU1.id },
      data: { employeeId: 'concurrent-user-id', status: 'AVAILABLE' }
    });

    // Unit 1 Admin attempts to approve with now-occupied seat -> 409 Conflict
    const conflictRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: { action: 'APPROVE', assignedTargetSeatId: targetSeatInU1.id }
    });
    expect(conflictRes.statusCode).toBe(409);

    // Unit 1 Admin selects alternate vacant seat (targetSeat2InU1) -> 200 OK
    const resolveRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: { action: 'APPROVE', assignedTargetSeatId: targetSeat2InU1.id, departmentId: engDept.id }
    });
    expect(resolveRes.statusCode).toBe(200);
    const resolved = JSON.parse(resolveRes.body);
    expect(resolved.status).toBe('APPROVED');
    expect(resolved.targetSeatId).toBe(targetSeat2InU1.id);

    const seat2Check = await mockPrisma.seat.findUnique({ where: { id: targetSeat2InU1.id } });
    expect(seat2Check.employeeId).toBe(sampleEmployee.id);
  });

  it('WORKFLOW-08: Target seat with MAINTENANCE status cannot be allocated', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

    const maintSeat = await mockPrisma.seat.create({
      data: {
        label: 'U1-WS-MAINT',
        floorId: floor1UnderU1.id,
        x: 300,
        y: 100,
        type: 'STANDARD_DESK',
        status: 'MAINTENANCE'
      }
    });

    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        employeeId: sampleEmployee.id,
        reason: 'Maintenance test'
      }
    });
    const req = JSON.parse(createRes.body);

    const forceRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: { action: 'APPROVE', assignedTargetSeatId: maintSeat.id, departmentId: engDept.id }
    });
    expect(forceRes.statusCode).toBe(409);
    expect(JSON.parse(forceRes.body).error).toBe('TRANSFER_DESTINATION_NOT_AVAILABLE');
    expect(JSON.parse(forceRes.body).message).toBe('This workstation is no longer available.');
  });

  it('WORKFLOW-09: Target hierarchy validation rejects mismatched IDs', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

    // Target floor in Unit 1, but targetUnitId given is Unit 2
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        reason: 'Hierarchy mismatch test'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const req = JSON.parse(createRes.body);

    const approveRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${req.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        action: 'APPROVE',
        assignedTargetSeatId: targetSeatInU1.id,
        departmentId: engDept.id,
        targetFloorId: u2Floor.id
      }
    });
    expect(approveRes.statusCode).toBe(400);
    expect(JSON.parse(approveRes.body).message).toContain('Floor does not contain');
  });

  it('WORKFLOW-10: Image Proof upload validation rejects invalid data URLs and accepts valid image data URL', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    // Invalid proof format
    const badRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Proof validation test',
        proofImageUrl: 'data:application/pdf;base64,JVBERi0xLjQK'
      }
    });
    expect(badRes.statusCode).toBe(400);
    expect(JSON.parse(badRes.body).message).toMatch(/valid base64 image data URL/i);

    // Valid image data URL succeeds
    const validRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Valid proof image test',
        proofImageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        proofFileName: 'transfer_order.png'
      }
    });
    expect(validRes.statusCode).toBe(201);
    const data = JSON.parse(validRes.body);
    expect(data.proofFileName).toBe('transfer_order.png');
    expect(data.proofImageUrl).toContain('data:image/png;base64');
  });

  it('WORKFLOW-11: Unit 1 Admin CANNOT initiate transfer for employee originating from Unit 2 (403 Forbidden)', async () => {
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');

    const leakRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit1AdminCookie },
      payload: {
        employeeId: sampleEmployee.id, // sampleEmployee is currently seated in Unit 2
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Poaching employee from Unit 2'
      }
    });

    expect(leakRes.statusCode).toBe(403);
    expect(JSON.parse(leakRes.body).message).toMatch(/within their assigned unit/i);
  });

  it('WORKFLOW-12: Unauthenticated caller receives 401 Unauthorized', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Unauthenticated attempt'
      }
    });
    expect(res.statusCode).toBe(401);
  });

  it('WORKFLOW-13: Transfer creation falls back to notifying SUPER_ADMIN when target unit has no Unit Admin', async () => {
    // Delete all UNIT_ADMINs assigned to Unit 1 so Unit 1 has 0 Unit Admins
    await mockPrisma.adminUser.deleteMany({
      where: { role: 'UNIT_ADMIN', assignedUnitId: unit1.id }
    });

    // Verify 0 Unit Admins for Unit 1
    const unit1Admins = await mockPrisma.adminUser.findMany({
      where: { role: 'UNIT_ADMIN', assignedUnitId: unit1.id }
    });
    expect(unit1Admins.length).toBe(0);

    // Source admin (Unit 2 Admin) creates transfer targeting Unit 1
    const u2Cookie = await getCookie('unit2.admin@shaktiman.com');
    const res = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: u2Cookie },
      payload: {
        employeeId: sampleEmployee.id,
        targetUnitId: unit1.id,
        reason: 'Transferring to unit with no unit admin currently assigned'
      }
    });

    // Must NOT crash transaction with 500 / NOTIFICATION_RECIPIENT_MISSING; must return 201 Created
    expect(res.statusCode).toBe(201);
    const createdTransfer = res.json();
    expect(createdTransfer.status).toBe('PENDING_TARGET_ADMIN');

    // Verify notification was delivered to active SUPER_ADMIN
    const superAdmins = await mockPrisma.adminUser.findMany({
      where: { role: 'SUPER_ADMIN' }
    });
    expect(superAdmins.length).toBeGreaterThan(0);

    const notifications = await mockPrisma.notification.findMany({
      where: { transferRequestId: createdTransfer.id }
    });
    expect(notifications.length).toBeGreaterThan(0);
    const superAdminIds = new Set(superAdmins.map((a: any) => a.id));
    const notifiedSuperAdmin = notifications.some((n: any) => superAdminIds.has(n.recipientAdminId));
    expect(notifiedSuperAdmin).toBe(true);
  });

  it('WORKFLOW-14: Auto-Reject pending transfer request on employee deactivation with admin attribution', async () => {
    const superAdminCookie = await getCookie('superadmin@shaktiman.com');
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    // Create a department scoped to Unit 2 so employee belongs to Unit 2
    const u2Dept = await mockPrisma.department.create({
      data: {
        name: 'Unit 2 Assembly',
        code: 'U2-ASY',
        unitId: unit2.id,
        colorHex: '#10B981'
      }
    });

    // 1. Create an active employee in Unit 2 seated on u2Floor
    const activeEmp = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-DEACT-001',
        fullName: 'Vikram Malhotra',
        email: 'vikram.malhotra@shaktiman.com',
        departmentId: u2Dept.id,
        isActive: true
      }
    });

    const empSeat = await mockPrisma.seat.create({
      data: {
        label: 'U2-WS-991',
        floorId: u2Floor.id,
        x: 150,
        y: 150,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        employeeId: activeEmp.id
      }
    });

    // 2. Initiate a cross-unit transfer request from Unit 2 to Unit 1
    const createTransferRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: activeEmp.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Transferring to Unit 1 engineering'
      }
    });
    expect(createTransferRes.statusCode).toBe(201);
    const transferData = createTransferRes.json();
    expect(transferData.status).toBe('PENDING_TARGET_ADMIN');
    expect(transferData.activeTransferKey).toBeDefined();

    // 3. Deactivate employee as Super Admin via PUT /api/employees/:id
    const deactRes = await server.inject({
      method: 'PUT',
      url: `/api/employees/${activeEmp.id}`,
      headers: { cookie: superAdminCookie },
      payload: {
        isActive: false
      }
    });
    expect(deactRes.statusCode).toBe(200);
    const deactBody = deactRes.json();
    expect(deactBody.isActive).toBe(false);

    // 4. Verify transfer request was automatically REJECTED
    const updatedTransfer = await mockPrisma.seatTransferRequest.findUnique({
      where: { id: transferData.id }
    });
    expect(updatedTransfer).toBeDefined();
    expect(updatedTransfer.status).toBe('REJECTED');
    expect(updatedTransfer.activeTransferKey).toBeNull();
    // Rejection reason contains admin's identity (name or email)
    expect(updatedTransfer.rejectionReason).toContain('Employee was inactivated during transfer by');
    expect(
      updatedTransfer.rejectionReason.includes('Super Admin') ||
      updatedTransfer.rejectionReason.includes('superadmin@shaktiman.com')
    ).toBe(true);

    // 5. Verify targetAdminApproval trail record was populated with REJECT
    const approval = updatedTransfer.targetAdminApproval as any;
    expect(approval).toBeDefined();
    expect(approval.action).toBe('REJECT');
    expect(approval.comment).toBe(updatedTransfer.rejectionReason);

    // Verify employee seat was released
    const freedSeat = await mockPrisma.seat.findUnique({ where: { id: empSeat.id } });
    expect(freedSeat?.employeeId).toBeNull();

    // 6. Verify audit logs record the auto-rejection
    const auditLogs = await mockPrisma.auditLog.findMany({
      where: {
        entityId: transferData.id
      }
    });
    const rejectAudit = auditLogs.find((l: any) => l.action === 'TRANSFER_REJECTED');
    expect(rejectAudit).toBeDefined();
    expect(rejectAudit.metadata?.autoRejectedDueToEmployeeDeactivation).toBe(true);
  });

  it('WORKFLOW-15: Auto-Reject pending transfer request when Unit Admin deactivates employee and release partial unique key', async () => {
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    const u2Dept = await mockPrisma.department.create({
      data: {
        name: 'Unit 2 Production',
        code: 'U2-PRD',
        unitId: unit2.id,
        colorHex: '#3B82F6'
      }
    });

    // 1. Create an active employee in Unit 2
    const activeEmp = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-DEACT-U2',
        fullName: 'Kiran Patel',
        email: 'kiran.patel@shaktiman.com',
        departmentId: u2Dept.id,
        isActive: true
      }
    });

    const empSeat = await mockPrisma.seat.create({
      data: {
        label: 'U2-WS-992',
        floorId: u2Floor.id,
        x: 160,
        y: 160,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        employeeId: activeEmp.id
      }
    });

    // 2. Initiate transfer from Unit 2 to Unit 1
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: activeEmp.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Relocation'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const transfer = createRes.json();
    expect(transfer.status).toBe('PENDING_TARGET_ADMIN');

    // 3. Deactivate by Unit 2 Admin
    const deactRes = await server.inject({
      method: 'PUT',
      url: `/api/employees/${activeEmp.id}`,
      headers: { cookie: unit2AdminCookie },
      payload: {
        isActive: false
      }
    });
    expect(deactRes.statusCode).toBe(200);

    // 4. Verify transfer request is REJECTED with Unit 2 Admin identity
    const updated = await mockPrisma.seatTransferRequest.findUnique({
      where: { id: transfer.id }
    });
    expect(updated.status).toBe('REJECTED');
    expect(updated.activeTransferKey).toBeNull();
    expect(updated.rejectionReason).toContain('Employee was inactivated during transfer by');
    expect(
      updated.rejectionReason.includes('Unit 2 Admin') ||
      updated.rejectionReason.includes('unit2.admin@shaktiman.com')
    ).toBe(true);

    // 5. Reactivate employee and verify activeTransferKey was cleared so a fresh transfer can be initiated
    const reactivateRes = await server.inject({
      method: 'PUT',
      url: `/api/employees/${activeEmp.id}`,
      headers: { cookie: unit2AdminCookie },
      payload: {
        isActive: true
      }
    });
    expect(reactivateRes.statusCode).toBe(200);

    const freshTransferRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: activeEmp.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Second attempt after reactivation'
      }
    });
    expect(freshTransferRes.statusCode).toBe(201);
    expect(freshTransferRes.json().status).toBe('PENDING_TARGET_ADMIN');
  });

  it('WORKFLOW-16: Processing transfer request (APPROVE) auto-marks incoming notification as read and decrements unread count', async () => {
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    // 1. Create a fresh employee in Unit 2
    const emp = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-NOTIF-APP',
        fullName: 'Notification Approve Tester',
        email: 'notif.approve@shaktiman.com',
        departmentId: engDept.id,
        isActive: true
      }
    });

    await mockPrisma.seat.create({
      data: {
        label: 'U2-WS-NOTIF-1',
        floorId: u2Floor.id,
        x: 170,
        y: 170,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        employeeId: emp.id
      }
    });

    // 2. Unit 2 Admin initiates transfer to Unit 1
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: emp.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Testing auto-mark read on approve'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const transfer = createRes.json();

    // 3. Verify Target Admin (Unit 1 Admin) has unread incoming notification
    const beforeNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit1AdminCookie }
    });
    expect(beforeNotifRes.statusCode).toBe(200);
    const beforeData = beforeNotifRes.json();
    const incomingNotif = beforeData.notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_PENDING');
    expect(incomingNotif).toBeDefined();
    expect(incomingNotif.readAt).toBeNull();
    const initialUnreadCount = beforeData.unreadCount;
    expect(initialUnreadCount).toBeGreaterThanOrEqual(1);

    // 4. Target Admin (Unit 1 Admin) approves the transfer
    const approveRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${transfer.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        action: 'APPROVE',
        assignedTargetSeatId: targetSeatInU1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        departmentId: engDept.id,
        comment: 'Seat allocated successfully'
      }
    });
    expect(approveRes.statusCode).toBe(200);

    // 5. Verify incoming notification is auto-marked as read and unreadCount is decremented
    const afterNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit1AdminCookie }
    });
    expect(afterNotifRes.statusCode).toBe(200);
    const afterData = afterNotifRes.json();
    const updatedIncomingNotif = afterData.notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_PENDING');
    expect(updatedIncomingNotif).toBeDefined();
    expect(updatedIncomingNotif.readAt).not.toBeNull();
    expect(afterData.unreadCount).toBe(initialUnreadCount - 1);

    // 6. Verify Source Admin (Unit 2 Admin) received the unread outcome notification (TRANSFER_APPROVED)
    const sourceNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit2AdminCookie }
    });
    expect(sourceNotifRes.statusCode).toBe(200);
    const approvedNotif = sourceNotifRes.json().notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_APPROVED');
    expect(approvedNotif).toBeDefined();
    expect(approvedNotif.readAt).toBeNull();
  });

  it('WORKFLOW-17: Processing transfer request (REJECT) auto-marks incoming notification as read and decrements unread count', async () => {
    const unit1AdminCookie = await getCookie('unit1.admin@shaktiman.com');
    const unit2AdminCookie = await getCookie('unit2.admin@shaktiman.com');

    // 1. Create another employee in Unit 2
    const emp = await mockPrisma.employee.create({
      data: {
        employeeCode: 'EMP-NOTIF-REJ',
        fullName: 'Notification Reject Tester',
        email: 'notif.reject@shaktiman.com',
        departmentId: engDept.id,
        isActive: true
      }
    });

    await mockPrisma.seat.create({
      data: {
        label: 'U2-WS-NOTIF-2',
        floorId: u2Floor.id,
        x: 180,
        y: 180,
        type: 'STANDARD_DESK',
        status: 'AVAILABLE',
        employeeId: emp.id
      }
    });

    // 2. Unit 2 Admin initiates transfer to Unit 1
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/transfer-requests',
      headers: { cookie: unit2AdminCookie },
      payload: {
        employeeId: emp.id,
        targetUnitId: unit1.id,
        targetPlantId: plant1UnderU1.id,
        targetBuildingId: building1UnderU1.id,
        targetFloorId: floor1UnderU1.id,
        reason: 'Testing auto-mark read on reject'
      }
    });
    expect(createRes.statusCode).toBe(201);
    const transfer = createRes.json();

    // 3. Verify Target Admin (Unit 1 Admin) has unread incoming notification
    const beforeNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit1AdminCookie }
    });
    const beforeData = beforeNotifRes.json();
    const incomingNotif = beforeData.notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_PENDING');
    expect(incomingNotif).toBeDefined();
    expect(incomingNotif.readAt).toBeNull();
    const initialUnread = beforeData.unreadCount;

    // 4. Target Admin (Unit 1 Admin) rejects the transfer
    const rejectRes = await server.inject({
      method: 'POST',
      url: `/api/transfer-requests/${transfer.id}/action`,
      headers: { cookie: unit1AdminCookie },
      payload: {
        action: 'REJECT',
        comment: 'No capacity available in Unit 1'
      }
    });
    expect(rejectRes.statusCode).toBe(200);

    // 5. Verify incoming notification is auto-marked as read and unread count decremented
    const afterNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit1AdminCookie }
    });
    const afterData = afterNotifRes.json();
    const updatedIncoming = afterData.notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_PENDING');
    expect(updatedIncoming).toBeDefined();
    expect(updatedIncoming.readAt).not.toBeNull();
    expect(afterData.unreadCount).toBe(initialUnread - 1);

    // 6. Verify Source Admin (Unit 2 Admin) received the unread outcome notification (TRANSFER_REJECTED)
    const sourceNotifRes = await server.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: unit2AdminCookie }
    });
    const rejectedNotif = sourceNotifRes.json().notifications.find((n: any) => n.transferRequestId === transfer.id && n.type === 'TRANSFER_REJECTED');
    expect(rejectedNotif).toBeDefined();
    expect(rejectedNotif.readAt).toBeNull();
  });
});
