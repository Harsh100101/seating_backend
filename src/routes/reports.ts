import { FastifyPluginAsync } from 'fastify';
import { normalizeEmpCode, isVacantEmpCode } from '../utils/employee-code.js';
import { getUnitCapacityMap } from '../services/capacity.service.js';
import { unitSelectorWhere } from '../utils/unit-classification.js';
import { buildingUnitWhere } from '../utils/building-unit.js';

export const reportRoutes: FastifyPluginAsync = async (fastify) => {
  const getSummary = async (filterFloorId?: string, effectiveUnitId?: string) => {
    // Resolve the hierarchy first, then push the resulting IDs into the
    // database queries. This keeps unit-scoped reports from loading the whole
    // company into application memory.
    const [allUnits, allPlants] = await Promise.all([
      fastify.prisma.unit.findMany({
        where: effectiveUnitId ? { id: effectiveUnitId } : unitSelectorWhere(),
        orderBy: { name: 'asc' }
      }),
      fastify.prisma.plant.findMany({
        ...(effectiveUnitId ? { where: { unitId: effectiveUnitId } } : {}),
        orderBy: { name: 'asc' }
      })
    ]);
    const allBuildings = (await fastify.prisma.building.findMany({
      where: buildingUnitWhere(allUnits.map((unit) => unit.id)),
      orderBy: { name: 'asc' }
    })).filter((building: any) => building.isActive !== false);
    const allFloors = (await fastify.prisma.floor.findMany({
      where: { buildingId: { in: allBuildings.map((b) => b.id) } },
      orderBy: { floorNumber: 'asc' }
    })).filter((floor: any) => floor.isActive !== false);
    const allSeats = await fastify.prisma.seat.findMany({
      where: { floorId: { in: allFloors.map((f) => f.id) } },
      select: {
        id: true,
        floorId: true,
        departmentId: true,
        employeeId: true,
        status: true
      }
    });
    const seatDepartmentIds = [...new Set(allSeats.map((seat) => seat.departmentId).filter(Boolean))] as string[];
    const allDepartments = await fastify.prisma.department.findMany({
      ...(effectiveUnitId
        ? { where: { OR: [{ unitId: effectiveUnitId }, { id: { in: seatDepartmentIds } }] } }
        : {}),
      select: {
        id: true,
        name: true,
        code: true,
        colorHex: true,
        unitId: true
      },
      orderBy: { name: 'asc' }
    });
    const seatEmployeeIds = [...new Set(allSeats.map((seat) => seat.employeeId).filter(Boolean))] as string[];
    const employeeWhere = effectiveUnitId
      ? { OR: [{ departmentId: { in: allDepartments.map((d) => d.id) } }, { id: { in: seatEmployeeIds } }] }
      : {};

    const [totalEmployees, seatedEmployees] = await Promise.all([
      fastify.prisma.employee.count({ where: employeeWhere }),
      seatEmployeeIds.length > 0
        ? fastify.prisma.employee.findMany({
            where: { id: { in: seatEmployeeIds } },
            select: { id: true, departmentId: true }
          })
        : Promise.resolve([])
    ]);

    const totalSeats = allSeats.length;
    const occupiedSeats = allSeats.filter((s) => s.employeeId !== null).length;
    const capacity = await getUnitCapacityMap(fastify.prisma, allUnits.map((unit) => unit.id));
    const availableSeats = allUnits.reduce((total, unit) => total + (capacity.get(unit.id)?.availableSeats || 0), 0);
    const maintenanceSeats = allSeats.filter((s) => s.status === 'MAINTENANCE').length;
    const reservedSeats = allSeats.filter((s) => s.status === 'RESERVED').length;

    const overallOccupancyRate = totalSeats > 0 ? Number(((occupiedSeats / totalSeats) * 100).toFixed(1)) : 0.0;
    const overallVacancyRate = totalSeats > 0 ? Number((((totalSeats - occupiedSeats) / totalSeats) * 100).toFixed(1)) : 0.0;

    const unassignedEmployees = Math.max(0, totalEmployees - seatedEmployees.length);

    // Lookups
    const unitMap = new Map(allUnits.map((u) => [u.id, u]));
    const plantMap = new Map(allPlants.map((p) => [p.id, p]));
    const buildingMap = new Map(allBuildings.map((b) => [b.id, b]));
    const floorMap = new Map(allFloors.map((f) => [f.id, f]));
    const plantUnitMap = new Map(allPlants.map((p) => [p.id, p.unitId]));
    const floorBuildingMap = new Map(allFloors.map((f) => [f.id, f.buildingId]));
    const floorUnitMap = new Map<string, string>();
    const floorPlantMap = new Map<string, string>();
    for (const floor of allFloors) {
      const building = buildingMap.get(floor.buildingId);
      const plantId = building?.plantId || undefined;
      const unitId = building?.unitId || (plantId ? plantUnitMap.get(plantId) : undefined);
      if (plantId) floorPlantMap.set(floor.id, plantId);
      if (unitId) floorUnitMap.set(floor.id, unitId);
    }

    const seatsByFloor = new Map<string, typeof allSeats>();
    const seatsByFloorDepartment = new Map<string, Map<string, number>>();
    const seatsByUnit = new Map<string, typeof allSeats>();
    const seatsByPlant = new Map<string, typeof allSeats>();
    for (const seat of allSeats) {
      const floorSeats = seatsByFloor.get(seat.floorId) || [];
      floorSeats.push(seat);
      seatsByFloor.set(seat.floorId, floorSeats);

      if (seat.departmentId) {
        const floorDepartments = seatsByFloorDepartment.get(seat.floorId) || new Map<string, number>();
        floorDepartments.set(seat.departmentId, (floorDepartments.get(seat.departmentId) || 0) + 1);
        seatsByFloorDepartment.set(seat.floorId, floorDepartments);
      }

      const unitId = floorUnitMap.get(seat.floorId);
      if (unitId) {
        const unitSeats = seatsByUnit.get(unitId) || [];
        unitSeats.push(seat);
        seatsByUnit.set(unitId, unitSeats);
      }
      const plantId = floorPlantMap.get(seat.floorId);
      if (plantId) {
        const plantSeats = seatsByPlant.get(plantId) || [];
        plantSeats.push(seat);
        seatsByPlant.set(plantId, plantSeats);
      }
    }

    const employeeIdsByDepartment = new Map<string, Set<string>>();
    for (const employee of seatedEmployees) {
      if (employee.departmentId) {
        const employeeIds = employeeIdsByDepartment.get(employee.departmentId) || new Set<string>();
        employeeIds.add(employee.id);
        employeeIdsByDepartment.set(employee.departmentId, employeeIds);
      }
    }
    const deptEmpMap = new Map<string, Set<string>>();
    for (const d of allDepartments) {
      deptEmpMap.set(d.id, employeeIdsByDepartment.get(d.id) || new Set<string>());
    }

    // byUnit aggregation
    const byUnit = allUnits.map((unit) => {
      const unitSeats = seatsByUnit.get(unit.id) || [];
      const occ = unitSeats.filter((s) => s.employeeId !== null).length;
      const rate = unitSeats.length > 0 ? Number(((occ / unitSeats.length) * 100).toFixed(1)) : 0.0;

      return {
        unitId: unit.id,
        unitName: unit.name,
        unitCode: unit.code,
        total: unitSeats.length,
        occupied: occ,
        availableSeats: capacity.get(unit.id)?.availableSeats || 0,
        rate,
        totalSeats: unitSeats.length,
        occupiedSeats: occ,
        occupancyRate: rate
      };
    });

    // byPlant aggregation
    const byPlant = allPlants.map((plant) => {
      const plantSeats = seatsByPlant.get(plant.id) || [];
      const occ = plantSeats.filter((s) => s.employeeId !== null).length;
      const rate = plantSeats.length > 0 ? Number(((occ / plantSeats.length) * 100).toFixed(1)) : 0.0;
      const parentUnit = unitMap.get(plant.unitId);

      return {
        plantId: plant.id,
        plantName: plant.name,
        plantCode: plant.code,
        unitId: plant.unitId,
        unitName: parentUnit?.name,
        total: plantSeats.length,
        occupied: occ,
        rate,
        totalSeats: plantSeats.length,
        occupiedSeats: occ,
        occupancyRate: rate
      };
    });

    // byFloor aggregation
    const byFloor = allFloors.map((flr) => {
      const flrSeats = seatsByFloor.get(flr.id) || [];
      const occ = flrSeats.filter((s) => s.employeeId !== null).length;
      const rate = flrSeats.length > 0 ? Number(((occ / flrSeats.length) * 100).toFixed(1)) : 0.0;
      const bld = buildingMap.get(flr.buildingId);
      const plant = bld?.plantId ? plantMap.get(bld.plantId) : null;
      const unitId = bld?.unitId || (plant ? plant.unitId : undefined);
      const unit = unitId ? unitMap.get(unitId) : null;

      const flrDepts = allDepartments
        .map((d) => {
          const deptEmpIds = deptEmpMap.get(d.id) || new Set();
            const allocated = flrSeats.filter((s) => s.employeeId && deptEmpIds.has(s.employeeId)).length;
            const directDepartmentSeats = flrSeats.filter((s) => s.departmentId === d.id && !(s.employeeId && deptEmpIds.has(s.employeeId))).length;
            const total = directDepartmentSeats + allocated;
          return {
            departmentId: d.id,
            departmentName: d.name,
            colorHex: d.colorHex,
            allocatedSeats: allocated,
            totalSeats: total
          };
        })
        .filter((d) => d.allocatedSeats > 0 || d.totalSeats > 0);

      return {
        floorId: flr.id,
        floorName: flr.name,
        floorNumber: flr.floorNumber,
        buildingName: bld?.name,
        plantName: plant?.name,
        unitName: unit?.name,
        officeName: unit?.name, // fallback for legacy consumers
        total: flrSeats.length,
        occupied: occ,
        rate,
        totalSeats: flrSeats.length,
        occupiedSeats: occ,
        occupancyRate: rate,
        departments: flrDepts
      };
    });

    // byDepartment aggregation
    const byDepartment = allDepartments.map((d) => {
      const deptEmpIds = deptEmpMap.get(d.id) || new Set();
      const relevantSeats = filterFloorId ? (seatsByFloor.get(filterFloorId) || []) : allSeats;
      const allocated = relevantSeats.filter((s) => s.employeeId && deptEmpIds.has(s.employeeId)).length;

      const floorAllocations: Record<string, number> = {};
      for (const flr of allFloors) {
        floorAllocations[flr.id] = (seatsByFloor.get(flr.id) || []).filter((s) => s.employeeId && deptEmpIds.has(s.employeeId)).length;
      }

      return {
        departmentId: d.id,
        departmentName: d.name,
        colorHex: d.colorHex,
        allocatedSeats: allocated,
        floorAllocations
      };
    });

    // byOffice fallback (aliases byUnit for backward compatibility)
    const byOffice = byUnit.map((u) => ({
      officeId: u.unitId,
      officeName: u.unitName,
      totalSeats: u.total,
      occupiedSeats: u.occupied,
      occupancyRate: u.rate
    }));

    const kpis = {
      totalSeats,
      occupiedSeats,
      availableSeats,
      maintenanceSeats,
      reservedSeats,
      overallOccupancyRate,
      overallVacancyRate,
      totalEmployees,
      unassignedEmployees
    };

    return {
      kpis,
      byUnit,
      byPlant,
      byOffice,
      byFloor,
      byDepartment,
      totalSeats,
      occupiedSeats,
      availableSeats,
      maintenanceSeats,
      reservedSeats,
      vacancyRate: overallVacancyRate,
      unitBreakdown: byUnit,
      plantBreakdown: byPlant,
      officeBreakdown: byOffice,
      floorBreakdown: byFloor
    };
  };

  // GET /api/reports/summary
  fastify.get('/summary', async (request, reply) => {
    const { floorId, unitId } = (request.query as any) || {};
    let effectiveUnitId: string | undefined = unitId;
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      effectiveUnitId = request.admin?.assignedUnitId || undefined;
    }
    const data = await getSummary(floorId, effectiveUnitId);
    return reply.status(200).send(data);
  });

  // GET /api/reports/occupancy (alias)
  fastify.get('/occupancy', async (request, reply) => {
    const { floorId, unitId } = (request.query as any) || {};
    let effectiveUnitId: string | undefined = unitId;
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      effectiveUnitId = request.admin?.assignedUnitId || undefined;
    }
    const data = await getSummary(floorId, effectiveUnitId);
    return reply.status(200).send(data);
  });

  // GET /api/reports/data-quality
  // Read-only integrity report for admin review. It intentionally does not mutate data.
  fastify.get('/data-quality', async (request, reply) => {
    const requestedUnitId = (request.query as any)?.unitId as string | undefined;
    const effectiveUnitId = request.admin?.role === 'SUPER_ADMIN' || request.admin?.role === 'TECH_ADMIN'
      ? requestedUnitId
      : request.admin?.assignedUnitId || undefined;

    const [employees, seats] = await Promise.all([
      fastify.prisma.employee.findMany({
        include: {
          department: { select: { name: true, unitId: true, unit: { select: { id: true, name: true } } } },
          // Atlas contains legacy buildings whose plant relation is missing.
          // Read the nullable foreign-key value and resolve valid plants below
          // instead of asking Prisma to materialize a required nested relation.
          seat: { select: { id: true, label: true, floorId: true, employeeId: true, floor: { select: { name: true, building: { select: { name: true, unitId: true, plantId: true } } } } } }
        }
      }),
      fastify.prisma.seat.findMany({
        include: {
          employee: { select: { id: true, employeeCode: true, fullName: true } },
          floor: { select: { id: true, name: true, building: { select: { name: true, unitId: true, plantId: true } } } }
        }
      })
    ]);

    const plantIds = Array.from(new Set([
      ...employees.map((employee: any) => employee.seat?.floor?.building?.plantId),
      ...seats.map((seat: any) => seat.floor?.building?.plantId)
    ].filter(Boolean)));
    const reportPlants = await fastify.prisma.plant.findMany({
      where: { id: { in: plantIds } },
      select: { id: true, unitId: true }
    });
    const directUnitIds = [
      ...employees.map((employee: any) => employee.seat?.floor?.building?.unitId),
      ...seats.map((seat: any) => seat.floor?.building?.unitId)
    ].filter(Boolean);
    const reportPlantUnitIds = Array.from(new Set([...reportPlants.map((plant) => plant.unitId), ...directUnitIds].filter(Boolean)));
    const reportUnits = await fastify.prisma.unit.findMany({
      where: { id: { in: reportPlantUnitIds } },
      select: { id: true, name: true }
    });
    const reportPlantMap = new Map(reportPlants.map((plant) => [plant.id, plant]));
    const reportUnitMap = new Map(reportUnits.map((unit) => [unit.id, unit]));
    const seatUnitId = (record: any): string | undefined => {
      const building = record?.floor?.building;
      if (building?.unitId) return building.unitId;
      const plantId = building?.plantId;
      return plantId ? reportPlantMap.get(plantId)?.unitId : undefined;
    };
    const seatUnitName = (record: any): string | undefined => {
      const unitId = seatUnitId(record);
      return unitId ? reportUnitMap.get(unitId)?.name : undefined;
    };

    const inUnit = (unitId?: string | null) => !effectiveUnitId || unitId === effectiveUnitId;
    const scopedEmployees = employees.filter((employee: any) => inUnit(employee.department?.unitId || seatUnitId(employee.seat)));
    const scopedSeats = seats.filter((seat: any) => inUnit(seatUnitId(seat)));

    const duplicateCodes = new Map<string, any[]>();
    for (const employee of scopedEmployees) {
      const code = normalizeEmpCode(employee.employeeCode);
      if (isVacantEmpCode(code)) continue;
      if (!duplicateCodes.has(code)) duplicateCodes.set(code, []);
      duplicateCodes.get(code)!.push(employee);
    }
    const duplicateEmployeeCodes = Array.from(duplicateCodes.entries())
      .filter(([, records]) => records.length > 1)
      .map(([employeeCode, records]) => ({ employeeCode, records: records.map((record) => ({ id: record.id, fullName: record.fullName, unit: record.department?.unit?.name || seatUnitName(record.seat) || null })) }));

    const duplicateSeatLabels = new Map<string, any[]>();
    for (const seat of scopedSeats) {
      const key = `${seat.floorId}:${seat.label.trim().toLowerCase()}`;
      if (!duplicateSeatLabels.has(key)) duplicateSeatLabels.set(key, []);
      duplicateSeatLabels.get(key)!.push(seat);
    }
    const duplicateSeats = Array.from(duplicateSeatLabels.entries())
      .filter(([, records]) => records.length > 1)
      .map(([key, records]) => ({ key, label: records[0].label, floor: records[0].floor?.name || null, count: records.length, seatIds: records.map((record) => record.id) }));

    const missingManager = scopedEmployees.filter((employee: any) => employee.isActive && !employee.reportingManager && !employee.reportingTo)
      .map((employee: any) => ({ id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName }));
    const missingHod = scopedEmployees.filter((employee: any) => employee.isActive && !employee.hod)
      .map((employee: any) => ({ id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName }));
    const occupiedWithoutEmployee = scopedSeats.filter((seat: any) => !seat.employeeId || !seat.employee)
      .filter((seat: any) => Boolean(seat.employeeId))
      .map((seat: any) => ({ id: seat.id, label: seat.label, floor: seat.floor?.name || null }));
    const activeEmployeeIds = new Set(scopedSeats.map((seat: any) => seat.employeeId).filter(Boolean));
    const activeEmployeesWithoutSeat = scopedEmployees.filter((employee: any) => employee.isActive && !activeEmployeeIds.has(employee.id))
      .map((employee: any) => ({ id: employee.id, employeeCode: employee.employeeCode, fullName: employee.fullName }));

    return reply.status(200).send({
      scope: effectiveUnitId || 'ALL',
      generatedAt: new Date().toISOString(),
      summary: {
        employees: scopedEmployees.length,
        seats: scopedSeats.length,
        occupiedSeats: scopedSeats.filter((seat: any) => Boolean(seat.employeeId)).length,
        vacantSeats: scopedSeats.filter((seat: any) => !seat.employeeId).length,
        duplicateEmployeeCodes: duplicateEmployeeCodes.length,
        duplicateSeats: duplicateSeats.length,
        missingManager: missingManager.length,
        missingHod: missingHod.length,
        occupiedWithoutEmployee: occupiedWithoutEmployee.length,
        activeEmployeesWithoutSeat: activeEmployeesWithoutSeat.length
      },
      issues: { duplicateEmployeeCodes, duplicateSeats, missingManager, missingHod, occupiedWithoutEmployee, activeEmployeesWithoutSeat }
    });
  });

  // GET /api/reports/export-csv
  fastify.get('/export-csv', async (request, reply) => {
    let [allSeats, allFloors, allBuildings, allPlants, allUnits] = await Promise.all([
      fastify.prisma.seat.findMany(),
      fastify.prisma.floor.findMany(),
      fastify.prisma.building.findMany(),
      fastify.prisma.plant.findMany(),
      fastify.prisma.unit.findMany({ where: unitSelectorWhere() })
    ]);
    const [allEmployees, allDepartments] = await Promise.all([
      fastify.prisma.employee.findMany(),
      fastify.prisma.department.findMany()
    ]);

    let effectiveUnitId: string | undefined = (request.query as any)?.unitId;
    if (request.admin?.role !== 'SUPER_ADMIN' && request.admin?.role !== 'TECH_ADMIN') {
      effectiveUnitId = request.admin?.assignedUnitId || undefined;
    }
    if (effectiveUnitId) {
      allUnits = allUnits.filter((u) => u.id === effectiveUnitId);
      allPlants = allPlants.filter((p) => p.unitId === effectiveUnitId);
      const plantIds = new Set(allPlants.map((p) => p.id));
      allBuildings = allBuildings.filter((b) => b.unitId === effectiveUnitId || (b.plantId ? plantIds.has(b.plantId) : false));
      const buildingIds = new Set(allBuildings.map((b) => b.id));
      allFloors = allFloors.filter((f) => buildingIds.has(f.buildingId));
      const floorIds = new Set(allFloors.map((f) => f.id));
      allSeats = allSeats.filter((s) => floorIds.has(s.floorId));
    }

    const floorMap = new Map(allFloors.map((f) => [f.id, f]));
    const buildingMap = new Map(allBuildings.map((b) => [b.id, b]));
    const plantMap = new Map(allPlants.map((p) => [p.id, p]));
    const unitMap = new Map(allUnits.map((u) => [u.id, u]));
    const employeeMap = new Map(allEmployees.map((e) => [e.id, e]));
    const deptMap = new Map(allDepartments.map((d) => [d.id, d]));

    const headers = 'Unit Name,Plant Name,Building Name,Floor Name,Seat Label,Seat Type,Seat Status,Employee Code,Employee Name,Employee Email,Department Code,Department Name';
    const rows: string[] = [headers];

    // Sort seats by floor and label for deterministic CSV export
    const sortedSeats = [...allSeats].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

    for (const seat of sortedSeats) {
      const floor = floorMap.get(seat.floorId);
      const building = floor ? buildingMap.get(floor.buildingId) : null;
      const plant = building?.plantId ? plantMap.get(building.plantId) : null;
      const unitId = building?.unitId || (plant ? plant.unitId : undefined);
      const unit = unitId ? unitMap.get(unitId) : null;
      const employee = seat.employeeId ? employeeMap.get(seat.employeeId) : null;
      const dept = employee ? deptMap.get(employee.departmentId) : (seat.departmentId ? deptMap.get(seat.departmentId) : null);

      // Sanitize against CSV / Excel formula injection (OWASP CWE-1236)
      const sanitizeCell = (val: unknown): string => {
        if (val === null || val === undefined) return '';
        const str = String(val);
        if (/^[=+\-@\t\r]/.test(str)) {
          return `'${str}`;
        }
        return str;
      };

      const cells = [
        unit?.name || '',
        plant?.name || '',
        building?.name || '',
        floor?.name || '',
        seat.label,
        seat.type,
        seat.status,
        employee?.employeeCode || '',
        employee?.fullName || '',
        employee?.email || '',
        dept?.code || '',
        dept?.name || ''
      ];

      rows.push(cells.map((v) => `"${sanitizeCell(v).replace(/"/g, '""')}"`).join(','));
    }

    const csvText = rows.join('\r\n');
    const today = new Date().toISOString().slice(0, 10);

    return reply
      .status(200)
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="seating-allocations-${today}.csv"`)
      .send(csvText);
  });
};
