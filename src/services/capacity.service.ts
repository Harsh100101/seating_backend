import { buildingUnitWhere } from '../utils/building-unit.js';

export interface UnitCapacity {
  unitId: string;
  totalSeats: number;
  occupiedSeats: number;
  availableSeats: number;
}

/**
 * Returns seat capacity using the same hierarchy and seat-state rules for
 * dashboards, transfer options, and transfer validation.
 *
 * A unit is eligible when it has at least one seat on an active building and
 * active floor. Direct Unit ownership is authoritative; legacy Plant ownership
 * remains a read fallback while populated databases are backfilled.
 */
export async function getUnitCapacityMap(
  prisma: any,
  requestedUnitIds?: string[]
): Promise<Map<string, UnitCapacity>> {
  const requested = requestedUnitIds?.length ? new Set(requestedUnitIds) : null;
  const units = (await prisma.unit.findMany({ select: { id: true } }))
    .filter((unit: any) => !requested || requested.has(unit.id));
  const unitIds = units.map((unit: any) => unit.id);
  const capacity = new Map<string, UnitCapacity>();
  for (const unitId of unitIds) {
    capacity.set(unitId, { unitId, totalSeats: 0, occupiedSeats: 0, availableSeats: 0 });
  }
  if (unitIds.length === 0) return capacity;

  const plants = await prisma.plant.findMany({
    where: { unitId: { in: unitIds } },
    select: { id: true, unitId: true }
  });
  const plantIds = plants.map((plant: any) => plant.id);

  const buildings = (await prisma.building.findMany({
    where: buildingUnitWhere(unitIds),
    select: { id: true, unitId: true, plantId: true }
  })).filter((building: any) => building.isActive !== false);
  const buildingIds = buildings.map((building: any) => building.id);
  if (buildingIds.length === 0) return capacity;

  const floors = (await prisma.floor.findMany({
    where: { buildingId: { in: buildingIds } },
    select: { id: true, buildingId: true }
  })).filter((floor: any) => floor.isActive !== false);
  const floorIds = floors.map((floor: any) => floor.id);
  if (floorIds.length === 0) return capacity;

  const plantUnit = new Map<string, string>(plants.map((plant: any) => [plant.id as string, plant.unitId as string]));
  const buildingUnit = new Map<string, string | undefined>();
  for (const building of buildings) {
    const legacyUnitId = building.plantId ? plantUnit.get(building.plantId) : undefined;
    buildingUnit.set(building.id, building.unitId || legacyUnitId);
  }
  const floorUnit = new Map<string, string | undefined>();
  for (const floor of floors) {
    floorUnit.set(floor.id, buildingUnit.get(floor.buildingId));
  }
  const seats = await prisma.seat.findMany({
    where: { floorId: { in: floorIds } },
    select: { floorId: true, employeeId: true, status: true }
  });

  for (const seat of seats) {
    const unitId = floorUnit.get(seat.floorId);
    if (!unitId) continue;
    const item = capacity.get(unitId);
    if (!item) continue;
    item.totalSeats += 1;
    if (seat.employeeId !== null && seat.employeeId !== undefined) item.occupiedSeats += 1;
    if (seat.status === 'AVAILABLE' && (seat.employeeId === null || seat.employeeId === undefined)) {
      item.availableSeats += 1;
    }
  }

  return capacity;
}

export async function getAvailableSeatCount(prisma: any, unitId: string): Promise<number> {
  return (await getUnitCapacityMap(prisma, [unitId])).get(unitId)?.availableSeats || 0;
}
