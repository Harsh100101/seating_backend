import type { Prisma, PrismaClient } from '@prisma/client';

type PrismaLike = PrismaClient | Prisma.TransactionClient | any;

/**
 * Direct Building.unitId is authoritative. Legacy Plant ownership is used
 * only while populated databases are being backfilled.
 */
export const buildingUnitWhere = (unitIds: string[]): Prisma.BuildingWhereInput => ({
  OR: [
    { unitId: { in: unitIds } },
    { AND: [{ unitId: { isSet: false } }, { plant: { unitId: { in: unitIds } } }] },
    { AND: [{ unitId: null }, { plant: { unitId: { in: unitIds } } }] }
  ]
});

export const resolveBuildingUnitId = async (
  prisma: PrismaLike,
  buildingId: string
): Promise<string | null> => {
  const building = await prisma.building.findUnique({
    where: { id: buildingId },
    select: { unitId: true, plantId: true }
  });
  if (!building) return null;
  if (building.unitId) return building.unitId;
  if (!building.plantId) return null;
  const plant = await prisma.plant.findUnique({
    where: { id: building.plantId },
    select: { unitId: true }
  });
  return plant?.unitId || null;
};

export const unitIdFromBuilding = (building: any): string | null =>
  building?.unitId || building?.unit?.id || building?.plant?.unitId || building?.plant?.unit?.id || null;
