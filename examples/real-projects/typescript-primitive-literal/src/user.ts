type Status = "ready";

function expectStatus(status: Status): Status {
  return status;
}

export const currentStatus = expectStatus("pending");
