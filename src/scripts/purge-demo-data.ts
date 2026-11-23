import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function purgeDemoData() {
  console.log('--- Checking Demo Employees ---');
  const demoEmployees = await prisma.employee.findMany({
    where: { employeeCode: { startsWith: 'EMP-' } },
    include: { seat: true },
  });

  console.log(`Found ${demoEmployees.length} demo employees with EMP- prefix.`);

  // Free seats attached to demo employees
  for (const emp of demoEmployees) {
    if (emp.seat) {
      console.log(`Clearing seat ${emp.seat.label} (${emp.seat.id}) from demo employee ${emp.fullName}`);
      await prisma.$runCommandRaw({
        update: 'seats',
        updates: [
          {
            q: { _id: { $oid: emp.seat.id } },
            u: {
              $unset: { employee_id: '' },
              $set: { status: 'AVAILABLE' }
            }
          }
        ]
      });
    }
  }

  // Delete the 34 demo employees
  const deleteResult = await prisma.employee.deleteMany({
    where: { employeeCode: { startsWith: 'EMP-' } },
  });
  console.log(`Deleted ${deleteResult.count} demo employees.`);

  // Check demo departments that have 0 employees now
  const demoDeptNames = [
    'Engineering',
    'Product',
    'Design',
    'Sales',
    'Finance',
    'Operations',
    'HR/Admin',
    'Marketing',
  ];

  for (const name of demoDeptNames) {
    const depts = await prisma.department.findMany({
      where: { name },
      include: { _count: { select: { employees: true } } },
    });
    for (const d of depts) {
      if (d._count.employees === 0) {
        console.log(`Removing empty demo department: ${d.name} (${d.code})`);
        await prisma.department.delete({ where: { id: d.id } });
      } else {
        console.log(`Retaining department ${d.name} because it has ${d._count.employees} employees.`);
      }
    }
  }

  const remainingEmployees = await prisma.employee.count();
  console.log(`Total remaining genuine employees in DB: ${remainingEmployees}`);
}

purgeDemoData()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
