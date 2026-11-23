import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

describe('Milestone 3 Integration: Reports, CSV Export & Audit Logs (Features 21 through 24)', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let floorId: string;
  let emptyFloorId: string;
  let seatId1: string;
  let seatId2: string;
  let empId: string;

  beforeEach(async () => {
    const mockPrisma = await createMockPrisma();
    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    // Authenticate admin
    const loginRes = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: DEFAULT_ADMIN.email,
        password: DEFAULT_ADMIN.password
      }
    });
    sessionCookie = loginRes.headers['set-cookie'] as string;

    // Seed office, building, floors
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Analytics HQ', city: 'Chicago' }
    });
    const office = offRes.json();

    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Building C', code: 'BLD-C', officeId: office.id }
    });
    const building = bldRes.json();

    const flr1Res = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Active Floor', floorNumber: 1, buildingId: building.id }
    });
    floorId = flr1Res.json().id;

    const flr2Res = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Empty Floor', floorNumber: 2, buildingId: building.id }
    });
    emptyFloorId = flr2Res.json().id;

    // Seed department & employee
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Analytics Team', code: 'ANALYTICS', colorHex: '#10B981' }
    });
    const dept = deptRes.json();

    const empRes = await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-ANL-1', fullName: 'Anna Analyst', email: 'anna@company.com', departmentId: dept.id }
    });
    empId = empRes.json().id;

    // Seed 2 seats on active floor: one occupied, one vacant
    const layoutRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floorId}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'SEAT-OCC', x: 50, y: 50 },
          { label: 'SEAT-VAC', x: 150, y: 50 }
        ]
      }
    });
    const seats = layoutRes.json().seats;
    seatId1 = seats[0].id;
    seatId2 = seats[1].id;

    // Assign Seat 1 to Anna
    await server.inject({
      method: 'POST',
      url: `/api/seats/${seatId1}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: empId }
    });
  });

  afterEach(async () => {
    await server.close();
  });

  // Feature 22: Occupancy Reporting APIs
  it('REPORT-01: GET /api/reports/summary calculates accurate KPIs and handles zero-seat floor safely', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { cookie: sessionCookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();

    // KPIs
    expect(body.kpis).toBeDefined();
    expect(body.kpis.totalSeats).toBe(2);
    expect(body.kpis.occupiedSeats).toBe(1);
    expect(body.kpis.availableSeats).toBe(1);
    expect(body.kpis.overallOccupancyRate).toBe(50.0);
    expect(body.kpis.overallVacancyRate).toBe(50.0);

    // Breakdowns
    expect(body.byOffice).toHaveLength(1);
    expect(body.byOffice[0].totalSeats).toBe(2);
    expect(body.byOffice[0].occupiedSeats).toBe(1);

    // Empty floor safety (division by zero protection)
    const emptyFlrReport = body.byFloor.find((f: any) => f.floorId === emptyFloorId);
    expect(emptyFlrReport).toBeDefined();
    expect(emptyFlrReport.totalSeats).toBe(0);
    expect(emptyFlrReport.occupancyRate).toBe(0.0);

    // GET /api/reports/occupancy acts as an alias
    const aliasRes = await server.inject({
      method: 'GET',
      url: '/api/reports/occupancy',
      headers: { cookie: sessionCookie }
    });
    expect(aliasRes.statusCode).toBe(200);
    expect(aliasRes.json().kpis.totalSeats).toBe(2);
  });

  it('REPORT-QUALITY-01: GET /api/reports/data-quality returns scoped integrity counters', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/reports/data-quality',
      headers: { cookie: sessionCookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({
      employees: 1,
      seats: 2,
      occupiedSeats: 1,
      vacantSeats: 1,
      duplicateEmployeeCodes: 0,
      duplicateSeats: 0
    });
    expect(body.issues.activeEmployeesWithoutSeat).toHaveLength(0);
  });

  // Feature 23: Employee Seat CSV Export API
  it('REPORT-02: GET /api/reports/export-csv returns text/csv attachment with exact 11 headers', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/reports/export-csv',
      headers: { cookie: sessionCookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');

    const csvText = res.body;
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3); // header + 2 seats

    // Check exact 12 required headers
    const headerLine = lines[0];
    const expectedHeaders = [
      'Unit Name',
      'Plant Name',
      'Building Name',
      'Floor Name',
      'Seat Label',
      'Seat Type',
      'Seat Status',
      'Employee Code',
      'Employee Name',
      'Employee Email',
      'Department Code',
      'Department Name'
    ];

    for (const h of expectedHeaders) {
      expect(headerLine).toContain(h);
    }

    // Check occupied seat row
    const occRow = lines.find((l) => l.includes('SEAT-OCC'));
    expect(occRow).toBeDefined();
    expect(occRow).toContain('Anna Analyst');
    expect(occRow).toContain('EMP-ANL-1');

    // Check vacant seat row
    const vacRow = lines.find((l) => l.includes('SEAT-VAC'));
    expect(vacRow).toBeDefined();
    expect(vacRow).toContain('AVAILABLE');
  });

  // Feature 24: Audit Log Query API & Immutability
  it('REPORT-03: GET /api/audit-logs supports action alias, newest-first order, and admin info', async () => {
    // Query with action alias ASSIGN_SEAT -> maps to SEAT_ASSIGNED
    const res = await server.inject({
      method: 'GET',
      url: '/api/audit-logs?action=ASSIGN_SEAT',
      headers: { cookie: sessionCookie }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.logs).toBeDefined();
    expect(body.logs.length).toBeGreaterThanOrEqual(1);

    const assignLog = body.logs.find((l: any) => l.entityId === seatId1);
    expect(assignLog).toBeDefined();
    expect(assignLog.action).toBe('SEAT_ASSIGNED');
    expect(assignLog.admin).toBeDefined();
    expect(assignLog.admin.email).toBe(DEFAULT_ADMIN.email.toLowerCase());
  });

  it('REPORT-04: Immutability: DELETE /api/audit-logs is rejected with 404 or 405', async () => {
    const res = await server.inject({
      method: 'DELETE',
      url: '/api/audit-logs',
      headers: { cookie: sessionCookie }
    });

    expect([404, 405]).toContain(res.statusCode);
  });

  it('REPORT-05: GET /api/reports/summary supports floorId query param and attaches departments to floors', async () => {
    const resAll = await server.inject({
      method: 'GET',
      url: '/api/reports/summary',
      headers: { cookie: sessionCookie }
    });
    expect(resAll.statusCode).toBe(200);
    const bodyAll = resAll.json();
    expect(bodyAll.byFloor).toBeDefined();

    // Verify departments array is attached to floors
    const activeFloor = bodyAll.byFloor.find((f: any) => f.floorId === floorId);
    expect(activeFloor).toBeDefined();
    expect(activeFloor.departments).toBeDefined();
    expect(activeFloor.departments.length).toBeGreaterThanOrEqual(1);
    expect(activeFloor.departments[0].allocatedSeats).toBe(1);

    // Verify floorId query filter
    const resFiltered = await server.inject({
      method: 'GET',
      url: `/api/reports/summary?floorId=${floorId}`,
      headers: { cookie: sessionCookie }
    });
    expect(resFiltered.statusCode).toBe(200);
    const bodyFiltered = resFiltered.json();
    expect(bodyFiltered.byDepartment).toBeDefined();
    const analyticsDept = bodyFiltered.byDepartment.find((d: any) => d.departmentName === 'Analytics Team');
    expect(analyticsDept).toBeDefined();
    expect(analyticsDept.allocatedSeats).toBe(1);
    expect(analyticsDept.floorAllocations[floorId]).toBe(1);
  });
});
