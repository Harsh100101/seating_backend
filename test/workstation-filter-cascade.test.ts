import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { workstationRoutes } from '../src/routes/workstations.js';
import { createMockPrisma } from './mock-prisma.js';

describe('workstation filter options', () => {
  it('keeps sibling buildings selectable and narrows physical choices by organization', async () => {
    const prisma = await createMockPrisma();
    const app = Fastify();
    app.decorate('prisma', prisma);
    app.addHook('onRequest', async (request: any) => { request.admin = { id: 'test-admin', role: 'UNIT_ADMIN', assignedUnitId: unit.id }; });
    const unit = await prisma.unit.create({ data: { name: 'Unit 2', code: 'UNIT-2' } });
    const plant = await prisma.plant.create({ data: { name: 'Plant', code: 'PLANT', unitId: unit.id } });
    const departmentA = await prisma.department.create({ data: { name: 'Costing', code: 'COST', unitId: unit.id } });
    const departmentB = await prisma.department.create({ data: { name: 'Production', code: 'PROD', unitId: unit.id } });
    const buildings = [];
    for (const [name, code, department] of [
      ['Contractore Office', 'CO', departmentA], ['Santosh Bhavan', 'SB', departmentB]
    ] as const) {
      const building = await prisma.building.create({ data: { name, code, plantId: plant.id } });
      const floor = await prisma.floor.create({ data: { name: 'Floor 1', floorNumber: 1, buildingId: building.id } });
      const employee = await prisma.employee.create({ data: { employeeCode: `${code}-EMP`, fullName: code, departmentId: department.id, section: `${code} Section`, functionName: `${code} Function` } });
      await prisma.seat.create({ data: { label: `${code}-WS`, floorId: floor.id, departmentId: department.id, employeeId: employee.id, officeArea: `${code} Area` } });
      buildings.push({ building, floor });
    }
    const foreignUnit = await prisma.unit.create({ data: { name: 'Unit 1', code: 'UNIT-1' } });
    const foreignDepartment = await prisma.department.create({ data: { name: 'Foreign', code: 'FOR', unitId: foreignUnit.id } });
    const foreignEmployee = await prisma.employee.create({ data: { employeeCode: 'FOREIGN-WS-EMP', fullName: 'Foreign', departmentId: foreignDepartment.id, section: 'Foreign Section', functionName: 'Foreign Function' } });
    await prisma.seat.create({ data: { label: 'FOREIGN-WS', floorId: buildings[0].floor.id, departmentId: foreignDepartment.id, employeeId: foreignEmployee.id } });
    await app.register(workstationRoutes, { prefix: '/api/workstations' });
    await app.ready();
    const selected = await app.inject({ method: 'GET', url: `/api/workstations/filter-options?unitId=${unit.id}&buildingId=${buildings[0].building.id}` });
    expect(selected.statusCode).toBe(200);
    expect(selected.json().buildings.map((building: any) => building.id)).toEqual(buildings.map((item) => item.building.id));
    expect(selected.json().departments.map((department: any) => department.id)).toEqual([departmentA.id]);
    expect(selected.json().departments.map((department: any) => department.id)).not.toContain(foreignDepartment.id);
    expect(selected.json().sections).not.toContain('Foreign Section');
    const foreignOrg = await app.inject({ method: 'GET', url: `/api/workstations/filter-options?section=Foreign%20Section` });
    expect(foreignOrg.json().buildings).toEqual([]);
    const org = await app.inject({ method: 'GET', url: `/api/workstations/filter-options?unitId=${unit.id}&departmentId=${departmentB.id}` });
    expect(org.json().buildings.map((building: any) => building.id)).toEqual([buildings[1].building.id]);
    expect(org.json().floors.map((floor: any) => floor.id)).toEqual([buildings[1].floor.id]);
    expect(org.json().officeAreas).toEqual(['SB Area']);
    const sectionAndFunction = await app.inject({ method: 'GET', url: `/api/workstations/filter-options?unitId=${unit.id}&section=SB%20Section&functionName=SB%20Function` });
    expect(sectionAndFunction.json().buildings.map((building: any) => building.id)).toEqual([buildings[1].building.id]);
    await app.close();
  });
});
