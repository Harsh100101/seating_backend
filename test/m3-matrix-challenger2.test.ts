import { describe, it, expect } from 'vitest';

// Types mirroring apps/frontend/src/pages/EmployeesPage.tsx
interface Employee {
  id: string;
  fullName: string;
  email?: string | null;
  employeeCode: string;
  designation?: string | null;
  grade?: string | null;
  phone?: string | null;
  ext?: string | null;
  section?: string | null;
  functionName?: string | null;
  reportingManager?: string | null;
  reportingTo?: string | null;
  hod?: string | null;
  remarks?: string | null;
  pcNumber?: string | null;
  officeArea?: string | null;
  subLocation?: string | null;
  departmentId: string;
  department?: {
    id: string;
    name: string;
    code?: string;
    colorHex: string;
    unitId?: string | null;
    unit?: {
      id: string;
      name: string;
      code: string;
    } | null;
  };
  seat?: {
    id: string;
    label: string;
    floorId: string;
    pcNumber?: string | null;
    officeArea?: string | null;
    zone?: string | null;
    type?: string | null;
    department?: {
      id?: string;
      name?: string;
      code?: string;
      colorHex?: string;
    } | null;
    floor?: {
      id?: string;
      name: string;
      floorNumber?: number;
      building?: {
        id?: string;
        name: string;
        plant?: {
          id?: string;
          name: string;
          unit?: {
            id?: string;
            name: string;
          };
        };
      };
    };
  } | null;
  unit?: { id: string; name: string; code?: string };
  plant?: { id: string; name: string; code?: string };
  building?: { id: string; name: string };
  floor?: { id: string; name: string; floorNumber?: number };
  isActive: boolean;
}

interface UnitOption {
  id: string;
  name: string;
  code?: string;
  location?: string;
}

interface BuildingOption {
  id: string;
  name: string;
  plantId?: string;
  plant?: { unitId?: string };
}

interface FloorOption {
  id: string;
  name: string;
  floorNumber: number;
  buildingId: string;
}

interface SeatOption {
  id: string;
  label: string;
  type?: string;
  status?: string;
  employeeId?: string | null;
  pcNumber?: string | null;
  officeArea?: string | null;
  zone?: string | null;
  remarks?: string | null;
  departmentId?: string | null;
  floor?: {
    id?: string;
    name?: string;
  } | null;
}

// Pure implementation of the EmployeesPage.tsx logic under empirical test
class EmployeesPageMatrixState {
  unitFilter: string = 'ALL';
  buildingFilter: string = 'ALL';
  floorFilter: string = 'ALL';
  officeAreaFilter: string = 'ALL';
  selectedDept: string = '';
  sectionFilter: string = '';
  plantFilter: string = 'ALL';
  search: string = '';
  assignmentFilter: 'ALL' | 'ASSIGNED' | 'UNASSIGNED' = 'ALL';
  activeFilter: 'ALL' | 'ACTIVE' | 'INACTIVE' = 'ALL';
  wsNoFilter: string = '';
  functionFilter: string = '';
  reportingToFilter: string = '';
  hodFilter: string = '';
  isSuperAdmin: boolean = true;

  handleUnitChange(newUnitId: string) {
    this.unitFilter = newUnitId;
    this.buildingFilter = 'ALL';
    this.floorFilter = 'ALL';
    this.officeAreaFilter = 'ALL';
    this.selectedDept = '';
    this.sectionFilter = '';
    this.plantFilter = 'ALL';
  }

  handleBuildingChange(newBuildingId: string) {
    this.buildingFilter = newBuildingId;
    this.floorFilter = 'ALL';
    this.officeAreaFilter = 'ALL';
  }

  handleFloorChange(newFloorId: string) {
    this.floorFilter = newFloorId;
    this.officeAreaFilter = 'ALL';
  }

  handleOfficeAreaChange(newArea: string) {
    this.officeAreaFilter = newArea;
  }

