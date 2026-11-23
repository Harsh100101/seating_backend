import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { buildServer } from '../src/server.js';
import { createMockPrisma } from './mock-prisma.js';
import { DEFAULT_ADMIN } from '../prisma/seed.js';
import { PDFDocument } from 'pdf-lib';

describe('Hierarchy & Data Optimization Suite', () => {
  let server: FastifyInstance;
  let sessionCookie: string;
  let mockPrisma: any;

  beforeEach(async () => {
    mockPrisma = await createMockPrisma();
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
  });

  afterEach(async () => {
    await server.close();
  });

  it('SHOULD FIX 10: Reports summary memory optimization preserves response contract', async () => {
    // Create office (unit)
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Data HQ', city: 'Detroit' }
    });
    const office = offRes.json();

    // Create building & floor
    const bldRes = await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Tower A', code: 'TWR-A', officeId: office.id }
    });
    const building = bldRes.json();

    const flrRes = await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 1', floorNumber: 1, buildingId: building.id }
    });
    const floor = flrRes.json();

    // Create department
    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Operations', code: 'OPS', colorHex: '#3B82F6', unitId: office.id }
    });
    const dept = deptRes.json();

    // Create 3 employees: 1 seated, 2 unassigned
    const emp1 = (await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-HD-1', fullName: 'Seated One', departmentId: dept.id }
    })).json();

    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-HD-2', fullName: 'Unseated Two', departmentId: dept.id }
    });

    await server.inject({
      method: 'POST',
      url: '/api/employees',
      headers: { cookie: sessionCookie },
      payload: { employeeCode: 'EMP-HD-3', fullName: 'Unseated Three', departmentId: dept.id }
    });

    // Create seat and assign emp1
    const layoutRes = await server.inject({
      method: 'PUT',
      url: `/api/floors/${floor.id}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [
          { label: 'SEAT-101', x: 10, y: 10 },
          { label: 'SEAT-102', x: 20, y: 20 }
        ]
      }
    });
    const seats = layoutRes.json().seats;
    await server.inject({
      method: 'POST',
      url: `/api/seats/${seats[0].id}/assign`,
      headers: { cookie: sessionCookie },
      payload: { employeeId: emp1.id }
    });

    // GET /api/reports/summary
    const summaryRes = await server.inject({
      method: 'GET',
      url: `/api/reports/summary?unitId=${office.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(summaryRes.statusCode).toBe(200);
    const body = summaryRes.json();

    expect(body.kpis.totalSeats).toBe(2);
    expect(body.kpis.occupiedSeats).toBe(1);
    expect(body.kpis.availableSeats).toBe(1);
    expect(body.kpis.totalEmployees).toBe(3);
    expect(body.kpis.unassignedEmployees).toBe(2);
    expect(body.kpis.overallOccupancyRate).toBe(50.0);
    expect(body.byFloor[0].departments.length).toBeGreaterThanOrEqual(1);
  });

  it('SHOULD FIX 12: Empty building is deleted, while building with floors is safely archived', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Delete Office', city: 'Austin' }
    });
    const office = offRes.json();

    // 1. Empty building
    const bld1 = (await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Empty Bldg', code: 'BLD-EMP', officeId: office.id }
    })).json();

    const delRes1 = await server.inject({
      method: 'DELETE',
      url: `/api/buildings/${bld1.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delRes1.statusCode).toBe(200);
    expect(delRes1.json().deletedId).toBe(bld1.id);

    // 2. Building with a floor
    const bld2 = (await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Used Bldg', code: 'BLD-USD', officeId: office.id }
    })).json();

    await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor 1', floorNumber: 1, buildingId: bld2.id }
    });

    const delRes2 = await server.inject({
      method: 'DELETE',
      url: `/api/buildings/${bld2.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delRes2.statusCode).toBe(200);
    expect(delRes2.json().archived).toBe(true);
    expect(delRes2.json().reason).toBe('Building contains floors');
  });

  it('SHOULD FIX 12: Empty floor is deleted, while floor with seats is safely archived', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor Office', city: 'Boston' }
    });
    const office = offRes.json();

    const bld = (await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Floor Test Bldg', code: 'BLD-FLR', officeId: office.id }
    })).json();

    // 1. Empty floor
    const flr1 = (await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Empty Floor', floorNumber: 10, buildingId: bld.id }
    })).json();

    const delFlr1 = await server.inject({
      method: 'DELETE',
      url: `/api/floors/${flr1.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delFlr1.statusCode).toBe(200);
    expect(delFlr1.json().deletedId).toBe(flr1.id);

    // 2. Used floor with layout seats
    const flr2 = (await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Used Floor', floorNumber: 11, buildingId: bld.id }
    })).json();

    await server.inject({
      method: 'PUT',
      url: `/api/floors/${flr2.id}/layout`,
      headers: { cookie: sessionCookie },
      payload: {
        seats: [{ label: 'SEAT-F2', x: 10, y: 10 }]
      }
    });

    const delFlr2 = await server.inject({
      method: 'DELETE',
      url: `/api/floors/${flr2.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(delFlr2.statusCode).toBe(200);
    expect(delFlr2.json().archived).toBe(true);
    expect(delFlr2.json().reason).toBe('Floor is in use');
  });

  it('SHOULD FIX 14: Departments are queried by unit using scalar foreign keys without deep plant joins', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Scalar Dept Office', city: 'Dallas' }
    });
    const office = offRes.json();

    const deptRes = await server.inject({
      method: 'POST',
      url: '/api/departments',
      headers: { cookie: sessionCookie },
      payload: { name: 'Logistics', code: 'LOG', colorHex: '#10B981', unitId: office.id }
    });
    expect(deptRes.statusCode).toBe(201);

    const listRes = await server.inject({
      method: 'GET',
      url: `/api/departments?unitId=${office.id}`,
      headers: { cookie: sessionCookie }
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((d: any) => d.code === 'LOG')).toBe(true);
  });

  it('SHOULD FIX 15: Floor image uploads are stored outside local disk and preserve legacy files', async () => {
    const offRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'Image Office', city: 'Denver' }
    });
    const office = offRes.json();

    const bld = (await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'Image Bldg', code: 'BLD-IMG', officeId: office.id }
    })).json();

    const flr = (await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'Image Floor', floorNumber: 1, buildingId: bld.id }
    })).json();

    const uploadDir = path.resolve(process.cwd(), 'uploads/floors');
    await fs.promises.mkdir(uploadDir, { recursive: true });

    // Simulate an existing old image on disk
    const oldFileName = `${flr.id}-oldimage.png`;
    const oldFilePath = path.join(uploadDir, oldFileName);
    await fs.promises.writeFile(oldFilePath, 'mock-old-image-data');
    expect(fs.existsSync(oldFilePath)).toBe(true);

    // Set floor.imageUrl to the old image
    await mockPrisma.floor.update({
      where: { id: flr.id },
      data: { imageUrl: `/uploads/floors/${oldFileName}` }
    });

    // Upload new image
    const boundary = '----WebKitFormBoundaryABC123';
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const fileContent = Buffer.concat([pngHeader, Buffer.from('new-image-data')]);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="new.png"\r\nContent-Type: image/png\r\n\r\n`),
      fileContent,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const uploadRes = await server.inject({
      method: 'POST',
      url: `/api/floors/${flr.id}/image`,
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    expect(uploadRes.statusCode).toBe(200);
    const updated = uploadRes.json();
    expect(updated.imageUrl).toMatch(/^\/uploads\/floors\//);

    // GridFS replacement keeps the previous legacy bytes until approved cleanup.
    expect(fs.existsSync(oldFilePath)).toBe(true);

    // Test Path Traversal Protection:
    // Create a canary file outside uploads/floors
    const canaryPath = path.resolve(process.cwd(), 'canary-test.txt');
    await fs.promises.writeFile(canaryPath, 'do-not-delete');
    expect(fs.existsSync(canaryPath)).toBe(true);

    // Set floor.imageUrl to attempted path traversal
    await mockPrisma.floor.update({
      where: { id: flr.id },
      data: { imageUrl: '/uploads/floors/../../canary-test.txt' }
    });

    // Upload another image
    await server.inject({
      method: 'POST',
      url: `/api/floors/${flr.id}/image`,
      headers: {
        cookie: sessionCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload
    });

    // Canary file MUST NOT be deleted
    expect(fs.existsSync(canaryPath)).toBe(true);
    await fs.promises.unlink(canaryPath);

    // Cleanup the uploaded new file if created
    const newFileName = path.basename(updated.imageUrl);
    const newFilePath = path.join(uploadDir, newFileName);
    if (fs.existsSync(newFilePath)) {
      await fs.promises.unlink(newFilePath);
    }
    await fs.promises.unlink(oldFilePath).catch(() => undefined);
  });

  it('accepts a validated PDF floor map and serves it through the protected image route', async () => {
    const officeRes = await server.inject({
      method: 'POST',
      url: '/api/offices',
      headers: { cookie: sessionCookie },
      payload: { name: 'PDF Test Unit', city: 'Test' },
    });
    const office = officeRes.json();
    const building = (await server.inject({
      method: 'POST',
      url: '/api/buildings',
      headers: { cookie: sessionCookie },
      payload: { name: 'PDF Test Building', code: 'PDF-TEST', officeId: office.id },
    })).json();
    const floor = (await server.inject({
      method: 'POST',
      url: '/api/floors',
      headers: { cookie: sessionCookie },
      payload: { name: 'PDF Floor', floorNumber: 1, buildingId: building.id },
    })).json();

    const pdf = await PDFDocument.create();
    pdf.addPage([640, 480]);
    pdf.addPage([640, 480]);
    const content = Buffer.from(await pdf.save());
    const boundary = '----PdfFloorPlanBoundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="floor-map.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const upload = await server.inject({
      method: 'POST',
      url: `/api/floors/${floor.id}/image`,
      headers: { cookie: sessionCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(upload.statusCode).toBe(200);
    expect(upload.json().pageCount).toBe(2);
    expect(upload.json().imageUrl).toMatch(/\.pdf$/);

    const served = await server.inject({
      method: 'GET',
      url: `/api/floors/${floor.id}/image`,
      headers: { cookie: sessionCookie },
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('application/pdf');
    expect(served.rawPayload.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const invalidPayload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fake.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from('not a pdf'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const invalid = await server.inject({
      method: 'POST',
      url: `/api/floors/${floor.id}/image`,
      headers: { cookie: sessionCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: invalidPayload,
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('returns a controlled retry-safe 404 when an uploaded floor-map asset is missing', async () => {
    const office = (await server.inject({
      method: 'POST', url: '/api/offices', headers: { cookie: sessionCookie },
      payload: { name: 'Missing Asset Unit', city: 'Test' },
    })).json();
    const building = (await server.inject({
      method: 'POST', url: '/api/buildings', headers: { cookie: sessionCookie },
      payload: { name: 'Missing Asset Building', code: 'MISSING-ASSET', officeId: office.id },
    })).json();
    const floor = (await server.inject({
      method: 'POST', url: '/api/floors', headers: { cookie: sessionCookie },
      payload: { name: 'Missing Asset Floor', floorNumber: 1, buildingId: building.id },
    })).json();
    await mockPrisma.floor.update({
      where: { id: floor.id },
      data: { imageUrl: `/uploads/floors/${floor.id}-missing.pdf` },
    });

    const response = await server.inject({
      method: 'GET', url: `/api/floors/${floor.id}/image`, headers: { cookie: sessionCookie },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().message).toBe('Floor plan asset is unavailable');
  });
});
