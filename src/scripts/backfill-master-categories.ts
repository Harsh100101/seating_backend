import { PrismaClient } from '@prisma/client';
import { loadApplicationEnvironment, requireDatabaseUrl } from '../config/environment.js';

loadApplicationEnvironment();
requireDatabaseUrl();

const prisma = new PrismaClient();
const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');

async function main() {
  const report = { areasCreated: 0, sectionsCreated: 0, functionsCreated: 0, seatsLinked: 0, employeesLinked: 0, ambiguous: [] as Array<Record<string, string>> };

  const seats = await prisma.seat.findMany({ where: { officeArea: { not: null } }, select: { id: true, floorId: true, officeArea: true, areaId: true } });
  for (const seat of seats) {
    if (seat.areaId || !seat.officeArea?.trim()) continue;
    const normalizedName = normalize(seat.officeArea);
    let area = await prisma.area.findUnique({ where: { floorId_normalizedName: { floorId: seat.floorId, normalizedName } } });
    if (!area) {
      area = await prisma.area.create({ data: { floorId: seat.floorId, name: seat.officeArea.trim().replace(/\s+/g, ' '), normalizedName } });
      report.areasCreated++;
    }
    await prisma.seat.update({ where: { id: seat.id }, data: { areaId: area.id } });
    report.seatsLinked++;
  }

  const employees = await prisma.employee.findMany({
    where: { OR: [{ section: { not: null } }, { functionName: { not: null } }] },
    select: { id: true, departmentId: true, section: true, sectionId: true, functionName: true, functionId: true }
  });
  for (const employee of employees) {
    let sectionId = employee.sectionId;
    if (!sectionId && employee.section?.trim()) {
      const normalizedName = normalize(employee.section);
      let section = await prisma.section.findUnique({ where: { departmentId_normalizedName: { departmentId: employee.departmentId, normalizedName } } });
      if (!section) {
        section = await prisma.section.create({ data: { departmentId: employee.departmentId, name: employee.section.trim().replace(/\s+/g, ' '), normalizedName } });
        report.sectionsCreated++;
      }
      sectionId = section.id;
    }
    let functionId = employee.functionId;
    if (!functionId && employee.functionName?.trim()) {
      if (!sectionId) {
        report.ambiguous.push({ employeeId: employee.id, field: 'functionName', value: employee.functionName, reason: 'No section available' });
      } else {
        const normalizedName = normalize(employee.functionName);
        let fn = await prisma.orgFunction.findUnique({ where: { sectionId_normalizedName: { sectionId, normalizedName } } });
        if (!fn) {
          fn = await prisma.orgFunction.create({ data: { sectionId, name: employee.functionName.trim().replace(/\s+/g, ' '), normalizedName } });
          report.functionsCreated++;
        }
        functionId = fn.id;
      }
    }
    if (sectionId !== employee.sectionId || functionId !== employee.functionId) {
      await prisma.employee.update({ where: { id: employee.id }, data: { sectionId, functionId } });
      report.employeesLinked++;
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().finally(() => prisma.$disconnect());