  handleDepartmentChange(newDeptId: string) {
    this.selectedDept = newDeptId;
    this.sectionFilter = '';
  }

  handleSectionChange(newSection: string) {
    this.sectionFilter = newSection;
  }

  handleResetFilters() {
    this.search = '';
    if (this.isSuperAdmin) this.unitFilter = 'ALL';
    this.buildingFilter = 'ALL';
    this.floorFilter = 'ALL';
    this.officeAreaFilter = 'ALL';
    this.selectedDept = '';
    this.sectionFilter = '';
    this.assignmentFilter = 'ALL';
    this.activeFilter = 'ALL';
    this.wsNoFilter = '';
    this.functionFilter = '';
    this.reportingToFilter = '';
    this.hodFilter = '';
    this.plantFilter = 'ALL';
  }

  computeFilteredEmployees(
    employees: Employee[],
    units: UnitOption[] = [],
    filterBuildings: BuildingOption[] = [],
    filterFloors: FloorOption[] = []
  ): Employee[] {
    return employees.filter((emp) => {
      // 1. Search Query
      if (this.search) {
        const q = this.search.toLowerCase();
        const matchesCode = emp.employeeCode?.toLowerCase().includes(q);
        const matchesName = emp.fullName?.toLowerCase().includes(q);
        const matchesEmail = emp.email?.toLowerCase().includes(q);
        const matchesDesig = emp.designation?.toLowerCase().includes(q);
        const matchesExt = emp.ext?.toLowerCase().includes(q) || emp.phone?.toLowerCase().includes(q);
        const matchesPc = emp.pcNumber?.toLowerCase().includes(q) || emp.seat?.pcNumber?.toLowerCase().includes(q);
        const matchesSeat = emp.seat?.label?.toLowerCase().includes(q);
        const matchesSection = emp.section?.toLowerCase().includes(q);
        const matchesFunction = emp.functionName?.toLowerCase().includes(q);
        const matchesManager = (emp.reportingManager || emp.reportingTo)?.toLowerCase().includes(q);
        const matchesHod = emp.hod?.toLowerCase().includes(q);
        if (
          !matchesCode &&
          !matchesName &&
          !matchesEmail &&
          !matchesDesig &&
          !matchesExt &&
          !matchesPc &&
          !matchesSeat &&
          !matchesSection &&
          !matchesFunction &&
          !matchesManager &&
          !matchesHod
        ) {
          return false;
        }
      }

      // Tier 1: Unit Filter
      if (this.unitFilter !== 'ALL') {
        const empUnitId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || (emp as any).unit?.id;
        const empUnitName = emp.seat?.floor?.building?.plant?.unit?.name || emp.department?.unit?.name || (emp as any).unit?.name;
        const targetUnit = units.find((u) => u.id === this.unitFilter);
        if (targetUnit) {
          if (empUnitId) {
            if (empUnitId !== targetUnit.id && empUnitName !== targetUnit.name) {
              return false;
            }
          } else if (this.isSuperAdmin) {
            return false;
          }
        } else if (empUnitId && empUnitId !== this.unitFilter) {
          return false;
        }
      }

      // Tier 2: Building Filter
      if (this.buildingFilter !== 'ALL') {
        const empBuildingId = emp.seat?.floor?.building?.id || (emp as any).building?.id;
        const empBuildingName = emp.seat?.floor?.building?.name || (emp as any).building?.name;
        const targetBuilding = filterBuildings.find((b) => b.id === this.buildingFilter);
        if (targetBuilding) {
          if (empBuildingId && empBuildingId !== targetBuilding.id && empBuildingName !== targetBuilding.name) {
            return false;
          }
        } else if (empBuildingId && empBuildingId !== this.buildingFilter) {
          return false;
        }
      }

      // Tier 3: Floor Filter
      if (this.floorFilter !== 'ALL') {
        const empFloorId = emp.seat?.floorId || emp.seat?.floor?.id || (emp as any).floor?.id;
        const empFloorName = emp.floor?.name || emp.seat?.floor?.name || emp.subLocation;
        const targetFloor = filterFloors.find((f) => f.id === this.floorFilter);
        if (targetFloor) {
          if (empFloorId && empFloorId !== targetFloor.id && empFloorName?.toLowerCase() !== targetFloor.name.toLowerCase()) {
            return false;
          }
        } else if (empFloorId !== this.floorFilter && empFloorName?.toLowerCase() !== this.floorFilter.toLowerCase()) {
          return false;
        }
      }

      // Tier 4: Office / Seating Area Filter
      if (this.officeAreaFilter !== 'ALL') {
        const targetArea = this.officeAreaFilter.trim().toLowerCase();
        const seatArea = emp.seat?.officeArea?.trim().toLowerCase();
        const directArea = emp.officeArea?.trim().toLowerCase();
        if (seatArea !== targetArea && directArea !== targetArea) {
          return false;
        }
      }

      // Tier 5: Department Filter
      if (this.selectedDept) {
        if (!emp.department) return false;
        const matchesDept =
          emp.departmentId === this.selectedDept ||
          emp.department.id === this.selectedDept ||
          emp.department.name.trim().toLowerCase() === this.selectedDept.trim().toLowerCase();
        if (!matchesDept) return false;
      }

      // Tier 6: Section Filter
      if (this.sectionFilter) {
        if (!emp.section || emp.section.trim().toLowerCase() !== this.sectionFilter.trim().toLowerCase()) {
          return false;
        }
      }

      // Secondary: WS NO
      if (this.wsNoFilter.trim()) {
        const q = this.wsNoFilter.trim().toLowerCase();
        const matchesSeat = emp.seat?.label?.toLowerCase().includes(q);
        if (!matchesSeat) return false;
      }

      // Secondary: Assignment Status
      if (this.assignmentFilter === 'ASSIGNED' && !emp.seat) return false;
      if (this.assignmentFilter === 'UNASSIGNED' && emp.seat) return false;

      // Secondary: Function
      if (this.functionFilter) {
        if (!emp.functionName || emp.functionName.trim().toLowerCase() !== this.functionFilter.trim().toLowerCase()) return false;
      }

      // Secondary: Reporting Manager
      if (this.reportingToFilter) {
        const manager = emp.reportingManager || emp.reportingTo;
        if (!manager || manager.trim().toLowerCase() !== this.reportingToFilter.trim().toLowerCase()) return false;
      }

      // Secondary: HOD
      if (this.hodFilter) {
        if (!emp.hod || emp.hod.trim().toLowerCase() !== this.hodFilter.trim().toLowerCase()) return false;
      }

      // Secondary: Active or not
      if (this.activeFilter === 'ACTIVE' && emp.isActive === false) return false;
      if (this.activeFilter === 'INACTIVE' && emp.isActive !== false) return false;

      // Secondary: Plant
      if (this.plantFilter !== 'ALL') {
        const empPlantId = emp.seat?.floor?.building?.plant?.id || (emp as any).plant?.id;
        if (empPlantId !== this.plantFilter) return false;
      }

      return true;
    });
  }

