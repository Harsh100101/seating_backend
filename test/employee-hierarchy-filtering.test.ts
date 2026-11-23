import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { employeeRoutes } from '../src/routes/employees.js';
import { createMockPrisma } from './mock-prisma.js';

describe('employee hierarchy filtering', () => {
  let app: FastifyInstance;
  let prisma: any;
  let admin: any;
  let unit1: any;
  let unit2: any;
  let building1: any;
  let floor1: any;
  let area1: any;
  let department1: any;
  let department2: any;
  let section1: any;
  let function1: any;
  let employee1: any;
  let employee2: any;
  let foreignEmployee: any;
  let legacyAreaEmployee: any;
  let archivedEmployee: any;
  let quarantinedEmployee: any;
  let invalidStateEmployee: any;

  beforeAll(async () => {
    prisma = await createMockPrisma();
    app = Fastify();
    app.decorate('prisma', prisma);
    admin = { role: 'SUPER_ADMIN', email: 'superadmin@shaktiman.com' };
    app.addHook('onRequest', async (request: any) => {
      request.admin = admin;
    });
    await app.register(employeeRoutes, { prefix: '/api/employees' });
    await app.ready();

    unit1 = await prisma.unit.create({ data: { name: 'Hierarchy Test Unit 1', code: 'HTU-1' } });
    unit2 = await prisma.unit.create({ data: { name: 'Hierarchy Test Unit 2', code: 'HTU-2' } });
    const plant1 = await prisma.plant.create({ data: { name: 'Test Campus 1', code: 'TC-1', unitId: unit1.id } });
    const building = await prisma.building.create({ data: { name: 'Test Building', code: 'TB-1', plantId: plant1.id } });
    building1 = building;
    floor1 = await prisma.floor.create({ data: { name: 'Test Floor', floorNumber: 2, buildingId: building.id } });
    area1 = await prisma.area.create({ data: { name: 'Test Area', normalizedName: 'test area', floorId: floor1.id } });
    department1 = await prisma.department.create({ data: { name: 'Test Department', code: 'TD-1', unitId: unit1.id } });
    department2 = await prisma.department.create({ data: { name: 'Foreign Department', code: 'TD-2', unitId: unit2.id } });
    section1 = await prisma.section.create({ data: { name: 'Test Section', normalizedName: 'test section', departmentId: department1.id } });
    function1 = await prisma.orgFunction.create({ data: { name: 'Test Function', normalizedName: 'test function', sectionId: section1.id } });

    employee1 = await prisma.employee.create({ data: {
      employeeCode: 'HT-001', fullName: 'Alpha Nishant', departmentId: department1.id,
      sectionId: section1.id, functionId: function1.id, section: section1.name, functionName: function1.name,
      operationalState: 'CURRENT', isActive: true
    } });
    employee2 = await prisma.employee.create({ data: {
      employeeCode: 'HT-002', fullName: 'Beta Unseated', departmentId: department1.id,
      sectionId: section1.id, functionId: function1.id, section: section1.name, functionName: function1.name,
      isActive: true
    } });
    foreignEmployee = await prisma.employee.create({ data: {
      employeeCode: 'HT-003', fullName: 'Foreign Employee', departmentId: department2.id,
      isActive: true
    } });
    legacyAreaEmployee = await prisma.employee.create({ data: {
      employeeCode: 'HT-004', fullName: 'Legacy Area Employee', departmentId: department1.id,
      isActive: true
    } });
    archivedEmployee = await prisma.employee.create({ data: {
      employeeCode: 'HT-005', fullName: 'Archived Employee', departmentId: department1.id,
      operationalState: 'ARCHIVED', isActive: true
    } });
    quarantinedEmployee = await prisma.employee.create({ data: {
      employeeCode: 'HT-006', fullName: 'Quarantined Employee', departmentId: department1.id,
      operationalState: 'QUARANTINED', isActive: true
    } });
    invalidStateEmployee = await prisma.employee.create({ data: {
      employeeCode: 'HT-007', fullName: 'Invalid State Employee', departmentId: department1.id,
      operationalState: 'UNKNOWN_LEGACY_VALUE', isActive: true
    } });
    await prisma.seat.upsert({ where: { floorId_label: { floorId: floor1.id, label: 'HT-WS-1' } }, update: {}, create: {
      floorId: floor1.id, label: 'HT-WS-1', areaId: area1.id, employeeId: employee1.id, status: 'AVAILABLE'
    } });
    await prisma.seat.upsert({ where: { floorId_label: { floorId: floor1.id, label: 'TBL-LEGACY-1' } }, update: {}, create: {
      floorId: floor1.id, label: 'TBL-LEGACY-1', officeArea: area1.name, employeeId: legacyAreaEmployee.id, status: 'AVAILABLE'
    } });
    await prisma.seat.upsert({ where: { floorId_label: { floorId: floor1.id, label: 'VACANT-HT-1' } }, update: {}, create: {
      floorId: floor1.id, label: 'VACANT-HT-1', officeArea: area1.name, status: 'AVAILABLE'
    } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('combines Unit, Building, Floor, Area, Department, Section, Function and search with AND semantics', async () => {
    const query = new URLSearchParams({
      unitId: unit1.id,
      buildingId: building1.id,
      floorId: floor1.id,
      areaId: area1.id,
      departmentId: department1.id,
      sectionId: section1.id,
      functionId: function1.id,
      search: 'nishant',
      page: '1',
      pageSize: '25',
      sortBy: 'employeeCode',
      sortOrder: 'asc'
    });
    const response = await app.inject({ method: 'GET', url: `/api/employees?${query}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.employees.map((employee: any) => employee.id)).toEqual([employee1.id]);
  });

  it('keeps unseated employees in Unit scope but excludes them from physical location scope', async () => {
    const unitResponse = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}` });
    expect(unitResponse.json().employees.map((employee: any) => employee.id)).toEqual(expect.arrayContaining([employee1.id, employee2.id]));

    const floorResponse = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&floorId=${floor1.id}` });
    expect(floorResponse.json().employees.map((employee: any) => employee.id)).toEqual(expect.arrayContaining([employee1.id, legacyAreaEmployee.id]));

    const unassignedFloor = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&floorId=${floor1.id}&status=unassigned` });
    expect(unassignedFloor.json().employees).toEqual([]);

    const unassignedDepartment = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&departmentId=${department1.id}&status=unassigned` });
    expect(unassignedDepartment.json().employees.map((employee: any) => employee.id)).toEqual([employee2.id]);
  });

  it('supports employee search by assigned workstation label without matching vacant desks', async () => {
    for (const term of ['HT-WS-1', 'ws-1', 'tbl-legacy']) {
      const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&search=${encodeURIComponent(term)}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().employees.map((employee: any) => employee.id)).toEqual(
        expect.arrayContaining(term.toLowerCase().includes('tbl') ? [legacyAreaEmployee.id] : [employee1.id])
      );
    }
    const vacant = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&search=VACANT-HT-1` });
    expect(vacant.json().employees).toEqual([]);
  });

  it('uses master Area IDs with legacy seat office-area compatibility only on the selected floor', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&areaId=${area1.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().employees.map((employee: any) => employee.id)).toEqual(expect.arrayContaining([employee1.id, legacyAreaEmployee.id]));
  });

  it('keeps legacy null/absent operational states readable, while excluding explicit or invalid states', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}` });
    expect(response.statusCode).toBe(200);
    const employees = response.json().employees;
    expect(employees.map((employee: any) => employee.id)).toEqual(expect.arrayContaining([employee1.id, employee2.id, legacyAreaEmployee.id]));
    expect(employees.map((employee: any) => employee.id)).not.toEqual(expect.arrayContaining([archivedEmployee.id, quarantinedEmployee.id, invalidStateEmployee.id]));
    expect(employees.find((employee: any) => employee.id === employee1.id).operationalState).toBe('CURRENT');
    expect(employees.find((employee: any) => employee.id === employee2.id).operationalState).toBe('LEGACY_UNCLASSIFIED');
  });

  it('returns a filtered summary from the same backend scope as the table', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&departmentId=${department1.id}&includeSummary=true` });
    expect(response.statusCode).toBe(200);
    expect(response.json().summary).toEqual({ total: 3, active: 3, seated: 2, unseated: 1 });
  });

  it('enforces Unit Admin scope even when a foreign unitId is supplied', async () => {
    admin = { role: 'UNIT_ADMIN', assignedUnitId: unit1.id, email: 'unit-admin@shaktiman.com' };
    const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit2.id}` });
    expect(response.statusCode).toBe(200);
    const ids = response.json().employees.map((employee: any) => employee.id);
    expect(ids).toEqual(expect.arrayContaining([employee1.id, employee2.id]));
    expect(ids).not.toContain(foreignEmployee.id);
  });

  it('keeps physical cross-unit visibility global while preventing a Unit Admin leak', async () => {
    await prisma.seat.upsert({ where: { floorId_label: { floorId: floor1.id, label: 'FOREIGN-CROSS-UNIT' } }, update: {}, create: {
      floorId: floor1.id, label: 'FOREIGN-CROSS-UNIT', employeeId: foreignEmployee.id, status: 'AVAILABLE'
    } });
    admin = { role: 'SUPER_ADMIN', email: 'superadmin@shaktiman.com' };
    const global = await app.inject({ method: 'GET', url: `/api/employees?buildingId=${building1.id}` });
    expect(global.json().employees.map((employee: any) => employee.id)).toContain(foreignEmployee.id);

    admin = { role: 'UNIT_ADMIN', assignedUnitId: unit1.id, email: 'unit-admin@shaktiman.com' };
    const scoped = await app.inject({ method: 'GET', url: `/api/employees?buildingId=${building1.id}` });
    expect(scoped.json().employees.map((employee: any) => employee.id)).not.toContain(foreignEmployee.id);
  });

  it('supports server-side pageSize and employeeCode sorting', async () => {
    admin = { role: 'SUPER_ADMIN', email: 'superadmin@shaktiman.com' };
    const response = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&page=1&pageSize=1&sortBy=employeeCode&sortOrder=desc` });
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.limit).toBe(1);
    expect(body.total).toBe(3);
    expect(body.employees[0].employeeCode).toBe('HT-004');
  });

  it('returns cascading option IDs from the same authorized hierarchy', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&buildingId=${building1.id}&floorId=${floor1.id}&departmentId=${department1.id}&sectionId=${section1.id}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.units.map((unit: any) => unit.id)).toEqual([unit1.id]);
    expect(body.buildings.map((building: any) => building.id)).toEqual([building1.id]);
    expect(body.floors.map((floor: any) => floor.id)).toEqual([floor1.id]);
    expect(body.floors[0].displayName).toBe('Hierarchy Test Unit 1 → Test Building → Test Floor');
    expect(body.areaOptions.map((area: any) => area.id)).toEqual([area1.id]);
    expect(body.areaOptions[0].displayName).toBe('Hierarchy Test Unit 1 → Test Building → Test Floor → Test Area');
    expect(body.departments.map((department: any) => department.id)).toEqual([department1.id]);
    expect(body.sectionOptions.map((section: any) => section.id)).toEqual([section1.id]);
    expect(body.sectionOptions[0].displayName).toBe('Test Department → Test Section');
    expect(body.functionOptions.map((fn: any) => fn.id)).toEqual([function1.id]);
    expect(body.functionOptions[0].displayName).toBe('Test Department → Test Section → Test Function');
  });

  it('keeps unseated departments in Unit scope but excludes them from a physical selection', async () => {
    const unseatedDepartment = await prisma.department.create({ data: { name: 'Unseated Only', code: 'UO-1', unitId: unit1.id } });
    await prisma.employee.create({ data: { employeeCode: 'HT-008', fullName: 'Unseated Option', departmentId: unseatedDepartment.id, isActive: true } });
    admin = { role: 'SUPER_ADMIN', email: 'superadmin@shaktiman.com' };
    const unit = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}` });
    expect(unit.json().departments.map((department: any) => department.id)).toContain(unseatedDepartment.id);
    const floor = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&floorId=${floor1.id}` });
    expect(floor.statusCode).toBe(200);
    expect(floor.json().departments.map((department: any) => department.id)).not.toContain(unseatedDepartment.id);
  });

  it('keeps sibling buildings available after choosing one and scopes organization to occupied seats', async () => {
    const plant = await prisma.plant.findFirst({ where: { unitId: unit1.id } });
    const sibling = await prisma.building.create({ data: { name: 'Contractore Office', code: 'CO-1', plantId: plant.id } });
    const siblingFloor = await prisma.floor.create({ data: { name: 'Ground Floor', floorNumber: 0, buildingId: sibling.id } });
    const siblingDepartment = await prisma.department.create({ data: { name: 'Contractor Department', code: 'CD-1', unitId: unit1.id } });
    const siblingSection = await prisma.section.create({ data: { name: 'Contractor Section', normalizedName: 'contractor section', departmentId: siblingDepartment.id } });
    const siblingFunction = await prisma.orgFunction.create({ data: { name: 'Contractor Function', normalizedName: 'contractor function', sectionId: siblingSection.id } });
    const siblingEmployee = await prisma.employee.create({ data: { employeeCode: 'HT-CO-1', fullName: 'Contractor Employee', departmentId: siblingDepartment.id,
      sectionId: siblingSection.id, section: siblingSection.name, functionId: siblingFunction.id, functionName: siblingFunction.name } });
    await prisma.seat.create({ data: { floorId: siblingFloor.id, label: 'CO-WS-1', employeeId: siblingEmployee.id } });
    const response = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&buildingId=${sibling.id}` });
    const body = response.json();
    expect(body.buildings.map((building: any) => building.id)).toEqual(expect.arrayContaining([building1.id, sibling.id]));
    expect(body.floors.map((floor: any) => floor.id)).toEqual([siblingFloor.id]);
    expect(body.departments.map((department: any) => department.id)).toEqual([siblingDepartment.id]);
    const switched = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&buildingId=${building1.id}` });
    expect(switched.json().floors.map((floor: any) => floor.id)).toContain(floor1.id);
    const organizational = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&departmentId=${siblingDepartment.id}` });
    expect(organizational.json().buildings.map((building: any) => building.id)).toEqual([sibling.id]);
    expect(organizational.json().sectionOptions.map((section: any) => section.id)).toEqual([siblingSection.id]);
    const functionScope = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}&sectionId=${siblingSection.id}&functionId=${siblingFunction.id}` });
    expect(functionScope.json().buildings.map((building: any) => building.id)).toEqual([sibling.id]);
    const intersection = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&buildingId=${sibling.id}&departmentId=${siblingDepartment.id}&sectionId=${siblingSection.id}&functionId=${siblingFunction.id}` });
    expect(intersection.json().employees.map((employee: any) => employee.id)).toEqual([siblingEmployee.id]);
    const incompatible = await app.inject({ method: 'GET', url: `/api/employees?unitId=${unit1.id}&buildingId=${sibling.id}&areaId=${area1.id}` });
    expect(incompatible.json().total).toBe(0);
  });

  it('disambiguates duplicate area and function names with parent hierarchy references', async () => {
    const plant2 = await prisma.plant.create({ data: { name: 'Test Campus 2', code: 'TC-2', unitId: unit1.id } });
    const building2 = await prisma.building.create({ data: { name: 'Second Building', code: 'SB-1', plantId: plant2.id } });
    const floor2 = await prisma.floor.create({ data: { name: 'Ground Floor', floorNumber: 0, buildingId: building2.id } });
    const areaDup = await prisma.area.create({ data: { name: 'Test Area', normalizedName: 'test area 2', floorId: floor2.id } });

    const departmentDup = await prisma.department.create({ data: { name: 'Second Department', code: 'SD-1', unitId: unit1.id } });
    const sectionDup = await prisma.section.create({ data: { name: 'Second Section', normalizedName: 'second section', departmentId: departmentDup.id } });
    const functionDup = await prisma.orgFunction.create({ data: { name: 'Test Function', normalizedName: 'test function 2', sectionId: sectionDup.id } });

    const empDup = await prisma.employee.create({ data: {
      employeeCode: 'HT-DUP-1', fullName: 'Dup Emp', departmentId: departmentDup.id,
      sectionId: sectionDup.id, functionId: functionDup.id, section: sectionDup.name, functionName: functionDup.name,
      isActive: true
    } });
    await prisma.seat.create({ data: { floorId: floor2.id, label: 'SB-WS-1', areaId: areaDup.id, employeeId: empDup.id } });

    admin = { role: 'SUPER_ADMIN', email: 'superadmin@shaktiman.com' };
    const res = await app.inject({ method: 'GET', url: `/api/employees/filter-options?unitId=${unit1.id}` });
    const data = res.json();

    const testAreas = data.areaOptions.filter((a: any) => a.name === 'Test Area');
    expect(testAreas.length).toBe(2);
    expect(testAreas.map((a: any) => a.displayName)).toEqual(expect.arrayContaining([
      'Hierarchy Test Unit 1 → Test Building → Test Floor → Test Area',
      'Hierarchy Test Unit 1 → Second Building → Ground Floor → Test Area'
    ]));

    const testFunctions = data.functionOptions.filter((f: any) => f.name === 'Test Function');
    expect(testFunctions.length).toBe(2);
    expect(testFunctions.map((f: any) => f.displayName)).toEqual(expect.arrayContaining([
      'Test Department → Test Section → Test Function',
      'Second Department → Second Section → Test Function'
    ]));
  });
});
