import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import argon2 from 'argon2';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';

function expectStandardError(
  res: { statusCode: number; json: () => any },
  statusCode: number,
  errorLabel: 'Bad Request' | 'Forbidden' | 'Not Found' | 'Conflict'
) {
  expect(res.statusCode).toBe(statusCode);
  const body = res.json();
  expect(Object.keys(body).sort()).toEqual(['error', 'message', 'statusCode']);
  expect(body.statusCode).toBe(statusCode);
  expect(body.error).toBe(errorLabel);
  expect(typeof body.message).toBe('string');
  expect(body.message.trim().length).toBeGreaterThan(0);
}

describe('Category Management API Standardized Errors & CRUD', () => {
  let server: FastifyInstance;
  let mockPrisma: any;
  let superCookie: string;
  let unit1Cookie: string;

  let unit1Id: string;
  let unit2Id: string;
  let plant1Id: string;
  let plant2Id: string;
  let bld1Id: string;
  let bld2Id: string;
  let floor1Id: string;
  let floor2Id: string;
  let dept1Id: string;
  let dept2Id: string;
  let area1Id: string;
  let area2Id: string;
  let section1Id: string;
  let section2Id: string;
  let fn1Id: string;
  let fn2Id: string;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();

    const u1 = await mockPrisma.unit.create({ data: { name: 'Unit One', code: 'U1' } });
    const u2 = await mockPrisma.unit.create({ data: { name: 'Unit Two', code: 'U2' } });
    unit1Id = u1.id;
    unit2Id = u2.id;

    const p1 = await mockPrisma.plant.create({ data: { name: 'Plant 1', code: 'P1', unitId: u1.id } });
    const p2 = await mockPrisma.plant.create({ data: { name: 'Plant 2', code: 'P2', unitId: u2.id } });
    plant1Id = p1.id;
    plant2Id = p2.id;

    const b1 = await mockPrisma.building.create({ data: { name: 'Bld 1', code: 'B1', plantId: p1.id } });
    const b2 = await mockPrisma.building.create({ data: { name: 'Bld 2', code: 'B2', plantId: p2.id } });
    bld1Id = b1.id;
    bld2Id = b2.id;

    const f1 = await mockPrisma.floor.create({ data: { name: 'Floor 1', floorNumber: 1, buildingId: b1.id } });
    const f2 = await mockPrisma.floor.create({ data: { name: 'Floor 2', floorNumber: 1, buildingId: b2.id } });
    floor1Id = f1.id;
    floor2Id = f2.id;

    const d1 = await mockPrisma.department.create({ data: { name: 'Dept 1', code: 'D1', colorHex: '#3B82F6', unitId: u1.id } });
    const d2 = await mockPrisma.department.create({ data: { name: 'Dept 2', code: 'D2', colorHex: '#10B981', unitId: u2.id } });
    dept1Id = d1.id;
    dept2Id = d2.id;

    const a1 = await mockPrisma.area.create({ data: { name: 'Area 1', normalizedName: 'area 1', floorId: f1.id } });
    const a2 = await mockPrisma.area.create({ data: { name: 'Area 2', normalizedName: 'area 2', floorId: f2.id } });
    area1Id = a1.id;
    area2Id = a2.id;

    const s1 = await mockPrisma.section.create({ data: { name: 'Section 1', normalizedName: 'section 1', departmentId: d1.id } });
    const s2 = await mockPrisma.section.create({ data: { name: 'Section 2', normalizedName: 'section 2', departmentId: d2.id } });
    section1Id = s1.id;
    section2Id = s2.id;

    const fn1 = await mockPrisma.orgFunction.create({ data: { name: 'Fn 1', normalizedName: 'fn 1', sectionId: s1.id } });
    const fn2 = await mockPrisma.orgFunction.create({ data: { name: 'Fn 2', normalizedName: 'fn 2', sectionId: s2.id } });
    fn1Id = fn1.id;
    fn2Id = fn2.id;

    const unitAdminPassword = 'UnitAdminPass!123';
    await mockPrisma.adminUser.create({
      data: {
        email: 'unit1.cat@shaktiman.com',
        passwordHash: await argon2.hash(unitAdminPassword, { type: argon2.argon2id }),
        name: 'Unit 1 Admin',
        role: 'UNIT_ADMIN',
        assignedUnitId: u1.id
      }
    });

    server = buildServer({
      prisma: mockPrisma,
      sessionSecret: 'a-very-long-32-byte-secret-key-for-fastify-session-security!!'
    });
    await server.ready();

    const superLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: DEFAULT_ADMIN.email, password: DEFAULT_ADMIN.password }
    });
    superCookie = superLogin.headers['set-cookie'] as string;

    const unitLogin = await server.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'unit1.cat@shaktiman.com', password: unitAdminPassword }
    });
    unit1Cookie = unitLogin.headers['set-cookie'] as string;
  });

  afterEach(async () => {
    await server.close();
  });

  it('returns standard 400 Bad Request errors for invalid POST, PUT, and PATCH across all 6 category families', async () => {
    const cases = [
      {
        base: '/api/buildings',
        id: bld1Id,
        badPost: { name: ' ', code: '', plantId: plant1Id },
        badPut: { name: ' ' },
        badPatch: { isActive: 'yes' }
      },
      {
        base: '/api/floors',
        id: floor1Id,
        badPost: { name: 'Floor X', floorNumber: 1.5, buildingId: bld1Id },
        badPut: { name: '' },
        badPatch: {}
      },
      {
        base: '/api/departments',
        id: dept1Id,
        badPost: { name: 'Dept X', code: 'DX', colorHex: 'invalid' },
        badPut: { colorHex: '#123' },
        badPatch: { isActive: 1 }
      },
      {
        base: '/api/areas',
        id: area1Id,
        badPost: { name: '   ', floorId: floor1Id },
        badPut: { name: '   ' },
        badPatch: {}
      },
      {
        base: '/api/sections',
        id: section1Id,
        badPost: { name: '', departmentId: dept1Id },
        badPut: { name: '' },
        badPatch: { isActive: 'true' }
      },
      {
        base: '/api/functions',
        id: fn1Id,
        badPost: { name: '', sectionId: section1Id },
        badPut: { name: '' },
        badPatch: {}
      }
    ];

    for (const c of cases) {
      const postRes = await server.inject({
        method: 'POST',
        url: c.base,
        headers: { cookie: superCookie },
        payload: c.badPost
      });
      expectStandardError(postRes, 400, 'Bad Request');

      const putRes = await server.inject({
        method: 'PUT',
        url: `${c.base}/${c.id}`,
        headers: { cookie: superCookie },
        payload: c.badPut
      });
      expectStandardError(putRes, 400, 'Bad Request');

      const patchRes = await server.inject({
        method: 'PATCH',
        url: `${c.base}/${c.id}/status`,
        headers: { cookie: superCookie },
        payload: c.badPatch
      });
      expectStandardError(patchRes, 400, 'Bad Request');
    }
  });

  it('returns standard 404 Not Found errors for missing parents and missing resources across all 6 category families', async () => {
    const missingId = '65f000000000000000000000';

    const missingParentCases = [
      { url: '/api/buildings', payload: { name: 'New Bld', code: 'NB1', plantId: missingId } },
      { url: '/api/floors', payload: { name: 'New Fl', floorNumber: 9, buildingId: missingId } },
      { url: '/api/departments', payload: { name: 'New Dept', code: 'ND1', colorHex: '#3B82F6', unitId: missingId } },
      { url: '/api/departments', payload: { name: 'New Dept 2', code: 'ND2', colorHex: '#3B82F6', floorId: missingId } },
      { url: '/api/areas', payload: { name: 'New Area', floorId: missingId } },
      { url: '/api/sections', payload: { name: 'New Sec', departmentId: missingId } },
      { url: '/api/functions', payload: { name: 'New Fn', sectionId: missingId } }
    ];

    for (const c of missingParentCases) {
      const res = await server.inject({
        method: 'POST',
        url: c.url,
        headers: { cookie: superCookie },
        payload: c.payload
      });
      expectStandardError(res, 404, 'Not Found');
    }

    const missingResourceCases = [
      { base: '/api/buildings', putPayload: { name: 'X' } },
      { base: '/api/floors', putPayload: { name: 'X' } },
      { base: '/api/departments', putPayload: { name: 'X' } },
      { base: '/api/areas', putPayload: { name: 'X' } },
      { base: '/api/sections', putPayload: { name: 'X' } },
      { base: '/api/functions', putPayload: { name: 'X' } }
    ];

    for (const c of missingResourceCases) {
      const putRes = await server.inject({
        method: 'PUT',
        url: `${c.base}/${missingId}`,
        headers: { cookie: superCookie },
        payload: c.putPayload
      });
      expectStandardError(putRes, 404, 'Not Found');

      const patchRes = await server.inject({
        method: 'PATCH',
        url: `${c.base}/${missingId}/status`,
        headers: { cookie: superCookie },
        payload: { isActive: false }
      });
      expectStandardError(patchRes, 404, 'Not Found');

      const delRes = await server.inject({
        method: 'DELETE',
        url: `${c.base}/${missingId}`,
        headers: { cookie: superCookie }
      });
      expectStandardError(delRes, 404, 'Not Found');
    }

    for (const base of ['/api/buildings', '/api/floors', '/api/departments']) {
      const getRes = await server.inject({
        method: 'GET',
        url: `${base}/${missingId}`,
        headers: { cookie: superCookie }
      });
      expectStandardError(getRes, 404, 'Not Found');
    }
  });

  it('returns standard 403 Forbidden errors when UNIT_ADMIN accesses categories outside their assigned unit', async () => {
    const crossUnitCases = [
      {
        base: '/api/buildings',
        otherId: bld2Id,
        postPayload: { name: 'Hack Bld', code: 'HB1', plantId: plant2Id },
        putPayload: { name: 'Hack Bld 2' }
      },
      {
        base: '/api/floors',
        otherId: floor2Id,
        postPayload: { name: 'Hack Floor', floorNumber: 5, buildingId: bld2Id },
        putPayload: { name: 'Hack Floor 2' }
      },
      {
        base: '/api/departments',
        otherId: dept2Id,
        postPayload: { name: 'Hack Dept', code: 'HD1', colorHex: '#3B82F6', unitId: unit2Id },
        putPayload: { name: 'Hack Dept 2' }
      },
      {
        base: '/api/areas',
        otherId: area2Id,
        postPayload: { name: 'Hack Area', floorId: floor2Id },
        putPayload: { name: 'Hack Area 2' }
      },
      {
        base: '/api/sections',
        otherId: section2Id,
        postPayload: { name: 'Hack Sec', departmentId: dept2Id },
        putPayload: { name: 'Hack Sec 2' }
      },
      {
        base: '/api/functions',
        otherId: fn2Id,
        postPayload: { name: 'Hack Fn', sectionId: section2Id },
        putPayload: { name: 'Hack Fn 2' }
      }
    ];

    for (const c of crossUnitCases) {
      const postRes = await server.inject({
        method: 'POST',
        url: c.base,
        headers: { cookie: unit1Cookie },
        payload: c.postPayload
      });
      expectStandardError(postRes, 403, 'Forbidden');

      const putRes = await server.inject({
        method: 'PUT',
        url: `${c.base}/${c.otherId}`,
        headers: { cookie: unit1Cookie },
        payload: c.putPayload
      });
      expectStandardError(putRes, 403, 'Forbidden');

      const patchRes = await server.inject({
        method: 'PATCH',
        url: `${c.base}/${c.otherId}/status`,
        headers: { cookie: unit1Cookie },
        payload: { isActive: false }
      });
      expectStandardError(patchRes, 403, 'Forbidden');

      const delRes = await server.inject({
        method: 'DELETE',
        url: `${c.base}/${c.otherId}`,
        headers: { cookie: unit1Cookie }
      });
      expectStandardError(delRes, 403, 'Forbidden');
    }

    for (const [base, otherId] of [
      ['/api/buildings', bld2Id],
      ['/api/floors', floor2Id]
    ] as const) {
      const getRes = await server.inject({
        method: 'GET',
        url: `${base}/${otherId}`,
        headers: { cookie: unit1Cookie }
      });
      expectStandardError(getRes, 403, 'Forbidden');
    }
  });

  it('returns standard 409 Conflict errors for duplicates and restricted deletions across all 6 category families', async () => {
    // Buildings duplicate code
    const bldDupPost = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: superCookie },
      payload: { name: 'Another Bld', code: 'b1', plantId: plant1Id }
    });
    expectStandardError(bldDupPost, 409, 'Conflict');

    const bldB = await mockPrisma.building.create({ data: { name: 'Bld 1B', code: 'B1B', plantId: plant1Id } });
    const bldDupPut = await server.inject({
      method: 'PUT',
      url: `/api/buildings/${bldB.id}`,
      headers: { cookie: superCookie },
      payload: { code: 'B1' }
    });
    expectStandardError(bldDupPut, 409, 'Conflict');

    // Floors duplicate floorNumber
    const flDupPost = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: superCookie },
      payload: { name: 'Dup Floor', floorNumber: 1, buildingId: bld1Id }
    });
    expectStandardError(flDupPost, 409, 'Conflict');

    const flB = await mockPrisma.floor.create({ data: { name: 'Floor 1B', floorNumber: 2, buildingId: bld1Id } });
    const flDupPut = await server.inject({
      method: 'PUT',
      url: `/api/floors/${flB.id}`,
      headers: { cookie: superCookie },
      payload: { floorNumber: 1 }
    });
    expectStandardError(flDupPut, 409, 'Conflict');

    // Departments duplicate & delete with section
    const deptDupPost = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: superCookie },
      payload: { name: 'dept 1', code: 'D99', colorHex: '#3B82F6', unitId: unit1Id }
    });
    expectStandardError(deptDupPost, 409, 'Conflict');

    const deptB = await mockPrisma.department.create({ data: { name: 'Dept 1B', code: 'D1B', colorHex: '#3B82F6', unitId: unit1Id } });
    const deptDupPut = await server.inject({
      method: 'PUT',
      url: `/api/departments/${deptB.id}`,
      headers: { cookie: superCookie },
      payload: { code: 'D1' }
    });
    expectStandardError(deptDupPut, 409, 'Conflict');

    const deptUsedDel = await server.inject({
      method: 'DELETE',
      url: `/api/departments/${dept1Id}`,
      headers: { cookie: superCookie }
    });
    expectStandardError(deptUsedDel, 409, 'Conflict');

    // Areas normalized duplicate
    const areaDupPost = await server.inject({
      method: 'POST',
      url: '/api/areas',
      headers: { cookie: superCookie },
      payload: { name: '  AREA   1 ', floorId: floor1Id }
    });
    expectStandardError(areaDupPost, 409, 'Conflict');

    const areaB = await mockPrisma.area.create({ data: { name: 'Area 1B', normalizedName: 'area 1b', floorId: floor1Id } });
    const areaDupPut = await server.inject({
      method: 'PUT',
      url: `/api/areas/${areaB.id}`,
      headers: { cookie: superCookie },
      payload: { name: 'area 1' }
    });
    expectStandardError(areaDupPut, 409, 'Conflict');

    // Sections normalized duplicate
    const secDupPost = await server.inject({
      method: 'POST',
      url: '/api/sections',
      headers: { cookie: superCookie },
      payload: { name: '  SECTION   1 ', departmentId: dept1Id }
    });
    expectStandardError(secDupPost, 409, 'Conflict');

    const secB = await mockPrisma.section.create({ data: { name: 'Section 1B', normalizedName: 'section 1b', departmentId: dept1Id } });
    const secDupPut = await server.inject({
      method: 'PUT',
      url: `/api/sections/${secB.id}`,
      headers: { cookie: superCookie },
      payload: { name: 'section 1' }
    });
    expectStandardError(secDupPut, 409, 'Conflict');

    // Functions normalized duplicate
    const fnDupPost = await server.inject({
      method: 'POST',
      url: '/api/functions',
      headers: { cookie: superCookie },
      payload: { name: '  FN   1 ', sectionId: section1Id }
    });
    expectStandardError(fnDupPost, 409, 'Conflict');

    const fnB = await mockPrisma.orgFunction.create({ data: { name: 'Fn 1B', normalizedName: 'fn 1b', sectionId: section1Id } });
    const fnDupPut = await server.inject({
      method: 'PUT',
      url: `/api/functions/${fnB.id}`,
      headers: { cookie: superCookie },
      payload: { name: 'fn 1' }
    });
    expectStandardError(fnDupPut, 409, 'Conflict');
  });

  it('preserves status toggling and archive-on-delete semantics for used vs unused categories', async () => {
    // Status toggle works across all families
    for (const [base, id] of [
      ['/api/buildings', bld1Id],
      ['/api/floors', floor1Id],
      ['/api/departments', dept1Id],
      ['/api/areas', area1Id],
      ['/api/sections', section1Id],
      ['/api/functions', fn1Id]
    ] as const) {
      const hideRes = await server.inject({
        method: 'PATCH',
        url: `${base}/${id}/status`,
        headers: { cookie: superCookie },
        payload: { isActive: false }
      });
      expect(hideRes.statusCode).toBe(200);
      expect(hideRes.json().isActive).toBe(false);

      const showRes = await server.inject({
        method: 'PATCH',
        url: `${base}/${id}/status`,
        headers: { cookie: superCookie },
        payload: { isActive: true }
      });
      expect(showRes.statusCode).toBe(200);
      expect(showRes.json().isActive).toBe(true);
    }

    // Used building/floor/section archive instead of deleting
    const bldDel = await server.inject({ method: 'DELETE', url: `/api/buildings/${bld1Id}`, headers: { cookie: superCookie } });
    expect(bldDel.statusCode).toBe(200);
    expect(bldDel.json()).toEqual({ archived: true, reason: 'Building contains floors' });

    const flDel = await server.inject({ method: 'DELETE', url: `/api/floors/${floor1Id}`, headers: { cookie: superCookie } });
    expect(flDel.statusCode).toBe(200);
    expect(flDel.json()).toEqual({ archived: true, reason: 'Floor is in use' });

    const secDel = await server.inject({ method: 'DELETE', url: `/api/sections/${section1Id}`, headers: { cookie: superCookie } });
    expect(secDel.statusCode).toBe(200);
    expect(secDel.json()).toEqual({ archived: true, reason: 'Section is in use' });

    // Unused area & function delete permanently
    const areaDel = await server.inject({ method: 'DELETE', url: `/api/areas/${area1Id}`, headers: { cookie: superCookie } });
    expect(areaDel.statusCode).toBe(200);
    expect(areaDel.json()).toEqual({ deleted: true });

    const fnDel = await server.inject({ method: 'DELETE', url: `/api/functions/${fn1Id}`, headers: { cookie: superCookie } });
    expect(fnDel.statusCode).toBe(200);
    expect(fnDel.json()).toEqual({ deleted: true });
  });
});
