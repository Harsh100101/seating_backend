import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  console.log('=== Database Audit for Demo / Mock Data ===');

  const totalEmployees = await prisma.employee.count();
  const allEmployees = await prisma.employee.findMany({
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      email: true,
      department: { select: { name: true, unit: { select: { name: true } } } },
      seat: { select: { label: true } }
    }
  });

  const empPrefix = allEmployees.filter(e => e.employeeCode.startsWith('EMP-'));
  const demoAccounts = await prisma.adminUser.findMany({
    select: { id: true, email: true, name: true, role: true }
  });

  const allUnits = await prisma.unit.findMany({
    include: {
      plants: {
        include: {
          buildings: {
            include: {
              floors: {
                include: {
                  seats: true
                }
              }
            }
          }
        }
      }
    }
  });

  console.log({
    totalEmployees,
    employeesWithEmpPrefix: empPrefix.length,
    adminUsersCount: demoAccounts.length
  });

  console.log('\n--- Employees with EMP- prefix (Sample 25) ---');
  for (const e of empPrefix.slice(0, 25)) {
    console.log(`[${e.employeeCode}] ${e.fullName} | Dept: ${e.department?.name || 'N/A'} | Unit: ${e.department?.unit?.name || 'N/A'} | Seat: ${e.seat?.label || 'None'}`);
  }

  console.log('\n--- Admin Users ---');
  for (const a of demoAccounts) {
    console.log(`[${a.role}] ${a.email} (${a.name})`);
  }

  console.log('\n--- Units Breakdown ---');
  for (const u of allUnits) {
    let seatCount = 0;
    for (const p of u.plants) {
      for (const b of p.buildings) {
        for (const f of b.floors) {
          seatCount += f.seats.length;
        }
      }
    }
    console.log(`Unit: ${u.name} (${u.code}) -> Plants: ${u.plants.length}, Seats: ${seatCount}`);
  }

  await prisma.$disconnect();
}

run().catch(console.error);
