export function classifyTransferUniqueConflict(error: any) {
  const target = error?.meta?.target;
  const fields = Array.isArray(target) ? target.join(' ') : String(target || '');
  if (/employee_?id|seats_employee_id_key/i.test(fields)) {
    return {
      error: 'TRANSFER_EMPLOYEE_SEAT_CONFLICT',
      message: 'Seat assignment data is inconsistent. Ask an administrator to check the employee\'s current seat and vacant workstations before approving.'
    };
  }
  if (/active_?transfer_?key/i.test(fields)) {
    return {
      error: 'TRANSFER_ACTIVE_REQUEST_CONFLICT',
      message: 'This employee already has an active transfer request. Refresh the request list.'
    };
  }
  return {
    error: 'TRANSFER_UNIQUE_CONFLICT',
    message: 'Approval could not be completed because of a data constraint. Refresh the request and contact an administrator if it continues.'
  };
}