  computeAvailableOfficeAreas(
    floorFilter: string,
    matrixFloorSeats: SeatOption[],
    employees: Employee[],
    unitFilter: string,
    buildingFilter: string,
    units: UnitOption[] = [],
    filterBuildings: BuildingOption[] = []
  ): { name: string; count: number }[] {
    const counts = new Map<string, number>();

    if (floorFilter !== 'ALL' && matrixFloorSeats.length > 0) {
      matrixFloorSeats.forEach((s) => {
        const area = s.officeArea?.trim();
        if (area) {
          counts.set(area, (counts.get(area) || 0) + 1);
        }
      });
    } else {
      employees.forEach((emp) => {
        if (unitFilter !== 'ALL') {
          const empUnitId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || (emp as any).unit?.id;
          const targetUnit = units.find((u) => u.id === unitFilter);
          if (targetUnit && empUnitId && empUnitId !== targetUnit.id && (emp as any).unit?.name !== targetUnit.name) {
            return;
          }
        }
        if (buildingFilter !== 'ALL') {
          const empBuildingId = emp.seat?.floor?.building?.id || (emp as any).building?.id;
          const targetBuilding = filterBuildings.find((b) => b.id === buildingFilter);
          if (targetBuilding && empBuildingId && empBuildingId !== targetBuilding.id && (emp as any).building?.name !== targetBuilding.name) {
            return;
          }
        }
        const area = emp.seat?.officeArea?.trim() || emp.officeArea?.trim();
        if (area) {
          counts.set(area, (counts.get(area) || 0) + 1);
        }
      });
    }

    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  computeAvailableSections(
    employees: Employee[],
    selectedDept: string,
    unitFilter: string,
    units: UnitOption[] = []
  ): string[] {
    const set = new Set<string>();
    employees.forEach((emp) => {
      if (unitFilter !== 'ALL') {
        const empUnitId = emp.seat?.floor?.building?.plant?.unit?.id || emp.department?.unitId || (emp as any).unit?.id;
        const targetUnit = units.find((u) => u.id === unitFilter);
        if (targetUnit && empUnitId && empUnitId !== targetUnit.id && (emp as any).unit?.name !== targetUnit.name) {
          return;
        }
      }
      if (selectedDept) {
        const matchesDept =
          emp.departmentId === selectedDept ||
          emp.department?.id === selectedDept ||
          emp.department?.name?.trim().toLowerCase() === selectedDept.trim().toLowerCase();
        if (!matchesDept) return;
      }
      if (emp.section && emp.section.trim()) {
        set.add(emp.section.trim());
      }
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  // Card formatting helper directly from EmployeesPage.tsx lines 1551-1712
  renderCardFields(emp: Employee) {
    const ext = emp.ext || emp.phone || '—';
    const reportingManager = emp.reportingManager || emp.reportingTo || '—';
    const hod = emp.hod || '—';
    const section = emp.section || '—';
    const functionName = emp.functionName || '—';
    const grade = emp.grade || '—';
    const email = emp.email || '—';
    const departmentName = emp.department?.name || '—';
    const workstation = emp.seat ? `${emp.seat.label} (${emp.seat.floor?.name || emp.floor?.name || 'Floor'})` : 'Unassigned';
    const pcNumber = emp.pcNumber || emp.seat?.pcNumber || '—';

    // R4 Header Format: [Emp ID] | [Emp Name] | [Emp Email] | Ext: [ext]
    const headerTitle = `${emp.employeeCode} | ${emp.fullName} | ${email} | Ext: ${ext}`;

    return {
      headerTitle,
      ext,
      reportingManager,
      hod,
      section,
      functionName,
      grade,
      email,
      departmentName,
      workstation,
      pcNumber,
    };
  }
}

describe('Milestone 3 Challenger 2: Empirical Matrix Verification', () => {
  it('1. Cascading Reset Handlers: confirms subordinate state is properly reset upon parent selection change', () => {
    const state = new EmployeesPageMatrixState();

    // Set dirty state across all tiers
    state.unitFilter = 'unit-1';
    state.buildingFilter = 'bld-1';
    state.floorFilter = 'flr-1';
    state.officeAreaFilter = 'Executive Wing';
    state.selectedDept = 'dept-eng';
    state.sectionFilter = 'DevOps';
    state.plantFilter = 'plant-1';

    // 1.1 Changing Unit resets Building, Floor, OfficeArea, Dept, Section, Plant
    state.handleUnitChange('unit-2');
    expect(state.unitFilter).toBe('unit-2');
    expect(state.buildingFilter).toBe('ALL');
    expect(state.floorFilter).toBe('ALL');
    expect(state.officeAreaFilter).toBe('ALL');
    expect(state.selectedDept).toBe('');
    expect(state.sectionFilter).toBe('');
    expect(state.plantFilter).toBe('ALL');

    // Restore dirty state for Building change test
    state.buildingFilter = 'bld-2';
    state.floorFilter = 'flr-2';
    state.officeAreaFilter = 'Admin Area';

    // 1.2 Changing Building resets Floor and OfficeArea
    state.handleBuildingChange('bld-3');
    expect(state.buildingFilter).toBe('bld-3');
    expect(state.floorFilter).toBe('ALL');
    expect(state.officeAreaFilter).toBe('ALL');

    // Restore dirty state for Floor change test
    state.floorFilter = 'flr-3';
    state.officeAreaFilter = 'Shop Floor';

    // 1.3 Changing Floor resets OfficeArea
    state.handleFloorChange('flr-4');
    expect(state.floorFilter).toBe('flr-4');
    expect(state.officeAreaFilter).toBe('ALL');

    // Restore dirty state for Department change test
    state.selectedDept = 'dept-finance';
    state.sectionFilter = 'Auditing';

    // 1.4 Changing Department resets Section
    state.handleDepartmentChange('dept-legal');
    expect(state.selectedDept).toBe('dept-legal');
    expect(state.sectionFilter).toBe('');

    // 1.5 handleResetFilters resets all filters
    state.unitFilter = 'unit-2';
    state.buildingFilter = 'bld-3';
    state.floorFilter = 'flr-4';
    state.officeAreaFilter = 'Ops Area';
    state.selectedDept = 'dept-legal';
    state.sectionFilter = 'Litigation';
    state.search = 'Alice';
    state.assignmentFilter = 'ASSIGNED';
    state.activeFilter = 'ACTIVE';
    state.wsNoFilter = 'WS-10';
    state.functionFilter = 'Legal';
    state.reportingToFilter = 'Bob';
    state.hodFilter = 'Charlie';
    state.plantFilter = 'plt-1';

    state.handleResetFilters();
    expect(state.unitFilter).toBe('ALL');
    expect(state.buildingFilter).toBe('ALL');
    expect(state.floorFilter).toBe('ALL');
    expect(state.officeAreaFilter).toBe('ALL');
    expect(state.selectedDept).toBe('');
    expect(state.sectionFilter).toBe('');
    expect(state.search).toBe('');
    expect(state.assignmentFilter).toBe('ALL');
    expect(state.activeFilter).toBe('ALL');
    expect(state.wsNoFilter).toBe('');
    expect(state.functionFilter).toBe('');
    expect(state.reportingToFilter).toBe('');
    expect(state.hodFilter).toBe('');
    expect(state.plantFilter).toBe('ALL');
  });

  it('2. Fallbacks with Null/Undefined values: renders cleanly without blank holes or crashing', () => {
    const state = new EmployeesPageMatrixState();

    // Employee with all nullable/matrix fields explicitly null
    const nullEmp: Employee = {
      id: 'emp-null',
      fullName: 'Vikram Joshi',
      employeeCode: 'VJ999',
      email: null,
      phone: null,
      ext: null,
      reportingManager: null,
      reportingTo: null,
      hod: null,
      section: null,
      functionName: null,
      grade: null,
      pcNumber: null,
      officeArea: null,
      departmentId: 'dept-1',
      department: undefined,
      seat: null,
      isActive: true,
    };

    const card = state.renderCardFields(nullEmp);

    expect(card.headerTitle).toBe('VJ999 | Vikram Joshi | — | Ext: —');
    expect(card.ext).toBe('—');
    expect(card.reportingManager).toBe('—');
    expect(card.hod).toBe('—');
    expect(card.section).toBe('—');
    expect(card.functionName).toBe('—');
    expect(card.grade).toBe('—');
    expect(card.email).toBe('—');
    expect(card.departmentName).toBe('—');
    expect(card.workstation).toBe('Unassigned');
    expect(card.pcNumber).toBe('—');

    // Backward compatibility fallbacks: phone for ext, reportingTo for reportingManager
    const legacyEmp: Employee = {
      id: 'emp-legacy',
      fullName: 'Sunita Sharma',
      employeeCode: 'SS101',
      email: 'sunita@example.com',
      phone: '9876543210',
      ext: undefined,
      reportingManager: undefined,
      reportingTo: 'Director Sharma',
      hod: 'HOD Patel',
      section: 'Payroll',
      functionName: 'Accounts',
      grade: 'L2',
      pcNumber: 'PC-OLD-1',
      departmentId: 'dept-acc',
      department: { id: 'dept-acc', name: 'Accounting', colorHex: '#444' },
      seat: null,
      isActive: true,
    };

    const legacyCard = state.renderCardFields(legacyEmp);
    expect(legacyCard.ext).toBe('9876543210');
    expect(legacyCard.reportingManager).toBe('Director Sharma');
    expect(legacyCard.hod).toBe('HOD Patel');
    expect(legacyCard.headerTitle).toBe('SS101 | Sunita Sharma | sunita@example.com | Ext: 9876543210');
  });

  it('3. Matrix Filtering Logic across 6 Tiers: verifies precision and isolation', () => {
    const state = new EmployeesPageMatrixState();

    const units: UnitOption[] = [
      { id: 'u1', name: 'Unit 1 (Bhubaneswar)' },
      { id: 'u2', name: 'Unit 2 (Cuttack)' },
    ];
    const buildings: BuildingOption[] = [
      { id: 'b1', name: 'Admin Block', plant: { unitId: 'u1' } },
      { id: 'b2', name: 'Tech Tower', plant: { unitId: 'u1' } },
    ];
    const floors: FloorOption[] = [
      { id: 'f1', name: '1st Floor', floorNumber: 1, buildingId: 'b1' },
      { id: 'f2', name: '2nd Floor', floorNumber: 2, buildingId: 'b1' },
    ];

    const employees: Employee[] = [
      {
        id: 'e1',
        fullName: 'Dev Employee',
        employeeCode: 'E001',
        departmentId: 'd1',
        department: { id: 'd1', name: 'Engineering', colorHex: '#00f', unitId: 'u1' },
        section: 'Frontend Core',
        functionName: 'Software Dev',
        reportingManager: 'Manager Bob',
        hod: 'Head John',
        seat: {
          id: 's1',
          label: 'WS-101',
          floorId: 'f1',
          officeArea: 'Powder Coating Office',
          floor: { id: 'f1', name: '1st Floor', building: { id: 'b1', name: 'Admin Block', plant: { unit: { id: 'u1', name: 'Unit 1 (Bhubaneswar)' } } } },
        },
        isActive: true,
      },
      {
        id: 'e2',
        fullName: 'Operations Employee',
        employeeCode: 'E002',
        departmentId: 'd1',
        department: { id: 'd1', name: 'Engineering', colorHex: '#00f', unitId: 'u1' },
        section: 'DevOps & Cloud',
        functionName: 'Infrastructure',
        reportingManager: 'Manager Bob',
        hod: 'Head John',
        seat: {
          id: 's2',
          label: 'WS-102',
          floorId: 'f2',
          officeArea: 'SAP & IT Office',
          floor: { id: 'f2', name: '2nd Floor', building: { id: 'b1', name: 'Admin Block', plant: { unit: { id: 'u1', name: 'Unit 1 (Bhubaneswar)' } } } },
        },
        isActive: true,
      },
      {
        id: 'e3',
        fullName: 'Unit 2 Employee',
        employeeCode: 'E003',
        departmentId: 'd2',
        department: { id: 'd2', name: 'HR', colorHex: '#f00', unitId: 'u2' },
        section: 'Recruitment',
        functionName: 'Talent Acquisition',
        reportingManager: 'HR Lead',
        hod: 'HR Head',
        officeArea: 'Recruitment Hub',
        seat: null,
        isActive: true,
      },
    ];

    // Tier 1: Unit Filter
    state.handleUnitChange('u1');
    let filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E001', 'E002']);

    // Tier 2: Building Filter
    state.handleBuildingChange('b1');
    filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E001', 'E002']);

    // Tier 3: Floor Filter
    state.handleFloorChange('f1');
    filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E001']);

    // Tier 4: Office Area Filter (exact match or case-insensitive match on seat.officeArea or employee.officeArea)
    state.floorFilter = 'ALL'; // reset floor to test office area across building
    state.handleOfficeAreaChange('SAP & IT Office');
    filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E002']);

    // Tier 5: Department Filter
    state.officeAreaFilter = 'ALL';
    state.handleDepartmentChange('d1');
    filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E001', 'E002']);

    // Tier 6: Section Filter
    state.handleSectionChange('DevOps & Cloud');
    filtered = state.computeFilteredEmployees(employees, units, buildings, floors);
    expect(filtered.map((e) => e.employeeCode)).toEqual(['E002']);
  });

  it('4. Dynamic Derivation: verifies availableOfficeAreas and availableSections calculations', () => {
    const state = new EmployeesPageMatrixState();

    const employees: Employee[] = [
      {
        id: 'e1',
        fullName: 'Alice',
        employeeCode: 'A01',
        departmentId: 'd-eng',
        department: { id: 'd-eng', name: 'Engineering', colorHex: '#111', unitId: 'u1' },
        section: 'Frontend Core',
        seat: {
          id: 's1',
          label: 'WS-1',
          floorId: 'flr-1',
          officeArea: 'Floor 1 Main Hall',
        },
        isActive: true,
      },
      {
        id: 'e2',
        fullName: 'Bob',
        employeeCode: 'B02',
        departmentId: 'd-eng',
        department: { id: 'd-eng', name: 'Engineering', colorHex: '#111', unitId: 'u1' },
        section: 'Backend Core',
        officeArea: 'Direct Employee Area',
        seat: null,
        isActive: true,
      },
      {
        id: 'e3',
        fullName: 'Charlie',
        employeeCode: 'C03',
        departmentId: 'd-sales',
        department: { id: 'd-sales', name: 'Sales', colorHex: '#222', unitId: 'u1' },
        section: 'Enterprise Sales',
        officeArea: 'Direct Employee Area',
        seat: null,
        isActive: true,
      },
    ];

    const floorSeats: SeatOption[] = [
      { id: 's10', label: 'WS-10', officeArea: 'Floor 1 Main Hall' },
      { id: 's11', label: 'WS-11', officeArea: 'Floor 1 Main Hall' },
      { id: 's12', label: 'WS-12', officeArea: 'Floor 1 Server Room' },
    ];

    // When floorFilter is selected, availableOfficeAreas derives from floorSeats
    const areasOnFloor = state.computeAvailableOfficeAreas('flr-1', floorSeats, employees, 'u1', 'ALL');
    expect(areasOnFloor).toEqual([
      { name: 'Floor 1 Main Hall', count: 2 },
      { name: 'Floor 1 Server Room', count: 1 },
    ]);

    // When floorFilter is 'ALL', availableOfficeAreas derives from loaded employees
    const areasAll = state.computeAvailableOfficeAreas('ALL', [], employees, 'u1', 'ALL');
    expect(areasAll).toEqual([
      { name: 'Direct Employee Area', count: 2 },
      { name: 'Floor 1 Main Hall', count: 1 },
    ]);

    // When department is selected, availableSections filters to that department only
    const sectionsEng = state.computeAvailableSections(employees, 'd-eng', 'u1');
    expect(sectionsEng).toEqual(['Backend Core', 'Frontend Core']);

    const sectionsSales = state.computeAvailableSections(employees, 'd-sales', 'u1');
    expect(sectionsSales).toEqual(['Enterprise Sales']);

    // When no department is selected, availableSections shows all sections in unit
    const sectionsAll = state.computeAvailableSections(employees, '', 'u1');
    expect(sectionsAll).toEqual(['Backend Core', 'Enterprise Sales', 'Frontend Core']);
  });
});
